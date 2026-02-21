# Architecture

This document describes the internal architecture of the BlazingMQ Node.js SDK,
explaining how each layer works, why it exists, and how they compose together.

## Design Philosophy

This SDK is a **pure-JavaScript** implementation of the BlazingMQ wire protocol.
Unlike the Python SDK (which uses Cython bindings to the C++ client library), this
SDK speaks the binary protocol directly over TCP — inspired by the Java SDK's
approach. This means:

- **Zero native dependencies** — no C++ compilation, no `node-gyp`, no platform-specific binaries.
- **Full protocol control** — every byte on the wire is constructed and parsed in TypeScript.
- **Portability** — runs anywhere Node.js runs, including containers, serverless, and CI.

## Layered Architecture

The SDK is organized into four layers, each with a clear responsibility boundary:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: High-Level APIs                                   │
│  Producer · Consumer · Admin                                │
│  (Ergonomic, task-oriented interfaces)                      │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Session                                           │
│  (Queue lifecycle, publish/subscribe, ACK correlation,      │
│   negotiation, heartbeat monitoring)                        │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Protocol Codec                                    │
│  (Binary encoding/decoding for all BlazingMQ event types)   │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Transport (TCP Connection)                        │
│  (TCP socket, event framing, stream reassembly,             │
│   reconnection with exponential backoff)                    │
└─────────────────────────────────────────────────────────────┘
                          │
                    TCP Socket
                          │
                ┌─────────┴─────────┐
                │  BlazingMQ Broker  │
                └───────────────────┘
```

### Layer 1: Transport (`src/transport/connection.ts`)

**Responsibility:** Raw TCP connectivity and event framing.

The `BmqConnection` class manages a `net.Socket` and solves the fundamental
problem of TCP stream reassembly: TCP delivers a continuous byte stream, but
BlazingMQ communicates in discrete *events*. The connection layer:

1. **Accumulates** incoming TCP data into an internal `readBuffer`.
2. **Peeks** at the first 4 bytes to read the event length (from the EventHeader).
3. **Waits** until the full event has arrived.
4. **Extracts** the complete event buffer and emits it as an `('event', type, data)` event.
5. **Repeats** for any remaining data in the buffer.

This is a classic state machine for length-prefixed binary protocol framing.
See [transport.md](./transport.md) for the full specification.

**Key design decisions:**
- The connection is an `EventEmitter`, keeping it decoupled from the Session layer.
- Reconnection logic uses exponential backoff with configurable limits.
- The connect timeout uses a `setTimeout` that is properly cleaned up on success.

### Layer 2: Protocol Codec (`src/protocol/codec.ts`, `src/protocol/constants.ts`)

**Responsibility:** Binary encoding and decoding of every BlazingMQ message type.

This layer is a pure-function library — no state, no I/O. It converts between
JavaScript objects and the binary wire format. See [protocol.md](./protocol.md)
for the complete wire format specification.

**Key components:**
- **EventHeader** — 8-byte framing header for every event.
- **Control events** — JSON-encoded payloads for negotiation, queue ops, disconnect.
- **PUT events** — Binary-encoded published messages with headers, properties, CRC32-C.
- **PUSH events** — Binary-encoded delivered messages (broker → client).
- **ACK events** — Binary-encoded delivery confirmations (broker → client).
- **CONFIRM events** — Binary-encoded message confirmations (client → broker).
- **Heartbeat events** — Header-only events (8 bytes, no payload).
- **Message Properties** — Variable-length typed key-value encoding.
- **CRC32-C** — Castagnoli checksum for data integrity.
- **Padding** — 4-byte alignment with fill-with-count scheme.

### Layer 3: Session (`src/session.ts`)

**Responsibility:** Protocol state machine — negotiation, queue lifecycle,
publish/subscribe flow, ACK correlation, heartbeat monitoring.

The `Session` class is the core of the SDK. It:

1. **Connects** via `BmqConnection` and performs the broker **negotiation handshake**.
2. **Manages queues** — open, configure, close — using JSON control messages with
   request/response correlation via `rId` integers.
3. **Publishes messages** — encodes PUT events with correlation IDs for ACK matching.
4. **Dispatches incoming messages** — parses PUSH events and routes to callbacks.
5. **Handles ACKs** — matches ACK events to pending publish callbacks via 24-bit correlation IDs.
6. **Responds to heartbeats** — immediately replies to HEARTBEAT_REQ with HEARTBEAT_RSP.
7. **Monitors health** — tracks missed heartbeats to detect dead connections.

**Request/response correlation:**
- Control messages (openQueue, closeQueue, configureStream, disconnect) use `rId` integers.
  The session assigns a monotonically increasing `rId` to each outgoing request, stores a
  `PendingRequest` (with resolve/reject callbacks and a timeout timer), and matches incoming
  control responses by their `rId` field.
- ACK messages use 24-bit correlation IDs embedded in the PUT header. The session assigns
  a correlation ID to each published message and stores a `PendingAck` callback.

### Layer 4: High-Level APIs (`src/producer.ts`, `src/consumer.ts`, `src/admin.ts`)

**Responsibility:** Ergonomic, task-oriented interfaces.

These wrap the Session to provide focused APIs:

- **Producer** — Open queues for writing, publish messages, wait for ACKs.
- **Consumer** — Subscribe to queues, receive messages via callbacks or async iterators,
  confirm messages, graceful drain on shutdown.
- **Admin** — Queue management (create, delete, drain, restore, inspect).

Each high-level API creates its own Session internally, so they are fully independent.
A single application can run multiple Producers and Consumers simultaneously, each
with its own TCP connection.

### Standalone: BrokerAdmin (`src/broker-admin.ts`)

**Responsibility:** Direct broker admin command interface.

Unlike the other high-level APIs which use the BlazingMQ wire protocol,
`BrokerAdmin` connects to the broker's **admin port** via raw TCP and sends
text-based admin commands. This provides access to operations not available
through the normal client protocol:

- **Cluster management** — node health, elector state, partitions, storage
- **Domain management** — config, capacity, purge, reconfigure
- **Queue operations** — internals, message listing, per-queue purge
- **Statistics** — broker-wide stats, per-queue metrics, tunables
- **Broker configuration** — runtime config dump
- **Danger zone** — shutdown, terminate

`BrokerAdmin` opens a new TCP connection for each command (fire-and-forget
pattern). It does not use the Session layer, protocol codec, or transport layer.
See [broker-admin.md](./broker-admin.md) for the complete API reference.

## Data Flow

### Publishing a message (Producer → Broker)

```
Producer.publishAndWait(payload)
  │
  ├── Session.post(payload)
  │     ├── Encode properties → encodeMessageProperties()
  │     ├── Build PUT message → buildPutEvent()
  │     │     ├── PutHeader (36 bytes): flags, queueId, correlationId, CRC32-C
  │     │     ├── Application data (properties + payload + padding)
  │     │     └── EventHeader (8 bytes): type=PUT, totalLength
  │     └── BmqConnection.send(buffer)
  │           └── net.Socket.write(buffer) → TCP → Broker
  │
  └── Wait for ACK (timeout timer started)
        │
        ├── Broker processes message, sends ACK event back
        │     └── TCP → BmqConnection.onData() → reassemble → emit('event', ACK)
        │           └── Session.handleAckEvent()
        │                 ├── parseAckEvent() → extract correlationId, status
        │                 ├── Match correlationId → PendingAck
        │                 ├── Clear timeout timer
        │                 └── Invoke callback with Ack result
        │
        └── Resolve promise with Ack
