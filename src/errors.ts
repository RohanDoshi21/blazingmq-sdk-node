// ============================================================================
// BlazingMQ Node.js SDK — Error Types
// ============================================================================

/**
 * Base error class for all BlazingMQ SDK errors.
 */
export class BlazingMQError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlazingMQError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a broker operation times out.
 */
export class BrokerTimeoutError extends BlazingMQError {
  public readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'BrokerTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a connection-related error occurs.
 */
export class ConnectionError extends BlazingMQError {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/**
 * Thrown when the broker refuses an operation.
 */
export class BrokerRefusedError extends BlazingMQError {
  public readonly category: string;
  public readonly code: number;

  constructor(message: string, category: string, code: number) {
    super(message);
    this.name = 'BrokerRefusedError';
    this.category = category;
    this.code = code;
  }
}

/**
 * Thrown when an invalid argument is provided.
 */
export class InvalidArgumentError extends BlazingMQError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

/**
 * Thrown when a queue operation fails.
 */
export class QueueError extends BlazingMQError {
  public readonly queueUri: string;

  constructor(message: string, queueUri: string) {
    super(message);
    this.name = 'QueueError';
    this.queueUri = queueUri;
  }
}
