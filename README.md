# blazingmq-node

> **Disclaimer:** This is an **unofficial, community-maintained** SDK. It is not affiliated with, endorsed by, or supported by Bloomberg LP.

A pure-JavaScript Node.js SDK for [BlazingMQ](https://github.com/bloomberg/blazingmq) —
Bloomberg's high-performance, open-source message queue system.

This SDK implements the BlazingMQ binary wire protocol natively over TCP. No C++ bindings,
no native modules, no `node-gyp` — just TypeScript that speaks the protocol directly.

```
npm install blazingmq-node
```

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
  - [Architecture](#architecture)
  - [Wire Protocol](#wire-protocol)
  - [Transport Layer](#transport-layer)
  - [Session Layer](#session-layer)
  - [Message Flow](#message-flow)
- [API Reference](#api-reference)
  - [Producer](#producer)
  - [Consumer](#consumer)
  - [Admin](#admin)
  - [Session (Low-Level)](#session-low-level)
- [Configuration](#configuration)
- [Error Handling](#error-handling)
- [Examples](#examples)
- [Running Tests](#running-tests)
- [Running the Broker](#running-the-broker)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

### Producing Messages

```typescript
import { Producer, AckResult } from 'blazingmq-node';

const producer = new Producer({ broker: 'tcp://localhost:30114' });
await producer.start();
await producer.openQueue('bmq://bmq.test.mem.priority/my-queue');

const ack = await producer.publishAndWait({
  queueUri: 'bmq://bmq.test.mem.priority/my-queue',
  payload: 'Hello, World!',
  properties: {
    eventType: 'greeting',
    priority: 1,
    isVip: true,
  },
});
console.log('ACK:', AckResult[ack.status]); // "SUCCESS"

await producer.stop();
```

### Consuming Messages

```typescript
import { Consumer, PropertyType } from 'blazingmq-node';

const consumer = new Consumer({
  broker: 'tcp://localhost:30114',
  onMessage: (msg, handle) => {
    console.log('Received:', msg.data.toString());

    for (const [key, entry] of msg.properties) {
      console.log(`  ${key}: ${entry.value} (${PropertyType[entry.type]})`);
    }

    handle.confirm(); // Acknowledge the message
  },
});

await consumer.start();
await consumer.subscribe({
  queueUri: 'bmq://bmq.test.mem.priority/my-queue',
  options: { maxUnconfirmedMessages: 1024, consumerPriority: 1 },
});
```

### Async Iterator Pattern

```typescript
import { Consumer } from 'blazingmq-node';

const consumer = new Consumer({ broker: 'tcp://localhost:30114' });
await consumer.start();
await consumer.subscribe({ queueUri: 'bmq://bmq.test.mem.priority/my-queue' });

for await (const { message, handle } of consumer) {
  console.log(message.data.toString());
  handle.confirm();
}
```

---

## How It Works

### Architecture

The SDK is built in four layers, each with a clear responsibility:

```
┌─────────────────────────────────────────────────────┐
│  Layer 4: High-Level APIs                           │
│  Producer · Consumer · Admin                        │
├─────────────────────────────────────────────────────┤
│  Layer 3: Session                                   │
│  (Negotiation, queue lifecycle, ACK correlation,    │
│   publish/subscribe, heartbeat)                     │
├─────────────────────────────────────────────────────┤
│  Layer 2: Protocol Codec                            │
│  (Binary encoding/decoding for all event types)     │
├─────────────────────────────────────────────────────┤
│  Layer 1: Transport                                 │
│  (TCP socket, event framing, stream reassembly)     │
└─────────────────────────────────────────────────────┘
                        │
                   TCP Socket
                        │
              ┌─────────┴─────────┐
              │  BlazingMQ Broker  │
              └───────────────────┘
```

**Layer 1 (Transport)** manages the raw TCP connection. It accumulates incoming
bytes and reassembles them into complete BlazingMQ events using the 8-byte
EventHeader framing protocol.

**Layer 2 (Protocol Codec)** is a stateless library of pure functions that
encode/decode every binary message type: EventHeaders, PUT/PUSH/ACK/CONFIRM
messages, control events (JSON), message properties, CRC32-C checksums, and
4-byte-aligned padding.

**Layer 3 (Session)** is the protocol state machine. It handles the negotiation
handshake, manages queue lifecycle (open/configure/close), publishes messages
with correlation IDs for ACK matching, dispatches incoming PUSH messages to
callbacks, and responds to heartbeats.

**Layer 4 (High-Level APIs)** wraps the Session into ergonomic, task-oriented
interfaces: Producer (publish), Consumer (subscribe with callbacks or async
iterators), and Admin (queue management).

### Wire Protocol

BlazingMQ uses a custom binary protocol over TCP. Every transmission is an
**event** — a discrete message with an 8-byte header:

```
Byte:  0       1       2       3       4       5       6       7
     ┌───────────────────────────┬───────┬───────┬───────┬───────┐
     │ Fragment(1) │ Length(31)  │PV│Type│ HdrW  │ TySpc │ Rsvd  │
     └───────────────────────────┴───────┴───────┴───────┴───────┘
```

The **Length** field (31 bits, big-endian) tells the transport layer how many
bytes to accumulate before it has a complete event. The **Type** field (6 bits)
determines how the payload is encoded:

| Type | Name          | Direction       | Encoding | Purpose                          |
|------|---------------|-----------------|----------|----------------------------------|
| 1    | CONTROL       | Bidirectional   | JSON     | Negotiation, queue ops, disconnect |
| 2    | PUT           | Client→Broker   | Binary   | Publish a message                |
| 3    | CONFIRM       | Client→Broker   | Binary   | Confirm a received message       |
| 4    | PUSH          | Broker→Client   | Binary   | Deliver a message to consumer    |
| 5    | ACK           | Broker→Client   | Binary   | Confirm a published message      |
| 11   | HEARTBEAT_REQ | Broker→Client   | None     | Liveness check (header only)     |
| 12   | HEARTBEAT_RSP | Client→Broker   | None     | Liveness response (header only)  |

**Control events** carry JSON payloads (UTF-8, forward-slashes escaped, padded
to 4-byte boundaries). The first exchange is always a negotiation: the client
sends `clientIdentity`, the broker responds with `brokerResponse`.

**Binary events** (PUT, PUSH, ACK, CONFIRM) use fixed-size headers with
bit-packed fields. For example, a PUT message has a 36-byte header containing
flags, queue ID, 24-bit correlation ID, CRC32-C checksum, and compression type.

All data is **big-endian** and **4-byte aligned** using a fill-with-count
padding scheme: padding bytes contain their own count (e.g., 3 bytes of
`0x03` for 3-byte padding).

📖 For the complete wire format specification, see [docs/protocol.md](./docs/protocol.md).

### Transport Layer

The transport layer solves **TCP stream reassembly**. TCP delivers a continuous
byte stream, but BlazingMQ communicates in discrete events. The `BmqConnection`
class:

1. Accumulates incoming TCP data into a buffer.
2. Reads the 4-byte length from the EventHeader.
3. Waits until the full event has arrived.
4. Extracts the event and emits it via Node.js `EventEmitter`.
5. Loops to handle any remaining data.

This is a classic length-prefixed framing state machine. The connection also
supports automatic reconnection with exponential backoff.

📖 See [docs/transport.md](./docs/transport.md) for details.

### Session Layer

The Session is the protocol state machine:

- **Negotiation** — Exchanges `clientIdentity` / `brokerResponse` on connect.
- **Queue lifecycle** — open (register + configure subscription), close
  (deconfigure + deregister), using JSON control messages with `rId` correlation.
- **Publishing** — Encodes PUT events with 24-bit correlation IDs. When the
  broker ACKs, the ID is matched to the original publish callback.
- **Consuming** — Parses PUSH events, looks up the queue URI, and invokes the
  registered message callback.
- **Heartbeat** — Immediately responds to HEARTBEAT_REQ with HEARTBEAT_RSP.

📖 See [docs/session.md](./docs/session.md) for the full specification.

### Message Flow

**Publishing (Client → Broker → ACK):**

```
publishAndWait("Hello")
  → encode PUT event (36-byte header + payload + CRC32-C + padding)
  → TCP write
  → broker stores message, sends ACK event
  → parse ACK, match correlationId
  → resolve promise with Ack { status: SUCCESS }
```

**Consuming (Broker → Client → CONFIRM):**

```
broker has message for subscribed queue
  → TCP delivers PUSH event
  → parse PushHeader, extract GUID + payload + properties
  → invoke onMessage callback
  → user calls handle.confirm()
  → encode CONFIRM event (queueId + GUID)
  → TCP write → broker marks message confirmed
```

---

## API Reference

### Producer

```typescript
const producer = new Producer(options?: ProducerOptions);
```

| Method | Returns | Description |
|--------|---------|-------------|
| `start()` | `Promise<void>` | Connect to broker |
| `stop()` | `Promise<void>` | Close all queues and disconnect |
| `openQueue(uri, options?)` | `Promise<void>` | Open a queue for writing |
| `closeQueue(uri)` | `Promise<void>` | Close a queue |
| `publish(options)` | `number` | Fire-and-forget publish (returns correlationId) |
| `publishAndWait(options, timeout?)` | `Promise<Ack>` | Publish and wait for broker ACK |
| `publishBatch(messages)` | `number[]` | Publish multiple messages |

**PublishOptions:**

```typescript
{
  queueUri?: string;         // Queue URI (or use ProducerOptions.defaultQueueUri)
  payload: string | Buffer;  // Message payload
  properties?: Record<string, boolean | number | bigint | string | Buffer>;
  propertyTypeOverrides?: Record<string, PropertyType>;
  compression?: CompressionAlgorithmType;
  onAck?: (ack: Ack) => void;  // Per-message ACK callback
}
```

### Consumer

```typescript
const consumer = new Consumer(options?: ConsumerOptions);
```

| Method | Returns | Description |
|--------|---------|-------------|
| `start()` | `Promise<void>` | Connect to broker |
| `stop()` | `Promise<void>` | Drain, close all queues, disconnect |
| `subscribe(options)` | `Promise<void>` | Subscribe to a queue |
| `unsubscribe(uri)` | `Promise<void>` | Unsubscribe (drain + close) |
| `reconfigure(uri, options)` | `Promise<void>` | Change queue options |
| `confirm(message)` | `void` | Confirm a message |
| `isSubscribed(uri)` | `boolean` | Check subscription status |
| `[Symbol.asyncIterator]()` | `AsyncIterator` | Async iteration over messages |

**ConsumerOptions:**

```typescript
{
  broker?: string;
  onMessage?: (message: Message, handle: MessageHandle) => void;
  autoConfirm?: boolean;           // Auto-confirm after callback (default: false)
  maxIteratorBufferSize?: number;   // Async iterator buffer limit (default: 10000)
}
```

### Admin

```typescript
const admin = new Admin(options?: AdminOptions);
```

| Method | Returns | Description |
|--------|---------|-------------|
| `start()` | `Promise<void>` | Connect to broker |
| `stop()` | `Promise<void>` | Close all managed queues, disconnect |
| `createQueue(uri, options?)` | `Promise<void>` | Open queue with read+write |
| `deleteQueue(uri)` | `Promise<void>` | Close a managed queue |
| `configureQueue(uri, options)` | `Promise<void>` | Reconfigure queue |
| `drainQueue(uri)` | `Promise<void>` | Pause consumption |
| `restoreQueue(uri, options?)` | `Promise<void>` | Resume after drain |
| `getQueueInfo()` | `QueueInfo[]` | Get all managed queue info |
| `pingBroker()` | `boolean` | Check connection health |

### Session (Low-Level)

The `Session` class provides direct protocol access:

```typescript
import { Session } from 'blazingmq-node';

const session = new Session({ broker: 'tcp://localhost:30114' });
session.setMessageCallback((msg, handle) => handle.confirm());
await session.start();

await session.openQueue({ queueUri: '...', read: true, write: true });
const ack = await session.postAndWaitForAck({ queueUri: '...', payload: 'Hello' });
await session.closeQueue('...');
await session.stop();
```

---

## Configuration

### Session Options

```typescript
{
  broker?: string;           // "tcp://host:port" (default: "tcp://localhost:30114")
  reconnect?: boolean;       // Auto-reconnect on disconnect (default: false)
  messageCompressionAlgorithm?: CompressionAlgorithmType; // Default: NONE
  timeouts?: {
    connectTimeout?: number;         // ms (default: 5000)
    disconnectTimeout?: number;      // ms (default: 5000)
    openQueueTimeout?: number;       // ms (default: 30000)
    configureQueueTimeout?: number;  // ms (default: 30000)
    closeQueueTimeout?: number;      // ms (default: 30000)
  }
}
```

### Queue Options

```typescript
{
  maxUnconfirmedMessages?: number;   // default: 1024
  maxUnconfirmedBytes?: number;      // default: 33554432 (32MB)
  consumerPriority?: number;         // default: 0 (higher = preferred)
  suspendsOnBadHostHealth?: boolean; // default: false
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BMQ_BROKER_URI` | Broker URI | `tcp://localhost:30114` |

### Queue URIs

```
bmq://<domain>/<queue-name>
```

Domains determine storage and routing behavior:
- `bmq.test.mem.priority` — In-memory, priority-based (for testing)
- `bmq.test.persistent.priority` — Persistent, priority-based

---

## Error Handling

The SDK provides a typed error hierarchy:

```
BlazingMQError              — Base class for all SDK errors
├── BrokerTimeoutError      — Operation timed out waiting for broker
├── ConnectionError         — TCP connection or negotiation failure
├── BrokerRefusedError      — Broker explicitly refused an operation
├── InvalidArgumentError    — Invalid parameters passed to SDK
└── QueueError              — Queue-specific operation failure
```

All async methods reject with typed errors. Session events provide
non-fatal error notifications.

---

## Examples

```bash
# Build first
npm run build

# End-to-end demo (producer + consumer in one script)
node examples/run-e2e.js

# Standalone producer
node examples/producer.js

# Standalone consumer (runs until Ctrl+C)
node examples/consumer.js
```

---

## Running Tests

```bash
# Unit tests (no broker required)
npm run test:unit

# Integration tests (requires broker on localhost:30114)
npm run test:integration

# All tests
npm test

# With coverage report
npm run test:coverage
```

---

## Running the Broker

```bash
# From the blazingmq repository root:
docker compose -f docker/single-node/docker-compose.yaml up -d
```

Ensure port 30114 is exposed:
```yaml
services:
  bmqbrkr:
    ports:
      - "30114:30114"
```

---

## Project Structure

```
src/
├── protocol/
│   ├── constants.ts     # Enums, sizes, magic numbers
│   ├── codec.ts         # Binary encoder/decoder (stateless pure functions)
│   └── index.ts
├── transport/
│   ├── connection.ts    # TCP connection + event framing state machine
│   └── index.ts
├── session.ts           # Core protocol state machine
├── producer.ts          # High-level Producer API
├── consumer.ts          # High-level Consumer API
├── admin.ts             # High-level Admin API
├── errors.ts            # Error class hierarchy
├── types.ts             # TypeScript interfaces
└── index.ts             # Public API barrel export

docs/
├── architecture.md      # Layered architecture overview
├── protocol.md          # Wire protocol specification
├── transport.md         # Transport layer documentation
└── session.md           # Session layer documentation
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE)
