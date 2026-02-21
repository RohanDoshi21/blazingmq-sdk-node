// ============================================================================
// BlazingMQ Node.js SDK — Consumer (Subscribe) API
//
// High-level API for consuming messages from BlazingMQ queues.
// Wraps Session with a focused, ergonomic consumer interface.
//
// Supports:
//   - Single and multi-queue consumption
//   - Automatic and manual message confirmation
//   - Graceful shutdown with drain pattern
//   - Async iterator interface
// ============================================================================

import { EventEmitter } from 'events';
import { Session } from './session';
import {
  SessionOptions,
  QueueOptions,
  DEFAULT_QUEUE_OPTIONS,
  Message,
  MessageHandle,
  SessionEventCallback,
  SessionEvent,
  SessionEventType,
  MessageCallback,
} from './types';
import { BlazingMQError, QueueError } from './errors';

export interface ConsumerOptions extends SessionOptions {
  /** Session event callback */
  onSessionEvent?: SessionEventCallback;

  /** Message callback — called for every received message */
  onMessage?: MessageCallback;

  /** Whether to auto-confirm messages after the callback returns. Default: false */
  autoConfirm?: boolean;
}

export interface SubscribeOptions {
  /** Queue URI to subscribe to */
  queueUri: string;

  /** Queue options for this subscription */
  options?: QueueOptions;

  /** Per-subscription message callback (overrides the consumer-level callback) */
  onMessage?: MessageCallback;
}

/**
 * High-level consumer for subscribing to BlazingMQ queues.
 *
 * @example
 * ```typescript
 * const consumer = new Consumer({
 *   broker: 'tcp://localhost:30114',
 *   onMessage: (msg, handle) => {
 *     console.log('Received:', msg.data.toString());
 *     handle.confirm();
 *   },
 * });
 *
 * await consumer.start();
 * await consumer.subscribe({ queueUri: 'bmq://bmq.test.mem.priority/my-queue' });
 *
 * // When done:
 * await consumer.stop();
 * ```
 *
 * @example Using async iterator
 * ```typescript
 * const consumer = new Consumer({ broker: 'tcp://localhost:30114' });
 * await consumer.start();
 * await consumer.subscribe({ queueUri: 'bmq://bmq.test.mem.priority/my-queue' });
 *
 * for await (const { message, handle } of consumer) {
 *   console.log('Received:', message.data.toString());
 *   handle.confirm();
 * }
 * ```
 */
export class Consumer extends EventEmitter implements AsyncIterable<{ message: Message; handle: MessageHandle }> {
  private session: Session;
  private options: ConsumerOptions;
  private subscriptions = new Map<string, SubscribeOptions>();
  private started = false;
  private draining = false;

  // For async iterator support
  private messageQueue: Array<{ message: Message; handle: MessageHandle }> = [];
  private messageResolvers: Array<(value: IteratorResult<{ message: Message; handle: MessageHandle }>) => void> = [];
  private iteratorDone = false;

  constructor(options: ConsumerOptions = {}) {
    super();
    this.options = options;
    this.session = new Session(options);

    if (options.onSessionEvent) {
      this.session.setSessionEventCallback(options.onSessionEvent);
    }

    // Set up message handling
    this.session.setMessageCallback((message, handle) => {
      this.handleMessage(message, handle);
    });
  }

  /**
   * Start the consumer — connect to the broker.
   */
  async start(): Promise<void> {
    await this.session.start();
    this.started = true;
  }

  /**
   * Stop the consumer — gracefully drain, close all queues, and disconnect.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.draining = true;

    // Drain all subscriptions — pause consumption, then close
    for (const [uri] of this.subscriptions) {
      try {
        await this.unsubscribe(uri);
      } catch {
        // Continue closing
      }
    }

    this.started = false;
    await this.session.stop();
    this.subscriptions.clear();

    // Signal end to async iterators
    this.iteratorDone = true;
    for (const resolver of this.messageResolvers) {
      resolver({ value: undefined as any, done: true });
    }
    this.messageResolvers = [];
  }

  /**
   * Subscribe to a queue for message consumption.
   */
  async subscribe(options: SubscribeOptions): Promise<void> {
    if (!this.started) {
      throw new BlazingMQError('Consumer is not started');
    }

    const queueUri = options.queueUri;
    if (this.subscriptions.has(queueUri)) {
      throw new QueueError('Already subscribed to this queue', queueUri);
    }

    await this.session.openQueue({
      queueUri,
      read: true,
      options: options.options,
    });

    this.subscriptions.set(queueUri, options);
  }

