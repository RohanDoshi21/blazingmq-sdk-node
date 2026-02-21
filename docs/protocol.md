# BlazingMQ Wire Protocol

This document describes the binary wire protocol used by BlazingMQ, as implemented
by this Node.js SDK. It serves as both documentation and a reference for anyone
wanting to understand or extend the protocol implementation.

## Overview

BlazingMQ uses a custom binary protocol over TCP. All communication between client
and broker is structured as **events** — discrete binary messages with a common
framing header.

**Key characteristics:**
- **Big-endian** byte order throughout.
- **4-byte alignment** — all structures and payloads are padded to 4-byte boundaries.
- **Event-based** — every transmission is wrapped in an EventHeader.
- **Mixed encoding** — control messages use JSON; data messages use binary encoding.

## Event Framing

Every event on the wire starts with an **EventHeader** (8 bytes):

```
Byte:  0       1       2       3       4       5       6       7
     ┌───────────────────────────┬───────┬───────┬───────┬───────┐
     │   F(1)  │  Length (31)    │PV │ Ty│ HdrW  │ TySpc │ Rsvd  │
     └───────────────────────────┴───────┴───────┴───────┴───────┘

Word 0 (bytes 0-3):
  - Bit 31:    Fragment flag (reserved, always 0)
  - Bits 0-30: Total event length in bytes (including this header)

Byte 4:
  - Bits 6-7: Protocol version (2 bits, currently 1)
  - Bits 0-5: Event type (6 bits)

Byte 5: Header words (header size / 4, always 2 for 8-byte header)
Byte 6: Type-specific field (meaning varies by event type)
Byte 7: Reserved (0)
```

The **Length** field is the key to stream reassembly: the TCP connection layer reads
this value to know how many bytes to accumulate before emitting a complete event.

## Event Types

| Value | Name             | Direction     | Encoding | Description                                |
|-------|------------------|---------------|----------|--------------------------------------------|
| 0     | UNDEFINED        | —             | —        | Invalid/placeholder                        |
| 1     | CONTROL          | Bidirectional | JSON     | Negotiation, queue ops, disconnect         |
| 2     | PUT              | Client→Broker | Binary   | Publish a message                          |
| 3     | CONFIRM          | Client→Broker | Binary   | Confirm (acknowledge) a received message   |
| 4     | PUSH             | Broker→Client | Binary   | Deliver a message to a consumer            |
| 5     | ACK              | Broker→Client | Binary   | Acknowledge a published message            |
| 11    | HEARTBEAT_REQ    | Broker→Client | None     | Heartbeat request (header only, 8 bytes)   |
| 12    | HEARTBEAT_RSP    | Client→Broker | None     | Heartbeat response (header only, 8 bytes)  |
| 6-10  | Internal         | Broker↔Broker | —        | Cluster state, election, storage, recovery |
| 13-15 | Internal         | Broker↔Broker | —        | Replication, authentication                |

## CONTROL Events (Type 1)

Control events carry **JSON-encoded** payloads. The TypeSpecific byte in the EventHeader
indicates the encoding:

```
TypeSpecific byte 6: [EncodingType:3][Reserved:5]
  EncodingType = 1 → JSON
```

The JSON payload is:
1. Serialized as UTF-8.
2. Forward slashes (`/`) are escaped as `\/` (for C++ parser compatibility).
3. Padded to 4-byte alignment (padding bytes contain the padding count).

### Negotiation Handshake

The very first exchange after TCP connection is a negotiation:

**Client → Broker (clientIdentity):**
```json
{
  "clientIdentity": {
    "protocolVersion": 1,
    "sdkVersion": 10000,
    "clientType": "E_TCPCLIENT",
    "processName": "my-app",
    "pid": 12345,
    "sessionId": 1,
    "hostName": "my-host",
    "features": "PROTOCOL_ENCODING:JSON;MPS:MESSAGE_PROPERTIES_EX",
    "clusterName": "",
    "clusterNodeId": -1,
    "sdkLanguage": "E_JAVA",
    "guidInfo": { "clientId": "", "nanoSecondsFromEpoch": 0 },
    "userAgent": "blazingmq-nodejs/1.0.0"
  }
}
```

**Broker → Client (brokerResponse):**
```json
{
  "brokerResponse": {
    "result": { "category": "E_SUCCESS", "code": 0, "message": "" },
    "brokerVersion": 999999,
    "heartbeatIntervalMs": 3000,
    "maxMissedHeartbeats": 10,
    "isDeprecatedSdk": false
  }
}
```

The `features` string declares protocol capabilities:
- `PROTOCOL_ENCODING:JSON` — control messages use JSON encoding.
- `MPS:MESSAGE_PROPERTIES_EX` — use the extended message properties format.

### Queue Operations

All queue operations use JSON control messages with a `rId` (request ID) for
correlation. The broker echoes back the `rId` in its response.

