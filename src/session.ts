// ============================================================================
// BlazingMQ Node.js SDK — Session
//
// The Session class is the main entry point for the BlazingMQ SDK.
// It manages the connection to the broker, queue operations, and
// message publishing/consuming.
//
// Architecture:
//   Session → BmqConnection (TCP)
//             ↓ Events
//   Session handles: CONTROL (negotiation, queue ops), PUT/PUSH/ACK/CONFIRM,
//                    HEARTBEAT_REQ/RSP
// ============================================================================

import * as os from 'os';
import { EventEmitter } from 'events';
import {
  EventType,
  QueueFlags,
  CompressionAlgorithmType,
  PropertyType,
  DEFAULT_BROKER_URI,
  SDK_FEATURES,
  SDK_VERSION,
  SDK_NAME,
  SDK_VERSION_STRING,
  PROTOCOL_VERSION,
  DEFAULT_APP_ID,
  ackStatusToResult,
  AckResult,
} from './protocol/constants';
import {
  buildControlEvent,
  parseControlPayload,
  buildHeartbeatResponse,
  buildPutEvent,
  parsePushEvent,
  parseAckEvent,
  buildConfirmEvent,
  PutMessageOptions,
  guidToHex,
} from './protocol/codec';
import { BmqConnection } from './transport/connection';
import {
  BlazingMQError,
  BrokerTimeoutError,
  ConnectionError,
  BrokerRefusedError,
  InvalidArgumentError,
  QueueError,
} from './errors';
import {
  SessionOptions,
  TimeoutOptions,
  QueueOptions,
  DEFAULT_QUEUE_OPTIONS,
  OpenQueueParams,
  PostOptions,
  Message,
  MessageHandle,
  Ack,
  AckCallback,
  MessageCallback,
  SessionEventCallback,
  SessionEvent,
  SessionEventType,
  PropertyEntry,
} from './types';

// ============================================================================
// Internal Types
// ============================================================================

interface QueueState {
  uri: string;
  queueId: number;
  flags: number;
  options: Required<QueueOptions>;
  isOpen: boolean;
  subQueueId: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingAck {
  callback: AckCallback;
  queueUri: string;
}

// ============================================================================
// Default Timeouts
// ============================================================================

const DEFAULT_TIMEOUTS: Required<TimeoutOptions> = {
  connectTimeout: 5000,
  disconnectTimeout: 5000,
  openQueueTimeout: 30000,
  configureQueueTimeout: 30000,
  closeQueueTimeout: 30000,
};

// ============================================================================
// Session Class
// ============================================================================

/**
 * Main entry point for the BlazingMQ Node.js SDK.
 *
 * @example
 * ```typescript
 * const session = new Session({
 *   broker: 'tcp://localhost:30114',
 * });
 *
 * session.on('message', (msg, handle) => {
 *   console.log('Received:', msg.data.toString());
 *   handle.confirm();
 * });
 *
 * await session.start();
 * await session.openQueue({ queueUri: 'bmq://bmq.test.mem.priority/my-queue', write: true });
 * await session.post({ queueUri: 'bmq://bmq.test.mem.priority/my-queue', payload: 'Hello!' });
 * ```
 */
export class Session extends EventEmitter {
  private connection: BmqConnection;
  private timeouts: Required<TimeoutOptions>;
  private compressionAlgorithm: CompressionAlgorithmType;

  // Request/response correlation
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();

  // Queue management
  private nextQueueId = 0;
  private queues = new Map<string, QueueState>(); // URI → QueueState
  private queueIdToUri = new Map<number, string>(); // queueId → URI

  // ACK correlation
  private nextCorrelationId = 1;
  private pendingAcks = new Map<number, PendingAck>(); // correlationId → PendingAck

  // Heartbeat tracking
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatReq = 0;
  private heartbeatIntervalMs = 3000;
  private maxMissedHeartbeats = 10;

  // Session state
  private started = false;

