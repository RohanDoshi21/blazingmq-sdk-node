// ============================================================================
// BlazingMQ Node.js SDK — Unit Tests for Protocol Codec
// ============================================================================

import {
  calculatePadding,
  createPaddingBuffer,
  removePadding,
  encodeEventHeader,
  decodeEventHeader,
  buildControlEvent,
  parseControlPayload,
  buildHeartbeatResponse,
  buildConfirmEvent,
  buildPutEvent,
  encodeMessageProperties,
  decodeMessageProperties,
  crc32c,
  guidToHex,
  hexToGuid,
} from '../src/protocol/codec';
import {
  EventType,
  EVENT_HEADER_SIZE,
  PROTOCOL_VERSION,
  PropertyType,
  CompressionAlgorithmType,
} from '../src/protocol/constants';

// ============================================================================
// Padding
// ============================================================================

describe('Padding utilities', () => {
  test('calculatePadding aligns to 4 bytes', () => {
    expect(calculatePadding(0)).toBe(4);
    expect(calculatePadding(1)).toBe(3);
    expect(calculatePadding(2)).toBe(2);
    expect(calculatePadding(3)).toBe(1);
    expect(calculatePadding(4)).toBe(4);
    expect(calculatePadding(5)).toBe(3);
    expect(calculatePadding(7)).toBe(1);
    expect(calculatePadding(8)).toBe(4);
  });

  test('createPaddingBuffer fills with padding count', () => {
    const pad3 = createPaddingBuffer(1); // needs 3 bytes
    expect(pad3.length).toBe(3);
    expect(pad3[0]).toBe(3);
    expect(pad3[1]).toBe(3);
    expect(pad3[2]).toBe(3);

    const pad4 = createPaddingBuffer(0); // aligned → 4 bytes of 0x04
    expect(pad4.length).toBe(4);
    expect(pad4[0]).toBe(4);
  });

  test('removePadding strips padding correctly', () => {
    const data = Buffer.from([0x41, 0x42, 0x43, 0x01]); // "ABC" + 1 byte padding
    expect(removePadding(data).toString()).toBe('ABC');

    const data2 = Buffer.from([0x41, 0x42, 0x02, 0x02]); // "AB" + 2 bytes padding
    expect(removePadding(data2).toString()).toBe('AB');
  });
});

// ============================================================================
// EventHeader
// ============================================================================