**Open Queue (Client → Broker):**
```json
{
  "rId": 1,
  "openQueue": {
    "handleParameters": {
      "uri": "bmq://bmq.test.mem.priority/my-queue",
      "qId": 0,
      "subIdInfo": { "subId": 0, "appId": "__default" },
      "flags": 14,
      "readCount": 1,
      "writeCount": 1,
      "adminCount": 0
    }
  }
}
```

The `flags` field is a bitmask:
| Bit | Name  | Value | Meaning              |
|-----|-------|-------|----------------------|
| 0   | ADMIN | 1     | Administrative access |
| 1   | READ  | 2     | Open for consuming    |
| 2   | WRITE | 4     | Open for producing    |
| 3   | ACK   | 8     | Request ACKs          |

So `flags = 14` means READ (2) + WRITE (4) + ACK (8).

**Configure Stream (Client → Broker) — required for consumers:**
```json
{
  "rId": 2,
  "configureStream": {
    "qId": 0,
    "streamParameters": {
      "appId": "__default",
      "subscriptions": [{
        "sId": 0,
        "expression": { "version": "E_UNDEFINED", "text": "" },
        "consumers": [{
          "maxUnconfirmedMessages": 1024,
          "maxUnconfirmedBytes": 33554432,
          "consumerPriority": 1,
          "consumerPriorityCount": 1
        }]
      }]
    }
  }
}
```

**Close Queue (Client → Broker):**
```json
{
  "rId": 3,
  "closeQueue": {
    "handleParameters": {
      "uri": "bmq://bmq.test.mem.priority/my-queue",
      "qId": 0,
      "subIdInfo": { "subId": 0, "appId": "__default" },
      "flags": 14,
      "readCount": 1,
      "writeCount": 1,
      "adminCount": 0
    },
    "isFinal": true
  }
}
```

**Critical:** The close message must include the **original** readCount/writeCount
values (not zeros). Sending zeros causes the broker to reject the request with
"At least one of [read|write|admin]Count must be > 0".

**Disconnect (Client → Broker):**
```json
{
  "rId": 4,
  "disconnect": {}
}
```

## PUT Events (Type 2) — Publishing

A PUT event contains one or more messages being published. After the EventHeader:

### PutHeader (36 bytes per message)

```
Byte:  0       1       2       3
     ┌───────────────────────────┐
W0:  │Flags(4)│  MessageWords(28)│   Total message size in 4-byte words
     ├───────────────────────────┤
W1:  │ OptionsWords(24) │CAT│HW │   CAT=compression(3b), HW=headerWords(5b)
     ├───────────────────────────┤
W2:  │      QueueId (32)        │   Queue identifier from openQueue
     ├───────────────────────────┤
W3:  │ 0 │ CorrId(24) │ ...    │   Byte 12=0, Bytes 13-15=correlationId
     ├───────────────────────────┤
W4-6:│          (GUID area, 12 more bytes — zeros for PUT)           │
     ├───────────────────────────┤
W7:  │        CRC32-C (32)      │   Checksum of padded application data
     ├───────────────────────────┤
W8:  │   SchemaId(16)  │ Rsvd   │   SchemaId=1 if properties present
     └───────────────────────────┘
```

**Flags (4 bits):**
| Bit | Name               | Meaning                        |
|-----|--------------------|--------------------------------|
| 0   | ACK_REQUESTED      | Request delivery confirmation  |
| 1   | MESSAGE_PROPERTIES | Payload contains properties    |

**Compression Algorithm Type (3 bits):**
| Value | Algorithm |
|-------|-----------|
| 0     | NONE      |
| 1     | ZLIB      |

After the PutHeader comes the **application data**: message properties (if present)
followed by the message payload, padded to 4-byte alignment.

### Correlation ID

The SDK uses the bytes 13-15 of the GUID area in the PutHeader as a 24-bit
correlation ID. Byte 12 is set to 0 to distinguish this from a real GUID.
When the broker sends an ACK, it echoes back this correlation ID, allowing
the SDK to match ACKs to their original publish requests.

The correlation ID wraps around at 0xFFFFFF (16,777,215), which is sufficient
for any practical number of in-flight messages.

## PUSH Events (Type 4) — Message Delivery

PUSH events deliver messages from the broker to subscribed consumers.
The structure mirrors PUT events:

### PushHeader (28-32 bytes)

```
W0:  │Flags(4)│  MessageWords(28)│
W1:  │ OptionsWords(24) │CAT│HW │
W2:  │      QueueId (32)        │
W3-6:│      GUID (16 bytes)     │   Globally unique message identifier
W7:  │   SchemaId(16)  │ Rsvd   │   (only if headerWords >= 8)
```

**Flags (4 bits):**
| Bit | Name               | Meaning                        |
|-----|--------------------|--------------------------------|
| 0   | IMPLICIT_PAYLOAD   | No payload (metadata only)     |
| 1   | MESSAGE_PROPERTIES | Payload contains properties    |
| 2   | OUT_OF_ORDER       | Message delivered out of order  |

After the header comes the application data (properties + payload + padding),
potentially compressed.

The GUID is a 16-byte globally unique identifier assigned by the broker. It is
used to confirm messages (see CONFIRM events below).

