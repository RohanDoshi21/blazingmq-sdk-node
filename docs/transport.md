# Transport Layer

This document describes the TCP transport layer of the BlazingMQ Node.js SDK —
how it manages the raw TCP connection and reassembles discrete events from the
continuous byte stream.

## The Problem: TCP Stream Reassembly

TCP is a **stream** protocol. It guarantees ordered, reliable byte delivery, but
it does **not** preserve message boundaries. When a BlazingMQ broker sends two
events (e.g., a PUSH and a HEARTBEAT_REQ), the client may receive them as:

- One TCP segment containing both events, or
- Three TCP segments, with the split happening mid-event, or
- Any other combination.

The transport layer's job is to reconstruct complete BlazingMQ events from this
byte stream.

## Framing State Machine

The `BmqConnection` class implements a simple state machine for event framing:

```
                    ┌─────────────┐
         TCP data   │  Accumulate │
        ─────────>  │  readBuffer │
                    └──────┬──────┘
                           │
                   ┌───────▼───────┐
                   │ readBuffer    │  No
                   │ >= 4 bytes?   │───────> (wait for more data)
                   └───────┬───────┘
                           │ Yes
                   ┌───────▼───────┐
                   │ Read length   │
                   │ from bytes    │
                   │ 0-3 (31 bits) │
                   └───────┬───────┘
                           │
                   ┌───────▼───────┐
                   │ readBuffer    │  No
                   │ >= length?    │───────> (wait for more data)
                   └───────┬───────┘
                           │ Yes
                   ┌───────▼───────┐
                   │ Extract event │
                   │ Decode header │
                   │ Emit ('event')│
                   └───────┬───────┘
                           │
                           └──> (loop: check for more events in buffer)
```

### Implementation

```typescript
private onData(chunk: Buffer): void {
  this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

  while (this.readBuffer.length >= EVENT_HEADER_SIZE) {
    const word0 = this.readBuffer.readUInt32BE(0);
    const eventLength = word0 & 0x7FFFFFFF;  // mask off fragment bit

    // Sanity check
    if (eventLength < 8 || eventLength > MAX_EVENT_SIZE) {
      this.emit('error', new Error(`Invalid event length: ${eventLength}`));
      this.readBuffer = Buffer.alloc(0);
      return;
    }

    // Wait for complete event
    if (this.readBuffer.length < eventLength) return;

    // Extract and emit
    const eventBuf = this.readBuffer.subarray(0, eventLength);
    this.readBuffer = this.readBuffer.subarray(eventLength);
    const header = decodeEventHeader(eventBuf);
    this.emit('event', header.type, eventBuf);
  }
}
```

## Connection Lifecycle

```
     ┌───────────────┐
     │  DISCONNECTED  │ <─── initial state
     └───────┬────────┘
             │ connect()
     ┌───────▼────────┐
     │  CONNECTING     │ ──── socket.connect() + timeout timer
     └───────┬────────┘
             │ 'connect' event (or timeout → DISCONNECTED)
     ┌───────▼────────┐
     │  CONNECTED      │ ──── data flow active
     └───────┬────────┘
             │ disconnect() or 'close' event
     ┌───────▼────────┐
     │  DISCONNECTING  │
     └───────┬────────┘
             │ socket destroyed
     ┌───────▼────────┐
     │  DISCONNECTED   │
     └────────────────┘
```

## Reconnection

When enabled (`reconnect: true`), the connection will automatically attempt to
reconnect after an unintentional disconnect:

1. The `'close'` event fires on the socket.
2. If the disconnect was **not** intentional and reconnection is enabled:
3. Schedule a reconnect with **exponential backoff**: `delay * 2^attempt`.
4. Cap the delay at `reconnectMaxDelay` (default: 30 seconds).
5. Optionally limit total attempts with `reconnectMaxAttempts`.

```
Initial delay:  1000ms
Attempt 1:      1000ms
Attempt 2:      2000ms
Attempt 3:      4000ms
Attempt 4:      8000ms
Attempt 5:     16000ms
Attempt 6+:    30000ms (capped)
```

## Events Emitted

The `BmqConnection` is an `EventEmitter` with these events:

| Event          | Arguments                  | Description                              |
|----------------|----------------------------|------------------------------------------|
| `connected`    | (none)                     | TCP connection established               |
| `disconnected` | `error?: Error`            | Connection closed                        |
| `error`        | `error: Error`             | Non-fatal error (bad event, etc.)        |
| `event`        | `type: EventType, data: Buffer` | Complete BlazingMQ event received   |
| `reconnecting` | `attempt: number`          | About to attempt reconnection            |

## Configuration

```typescript
interface ConnectionOptions {
  host: string;              // Broker hostname
  port: number;              // Broker port (default: 30114)
  connectTimeout?: number;   // Connection timeout in ms (default: 5000)
  reconnect?: boolean;       // Enable auto-reconnect (default: false)
  reconnectDelay?: number;   // Initial reconnect delay in ms (default: 1000)
  reconnectMaxDelay?: number;  // Max reconnect delay in ms (default: 30000)
  reconnectMaxAttempts?: number; // Max attempts, 0 = infinite (default: 0)
}
```

## Buffer Management

The `readBuffer` is a `Buffer` that grows as TCP data arrives and shrinks as
complete events are extracted. On disconnect, it is reset to an empty buffer
to prevent stale data from corrupting the next connection.

**Memory consideration:** In normal operation, the buffer stays small (typically
under a few KB) because events are processed as fast as they arrive. The
`MAX_EVENT_SIZE` (64MB) sanity check prevents a malformed length field from
causing unbounded memory allocation.