describe('EventHeader', () => {
  test('encode and decode roundtrip', () => {
    const header = encodeEventHeader(EventType.CONTROL, 100, 0x20);
    expect(header.length).toBe(EVENT_HEADER_SIZE);

    const decoded = decodeEventHeader(header);
    expect(decoded.length).toBe(100);
    expect(decoded.type).toBe(EventType.CONTROL);
    expect(decoded.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(decoded.headerWords).toBe(2);
    expect(decoded.typeSpecific).toBe(0x20);
  });

  test('decode various event types', () => {
    for (const type of [EventType.PUT, EventType.PUSH, EventType.ACK, EventType.CONFIRM]) {
      const header = encodeEventHeader(type, 64);
      const decoded = decodeEventHeader(header);
      expect(decoded.type).toBe(type);
      expect(decoded.length).toBe(64);
    }
  });

  test('length field uses 31 bits (no fragment bit)', () => {
    const header = encodeEventHeader(EventType.PUT, 0x7fffffff);
    const decoded = decodeEventHeader(header);
    expect(decoded.length).toBe(0x7fffffff);
  });
});

// ============================================================================
// Control Events
// ============================================================================

describe('Control events', () => {
  test('build and parse roundtrip', () => {
    const payload = {
      clientIdentity: {
        protocolVersion: 1,
        sdkVersion: 10000,
        clientType: 'E_TCPCLIENT',
        processName: 'test',
        pid: 1234,
      },
    };

    const event = buildControlEvent(payload);
    expect(event.length % 4).toBe(0); // 4-byte aligned

    // Verify event header
    const header = decodeEventHeader(event);
    expect(header.type).toBe(EventType.CONTROL);
    expect(header.length).toBe(event.length);

    // Parse back
    const parsed = parseControlPayload(event);
    expect(parsed.clientIdentity.protocolVersion).toBe(1);
    expect(parsed.clientIdentity.sdkVersion).toBe(10000);
    expect(parsed.clientIdentity.pid).toBe(1234);
  });

  test('JSON escapes forward slashes', () => {
    const payload = { uri: 'bmq://domain/queue' };
    const event = buildControlEvent(payload);
    const headerWords = event[5];
    const jsonBuf = event.subarray(headerWords * 4);
    const unpadded = removePadding(jsonBuf);
    const jsonStr = unpadded.toString('utf8');
    expect(jsonStr).toContain('\\/');
    expect(jsonStr).not.toMatch(/[^\\]\//);
  });
});

// ============================================================================
// Heartbeat
// ============================================================================

describe('Heartbeat', () => {
  test('heartbeat response is 8-byte header-only event', () => {
    const response = buildHeartbeatResponse();
    expect(response.length).toBe(EVENT_HEADER_SIZE);

    const header = decodeEventHeader(response);
    expect(header.type).toBe(EventType.HEARTBEAT_RSP);
    expect(header.length).toBe(EVENT_HEADER_SIZE);
  });
});

// ============================================================================
// CONFIRM Event
// ============================================================================

describe('CONFIRM event', () => {
  test('builds correct structure for single message', () => {
    const guid = Buffer.alloc(16, 0xab);
    const event = buildConfirmEvent([{ queueId: 42, guid, subQueueId: 0 }]);

    const header = decodeEventHeader(event);
    expect(header.type).toBe(EventType.CONFIRM);
    expect(header.length).toBe(8 + 4 + 24); // EventHeader + ConfirmHeader + ConfirmMessage

    // ConfirmHeader
    const chOffset = 8;
    const ch0 = event[chOffset];
    expect((ch0 >>> 4) & 0xf).toBe(1); // headerWords
    expect(ch0 & 0xf).toBe(6); // perMessageWords

    // ConfirmMessage
    const cmOffset = chOffset + 4;
    expect(event.readInt32BE(cmOffset)).toBe(42); // queueId
    expect(event.subarray(cmOffset + 4, cmOffset + 20)).toEqual(guid); // GUID
    expect(event.readInt32BE(cmOffset + 20)).toBe(0); // subQueueId
  });

  test('builds multiple confirm messages', () => {
    const guid1 = Buffer.alloc(16, 0x01);
    const guid2 = Buffer.alloc(16, 0x02);
    const event = buildConfirmEvent([
      { queueId: 1, guid: guid1 },
      { queueId: 2, guid: guid2 },
    ]);

    const header = decodeEventHeader(event);
    expect(header.length).toBe(8 + 4 + 24 * 2);
  });
});

// ============================================================================
// Message Properties
// ============================================================================

describe('Message Properties', () => {
  test('encode and decode roundtrip for various types', () => {
    const props = new Map<string, { type: PropertyType; value: any }>();
    props.set('strProp', { type: PropertyType.STRING, value: 'hello' });
    props.set('intProp', { type: PropertyType.INT32, value: 42 });
    props.set('boolProp', { type: PropertyType.BOOL, value: true });

    const encoded = encodeMessageProperties(props);
    expect(encoded.length % 4).toBe(0); // 4-byte aligned

    const { props: decoded, dataOffset } = decodeMessageProperties(encoded);
    expect(dataOffset).toBe(encoded.length);
    expect(decoded.size).toBe(3);
    expect(decoded.get('strProp')?.value).toBe('hello');
    expect(decoded.get('intProp')?.value).toBe(42);
    expect(decoded.get('boolProp')?.value).toBe(true);
  });

  test('encode empty properties returns empty buffer', () => {
    const props = new Map();
    const encoded = encodeMessageProperties(props);
    expect(encoded.length).toBe(0);
  });
});

// ============================================================================
// CRC32-C
// ============================================================================

describe('CRC32-C', () => {
  test('computes correct checksum for known data', () => {
    // Known CRC32-C for empty buffer
    const empty = crc32c(Buffer.alloc(0));
    expect(empty).toBe(0x00000000);

    // Known CRC32-C for "123456789"
    const test = crc32c(Buffer.from('123456789'));
    expect(test).toBe(0xe3069283);
  });
});

// ============================================================================
// GUID Utilities
// ============================================================================

describe('GUID utilities', () => {
  test('guidToHex and hexToGuid roundtrip', () => {
    const guid = Buffer.from('0123456789ABCDEF0123456789ABCDEF', 'hex');
    const hex = guidToHex(guid);
    expect(hex).toBe('0123456789ABCDEF0123456789ABCDEF');

    const back = hexToGuid(hex);
    expect(back).toEqual(guid);
  });
});
