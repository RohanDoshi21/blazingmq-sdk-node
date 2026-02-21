// ============================================================================
// BlazingMQ Node.js SDK — Public API
//
// This is the main entry point for the SDK. All public types, classes, and
// functions are exported from here.
// ============================================================================

// Core Session
export { Session } from './session';

// High-level APIs
export { Producer } from './producer';
export type { ProducerOptions, PublishOptions } from './producer';
export { Consumer } from './consumer';
export type { ConsumerOptions, SubscribeOptions } from './consumer';
export { Admin } from './admin';
export type { AdminOptions, QueueInfo } from './admin';

// Types
export {
  DEFAULT_QUEUE_OPTIONS,
  SessionEventType,
} from './types';
export type {
  SessionOptions,
  TimeoutOptions,
  QueueOptions,
  Message,
  MessageHandle,
  Ack,
  AckCallback,
  MessageCallback,
  SessionEventCallback,
  SessionEvent,
  OpenQueueParams,
  PostOptions,
  PropertyEntry,
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