  // Callbacks
  private onSessionEvent?: SessionEventCallback;
  private onMessage?: MessageCallback;

  // Bound event handlers (for proper removal on cleanup)
  private readonly boundHandleEvent: (type: EventType, data: Buffer) => void;
  private readonly boundHandleError: (err: Error) => void;
  private readonly boundHandleDisconnect: () => void;

  constructor(options: SessionOptions = {}) {
    super();
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.compressionAlgorithm =
      options.messageCompressionAlgorithm ?? CompressionAlgorithmType.NONE;

    // Parse broker URI
    const brokerUri = options.broker ?? process.env.BMQ_BROKER_URI ?? DEFAULT_BROKER_URI;
    const { host, port } = parseBrokerUri(brokerUri);

    this.connection = new BmqConnection({
      host,
      port,
      connectTimeout: this.timeouts.connectTimeout,
      reconnect: options.reconnect ?? false,
    });

    // Create bound handlers so we can remove them on cleanup
    this.boundHandleEvent = this.handleEvent.bind(this);
    this.boundHandleError = (err: Error) => {
      this.emitSessionEvent({
        type: SessionEventType.ERROR,
        message: err.message,
        error: err,
      });
    };
    this.boundHandleDisconnect = () => {
      if (this.started) {
        this.emitSessionEvent({
          type: SessionEventType.CONNECTION_LOST,
          message: 'Connection to broker lost',
        });
      }
    };

    // Wire up connection events
    this.connection.on('event', this.boundHandleEvent);
    this.connection.on('error', this.boundHandleError);
    this.connection.on('disconnected', this.boundHandleDisconnect);
  }

  /**
   * Set the session event callback.
   */
  setSessionEventCallback(callback: SessionEventCallback): void {
    this.onSessionEvent = callback;
  }

  /**
   * Set the message callback for received messages.
   */
  setMessageCallback(callback: MessageCallback): void {
    this.onMessage = callback;
  }

  // ============================================================================
  // Session Lifecycle
  // ============================================================================

