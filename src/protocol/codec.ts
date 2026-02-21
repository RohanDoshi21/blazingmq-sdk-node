// ============================================================================
// BlazingMQ Node.js SDK — Binary Protocol Codec
//
// Handles encoding/decoding of all binary wire format messages:
//   EventHeader, PutHeader, PushHeader, AckHeader, ConfirmHeader,
//   MessageProperties, and padding/alignment utilities.
// ============================================================================

import * as zlib from 'zlib';
import {
  EVENT_HEADER_SIZE,
  PUT_HEADER_SIZE,
  CONFIRM_HEADER_SIZE,
  CONFIRM_MESSAGE_SIZE,
  GUID_SIZE,
  PROTOCOL_VERSION,
  CONTROL_ENCODING_JSON,
  EventType,
  PutHeaderFlags,
  PushHeaderFlags,
  CompressionAlgorithmType,
  PropertyType,
} from './constants';

// ============================================================================
// Padding Utilities
// ============================================================================

/**
 * Calculate padding bytes needed to align to 4-byte boundary.
 * BlazingMQ uses a padding scheme where padding bytes contain the padding count.
 * If already aligned, 4 bytes of 0x04 are added.
 */
export function calculatePadding(size: number): number {
  const remainder = size % 4;
  return remainder === 0 ? 4 : 4 - remainder;
}

/**
 * Create a padding buffer filled with the padding count value.
 */
export function createPaddingBuffer(size: number): Buffer {
  const padding = calculatePadding(size);
  const buf = Buffer.alloc(padding);
  buf.fill(padding);
  return buf;
}

/**
 * Remove padding from the end of a buffer.
 * The last byte tells us how many padding bytes there are.
 */
export function removePadding(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  const paddingCount = buf[buf.length - 1];
  if (paddingCount >= 1 && paddingCount <= 4 && paddingCount <= buf.length) {
    return buf.subarray(0, buf.length - paddingCount);
  }
  return buf;
}

// ============================================================================
// EventHeader
// ============================================================================

export interface EventHeader {
  length: number;
  protocolVersion: number;
  type: EventType;
  headerWords: number;
  typeSpecific: number;
}

/**
 * Decode an 8-byte EventHeader from a buffer.
 */
export function decodeEventHeader(buf: Buffer): EventHeader {
  const word0 = buf.readUInt32BE(0);
  const length = word0 & 0x7fffffff; // mask off fragment bit
  const byte4 = buf[4];
  const protocolVersion = (byte4 >> 6) & 0x03;
  const type = byte4 & 0x3f;
  const headerWords = buf[5];
  const typeSpecific = buf[6];

  return { length, protocolVersion, type, headerWords, typeSpecific };
}

/**
 * Encode an EventHeader into an 8-byte buffer.
 */
export function encodeEventHeader(
  type: EventType,
  totalLength: number,
  typeSpecific: number = 0,
): Buffer {
  const buf = Buffer.alloc(EVENT_HEADER_SIZE);

  // Word 0: [F:1][Length:31]
  buf.writeUInt32BE(totalLength & 0x7fffffff, 0);

  // Byte 4: [PV:2][Type:6]
  buf[4] = ((PROTOCOL_VERSION & 0x03) << 6) | (type & 0x3f);

  // Byte 5: HeaderWords (8 bytes / 4 = 2)
  buf[5] = EVENT_HEADER_SIZE / 4;

  // Byte 6: TypeSpecific
  buf[6] = typeSpecific;

  // Byte 7: Reserved
  buf[7] = 0;

  return buf;
}

// ============================================================================
// Control Event (JSON-encoded payload)
// ============================================================================

/**
 * Build a CONTROL event containing a JSON payload.
 */