```

### Consuming a message (Broker → Consumer)

```
Broker has message for subscribed queue
  │
  └── TCP → BmqConnection.onData() → reassemble → emit('event', PUSH)
        │
        └── Session.handlePushEvent()
              ├── parsePushEvent() → extract queueId, guid, payload, properties
              ├── Look up queueUri from queueId
              ├── Build Message object
              ├── Build MessageHandle (with confirm closure)
              └── Invoke message callback (or emit 'message' event)
                    │
                    └── User code calls handle.confirm()
                          ├── buildConfirmEvent(queueId, guid)
                          └── BmqConnection.send() → TCP → Broker
```

## Concurrency Model

Node.js is single-threaded (event loop). This SDK leverages that:

- **No locks or mutexes needed** — all state mutations happen on the event loop.
- **Promises** — async operations (connect, openQueue, postAndWaitForAck) return promises.
- **Callbacks** — message delivery uses synchronous callbacks (called on the event loop).
- **Backpressure** — TCP socket backpressure is handled by Node.js's `net.Socket` internally.

## Error Handling Strategy

The SDK uses a typed error hierarchy:

```
BlazingMQError              — Base class for all SDK errors
├── BrokerTimeoutError      — An operation timed out waiting for broker response
├── ConnectionError         — TCP connection failure or negotiation rejection
├── BrokerRefusedError      — Broker explicitly refused an operation
├── InvalidArgumentError    — Invalid parameters passed to SDK methods
└── QueueError              — Queue-specific operation failure
```

Errors propagate through:
1. **Promises** — async methods reject with typed errors.
2. **Session events** — the `SessionEventCallback` receives error events for
   non-fatal issues (e.g., failed to parse an incoming message).
3. **Event emitter** — `Session` and `Consumer` emit `'error'` events.

## Resource Cleanup

The SDK tracks all timers and resources to prevent leaks:

- **Pending request timers** — cleared on response or session stop.
- **Heartbeat interval** — cleared on session stop, uses `unref()` to not prevent process exit.
- **Reconnect timers** — cleared on intentional disconnect.
- **Consumer message queue** — drained on stop, async iterators signaled with `done: true`.
- **Event listeners** — removed during cleanup to prevent memory leaks.