## ACK Events (Type 5)

ACK events confirm that the broker has accepted published messages.

### AckHeader (4 bytes)

```
Byte 0: [HeaderWords:4][PerMessageWords:4]
Bytes 1-3: Reserved
```

### AckMessage (24 bytes, repeated)

```
W0:  │ Status(8) │ Rsvd(8) │ CorrelationId(16) │
     │           │         │ CorrelationId(8)   │
W1-4:│          GUID (16 bytes)                  │
W5:  │          QueueId (32)                     │
```

**Note:** The correlationId is 24 bits, stored in the lower 24 bits of Word 0.
The status is in the upper 8 bits (only lower 4 bits used).

**ACK Status Codes:**
| Value | Name            | Meaning                          |
|-------|-----------------|----------------------------------|
| 0     | SUCCESS         | Message accepted                 |
| 1     | LIMIT_MESSAGES  | Per-queue message limit exceeded |
| 2     | LIMIT_BYTES     | Per-queue byte limit exceeded    |
| 3     | STORAGE_FAILURE | Storage backend error            |
| 15    | NOT_READY       | Broker not ready                 |

## CONFIRM Events (Type 3)

CONFIRM events tell the broker that a consumer has successfully processed a message.

### ConfirmHeader (4 bytes)

```
Byte 0: [HeaderWords:4][PerMessageWords:4]
Bytes 1-3: Reserved
```

### ConfirmMessage (24 bytes, repeated)

```
W0:   │     QueueId (32)      │
W1-4: │     GUID (16 bytes)   │
W5:   │     SubQueueId (32)   │
```

The GUID must match the GUID from the PUSH event that delivered the message.

## Heartbeat Events (Types 11, 12)

Heartbeats are **header-only** events (8 bytes, no payload):

- **HEARTBEAT_REQ (11)** — Broker → Client: "Are you alive?"
- **HEARTBEAT_RSP (12)** — Client → Broker: "Yes, I am."

The broker sends HEARTBEAT_REQ at a configured interval (typically 3 seconds).
The client must respond promptly. If the broker doesn't receive a response after
`maxMissedHeartbeats` intervals, it considers the client dead and closes the connection.

## Message Properties

Message properties are typed key-value pairs prepended to the application data.
The format consists of a header, per-property headers, and name-value data.

### MessagePropertiesHeader (6 bytes)

```
Byte 0: [MphSize2x:3][HeaderSize2x:3]   (each is actual_size / 2)
Byte 1: AreaWords upper 8 bits
Bytes 2-3: AreaWords lower 16 bits      (total padded size / 4)
Byte 4: Reserved
Byte 5: Number of properties
```

### Per-Property Header (6 bytes each)

```
Bytes 0-1: [Reserved:1][PropType:5][PropValueLenUpper:10]
Bytes 2-3: PropValueLenLower (16 bits)
Bytes 4-5: [Reserved:4][PropNameLen:12]
```

**Property Types:**
| Value | Type   | Size     | Description        |
|-------|--------|----------|--------------------|
| 0     | UNDEF  | 0        | Undefined          |
| 1     | BOOL   | 1 byte   | Boolean            |
| 2     | CHAR   | 1 byte   | Character          |
| 3     | SHORT  | 2 bytes  | 16-bit integer     |
| 4     | INT32  | 4 bytes  | 32-bit integer     |
| 5     | INT64  | 8 bytes  | 64-bit integer     |
| 6     | STRING | variable | UTF-8 string       |
| 7     | BINARY | variable | Raw bytes          |

After the headers comes the data area: name bytes followed by value bytes for each
property, in order. The entire properties block is padded to 4-byte alignment.

## Padding Scheme

BlazingMQ uses a specific padding scheme for 4-byte alignment:

1. Calculate `remainder = size % 4`.
2. If `remainder == 0`, add **4** padding bytes (not 0).
3. Otherwise, add `4 - remainder` padding bytes.
4. Each padding byte contains the **padding count** as its value.

Example: A 5-byte payload needs 3 bytes of padding → `[0x03, 0x03, 0x03]`.
An 8-byte payload (already aligned) gets 4 bytes → `[0x04, 0x04, 0x04, 0x04]`.

This scheme allows the recipient to determine the padding length by reading the
last byte of the padded data.

## CRC32-C Checksum

PUT events include a CRC32-C (Castagnoli) checksum of the **padded** application data.
This provides data integrity verification. The polynomial is 0x1EDC6F41 (bit-reversed
as 0x82F63B78 for the table-based implementation).

## Queue URIs

Queue URIs follow the format:
```
bmq://<domain>/<queue-name>
```

The domain determines the queue's storage and routing behavior:
- `bmq.test.mem.priority` — In-memory, priority-based routing (for testing).
- `bmq.test.persistent.priority` — Persistent, priority-based routing.

## Wire Byte Order

All multi-byte integers are encoded in **big-endian** (network byte order).
This is consistent throughout the protocol — EventHeaders, PutHeaders, PushHeaders,
AckMessages, ConfirmMessages, and message property values.
