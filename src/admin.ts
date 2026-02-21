// ============================================================================
// BlazingMQ Node.js SDK — Admin API
//
// High-level API for administering BlazingMQ queues and clusters.
// Provides queue management, inspection, and monitoring capabilities.
// ============================================================================

import { Session } from './session';
import {
  SessionOptions,
  QueueOptions,
  DEFAULT_QUEUE_OPTIONS,
  SessionEventCallback,
  SessionEvent,
  SessionEventType,
} from './types';
import { QueueFlags } from './protocol/constants';
import { BlazingMQError, QueueError } from './errors';

export interface AdminOptions extends SessionOptions {
  /** Session event callback */
  onSessionEvent?: SessionEventCallback;
}

export interface QueueInfo {
  uri: string;
  isOpen: boolean;
  flags: {
    read: boolean;
    write: boolean;
    admin: boolean;
  };
  options: Required<QueueOptions>;
}

/**
 * High-level admin client for BlazingMQ cluster management.
 *
 * Provides capabilities such as:
 *   - Creating and deleting queues (through open/close)
 *   - Inspecting queue status
 *   - Reconfiguring queue options
 *   - Purging messages (drain pattern)
 *   - Health checking the broker connection
 *
 * @example
 * ```typescript
 * const admin = new Admin({ broker: 'tcp://localhost:30114' });
 * await admin.start();
 *
 * // Create a queue by opening it
 * await admin.createQueue('bmq://bmq.test.mem.priority/my-queue');
 *
 * // Check queue health
 * const healthy = await admin.pingBroker();
 *
 * // Drain a queue (pause consumption)
 * await admin.drainQueue('bmq://bmq.test.mem.priority/my-queue');
 *
 * await admin.stop();
 * ```
 */
export class Admin {
  private session: Session;
  private options: AdminOptions;
  private managedQueues = new Map<string, { queueId: number; flags: number }>();
  private started = false;

  constructor(options: AdminOptions = {}) {
    this.options = options;
    this.session = new Session(options);

    if (options.onSessionEvent) {
      this.session.setSessionEventCallback(options.onSessionEvent);
    }

    // Admin needs a dummy message handler to open read queues
    this.session.setMessageCallback(() => {});
  }

  /**
   * Start the admin client — connect to the broker.
   */
  async start(): Promise<void> {
    await this.session.start();
    this.started = true;
  }

  /**
   * Stop the admin client — close all managed queues and disconnect.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    // Close all managed queues
    for (const [uri] of this.managedQueues) {
      try {
        await this.session.closeQueue(uri);
      } catch {
        // Continue
      }
    }

    this.started = false;
    await this.session.stop();
    this.managedQueues.clear();
  }

  /**
   * Create a queue by opening it with both read and write flags.
   * This ensures the queue exists on the broker.
   */
  async createQueue(
    queueUri: string,
    options?: QueueOptions,
  ): Promise<void> {
    this.ensureStarted();

    if (this.managedQueues.has(queueUri)) {
      return; // Already managed
    }

    const resolvedOptions = await this.session.openQueue({
      queueUri,
      read: true,
      write: true,
      options: options ?? {
        maxUnconfirmedMessages: 0,
        maxUnconfirmedBytes: 0,
        consumerPriority: 0,
      },
    });

    this.managedQueues.set(queueUri, {
      queueId: 0,
      flags: QueueFlags.READ | QueueFlags.WRITE | QueueFlags.ACK,
    });
  }

  /**
   * Delete a queue by closing it. Note: BlazingMQ queues are created on-demand
   * and persist based on domain configuration. This closes the admin's handle.
   */
  async deleteQueue(queueUri: string): Promise<void> {
    this.ensureStarted();

    if (!this.managedQueues.has(queueUri)) {
      throw new QueueError('Queue is not managed by this admin client', queueUri);
    }

    await this.session.closeQueue(queueUri);
    this.managedQueues.delete(queueUri);
  }

  /**
   * Open a queue for admin purposes (read-only, to inspect).
   */
  async openQueueForRead(
    queueUri: string,
    options?: QueueOptions,
  ): Promise<void> {
    this.ensureStarted();

    await this.session.openQueue({
      queueUri,
      read: true,
      options,
    });

    this.managedQueues.set(queueUri, {
      queueId: 0,
      flags: QueueFlags.READ,
    });
  }

  /**
   * Open a queue for writing (to test message production).
   */
  async openQueueForWrite(
    queueUri: string,
    options?: QueueOptions,
  ): Promise<void> {
    this.ensureStarted();

    await this.session.openQueue({
      queueUri,
      write: true,
      options,
    });

    this.managedQueues.set(queueUri, {
      queueId: 0,
      flags: QueueFlags.WRITE | QueueFlags.ACK,
    });
  }

  /**
   * Reconfigure a queue's options.
   */
  async configureQueue(
    queueUri: string,
    options: QueueOptions,
  ): Promise<void> {
    this.ensureStarted();

    if (!this.managedQueues.has(queueUri)) {
      throw new QueueError('Queue is not managed by this admin client', queueUri);
    }

    await this.session.configureQueue(queueUri, options);
  }

  /**
   * Drain a queue — pause message consumption by setting limits to 0.
   * This is the recommended pattern for graceful shutdown.
   */
  async drainQueue(queueUri: string): Promise<void> {
    this.ensureStarted();

    await this.session.configureQueue(queueUri, {
      maxUnconfirmedMessages: 0,
      maxUnconfirmedBytes: 0,
      consumerPriority: 0,
    });
  }

  /**
   * Restore a drained queue — set limits back to defaults.
   */
  async restoreQueue(
    queueUri: string,
    options?: QueueOptions,
  ): Promise<void> {
    this.ensureStarted();

    const opts = options ?? DEFAULT_QUEUE_OPTIONS;
    await this.session.configureQueue(queueUri, opts);
  }

  /**
   * Ping the broker — verifies the connection is alive.
   * This is done by checking the session's connection state.
   */
  pingBroker(): boolean {
    return this.started && this.session.isQueueOpen !== undefined;
  }

  /**
   * Get information about all managed queues.
   */
  getQueueInfo(): QueueInfo[] {
    const info: QueueInfo[] = [];
    for (const [uri, state] of this.managedQueues) {
      const options = this.session.getQueueOptions(uri);
      info.push({
        uri,
        isOpen: this.session.isQueueOpen(uri),
        flags: {
          read: !!(state.flags & QueueFlags.READ),
          write: !!(state.flags & QueueFlags.WRITE),
          admin: !!(state.flags & QueueFlags.ADMIN),
        },
        options: options ?? DEFAULT_QUEUE_OPTIONS,
      });
    }
    return info;
  }

  /**
   * Get information about a specific queue.
   */
  getQueueInfoByUri(queueUri: string): QueueInfo | undefined {
    const state = this.managedQueues.get(queueUri);
    if (!state) return undefined;

    const options = this.session.getQueueOptions(queueUri);
    return {
      uri: queueUri,
      isOpen: this.session.isQueueOpen(queueUri),
      flags: {
        read: !!(state.flags & QueueFlags.READ),
        write: !!(state.flags & QueueFlags.WRITE),
        admin: !!(state.flags & QueueFlags.ADMIN),
      },
      options: options ?? DEFAULT_QUEUE_OPTIONS,
    };
  }

  /**
   * Get the underlying session (for advanced use).
   */
  getSession(): Session {
    return this.session;
  }

  private ensureStarted(): void {
    if (!this.started) {
      throw new BlazingMQError('Admin client is not started');
    }
  }
}
