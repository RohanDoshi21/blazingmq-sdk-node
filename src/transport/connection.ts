// ============================================================================
// BlazingMQ Node.js SDK — TCP Connection Manager
//
// Manages the low-level TCP connection to a BlazingMQ broker.
// Handles:
//   - TCP connection/disconnection
//   - Event framing (reading complete events from TCP stream)
//   - Event dispatching by type
//   - Reconnection with exponential backoff
// ============================================================================

import * as net from 'net';
import { EventEmitter } from 'events';
import {
  EventType,
  EVENT_HEADER_SIZE,
  MAX_EVENT_SIZE,
} from '../protocol/constants';
import { decodeEventHeader, EventHeader } from '../protocol/codec';

export interface ConnectionOptions {
  host: string;
  port: number;
  connectTimeout?: number; // ms, default 5000
  reconnect?: boolean;
  reconnectDelay?: number; // ms, initial delay
  reconnectMaxDelay?: number; // ms, max delay
  reconnectMaxAttempts?: number; // 0 = infinite
}

export const DEFAULT_CONNECTION_OPTIONS: Required<ConnectionOptions> = {
  host: 'localhost',
  port: 30114,
  connectTimeout: 5000,
  reconnect: false,
  reconnectDelay: 1000,
  reconnectMaxDelay: 30000,
  reconnectMaxAttempts: 0,
};

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTING = 'disconnecting',
}

export interface BmqConnection {
  on(event: 'event', listener: (type: EventType, data: Buffer) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: (error?: Error) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'reconnecting', listener: (attempt: number) => void): this;
  emit(event: 'event', type: EventType, data: Buffer): boolean;
  emit(event: 'connected'): boolean;
  emit(event: 'disconnected', error?: Error): boolean;
  emit(event: 'error', error: Error): boolean;
  emit(event: 'reconnecting', attempt: number): boolean;
}

/**
 * Low-level TCP connection to a BlazingMQ broker.
 *
 * Reassembles events from the TCP byte stream using the BlazingMQ framing
 * protocol (8-byte EventHeader with length field), then emits complete events.
 */
export class BmqConnection extends EventEmitter {
  private socket: net.Socket | null = null;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private options: Required<ConnectionOptions>;
  private readBuffer: Buffer = Buffer.alloc(0);
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  constructor(options: ConnectionOptions) {
    super();
    this.options = { ...DEFAULT_CONNECTION_OPTIONS, ...options };
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED;
  }

  /**
   * Connect to the broker. Returns a promise that resolves when connected.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state !== ConnectionState.DISCONNECTED) {
        reject(new Error(`Cannot connect: state is ${this.state}`));
        return;
      }

      this.intentionalDisconnect = false;
      this.state = ConnectionState.CONNECTING;
      this.readBuffer = Buffer.alloc(0);

      const socket = new net.Socket();
      this.socket = socket;

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        this.state = ConnectionState.DISCONNECTED;
        reject(new Error(`Connection timed out after ${this.options.connectTimeout}ms`));
      }, this.options.connectTimeout);

      socket.on('connect', () => {
        clearTimeout(connectTimeout);
        this.state = ConnectionState.CONNECTED;
        this.reconnectAttempt = 0;
        this.emit('connected');
        resolve();
      });

      socket.on('data', (data: Buffer) => {
        this.onData(data);
      });

      socket.on('error', (err: Error) => {
        clearTimeout(connectTimeout);
        this.emit('error', err);
      });

      socket.on('close', () => {
        const wasConnected = this.state === ConnectionState.CONNECTED;
        this.state = ConnectionState.DISCONNECTED;
        this.socket = null;
        this.readBuffer = Buffer.alloc(0);
        this.emit('disconnected');

        if (wasConnected && !this.intentionalDisconnect && this.options.reconnect) {
          this.scheduleReconnect();
        }
      });

      socket.connect(this.options.port, this.options.host);
    });
  }

  /**
   * Disconnect from the broker.
   */
  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.intentionalDisconnect = true;

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      if (!this.socket || this.state === ConnectionState.DISCONNECTED) {
        this.state = ConnectionState.DISCONNECTED;
        resolve();
        return;
      }

      this.state = ConnectionState.DISCONNECTING;
      this.socket.once('close', () => {
        resolve();
      });
      this.socket.destroy();
    });
  }

  /**
   * Send raw bytes to the broker.
   */
  send(data: Buffer): void {
    if (!this.socket || this.state !== ConnectionState.CONNECTED) {
      throw new Error('Not connected');
    }
    this.socket.write(data);
  }

  /**
   * Process incoming TCP data — reassemble events from the stream.
   */
  private onData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

    // Process as many complete events as possible
    while (this.readBuffer.length >= EVENT_HEADER_SIZE) {
      // Read the length from the first 4 bytes
      const word0 = this.readBuffer.readUInt32BE(0);
      const eventLength = word0 & 0x7fffffff;

      // Sanity check
      if (eventLength < EVENT_HEADER_SIZE || eventLength > MAX_EVENT_SIZE) {
        this.emit(
          'error',
          new Error(`Invalid event length: ${eventLength}`),
        );
        this.readBuffer = Buffer.alloc(0);
        return;
      }

      // Wait for the complete event
      if (this.readBuffer.length < eventLength) {
        return; // Need more data
      }

      // Extract the complete event
      const eventBuf = this.readBuffer.subarray(0, eventLength);
      this.readBuffer = this.readBuffer.subarray(eventLength);

      // Decode the header to get the type
      const header = decodeEventHeader(eventBuf);

      // Emit the typed event
      this.emit('event', header.type as EventType, eventBuf);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (
      this.options.reconnectMaxAttempts > 0 &&
      this.reconnectAttempt >= this.options.reconnectMaxAttempts
    ) {
      this.emit(
        'error',
        new Error(
          `Max reconnect attempts (${this.options.reconnectMaxAttempts}) reached`,
        ),
      );
      return;
    }

    const delay = Math.min(
      this.options.reconnectDelay * Math.pow(2, this.reconnectAttempt),
      this.options.reconnectMaxDelay,
    );

    this.reconnectAttempt++;
    this.emit('reconnecting', this.reconnectAttempt);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // connect() failure will trigger 'close' which will schedule another reconnect
      }
    }, delay);
  }
}
