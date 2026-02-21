// ============================================================================
// BlazingMQ Node.js SDK — Producer (Publish) API
//
// High-level API for publishing messages to BlazingMQ queues.
// Wraps Session with a focused, ergonomic producer interface.
// ============================================================================

import { Session } from './session';
import {
  SessionOptions,
  QueueOptions,
  PostOptions,
  Ack,
  AckCallback,
  SessionEventCallback,
  SessionEvent,
  SessionEventType,
  PropertyEntry,
} from './types';
import { PropertyType, CompressionAlgorithmType, AckResult } from './protocol/constants';
import { BlazingMQError, QueueError } from './errors';

export interface ProducerOptions extends SessionOptions {
  /** Default queue URI to produce to (optional — can be specified per message) */
  defaultQueueUri?: string;

  /** Default message compression algorithm */
  defaultCompression?: CompressionAlgorithmType;

  /** Session event callback */
  onSessionEvent?: SessionEventCallback;
}

export interface PublishOptions {
  /** Queue URI (required if no defaultQueueUri is set) */
  queueUri?: string;

  /** Message payload — string or Buffer */
  payload: string | Buffer;

  /** Optional message properties */
  properties?: Record<string, boolean | number | bigint | string | Buffer>;

  /** Optional property type overrides */
  propertyTypeOverrides?: Record<string, PropertyType>;

  /** Per-message ACK callback */
  onAck?: AckCallback;

  /** Compression algorithm override */
  compression?: CompressionAlgorithmType;
}

/**
 * High-level producer for publishing messages to BlazingMQ queues.
 *
 * @example
 * ```typescript
 * const producer = new Producer({
 *   broker: 'tcp://localhost:30114',
 *   defaultQueueUri: 'bmq://bmq.test.mem.priority/my-queue',
 * });
 *
 * await producer.start();
 *
 * // Simple publish
 * await producer.publish({ payload: 'Hello, World!' });
 *
 * // Publish with properties
 * await producer.publish({
 *   payload: JSON.stringify({ event: 'user_signup', userId: 42 }),
 *   properties: { eventType: 'user_signup', priority: 1 },
 * });
 *
 * // Publish and wait for ACK
 * const ack = await producer.publishAndWait({ payload: 'Important message' });
 * console.log('ACK status:', ack.status);
 *
 * await producer.stop();
 * ```
 */
export class Producer {
  private session: Session;
  private options: ProducerOptions;
  private openQueues = new Set<string>();
  private started = false;

  constructor(options: ProducerOptions = {}) {
    this.options = options;
    this.session = new Session(options);

    if (options.onSessionEvent) {
      this.session.setSessionEventCallback(options.onSessionEvent);
    }
  }

  /**
   * Start the producer — connect to the broker.
   */
  async start(): Promise<void> {
    await this.session.start();
    this.started = true;

    // Open default queue if specified
    if (this.options.defaultQueueUri) {
      await this.openQueue(this.options.defaultQueueUri);
    }
  }

  /**
   * Stop the producer — close all queues and disconnect.
   */
  async stop(): Promise<void> {
    this.started = false;
    await this.session.stop();
    this.openQueues.clear();
  }

  /**
   * Open a queue for writing.
   */
  async openQueue(
    queueUri: string,
    options?: QueueOptions,
  ): Promise<void> {
    if (this.openQueues.has(queueUri)) return;

    await this.session.openQueue({
      queueUri,
      write: true,
      options,
    });
    this.openQueues.add(queueUri);
  }

  /**
   * Close a queue.
   */
  async closeQueue(queueUri: string): Promise<void> {
    if (!this.openQueues.has(queueUri)) return;

    await this.session.closeQueue(queueUri);
    this.openQueues.delete(queueUri);
  }

  /**
   * Publish a message. Fire-and-forget — use onAck callback for delivery confirmation.
   *
   * @returns correlation ID for the message
   */
  publish(options: PublishOptions): number {
    if (!this.started) {
      throw new BlazingMQError('Producer is not started');
    }

    const queueUri = options.queueUri ?? this.options.defaultQueueUri;
    if (!queueUri) {
      throw new BlazingMQError(
        'No queue URI specified and no defaultQueueUri configured',
      );
    }

    // Auto-open queue if not yet open
    if (!this.openQueues.has(queueUri)) {
      throw new QueueError(`Queue ${queueUri} is not open. Call openQueue() first.`, queueUri);
    }

    return this.session.post({
      queueUri,
      payload: options.payload,
      properties: options.properties,
      propertyTypeOverrides: options.propertyTypeOverrides,
      onAck: options.onAck,
      compressionAlgorithm: options.compression ?? this.options.defaultCompression,
    });
  }

  /**
   * Publish a message and wait for the broker ACK.
   *
   * @returns The ACK result
   * @throws BlazingMQError if the ACK indicates failure
   */
  async publishAndWait(
    options: Omit<PublishOptions, 'onAck'>,
    timeout?: number,
  ): Promise<Ack> {
    if (!this.started) {
      throw new BlazingMQError('Producer is not started');
    }

    const queueUri = options.queueUri ?? this.options.defaultQueueUri;
    if (!queueUri) {
      throw new BlazingMQError(
        'No queue URI specified and no defaultQueueUri configured',
      );
    }

    if (!this.openQueues.has(queueUri)) {
      throw new QueueError(`Queue ${queueUri} is not open. Call openQueue() first.`, queueUri);
    }

    return this.session.postAndWaitForAck(
      {
        queueUri,
        payload: options.payload,
        properties: options.properties,
        propertyTypeOverrides: options.propertyTypeOverrides,
        compressionAlgorithm: options.compression ?? this.options.defaultCompression,
      },
      timeout,
    );
  }

  /**
   * Publish multiple messages in a batch.
   *
   * @returns Array of correlation IDs
   */
  publishBatch(
    messages: PublishOptions[],
  ): number[] {
    return messages.map((msg) => this.publish(msg));
  }

  /**
   * Get the underlying session (for advanced use).
   */
  getSession(): Session {
    return this.session;
  }
}