  /**
   * Start the session — connect to the broker and perform negotiation.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new BlazingMQError('Session already started');
    }

    // Connect TCP
    await this.connection.connect();

    // Perform negotiation
    await this.negotiate();

    this.started = true;
    this.emitSessionEvent({
      type: SessionEventType.CONNECTED,
      message: 'Connected to broker',
    });
  }

  /**
   * Stop the session — close all queues, disconnect from broker.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    // Close all open queues
    const closePromises: Promise<void>[] = [];
    for (const [uri, queue] of this.queues) {
      if (queue.isOpen) {
        closePromises.push(this.closeQueue(uri).catch(() => {}));
      }
    }
    await Promise.allSettled(closePromises);

    // Send disconnect
    try {
      await this.sendDisconnect();
    } catch {
      // Ignore disconnect errors
    }

    // Stop heartbeat
    this.stopHeartbeat();

    // Remove connection event listeners to prevent memory leaks
    this.connection.removeListener('event', this.boundHandleEvent);
    this.connection.removeListener('error', this.boundHandleError);
    this.connection.removeListener('disconnected', this.boundHandleDisconnect);

    // Close connection
    await this.connection.disconnect();

    this.started = false;
    this.queues.clear();
    this.queueIdToUri.clear();
    this.pendingAcks.clear();

    // Reject all pending requests
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new BlazingMQError('Session stopped'));
    }
    this.pendingRequests.clear();

    this.emitSessionEvent({
      type: SessionEventType.DISCONNECTED,
      message: 'Disconnected from broker',
    });
  }

  // ============================================================================
  // Queue Operations
  // ============================================================================

  /**
   * Open a queue for reading and/or writing.
   *
   * @param params Queue parameters
   * @returns Queue options in effect
   */
  async openQueue(params: OpenQueueParams): Promise<Required<QueueOptions>> {
    this.ensureStarted();

    const { queueUri, read = false, write = false, options = {}, timeout } = params;

    if (!read && !write) {
      throw new InvalidArgumentError(
        'At least one of read or write must be true',
      );
    }

    if (read && !this.onMessage && this.listenerCount('message') === 0) {
      throw new InvalidArgumentError(
        'Cannot open queue for reading without a message callback or message event listener',
      );
    }

    if (this.queues.has(queueUri)) {
      throw new QueueError('Queue is already open', queueUri);
    }

    // Build flags
    let flags = 0;
    if (read) flags |= QueueFlags.READ;
    if (write) {
      flags |= QueueFlags.WRITE;
      flags |= QueueFlags.ACK; // Always request ACKs for writes
    }

    const queueId = this.nextQueueId++;
    const resolvedOptions: Required<QueueOptions> = {
      ...DEFAULT_QUEUE_OPTIONS,
      ...options,
    };

    const openTimeout = timeout ?? this.timeouts.openQueueTimeout;

    // Step 1: Send openQueue control message
    const openResponse = await this.sendControlRequest(
      {
        openQueue: {
          handleParameters: {
            uri: queueUri,
            qId: queueId,
            subIdInfo: { subId: 0, appId: DEFAULT_APP_ID },
            flags,
            readCount: read ? 1 : 0,
            writeCount: write ? 1 : 0,
            adminCount: 0,
          },
        },
      },
      openTimeout,
    );

    // Check for error
    if (openResponse.status) {
      throw new BrokerRefusedError(
        `Failed to open queue ${queueUri}: ${openResponse.status.message || openResponse.status.category}`,
        openResponse.status.category,
        openResponse.status.code,
      );
    }

    // Step 2: Configure stream (for consumers)
    if (read) {
      const configTimeout = timeout ?? this.timeouts.configureQueueTimeout;
      const configResponse = await this.sendControlRequest(
        {
          configureStream: {
            qId: queueId,
            streamParameters: {
              appId: DEFAULT_APP_ID,
              subscriptions: [
                {
                  sId: 0,
                  expression: { version: 'E_UNDEFINED', text: '' },
                  consumers: [
                    {
                      maxUnconfirmedMessages: resolvedOptions.maxUnconfirmedMessages,
                      maxUnconfirmedBytes: resolvedOptions.maxUnconfirmedBytes,
                      consumerPriority: resolvedOptions.consumerPriority,
                      consumerPriorityCount: 1,
                    },
                  ],
                },
              ],
            },
          },
        },
        configTimeout,
      );

      if (configResponse.status && configResponse.status.category !== 'E_SUCCESS') {
        throw new BrokerRefusedError(
          `Failed to configure queue ${queueUri}: ${configResponse.status.message || configResponse.status.category}`,
          configResponse.status.category,
          configResponse.status.code,
        );
      }
    }

    // Record queue state
    const queueState: QueueState = {
      uri: queueUri,
      queueId,
      flags,
      options: resolvedOptions,
      isOpen: true,
      subQueueId: 0,
    };
    this.queues.set(queueUri, queueState);
    this.queueIdToUri.set(queueId, queueUri);

    return resolvedOptions;
  }

  /**
   * Configure a queue's options (e.g., change consumer priority, unconfirmed limits).
   */
  async configureQueue(
    queueUri: string,
    options: QueueOptions,
    timeout?: number,
  ): Promise<void> {
    this.ensureStarted();

    const queue = this.queues.get(queueUri);
    if (!queue) {
      throw new QueueError('Queue is not open', queueUri);
    }

    const newOptions = { ...queue.options, ...options };
    const configTimeout = timeout ?? this.timeouts.configureQueueTimeout;

    const response = await this.sendControlRequest(
      {
        configureStream: {
          qId: queue.queueId,
          streamParameters: {
            appId: DEFAULT_APP_ID,
            subscriptions: [
              {
                sId: 0,
                expression: { version: 'E_UNDEFINED', text: '' },
                consumers: [
                  {
                    maxUnconfirmedMessages: newOptions.maxUnconfirmedMessages,
                    maxUnconfirmedBytes: newOptions.maxUnconfirmedBytes,
                    consumerPriority: newOptions.consumerPriority,
                    consumerPriorityCount: 1,
                  },
                ],
              },
            ],
          },
        },
      },
      configTimeout,
    );

    if (response.status && response.status.category !== 'E_SUCCESS') {
      throw new BrokerRefusedError(
        `Failed to configure queue ${queueUri}: ${response.status.message || response.status.category}`,
        response.status.category,
        response.status.code,
      );
    }

    queue.options = newOptions as Required<QueueOptions>;
  }

