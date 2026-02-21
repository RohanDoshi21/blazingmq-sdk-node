# BlazingMQ Node.js SDK

A production-ready, pure-JavaScript Node.js SDK for [BlazingMQ](https://github.com/bloomberg/blazingmq) — Bloomberg's high-performance, open-source message queue system.

This SDK implements the BlazingMQ wire protocol natively in Node.js (no C++ bindings required), providing a clean, idiomatic JavaScript/TypeScript API for producing and consuming messages.

## Features

- **Pure JavaScript** — No native dependencies or C++ compilation required
- **Full Protocol Support** — Implements the BlazingMQ binary wire protocol (PUT, PUSH, ACK, CONFIRM, CONTROL, HEARTBEAT)
- **Producer API** — Publish messages with optional properties, compression, and delivery confirmation (ACK)
- **Consumer API** — Subscribe to queues with automatic message handling, manual or auto-confirmation, and async iterator support
- **Admin API** — Queue management, inspection, draining, and health checks
- **Message Properties** — Full support for typed properties (string, int32, int64, bool, binary)
- **TypeScript** — Complete type definitions with strict typing
- **Compression** — Zlib compression support for large payloads
- **Heartbeat** — Automatic heartbeat response to keep connections alive

## Installation

```bash
npm install blazingmq
```

Or from source:

```bash
git clone https://github.com/RohanDoshi21/blazingmq-sdk-node
npm install
npm run build
```

## Quick Start

### Producer

```typescript
import { Producer, AckResult } from 'blazingmq';

const producer = new Producer({
  broker: 'tcp://localhost:30114',
});

await producer.start();
await producer.openQueue('bmq://bmq.test.mem.priority/my-queue');

// Publish and wait for broker acknowledgment
const ack = await producer.publishAndWait({
  queueUri: 'bmq://bmq.test.mem.priority/my-queue',
  payload: 'Hello, World!',
});
console.log('ACK:', AckResult[ack.status]); // "SUCCESS"

await producer.stop();
```

### Consumer

```typescript
import { Consumer, PropertyType } from 'blazingmq';

const consumer = new Consumer({
  broker: 'tcp://localhost:30114',
  onMessage: (msg, handle) => {
    console.log('Received:', msg.data.toString());
    console.log('Queue:', msg.queueUri);
    console.log('GUID:', msg.guidHex);

    // Access message properties
    for (const [key, entry] of msg.properties) {
      console.log(`  ${key}: ${entry.value} (${PropertyType[entry.type]})`);
    }

    // Confirm the message (required for at-least-once delivery)
    handle.confirm();
  },
});

await consumer.start();
await consumer.subscribe({
  queueUri: 'bmq://bmq.test.mem.priority/my-queue',
  options: {
    maxUnconfirmedMessages: 1024,
    consumerPriority: 1,
  },
});

// Consumer runs until stopped
// process.on('SIGINT', () => consumer.stop());
```

### Consumer with Async Iterator

```typescript
const consumer = new Consumer({ broker: 'tcp://localhost:30114' });
await consumer.start();
await consumer.subscribe({ queueUri: 'bmq://bmq.test.mem.priority/my-queue' });

for await (const { message, handle } of consumer) {
  console.log('Received:', message.data.toString());
  handle.confirm();
}
```

### Message Properties

```typescript
// Producing with properties
await producer.publishAndWait({
  queueUri: 'bmq://bmq.test.mem.priority/my-queue',
  payload: JSON.stringify({ event: 'user_signup', userId: 42 }),
  properties: {
    eventType: 'user_signup',    // → STRING
    priority: 1,                 // → INT32 (auto-inferred)
    isVip: true,                 // → BOOL
    rawData: Buffer.from([1,2]), // → BINARY
  },
  propertyTypeOverrides: {
    priority: PropertyType.INT32, // explicit type override
  },
});

// Consuming with properties
consumer.onMessage = (msg, handle) => {
  for (const [key, { type, value }] of msg.properties) {
    console.log(`${key}: ${value} (${PropertyType[type]})`);
  }
  handle.confirm();
};
```

### Admin

```typescript
import { Admin } from 'blazingmq';

const admin = new Admin({ broker: 'tcp://localhost:30114' });
await admin.start();

// Create a queue (open with read+write)
await admin.createQueue('bmq://bmq.test.mem.priority/my-queue');

// Inspect queues
const queues = admin.getQueueInfo();
console.log(queues);

// Drain a queue (pause consumption)
await admin.drainQueue('bmq://bmq.test.mem.priority/my-queue');

// Restore a drained queue
await admin.restoreQueue('bmq://bmq.test.mem.priority/my-queue');

await admin.stop();
```

## API Reference

### Session (Low-Level)

The `Session` class provides direct access to all BlazingMQ operations:

```typescript
import { Session } from 'blazingmq';

const session = new Session({
  broker: 'tcp://localhost:30114',
  timeouts: {
    connectTimeout: 5000,
    openQueueTimeout: 30000,
    closeQueueTimeout: 30000,
    configureQueueTimeout: 30000,
    disconnectTimeout: 5000,
  },
});

session.setSessionEventCallback((event) => {
  console.log(event.type, event.message);
});

session.setMessageCallback((msg, handle) => {
  handle.confirm();
});

await session.start();
await session.openQueue({ queueUri: '...', read: true, write: true });
session.post({ queueUri: '...', payload: '...' });
session.confirm(message);
await session.closeQueue('...');
await session.stop();
```

### Producer

| Method | Description |
|--------|-------------|
| `start()` | Connect to the broker |
| `stop()` | Close all queues and disconnect |
| `openQueue(uri, options?)` | Open a queue for writing |
| `closeQueue(uri)` | Close a queue |
| `publish(options)` | Fire-and-forget publish (returns correlation ID) |
| `publishAndWait(options, timeout?)` | Publish and wait for broker ACK |
| `publishBatch(messages)` | Publish multiple messages |

### Consumer

| Method | Description |
|--------|-------------|
| `start()` | Connect to the broker |
| `stop()` | Drain, close all queues, disconnect |
| `subscribe(options)` | Subscribe to a queue |
| `unsubscribe(uri)` | Unsubscribe from a queue |
| `reconfigure(uri, options)` | Change queue options |
| `confirm(message)` | Confirm a message |
| `[Symbol.asyncIterator]()` | Async iteration over messages |

### Admin

| Method | Description |
|--------|-------------|
| `start()` | Connect to the broker |
| `stop()` | Close all managed queues, disconnect |
| `createQueue(uri, options?)` | Create a queue |
| `deleteQueue(uri)` | Close a managed queue |
| `configureQueue(uri, options)` | Reconfigure a queue |
| `drainQueue(uri)` | Pause consumption (set limits to 0) |
| `restoreQueue(uri, options?)` | Restore after drain |
| `getQueueInfo()` | Get info on all managed queues |
| `pingBroker()` | Check connection health |

## Queue URIs

BlazingMQ queue URIs follow the format:
```
bmq://<domain>/<queue-name>
```

For the single-node Docker setup, use:
```
bmq://bmq.test.mem.priority/<queue-name>
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BMQ_BROKER_URI` | Broker URI | `tcp://localhost:30114` |

### Session Options

```typescript
interface SessionOptions {
  broker?: string;                              // "tcp://host:port"
  messageCompressionAlgorithm?: CompressionAlgorithmType;
  reconnect?: boolean;
  timeouts?: {
    connectTimeout?: number;     // ms (default: 5000)
    disconnectTimeout?: number;  // ms (default: 5000)
    openQueueTimeout?: number;   // ms (default: 30000)
    configureQueueTimeout?: number; // ms (default: 30000)
    closeQueueTimeout?: number;  // ms (default: 30000)
  };
}
```

### Queue Options

```typescript
interface QueueOptions {
  maxUnconfirmedMessages?: number;  // default: 1024
  maxUnconfirmedBytes?: number;     // default: 33554432 (32MB)
  consumerPriority?: number;        // default: 0
  suspendsOnBadHostHealth?: boolean; // default: false
}
```

## Error Handling

The SDK provides a hierarchy of error types:

```
BlazingMQError              — Base error
├── BrokerTimeoutError      — Operation timed out
├── ConnectionError         — Connection-level failure
├── BrokerRefusedError      — Broker rejected the operation
├── InvalidArgumentError    — Invalid parameters
└── QueueError              — Queue operation failure
```

## Architecture

This SDK implements the BlazingMQ binary wire protocol directly over TCP:

```
┌──────────────────────────────────────────┐
│ Producer / Consumer / Admin (High-Level) │
├──────────────────────────────────────────┤
│ Session (Queue ops, ACK/Confirm flow)    │
├──────────────────────────────────────────┤
│ Protocol Codec (Binary encoding/parsing) │
├──────────────────────────────────────────┤
│ TCP Connection (Framing, heartbeat)      │
└──────────────────────────────────────────┘
           │ TCP Socket │
           ▼            ▼
┌──────────────────────────────────────────┐
│         BlazingMQ Broker                 │
└──────────────────────────────────────────┘
```

**Inspired by** the [BlazingMQ Python SDK](https://github.com/bloomberg/blazingmq-sdk-python) architecture and the [BlazingMQ Java SDK](https://github.com/bloomberg/blazingmq-sdk-java) protocol implementation.

## Running Tests

```bash
# Unit tests (no broker required)
npm test -- --testPathPattern=protocol

# Integration tests (requires running broker at localhost:30114)
npm test -- --testPathPattern=integration

# All tests
npm test
```

## Running Examples

```bash
# Build the SDK first
npm run build

# Run the end-to-end demo
node examples/run-e2e.js
```

## Running BlazingMQ Broker (Docker)

```bash
# From the blazingmq repository root:
docker compose -f docker/single-node/docker-compose.yaml up -d
```

Make sure port 30114 is exposed in the docker-compose.yaml:
```yaml
services:
  bmqbrkr:
    ports:
      - "30114:30114"
```

## Requirements

- **Node.js** ≥ 18.0.0
- **BlazingMQ Broker** running and accessible via TCP

## License

Apache-2.0
