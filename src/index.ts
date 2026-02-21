// ============================================================================
// BlazingMQ Node.js SDK — Public API
//
// This is the main entry point for the SDK. All public types, classes, and
// functions are exported from here.
// ============================================================================

// Core Session
export { Session } from './session';

// High-level APIs
import { Producer, ProducerOptions, PublishOptions } from './producer';
import { Consumer, ConsumerOptions, SubscribeOptions } from './consumer';
import { Admin, AdminOptions, QueueInfo } from './admin';
export { Producer, ProducerOptions, PublishOptions };
export { Consumer, ConsumerOptions, SubscribeOptions };
export { Admin, AdminOptions, QueueInfo };

// Types
export {
  SessionOptions,
  TimeoutOptions,
  QueueOptions,
  DEFAULT_QUEUE_OPTIONS,
  Message,
  MessageHandle,
  Ack,
  AckCallback,
  MessageCallback,
  SessionEventCallback,
  SessionEvent,
  SessionEventType,
  OpenQueueParams,
  PostOptions,
  PropertyEntry,
  PropertyValueMap,
  PropertyTypeMap,
} from './types';

// Protocol constants & enums
export {
  EventType,
  QueueFlags,
  CompressionAlgorithmType,
  PropertyType,
  AckResult,
  AckStatus,
  StatusCategory,
  DEFAULT_BROKER_URI,
  SDK_VERSION_STRING,
} from './protocol/constants';

// Errors
export {
  BlazingMQError,
  BrokerTimeoutError,
  ConnectionError,
  BrokerRefusedError,
  InvalidArgumentError,
  QueueError,
} from './errors';

// Utility
export { guidToHex, hexToGuid } from './protocol/codec';

/**
 * Convenience function to create a producer with minimal configuration.
 */
export function createProducer(
  broker: string = 'tcp://localhost:30114',
  defaultQueueUri?: string,
) {
  return new Producer({ broker, defaultQueueUri });
}

/**
 * Convenience function to create a consumer with minimal configuration.
 */
export function createConsumer(
  broker: string = 'tcp://localhost:30114',
  onMessage?: (message: any, handle: any) => void,
) {
  return new Consumer({ broker, onMessage });
}

/**
 * Convenience function to create an admin client with minimal configuration.
 */
export function createAdmin(
  broker: string = 'tcp://localhost:30114',
) {
  return new Admin({ broker });
}