  /**
   * Close a queue.
   */
  async closeQueue(queueUri: string, timeout?: number): Promise<void> {
    this.ensureStarted();

    const queue = this.queues.get(queueUri);
    if (!queue) {
      throw new QueueError('Queue is not open', queueUri);
    }

    const closeTimeout = timeout ?? this.timeouts.closeQueueTimeout;

    // Step 1: Deconfigure (if consumer) — set empty subscriptions
    if (queue.flags & QueueFlags.READ) {
      try {
        await this.sendControlRequest(
          {
            configureStream: {
              qId: queue.queueId,
              streamParameters: {
                appId: DEFAULT_APP_ID,
                subscriptions: [],
              },
            },
          },
          closeTimeout,
        );
      } catch {
        // Continue with close even if deconfigure fails
      }
    }

    // Step 2: Send closeQueue with the original handle parameters
    const hasRead = !!(queue.flags & QueueFlags.READ);
    const hasWrite = !!(queue.flags & QueueFlags.WRITE);

    const response = await this.sendControlRequest(
      {
        closeQueue: {
          handleParameters: {
            uri: queueUri,
            qId: queue.queueId,
            subIdInfo: { subId: 0, appId: DEFAULT_APP_ID },
            flags: queue.flags,
            readCount: hasRead ? 1 : 0,
            writeCount: hasWrite ? 1 : 0,
            adminCount: 0,
          },
          isFinal: true,
        },
      },
      closeTimeout,
    );

    if (response.status && response.status.category !== 'E_SUCCESS') {
      throw new BrokerRefusedError(
        `Failed to close queue ${queueUri}: ${response.status.message || response.status.category}`,
        response.status.category,
        response.status.code,
      );
    }

    // Remove from tracking
    this.queueIdToUri.delete(queue.queueId);
    this.queues.delete(queueUri);
    queue.isOpen = false;
  }

  /**
   * Get queue options for an open queue.
   */
  getQueueOptions(queueUri: string): Required<QueueOptions> | undefined {
    return this.queues.get(queueUri)?.options;
  }

  /**
   * Check if a queue is open.
   */
  isQueueOpen(queueUri: string): boolean {
    return this.queues.get(queueUri)?.isOpen ?? false;
  }

  // ============================================================================
  // Publishing (POST)
  // ============================================================================

  /**
   * Publish a message to a queue.
   *
   * @param options Post options
   * @returns A promise that resolves with the correlation ID
   */
  post(options: PostOptions): number {
    this.ensureStarted();

    const queue = this.queues.get(options.queueUri);
    if (!queue) {
      throw new QueueError('Queue is not open', options.queueUri);
    }
    if (!(queue.flags & QueueFlags.WRITE)) {
      throw new QueueError('Queue is not open for writing', options.queueUri);
    }

    const payload = typeof options.payload === 'string'
      ? Buffer.from(options.payload, 'utf8')
      : options.payload;

    const correlationId = this.nextCorrelationId++;
    if (this.nextCorrelationId > 0xffffff) {
      this.nextCorrelationId = 1; // Wrap around 24-bit space
    }

    // Build properties map
    let properties: Map<string, { type: PropertyType; value: any }> | undefined;
    if (options.properties) {
      properties = new Map();
      for (const [key, value] of Object.entries(options.properties)) {
        const overrideType = options.propertyTypeOverrides?.[key];
        const type = overrideType ?? inferPropertyType(value);
        properties.set(key, { type, value });
      }
    }

    // Register ACK callback
    if (options.onAck) {
      this.pendingAcks.set(correlationId, {
        callback: options.onAck,
        queueUri: options.queueUri,
      });
    }

    const compressionType =
      options.compressionAlgorithm ?? this.compressionAlgorithm;

    const putMsg: PutMessageOptions = {
      queueId: queue.queueId,
      correlationId,
      payload,
      properties,
      compressionType,
      ackRequested: true,
    };

    const eventBuf = buildPutEvent([putMsg]);
    this.connection.send(eventBuf);

    return correlationId;
  }

