# Session Layer

This document describes the Session layer — the protocol state machine that
manages the BlazingMQ client lifecycle: negotiation, queue operations, message
publishing, message consumption, ACK handling, and heartbeat monitoring.

## Lifecycle

```
         new Session(options)
               │
               ▼
         ┌───────────┐
         │  CREATED   │  No connection yet
         └─────┬─────┘
               │ start()
               ▼
         ┌───────────┐     ┌────────────┐
         │ CONNECTING │────>│ NEGOTIATE  │  TCP connected, send clientIdentity
         └───────────┘     └─────┬──────┘
                                 │ brokerResponse received
                                 ▼
                           ┌───────────┐
                           │  STARTED   │  Ready for queue ops
                           └─────┬─────┘
                                 │ stop()
                                 ▼
                           ┌───────────┐
                           │ STOPPING   │  Close queues, send disconnect
                           └─────┬─────┘
                                 │
                                 ▼
                           ┌───────────┐
                           │  STOPPED   │  All resources released
                           └───────────┘
```

## Negotiation

When `start()` is called, the Session:

1. Calls `BmqConnection.connect()` to establish the TCP connection.
2. Sends a `clientIdentity` CONTROL event with SDK metadata.
3. Waits for the `brokerResponse` CONTROL event.
4. Extracts heartbeat configuration from the response.
5. Starts the heartbeat monitor.

**Why `sdkLanguage: "E_JAVA"`?**
The BlazingMQ broker's protocol enum doesn't include a value for Node.js.
We use `E_JAVA` because the Java SDK also uses a pure-protocol implementation
(no C++ bindings), and the broker's behavior for `E_JAVA` clients is compatible
with our approach. The actual language doesn't affect protocol behavior.

## Queue Operations

### Opening a Queue

Opening a queue is a two-step process:

1. **openQueue** — Register the queue with the broker. The broker assigns internal
   routing based on the queue domain and flags.
2. **configureStream** (consumers only) — Configure the subscription parameters:
   max unconfirmed messages/bytes, consumer priority.

The Session assigns a monotonically increasing `queueId` (starting from 0) to
each opened queue. This numeric ID is used in all subsequent binary messages
(PUT, PUSH, ACK, CONFIRM) instead of the full URI string.

### Closing a Queue

Closing a queue is also multi-step:

1. **configureStream** (consumers) — Send empty subscriptions to drain the consumer.
2. **closeQueue** — Send the close request with the **original** handle parameters
   (including the original readCount/writeCount values).

### Request/Response Correlation

Every control request includes an `rId` (request ID) — a monotonically increasing
integer. The Session stores a `PendingRequest` object for each:

```typescript
interface PendingRequest {
  resolve: (value: any) => void;  // Promise resolve
  reject: (error: Error) => void; // Promise reject
  timer: NodeJS.Timeout;          // Timeout timer
}
```

When a control response arrives, its `rId` is matched against the pending requests
map. The timer is cleared and the promise is resolved or rejected.

If no response arrives within the timeout, the timer fires, the pending request
is removed, and the promise is rejected with a `BrokerTimeoutError`.

## Publishing Messages

When `post()` or `postAndWaitForAck()` is called:

1. Look up the queue's numeric `queueId` from the URI.
2. Assign a 24-bit `correlationId` (wraps at 0xFFFFFF).
3. Encode message properties (if any) using the MessageProperties format.
4. Build the PUT event: PutHeader (36 bytes) + properties + payload + padding.
5. Compute CRC32-C checksum of the padded application data.
6. Send the event via `BmqConnection.send()`.

If `postAndWaitForAck()` was used, a `PendingAck` is stored with the correlationId
and a timeout timer. The promise resolves when the matching ACK arrives.

### ACK Handling

When an ACK event arrives from the broker:

1. Parse the ACK event → extract `status`, `correlationId`, `guid`, `queueId`.
2. Map the wire status code (4-bit) to an `AckResult` enum value.
3. Look up the `PendingAck` by `correlationId`.
4. Clear the timeout timer and invoke the stored callback.
5. Emit an `'ack'` event on the Session for any listeners.

## Consuming Messages

When a PUSH event arrives:

1. Parse the event → extract `queueId`, `guid`, `payload`, `properties`, `compressionType`.
2. If compressed (ZLIB), decompress the application data.
3. If the MESSAGE_PROPERTIES flag is set, decode properties from the application data.
4. Look up the `queueUri` from the `queueId`.
5. Create a `Message` object and a `MessageHandle` (with a `confirm()` closure).
6. Invoke the registered message callback.
7. Emit a `'message'` event on the Session.

### Message Confirmation

When `handle.confirm()` (or `Session.confirm()`) is called:

1. Build a CONFIRM event with the `queueId` and `guid`.
2. Send via `BmqConnection.send()`.

The broker uses CONFIRM messages to track which messages have been processed,
enabling at-least-once delivery semantics.

## Heartbeat Monitoring

After negotiation, the Session starts a heartbeat monitor:

- The broker sends `HEARTBEAT_REQ` events at a configured interval (e.g., 3 seconds).
- The Session immediately responds with `HEARTBEAT_RSP`.
- The monitor checks if heartbeats are being received. If too many are missed
  (based on the broker's `maxMissedHeartbeats` configuration), a `CONNECTION_LOST`
  session event is emitted.

The heartbeat interval timer uses `unref()` so it doesn't prevent the Node.js
process from exiting naturally.

## Graceful Shutdown

When `stop()` is called:

1. **Close all open queues** — sends configureStream (empty) and closeQueue for each.
2. **Send disconnect** — notifies the broker of the intentional disconnection.
3. **Stop heartbeat monitor** — clears the interval timer.
4. **Disconnect TCP** — destroys the socket.
5. **Clean up state** — clears all maps, rejects pending requests with "Session stopped".

This ordering ensures the broker properly cleans up its resources for this client.

## Error Propagation

Errors in the Session can arise from:
- **TCP errors** — forwarded from `BmqConnection` → SessionEvent(ERROR).
- **Protocol errors** — malformed events → logged as SessionEvent(ERROR), not thrown.
- **Timeout errors** — pending requests/ACKs timeout → promise rejection.
- **Broker rejections** — control response indicates failure → `BrokerRefusedError`.
- **Callback errors** — caught and emitted as SessionEvent(ERROR).

The Session never throws from event handlers — errors are always channeled through
the SessionEvent mechanism or promise rejections.