export function buildControlEvent(payload: object): Buffer {
  // JSON encode — escape forward slashes for C++ compatibility
  const jsonStr = JSON.stringify(payload).replace(/\//g, '\\/');
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const padding = createPaddingBuffer(jsonBuf.length);
  const totalLength = EVENT_HEADER_SIZE + jsonBuf.length + padding.length;

  // TypeSpecific: encoding type (JSON=1) in top 3 bits
  const typeSpecific = CONTROL_ENCODING_JSON << 5;

  const header = encodeEventHeader(EventType.CONTROL, totalLength, typeSpecific);
  return Buffer.concat([header, jsonBuf, padding]);
}

/**
 * Parse a CONTROL event payload into a JSON object.
 */
export function parseControlPayload(eventBuf: Buffer): any {
  const header = decodeEventHeader(eventBuf);
  const headerBytes = header.headerWords * 4;
  const payloadBuf = eventBuf.subarray(headerBytes);
  const unpadded = removePadding(payloadBuf);
  const jsonStr = unpadded.toString('utf8');
  return JSON.parse(jsonStr);
}

// ============================================================================
// Heartbeat Events (header-only, no payload)
// ============================================================================

/**
 * Build a HEARTBEAT_RSP event (8 bytes, header only).
 */
export function buildHeartbeatResponse(): Buffer {
  return encodeEventHeader(EventType.HEARTBEAT_RSP, EVENT_HEADER_SIZE);
}

// ============================================================================
// PUT Event
// ============================================================================

export interface PutMessageOptions {
  queueId: number;
  correlationId: number; // 24-bit
  payload: Buffer;
  properties?: Map<string, { type: PropertyType; value: any }>;
  compressionType?: CompressionAlgorithmType;
  ackRequested?: boolean;
}

/**
 * Build a complete PUT event containing one or more messages.
 */
export function buildPutEvent(messages: PutMessageOptions[]): Buffer {
  const parts: Buffer[] = [];
  let totalLength = EVENT_HEADER_SIZE;

  for (const msg of messages) {
    const msgBuf = buildPutMessage(msg);
    parts.push(msgBuf);
    totalLength += msgBuf.length;
  }

  const header = encodeEventHeader(EventType.PUT, totalLength);
  return Buffer.concat([header, ...parts]);
}

/**
 * Build a single PUT message (PutHeader + application data + padding).
 */
function buildPutMessage(opts: PutMessageOptions): Buffer {
  let appData = opts.payload;
  let flags = 0;
  let compressionType = opts.compressionType ?? CompressionAlgorithmType.NONE;

  if (opts.ackRequested !== false) {
    flags |= PutHeaderFlags.ACK_REQUESTED;
  }

  // Encode message properties if present
  let propertiesBuf: Buffer | null = null;
  if (opts.properties && opts.properties.size > 0) {
    flags |= PutHeaderFlags.MESSAGE_PROPERTIES;
    propertiesBuf = encodeMessageProperties(opts.properties);
    appData = Buffer.concat([propertiesBuf, appData]);
  }

  // Compress if needed and payload is large enough
  if (compressionType === CompressionAlgorithmType.ZLIB && appData.length >= 1024) {
    appData = zlib.deflateSync(appData);
  } else {
    compressionType = CompressionAlgorithmType.NONE;
  }

  // Pad application data
  const padding = createPaddingBuffer(appData.length);
  const paddedAppData = Buffer.concat([appData, padding]);

  // CRC32-C of the (padded) application data
  const crc = crc32c(paddedAppData);

  // Calculate sizes in words
  const messageWords = (PUT_HEADER_SIZE + paddedAppData.length) / 4;
  const headerWords = PUT_HEADER_SIZE / 4; // 9
  const optionsWords = 0;

  // Build PutHeader (36 bytes)
  const putHeader = Buffer.alloc(PUT_HEADER_SIZE);

  // Word 0: [Flags:4][MessageWords:28]
  putHeader.writeUInt32BE(((flags & 0xf) << 28) | (messageWords & 0x0fffffff), 0);

  // Word 1: [OptionsWords:24][CAT:3][HeaderWords:5]
  putHeader.writeUInt32BE(
    ((optionsWords & 0xffffff) << 8) |
      ((compressionType & 0x7) << 5) |
      (headerWords & 0x1f),
    4,
  );

  // Word 2: QueueId
  putHeader.writeInt32BE(opts.queueId, 8);

  // Bytes 12-27: CorrelationId (24-bit in bytes 13-15)
  putHeader[12] = 0; // marker for correlation ID (not full GUID)
  putHeader[13] = (opts.correlationId >> 16) & 0xff;
  putHeader[14] = (opts.correlationId >> 8) & 0xff;
  putHeader[15] = opts.correlationId & 0xff;
  // Bytes 16-27: zeros (rest of GUID area)

  // Word 7: CRC32-C
  putHeader.writeUInt32BE(crc, 28);

  // Word 8: SchemaId (1 = new-style properties when properties exist, else 0)
  const schemaId = propertiesBuf ? 1 : 0;
  putHeader.writeUInt16BE(schemaId, 32);
  putHeader.writeUInt16BE(0, 34); // reserved

  return Buffer.concat([putHeader, paddedAppData]);
}

// ============================================================================
// PUSH Event Parsing
// ============================================================================

export interface PushMessage {
  queueId: number;
  guid: Buffer;
  payload: Buffer;
  properties: Map<string, { type: PropertyType; value: any }>;
  compressionType: CompressionAlgorithmType;
  flags: number;
}

/**
 * Parse a PUSH event into an array of PushMessages.
 */
export function parsePushEvent(eventBuf: Buffer): PushMessage[] {
  const eventHeader = decodeEventHeader(eventBuf);
  const messages: PushMessage[] = [];
  let offset = eventHeader.headerWords * 4;

  while (offset < eventHeader.length) {
    // Read PushHeader
    const word0 = eventBuf.readUInt32BE(offset);
    const word1 = eventBuf.readUInt32BE(offset + 4);

    const flags = (word0 >>> 28) & 0xf;
    const messageWords = word0 & 0x0fffffff;
    const optionsWords = (word1 >>> 8) & 0xffffff;
    const compressionType = ((word1 >>> 5) & 0x7) as CompressionAlgorithmType;
    const headerWords = word1 & 0x1f;

    const queueId = eventBuf.readInt32BE(offset + 8);
    const guid = Buffer.alloc(GUID_SIZE);
    eventBuf.copy(guid, 0, offset + 12, offset + 12 + GUID_SIZE);

    const headerBytes = headerWords * 4;
    const optionsBytes = optionsWords * 4;
    const totalBytes = messageWords * 4;
    const appDataStart = offset + headerBytes + optionsBytes;
    const appDataEnd = offset + totalBytes;

    let appData: Buffer;
    let properties = new Map<string, { type: PropertyType; value: any }>();

    if (flags & PushHeaderFlags.IMPLICIT_PAYLOAD) {
      // No payload
      appData = Buffer.alloc(0);
    } else {
      let rawData = eventBuf.subarray(appDataStart, appDataEnd);
      rawData = removePadding(rawData);

      // Decompress if needed
      if (compressionType === CompressionAlgorithmType.ZLIB) {
        rawData = zlib.inflateSync(rawData);
      }

      // Extract properties if present
      if (flags & PushHeaderFlags.MESSAGE_PROPERTIES) {
        const { props, dataOffset } = decodeMessageProperties(rawData);
        properties = props;
        appData = rawData.subarray(dataOffset);
      } else {
        appData = rawData;
      }
    }

    messages.push({
      queueId,
      guid,
      payload: appData,
      properties,
      compressionType,
      flags,
    });

    offset += totalBytes;
  }

  return messages;
}

// ============================================================================
// ACK Event Parsing
// ============================================================================

export interface AckMessage {
  status: number; // 4-bit wire status
  correlationId: number; // 24-bit
  guid: Buffer;
  queueId: number;
}

/**
 * Parse an ACK event into an array of AckMessages.
 */
export function parseAckEvent(eventBuf: Buffer): AckMessage[] {
  const eventHeader = decodeEventHeader(eventBuf);
  const messages: AckMessage[] = [];

  // AckHeader at offset 8 (after EventHeader)
  const ackHeaderOffset = eventHeader.headerWords * 4;
  const ackHeaderByte0 = eventBuf[ackHeaderOffset];
  const ackHeaderWords = (ackHeaderByte0 >>> 4) & 0xf;
  const perMessageWords = ackHeaderByte0 & 0xf;
  const perMessageBytes = perMessageWords * 4;

  let offset = ackHeaderOffset + ackHeaderWords * 4;

  while (offset + perMessageBytes <= eventHeader.length) {
    const word0 = eventBuf.readUInt32BE(offset);
    const status = (word0 >>> 24) & 0xf;
    const correlationId = word0 & 0xffffff;
    const guid = Buffer.alloc(GUID_SIZE);
    eventBuf.copy(guid, 0, offset + 4, offset + 4 + GUID_SIZE);
    const queueId = eventBuf.readInt32BE(offset + 20);

    messages.push({ status, correlationId, guid, queueId });
    offset += perMessageBytes;
  }

  return messages;
}

// ============================================================================
// CONFIRM Event
// ============================================================================

export interface ConfirmMessageData {
  queueId: number;
  guid: Buffer;
  subQueueId?: number;
}

/**
 * Build a CONFIRM event for one or more messages.
 */
export function buildConfirmEvent(messages: ConfirmMessageData[]): Buffer {
  const headerWords = 1;
  const perMessageWords = 6; // 24 bytes

  // ConfirmHeader (4 bytes)
  const confirmHeader = Buffer.alloc(CONFIRM_HEADER_SIZE);
  confirmHeader[0] = ((headerWords & 0xf) << 4) | (perMessageWords & 0xf);
  confirmHeader[1] = 0;
  confirmHeader[2] = 0;
  confirmHeader[3] = 0;

  const messageBufs: Buffer[] = [];
  for (const msg of messages) {
    const msgBuf = Buffer.alloc(CONFIRM_MESSAGE_SIZE);
    msgBuf.writeInt32BE(msg.queueId, 0);
    msg.guid.copy(msgBuf, 4, 0, GUID_SIZE);
    msgBuf.writeInt32BE(msg.subQueueId ?? 0, 20);
    messageBufs.push(msgBuf);
  }

  const payload = Buffer.concat([confirmHeader, ...messageBufs]);
  const totalLength = EVENT_HEADER_SIZE + payload.length;
  const header = encodeEventHeader(EventType.CONFIRM, totalLength);
  return Buffer.concat([header, payload]);
}

// ============================================================================
// Message Properties Encoding/Decoding
// ============================================================================

/**
 * Encode message properties into the wire format.
 */
export function encodeMessageProperties(
  properties: Map<string, { type: PropertyType; value: any }>,
): Buffer {
  const numProps = properties.size;
  if (numProps === 0) return Buffer.alloc(0);

  const MPH_SIZE = 6; // MessagePropertiesHeader
  const PROP_HEADER_SIZE = 6; // per-property header

  // First pass: calculate sizes
  const propEntries: Array<{
    name: string;
    type: PropertyType;
    nameBytes: Buffer;
    valueBytes: Buffer;
  }> = [];

  for (const [name, { type, value }] of properties) {
    const nameBytes = Buffer.from(name, 'utf8');
    const valueBytes = encodePropertyValue(type, value);
    propEntries.push({ name, type, nameBytes, valueBytes });
  }

  // Calculate total data area (name + value for all properties)
  let dataAreaSize = 0;
  for (const entry of propEntries) {
    dataAreaSize += entry.nameBytes.length + entry.valueBytes.length;
  }

  const headersSize = MPH_SIZE + numProps * PROP_HEADER_SIZE;
  const totalUnpadded = headersSize + dataAreaSize;
  const padding = calculatePadding(totalUnpadded);
  const totalPadded = totalUnpadded + padding;
  const areaWords = totalPadded / 4;

  // Build the MessagePropertiesHeader (6 bytes)
  const headerBuf = Buffer.alloc(MPH_SIZE);
  const headerSize2x = 3; // 6 bytes / 2
  const mphSize2x = 3; // 6 bytes / 2
  headerBuf[0] = ((mphSize2x & 0x7) << 3) | (headerSize2x & 0x7);
  headerBuf[1] = (areaWords >>> 16) & 0xff; // upper
  headerBuf.writeUInt16BE(areaWords & 0xffff, 2); // lower
  headerBuf[4] = 0; // reserved
  headerBuf[5] = numProps & 0xff;

  // Build per-property headers (6 bytes each)
  const propHeaders: Buffer[] = [];
  for (const entry of propEntries) {
    const propHeader = Buffer.alloc(PROP_HEADER_SIZE);
    const propValueLen = entry.valueBytes.length;
    const propNameLen = entry.nameBytes.length;

    // Bytes 0-1: [R:1][PropType:5][PropValueLenUpper:10]
    const word0 =
      ((entry.type & 0x1f) << 10) | ((propValueLen >>> 16) & 0x3ff);
    propHeader.writeUInt16BE(word0, 0);

    // Bytes 2-3: PropValueLenLower
    propHeader.writeUInt16BE(propValueLen & 0xffff, 2);

    // Bytes 4-5: [R2:4][PropNameLen:12]
    propHeader.writeUInt16BE(propNameLen & 0xfff, 4);

    propHeaders.push(propHeader);
  }

  // Build data area (name + value pairs sequentially)
  const dataParts: Buffer[] = [];
  for (const entry of propEntries) {
    dataParts.push(entry.nameBytes);
    dataParts.push(entry.valueBytes);
  }

  const paddingBuf = Buffer.alloc(padding);
  paddingBuf.fill(padding);

  return Buffer.concat([headerBuf, ...propHeaders, ...dataParts, paddingBuf]);
}

/**
 * Decode message properties from a buffer.
 * Returns the properties map and the byte offset where app data starts.
 */
export function decodeMessageProperties(buf: Buffer): {
  props: Map<string, { type: PropertyType; value: any }>;
  dataOffset: number;
} {
  const props = new Map<string, { type: PropertyType; value: any }>();

  if (buf.length < 6) return { props, dataOffset: 0 };

  // MessagePropertiesHeader (6 bytes)
  const byte0 = buf[0];
  const headerSize2x = byte0 & 0x7;
  const mphSize2x = (byte0 >>> 3) & 0x7;
  const headerSize = headerSize2x * 2;
  const mphSize = mphSize2x * 2;

  const areaWordsUpper = buf[1];
  const areaWordsLower = buf.readUInt16BE(2);
  const areaWords = (areaWordsUpper << 16) | areaWordsLower;
  const totalBytes = areaWords * 4;

  const numProperties = buf[5];

  // Read per-property headers
  const propHeaders: Array<{
    type: PropertyType;
    valueLen: number;
    nameLen: number;
  }> = [];
  let offset = headerSize;

  for (let i = 0; i < numProperties; i++) {
    const w0 = buf.readUInt16BE(offset);
    const propType = (w0 >>> 10) & 0x1f;
    const valueLenUpper = w0 & 0x3ff;
    const valueLenLower = buf.readUInt16BE(offset + 2);
    const valueLen = (valueLenUpper << 16) | valueLenLower;
    const w2 = buf.readUInt16BE(offset + 4);
    const nameLen = w2 & 0xfff;

    propHeaders.push({ type: propType, valueLen, nameLen });
    offset += mphSize;
  }

  // Read name-value data
  for (const ph of propHeaders) {
    const name = buf.subarray(offset, offset + ph.nameLen).toString('utf8');
    offset += ph.nameLen;
    const valueBytes = buf.subarray(offset, offset + ph.valueLen);
    const value = decodePropertyValue(ph.type as PropertyType, valueBytes);
    offset += ph.valueLen;
    props.set(name, { type: ph.type as PropertyType, value });
  }

  return { props, dataOffset: totalBytes };
}

function encodePropertyValue(type: PropertyType, value: any): Buffer {
  switch (type) {
    case PropertyType.BOOL: {
      const buf = Buffer.alloc(1);
      buf[0] = value ? 1 : 0;
      return buf;
    }
    case PropertyType.CHAR: {
      const buf = Buffer.alloc(1);
      buf[0] = typeof value === 'string' ? value.charCodeAt(0) : value;
      return buf;
    }
    case PropertyType.SHORT: {
      const buf = Buffer.alloc(2);
      buf.writeInt16BE(value, 0);
      return buf;
    }
    case PropertyType.INT32: {
      const buf = Buffer.alloc(4);
      buf.writeInt32BE(value, 0);
      return buf;
    }
    case PropertyType.INT64: {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64BE(BigInt(value), 0);
      return buf;
    }
    case PropertyType.STRING:
      return Buffer.from(value, 'utf8');
    case PropertyType.BINARY:
      return Buffer.isBuffer(value) ? value : Buffer.from(value);
    default:
      return Buffer.alloc(0);
  }
}

function decodePropertyValue(type: PropertyType, buf: Buffer): any {
  switch (type) {
    case PropertyType.BOOL:
      return buf[0] !== 0;
    case PropertyType.CHAR:
      return String.fromCharCode(buf[0]);
    case PropertyType.SHORT:
      return buf.readInt16BE(0);
    case PropertyType.INT32:
      return buf.readInt32BE(0);
    case PropertyType.INT64:
      return buf.readBigInt64BE(0);
    case PropertyType.STRING:
      return buf.toString('utf8');
    case PropertyType.BINARY:
      return Buffer.from(buf);
    default:
      return buf;
  }
}

// ============================================================================
// CRC32-C Implementation (Castagnoli polynomial)
// ============================================================================

const CRC32C_TABLE = generateCrc32cTable();

function generateCrc32cTable(): Uint32Array {
  const table = new Uint32Array(256);
  const polynomial = 0x82f63b78; // Reversed Castagnoli

  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ polynomial;
      } else {
        crc = crc >>> 1;
      }
    }
    table[i] = crc;
  }
  return table;
}

export function crc32c(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32C_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ============================================================================
// GUID Utilities
// ============================================================================

/**
 * Convert a 16-byte GUID buffer to its hex string representation.
 */
export function guidToHex(guid: Buffer): string {
  return guid.toString('hex').toUpperCase();
}

/**
 * Convert a hex string GUID to a 16-byte buffer.
 */
export function hexToGuid(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}