  /**
   * Publish a message and wait for the ACK.
   *
   * @returns A promise that resolves with the Ack
   */
  postAndWaitForAck(
    options: Omit<PostOptions, 'onAck'>,
    timeout?: number,
  ): Promise<Ack> {
    return new Promise((resolve, reject) => {
      const ackTimeout = timeout ?? 30000;

      const timer = setTimeout(() => {
        this.pendingAcks.delete(correlationId);
        reject(new BrokerTimeoutError('Post ACK', ackTimeout));
      }, ackTimeout);

      const correlationId = this.post({
        ...options,
        onAck: (ack) => {
          clearTimeout(timer);
          if (ack.isSuccess) {
            resolve(ack);
          } else {
            reject(
              new BlazingMQError(
                `Post failed with status: ${AckResult[ack.status]}`,
              ),
            );
          }
        },
      });
    });
  }

  // ============================================================================
  // Confirming Messages
  // ============================================================================

  /**
   * Confirm (acknowledge) a received message.
   */
  confirm(message: Message): void {
    this.ensureStarted();

    const confirmBuf = buildConfirmEvent([
      {
        queueId: message.queueId,
        guid: message.guid,
        subQueueId: 0,
      },
    ]);
    this.connection.send(confirmBuf);
  }

  // ============================================================================
  // Negotiation
  // ============================================================================

  private async negotiate(): Promise<void> {
    const clientIdentity = {
      clientIdentity: {
        protocolVersion: PROTOCOL_VERSION,
        sdkVersion: SDK_VERSION,
        clientType: 'E_TCPCLIENT',
        processName: process.argv[1] || 'node',
        pid: process.pid,
        sessionId: 1,
        hostName: os.hostname(),
        features: SDK_FEATURES,
        clusterName: '',
        clusterNodeId: -1,
        sdkLanguage: 'E_JAVA', // Use E_JAVA since there's no Node.js enum
        guidInfo: {
          clientId: '',
          nanoSecondsFromEpoch: 0,
        },
        userAgent: `${SDK_NAME}/${SDK_VERSION_STRING}`,
      },
    };

    const eventBuf = buildControlEvent(clientIdentity);
    this.connection.send(eventBuf);

    // Wait for broker response
    const response = await this.waitForControlResponse(
      this.timeouts.connectTimeout,
    );

    if (response.brokerResponse) {
      const br = response.brokerResponse;
      if (br.result && br.result.category !== 'E_SUCCESS') {
        throw new ConnectionError(
          `Broker rejected negotiation: ${br.result.message || br.result.category}`,
        );
      }

      // Extract heartbeat settings
      if (br.heartbeatIntervalMs) {
        this.heartbeatIntervalMs = br.heartbeatIntervalMs;
      }
      if (br.maxMissedHeartbeats) {
        this.maxMissedHeartbeats = br.maxMissedHeartbeats;
      }

      // Start heartbeat tracking (we don't send heartbeats — we respond to them)
      this.startHeartbeatMonitor();
    } else {
      throw new ConnectionError('Unexpected negotiation response');
    }
  }

