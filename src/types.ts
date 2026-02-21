// ============================================================================
// BlazingMQ Node.js SDK — Type Definitions
// ============================================================================

import { AckResult, PropertyType, CompressionAlgorithmType } from './protocol/constants';

// ============================================================================
// Session Options
// ============================================================================

export interface SessionOptions {
  /** Broker URI in format "tcp://host:port". Default: "tcp://localhost:30114" */
  broker?: string;

  /** Compression algorithm for outgoing messages. Default: NONE */
  messageCompressionAlgorithm?: CompressionAlgorithmType;

  /** Timeout configuration */
  timeouts?: TimeoutOptions;

  /** Whether to automatically reconnect on unintentional disconnect. Default: false */
  reconnect?: boolean;
}

export interface TimeoutOptions {
  /** Connect timeout in ms. Default: 5000 */
  connectTimeout?: number;

  /** Disconnect timeout in ms. Default: 5000 */
  disconnectTimeout?: number;

  /** Open queue timeout in ms. Default: 30000 */
  openQueueTimeout?: number;

  /** Configure queue timeout in ms. Default: 30000 */
  configureQueueTimeout?: number;

  /** Close queue timeout in ms. Default: 30000 */
  closeQueueTimeout?: number;
}

// ============================================================================
// Queue Options
// ============================================================================

export interface QueueOptions {
  /** Maximum unconfirmed messages. 0 = no limit. Default: 1024 */
  maxUnconfirmedMessages?: number;

  /** Maximum unconfirmed bytes. 0 = no limit. Default: 33554432 (32MB) */
  maxUnconfirmedBytes?: number;

  /** Consumer priority. Higher = preferred. Default: 0 */
  consumerPriority?: number;

  /** Whether to suspend queue when host health is bad. Default: false */
  suspendsOnBadHostHealth?: boolean;
}

export const DEFAULT_QUEUE_OPTIONS: Required<QueueOptions> = {
  maxUnconfirmedMessages: 1024,
  maxUnconfirmedBytes: 33554432,
  consumerPriority: 0,
  suspendsOnBadHostHealth: false,
};

// ============================================================================
// Message Types
// ============================================================================

/** Combined property entry with type and value */
export interface PropertyEntry {
  type: PropertyType;
  value: boolean | number | bigint | string | Buffer;
}

/**
 * A message received from a queue (PUSH message).
 */
export interface Message {
  /** Raw payload data */
  readonly data: Buffer;

  /** Globally unique message identifier (16 bytes) */
  readonly guid: Buffer;

  /** GUID as hex string */
  readonly guidHex: string;

  /** Queue URI the message was received from */
  readonly queueUri: string;

  /** Message properties */
  readonly properties: Map<string, PropertyEntry>;

  /** Queue ID (internal) */
  readonly queueId: number;
}

/**
 * Handle for confirming a received message.
 */
export interface MessageHandle {
  /** The message this handle refers to */
  readonly message: Message;

  /** Confirm (acknowledge) the message to the broker */
  confirm(): void;
}

/**
 * Acknowledgment received for a posted message.
 */
export interface Ack {
  /** GUID of the posted message */
  readonly guid: Buffer | null;

  /** GUID as hex string */
  readonly guidHex: string;

  /** ACK status */
  readonly status: AckResult;

  /** Queue URI */
  readonly queueUri: string;

  /** Whether the ACK represents success */
  readonly isSuccess: boolean;
}

// ============================================================================
// Callback Types
// ============================================================================

/** Callback for session lifecycle events */
export type SessionEventCallback = (event: SessionEvent) => void;

/** Callback for received messages */
export type MessageCallback = (message: Message, handle: MessageHandle) => void;

/** Callback for acknowledgments */
export type AckCallback = (ack: Ack) => void;

// ============================================================================
// Session Events
// ============================================================================

export enum SessionEventType {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  CONNECTION_LOST = 'connection_lost',
  RECONNECTED = 'reconnected',
  STATE_RESTORED = 'state_restored',
  CONNECTION_TIMEOUT = 'connection_timeout',
  QUEUE_OPEN_RESULT = 'queue_open_result',
  QUEUE_CLOSE_RESULT = 'queue_close_result',
  QUEUE_CONFIGURE_RESULT = 'queue_configure_result',
  QUEUE_REOPEN_RESULT = 'queue_reopen_result',
  SLOWCONSUMER_NORMAL = 'slowconsumer_normal',
  SLOWCONSUMER_HIGHWATERMARK = 'slowconsumer_highwatermark',
  ERROR = 'error',
}

export interface SessionEvent {
  type: SessionEventType;
  message?: string;
  queueUri?: string;
  error?: Error;
}

// ============================================================================
// Open Queue Options
// ============================================================================

export interface OpenQueueParams {
  /** Queue URI, e.g. "bmq://bmq.test.mem.priority/my-queue" */
  queueUri: string;

  /** Open for reading (consuming). Default: false */
  read?: boolean;

  /** Open for writing (producing). Default: false */
  write?: boolean;

  /** Queue options for consumers */
  options?: QueueOptions;

  /** Timeout in ms. Default: from session options */
  timeout?: number;
}

// ============================================================================
// Post Options
// ============================================================================

export interface PostOptions {
  /** Queue URI to post to */
  queueUri: string;

  /** Message payload */
  payload: Buffer | string;

  /** Optional message properties */
  properties?: Record<string, boolean | number | bigint | string | Buffer>;

  /** Optional property type overrides */
  propertyTypeOverrides?: Record<string, PropertyType>;

  /** ACK callback for this specific message */
  onAck?: AckCallback;

  /** Compression algorithm. Default: from session options */
  compressionAlgorithm?: CompressionAlgorithmType;
}