  /**
   * Unsubscribe from a queue — drains pending messages, then closes.
   */
  async unsubscribe(queueUri: string): Promise<void> {
    if (!this.subscriptions.has(queueUri)) {
      throw new QueueError('Not subscribed to this queue', queueUri);
    }

    // Pause consumption — set limits to 0
    try {
      await this.session.configureQueue(queueUri, {
        maxUnconfirmedMessages: 0,
        maxUnconfirmedBytes: 0,
        consumerPriority: 0,
      });
    } catch {
      // Continue with close
    }

    await this.session.closeQueue(queueUri);
    this.subscriptions.delete(queueUri);
  }

  /**
   * Reconfigure a subscription's queue options.
   */
  async reconfigure(queueUri: string, options: QueueOptions): Promise<void> {
    if (!this.subscriptions.has(queueUri)) {
      throw new QueueError('Not subscribed to this queue', queueUri);
    }

    await this.session.configureQueue(queueUri, options);
  }

  /**
   * Confirm a message.
   */
  confirm(message: Message): void {
    this.session.confirm(message);
  }

  /**
   * Check if subscribed to a queue.
   */
  isSubscribed(queueUri: string): boolean {
    return this.subscriptions.has(queueUri);
  }

  /**
   * Get list of subscribed queue URIs.
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  // ============================================================================
  // Async Iterator Support
  // ============================================================================

  [Symbol.asyncIterator](): AsyncIterator<{ message: Message; handle: MessageHandle }> {
    return {
      next: (): Promise<IteratorResult<{ message: Message; handle: MessageHandle }>> => {
        if (this.iteratorDone) {
          return Promise.resolve({ value: undefined as any, done: true });
        }

        // If there are queued messages, return immediately
        const queued = this.messageQueue.shift();
        if (queued) {
          return Promise.resolve({ value: queued, done: false });
        }

        // Otherwise, wait for the next message
        return new Promise((resolve) => {
          this.messageResolvers.push(resolve);
        });
      },

      return: (): Promise<IteratorResult<{ message: Message; handle: MessageHandle }>> => {
        this.iteratorDone = true;
        return Promise.resolve({ value: undefined as any, done: true });
      },
    };
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private handleMessage(message: Message, handle: MessageHandle): void {
    // Check for per-subscription callback
    const subscription = this.subscriptions.get(message.queueUri);
    const perSubCallback = subscription?.onMessage;

    // Auto-wrap handle for auto-confirm
    const wrappedHandle: MessageHandle = this.options.autoConfirm
      ? {
          message,
          confirm: () => {
            handle.confirm();
          },
        }
      : handle;

    // Dispatch to per-subscription callback
    if (perSubCallback) {
      try {
        perSubCallback(message, wrappedHandle);
      } catch (err) {
        this.emit('error', err);
      }
    }

    // Dispatch to consumer-level callback
    if (this.options.onMessage) {
      try {
        this.options.onMessage(message, wrappedHandle);
      } catch (err) {
        this.emit('error', err);
      }
    }

    // Auto-confirm if enabled
    if (this.options.autoConfirm) {
      try {
        handle.confirm();
      } catch {
        // May fail if session is disconnecting
      }
    }

    // Feed async iterator
    const item = { message, handle: wrappedHandle };
    const resolver = this.messageResolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
    } else {
      this.messageQueue.push(item);
    }

    // Emit event
    this.emit('message', message, wrappedHandle);
  }

  /**
   * Get the underlying session (for advanced use).
   */
  getSession(): Session {
    return this.session;
  }
}