  /**
   * Wait for the next CONTROL event (used during negotiation).
   */
  private waitForControlResponse(timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connection.removeListener('event', handler);
        reject(new BrokerTimeoutError('Negotiation', timeoutMs));
      }, timeoutMs);

      const handler = (type: EventType, data: Buffer) => {
        if (type === EventType.CONTROL) {
          clearTimeout(timer);
          this.connection.removeListener('event', handler);
          try {
            const payload = parseControlPayload(data);
            resolve(payload);
          } catch (err) {
            reject(err);
          }
        }
      };

      this.connection.on('event', handler);
    });
  }

  // ============================================================================
  // Control Request/Response
  // ============================================================================

  /**
   * Send a control message with a request ID and wait for the matching response.
   */
  private sendControlRequest(payload: any, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const rId = this.nextRequestId++;
      const message = { rId, ...payload };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(rId);
        reject(new BrokerTimeoutError('Control request', timeoutMs));
      }, timeoutMs);

      this.pendingRequests.set(rId, { resolve, reject, timer });

      const eventBuf = buildControlEvent(message);
      this.connection.send(eventBuf);
    });
  }

  /**
   * Send disconnect control message.
   */
  private async sendDisconnect(): Promise<void> {
    try {
      await this.sendControlRequest(
        { disconnect: {} },
        this.timeouts.disconnectTimeout,
      );
    } catch {
      // Ignore timeout on disconnect
    }
  }

  // ============================================================================
  // Event Handling
  // ============================================================================

  /**
   * Handle an incoming event from the TCP connection.
   */
  private handleEvent(type: EventType, data: Buffer): void {
    switch (type) {
      case EventType.CONTROL:
        this.handleControlEvent(data);
        break;
      case EventType.PUSH:
        this.handlePushEvent(data);
        break;
      case EventType.ACK:
        this.handleAckEvent(data);
        break;
      case EventType.HEARTBEAT_REQ:
        this.handleHeartbeatReq();
        break;
      default:
        // Ignore unknown event types
        break;
    }
  }

  /**
   * Handle a CONTROL event (response to a request).
   */
  private handleControlEvent(data: Buffer): void {
    try {
      const payload = parseControlPayload(data);

      // Match by rId
      if (typeof payload.rId === 'number') {
        const pending = this.pendingRequests.get(payload.rId);
        if (pending) {
          this.pendingRequests.delete(payload.rId);
          clearTimeout(pending.timer);
          pending.resolve(payload);
          return;
        }
      }

      // Unsolicited control messages (broker-initiated)
      // These could be disconnect notifications, etc.
    } catch (err) {
      this.emitSessionEvent({
        type: SessionEventType.ERROR,
        message: `Failed to parse control event: ${err}`,
      });
    }
  }

  /**
   * Handle a PUSH event (message delivered by broker).
   */
  private handlePushEvent(data: Buffer): void {
    try {
      const pushMessages = parsePushEvent(data);

      for (const pushMsg of pushMessages) {
        const queueUri = this.queueIdToUri.get(pushMsg.queueId);
        if (!queueUri) continue;

        // Build message
        const message: Message = {
          data: pushMsg.payload,
          guid: pushMsg.guid,
          guidHex: guidToHex(pushMsg.guid),
          queueUri,
          properties: pushMsg.properties as Map<string, PropertyEntry>,
          queueId: pushMsg.queueId,
        };

        // Build handle
        const handle: MessageHandle = {
          message,
          confirm: () => this.confirm(message),
        };

        // Dispatch to callback or event
        if (this.onMessage) {
          try {
            this.onMessage(message, handle);
          } catch (err) {
            this.emitSessionEvent({
              type: SessionEventType.ERROR,
              message: `Error in message callback: ${err}`,
            });
          }
        }
        this.emit('message', message, handle);
      }
    } catch (err) {
      this.emitSessionEvent({
        type: SessionEventType.ERROR,
        message: `Failed to parse PUSH event: ${err}`,
      });
    }
  }

  /**
   * Handle an ACK event (acknowledgment for published messages).
   */
  private handleAckEvent(data: Buffer): void {
    try {
      const ackMessages = parseAckEvent(data);

      for (const ackMsg of ackMessages) {
        const queueUri =
          this.queueIdToUri.get(ackMsg.queueId) ?? 'unknown';
        const status = ackStatusToResult(ackMsg.status);

        const ack: Ack = {
          guid: ackMsg.guid,
          guidHex: guidToHex(ackMsg.guid),
          status,
          queueUri,
          isSuccess: status === AckResult.SUCCESS,
        };

        // Dispatch to per-message callback
        const pending = this.pendingAcks.get(ackMsg.correlationId);
        if (pending) {
          this.pendingAcks.delete(ackMsg.correlationId);
          try {
            pending.callback(ack);
          } catch (err) {
            this.emitSessionEvent({
              type: SessionEventType.ERROR,
              message: `Error in ACK callback: ${err}`,
            });
          }
        }

        // Also emit as event
        this.emit('ack', ack);
      }
    } catch (err) {
      this.emitSessionEvent({
        type: SessionEventType.ERROR,
        message: `Failed to parse ACK event: ${err}`,
      });
    }
  }

  /**
   * Handle a HEARTBEAT_REQ from the broker — respond immediately.
   */
  private handleHeartbeatReq(): void {
    this.lastHeartbeatReq = Date.now();

    try {
      const response = buildHeartbeatResponse();
      this.connection.send(response);
    } catch {
      // Connection may have closed
    }
  }

  // ============================================================================
  // Heartbeat Monitor
  // ============================================================================

  private startHeartbeatMonitor(): void {
    // Monitor that we're receiving heartbeats from the broker
    const checkInterval = this.heartbeatIntervalMs * 2;
    this.heartbeatInterval = setInterval(() => {
      if (this.lastHeartbeatReq > 0) {
        const elapsed = Date.now() - this.lastHeartbeatReq;
        if (elapsed > this.heartbeatIntervalMs * this.maxMissedHeartbeats) {
          this.emitSessionEvent({
            type: SessionEventType.CONNECTION_LOST,
            message: 'Heartbeat timeout — connection may be dead',
          });
        }
      }
    }, checkInterval);

    // Don't prevent process exit
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ============================================================================
  // Utility
  // ============================================================================

  private ensureStarted(): void {
    if (!this.started) {
      throw new BlazingMQError('Session is not started');
    }
    if (!this.connection.isConnected) {
      throw new ConnectionError('Not connected to broker');
    }
  }

  private emitSessionEvent(event: SessionEvent): void {
    if (this.onSessionEvent) {
      try {
        this.onSessionEvent(event);
      } catch {
        // Don't propagate callback errors
      }
    }
    this.emit('sessionEvent', event);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse a broker URI like "tcp://host:port" into host and port.
 */
function parseBrokerUri(uri: string): { host: string; port: number } {
  const match = uri.match(/^tcp:\/\/([^:]+):(\d+)$/);
  if (!match) {
    throw new InvalidArgumentError(`Invalid broker URI: ${uri}. Expected format: tcp://host:port`);
  }
  return { host: match[1], port: parseInt(match[2], 10) };
}

/**
 * Infer property type from a JavaScript value.
 */
function inferPropertyType(value: any): PropertyType {
  if (typeof value === 'boolean') return PropertyType.BOOL;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return value >= -2147483648 && value <= 2147483647
        ? PropertyType.INT32
        : PropertyType.INT64;
    }
    return PropertyType.INT64;
  }
  if (typeof value === 'bigint') return PropertyType.INT64;
  if (typeof value === 'string') return PropertyType.STRING;
  if (Buffer.isBuffer(value)) return PropertyType.BINARY;
  return PropertyType.STRING;
}
