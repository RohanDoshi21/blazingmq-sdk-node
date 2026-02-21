// ============================================================================
// BlazingMQ Node.js SDK — Protocol Constants & Enums
// ============================================================================

/** Event types on the BlazingMQ wire protocol */
export enum EventType {
  UNDEFINED = 0,
  CONTROL = 1,
  PUT = 2,
  CONFIRM = 3,
  PUSH = 4,
  ACK = 5,
  CLUSTER_STATE = 6,
  ELECTOR = 7,
  STORAGE = 8,
  RECOVERY = 9,
  PARTITION_SYNC = 10,
  HEARTBEAT_REQ = 11,
  HEARTBEAT_RSP = 12,
  REPLICATION_RECEIPT = 13,
  UNDEFINED_14 = 14,
  AUTHENTICATION = 15,
}

/** Queue operation flags (bitmask) */
export enum QueueFlags {
  ADMIN = 1 << 0,
  READ = 1 << 1,
  WRITE = 1 << 2,
  ACK = 1 << 3,
}

/** PUT header flags */
export enum PutHeaderFlags {
  ACK_REQUESTED = 1 << 0,
  MESSAGE_PROPERTIES = 1 << 1,
}

/** PUSH header flags */
export enum PushHeaderFlags {
  IMPLICIT_PAYLOAD = 1 << 0,
  MESSAGE_PROPERTIES = 1 << 1,
  OUT_OF_ORDER = 1 << 2,
}

/** Compression algorithm types */
export enum CompressionAlgorithmType {
  NONE = 0,
  ZLIB = 1,
}

/** ACK status codes (4-bit wire values) */
export enum AckStatus {
  SUCCESS = 0,
  LIMIT_MESSAGES = 1,
  LIMIT_BYTES = 2,
  STORAGE_FAILURE = 3,
  // 4-14 reserved
  NOT_READY = 15,
}

/** Extended ACK status for SDK use */
export enum AckResult {
  SUCCESS = 0,
  UNKNOWN = -1,
  TIMEOUT = -2,
  NOT_CONNECTED = -3,
  CANCELED = -4,
  NOT_SUPPORTED = -5,
  REFUSED = -6,
  INVALID_ARGUMENT = -7,
  NOT_READY = -8,
  LIMIT_MESSAGES = -100,
  LIMIT_BYTES = -101,
  STORAGE_FAILURE = -102,
}

/** Status category for control message responses */
export enum StatusCategory {
  SUCCESS = 'E_SUCCESS',
  UNKNOWN = 'E_UNKNOWN',
  TIMEOUT = 'E_TIMEOUT',
  NOT_CONNECTED = 'E_NOT_CONNECTED',
  CANCELED = 'E_CANCELED',
  NOT_SUPPORTED = 'E_NOT_SUPPORTED',
  REFUSED = 'E_REFUSED',
  INVALID_ARGUMENT = 'E_INVALID_ARGUMENT',
  NOT_READY = 'E_NOT_READY',
}

/** Message property types (wire encoding) */
export enum PropertyType {
  UNDEFINED = 0,
  BOOL = 1,
  CHAR = 2,
  SHORT = 3,
  INT32 = 4,
  INT64 = 5,
  STRING = 6,
  BINARY = 7,
}

/** Client type enum for negotiation */
export enum ClientType {
  E_TCPCLIENT = 'E_TCPCLIENT',
  E_TCPBROKER = 'E_TCPBROKER',
  E_UNKNOWN = 'E_UNKNOWN',
}

/** SDK language enum for negotiation */
export enum SdkLanguage {
  E_CPP = 'E_CPP',
  E_JAVA = 'E_JAVA',
  E_UNKNOWN = 'E_UNKNOWN',
}

// ============================================================================
// Protocol Constants
// ============================================================================

/** EventHeader size in bytes */
export const EVENT_HEADER_SIZE = 8;

/** PutHeader size in bytes */
export const PUT_HEADER_SIZE = 36;

/** PushHeader size in bytes (minimum) */
export const PUSH_HEADER_SIZE_MIN = 28;

/** PushHeader size with SchemaId */
export const PUSH_HEADER_SIZE = 32;

/** AckHeader size in bytes */
export const ACK_HEADER_SIZE = 4;

/** AckMessage size in bytes */
export const ACK_MESSAGE_SIZE = 24;

/** ConfirmHeader size in bytes */
export const CONFIRM_HEADER_SIZE = 4;

/** ConfirmMessage size in bytes */
export const CONFIRM_MESSAGE_SIZE = 24;

/** Protocol version */
export const PROTOCOL_VERSION = 1;

/** Default broker port */
export const DEFAULT_BROKER_PORT = 30114;

/** Default broker URI */
export const DEFAULT_BROKER_URI = 'tcp://localhost:30114';

/** GUID size in bytes */
export const GUID_SIZE = 16;

/** Maximum event size in bytes */
export const MAX_EVENT_SIZE = 67108864; // 64MB

/** JSON encoding type value for control events */
export const CONTROL_ENCODING_JSON = 1;

/** Invalid queue ID */
export const QUEUE_ID_INVALID = 0xffffffff;

/** Default app ID for queues */
export const DEFAULT_APP_ID = '__default';

/** Minimum data size for compression (1KB) */
export const COMPRESSION_MIN_SIZE = 1024;

/** Features string for negotiation */
export const SDK_FEATURES = 'PROTOCOL_ENCODING:JSON;MPS:MESSAGE_PROPERTIES_EX';

/** SDK version number */
export const SDK_VERSION = 10000; // 1.0.0 encoded as major*10000+minor*100+patch

/** SDK name for user-agent */
export const SDK_NAME = 'blazingmq-nodejs';

/** SDK version string */
export const SDK_VERSION_STRING = '1.0.0';

// ============================================================================
// Wire format mapping: ACK status 4-bit → AckResult
// ============================================================================

export const ACK_STATUS_TO_RESULT: Record<number, AckResult> = {
  [AckStatus.SUCCESS]: AckResult.SUCCESS,
  [AckStatus.LIMIT_MESSAGES]: AckResult.LIMIT_MESSAGES,
  [AckStatus.LIMIT_BYTES]: AckResult.LIMIT_BYTES,
  [AckStatus.STORAGE_FAILURE]: AckResult.STORAGE_FAILURE,
  [AckStatus.NOT_READY]: AckResult.NOT_READY,
};

export function ackStatusToResult(wireStatus: number): AckResult {
  return ACK_STATUS_TO_RESULT[wireStatus] ?? AckResult.UNKNOWN;
}
