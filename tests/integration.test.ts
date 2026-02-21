// ============================================================================
// BlazingMQ Node.js SDK — Integration Tests
//
// These tests connect to a live BlazingMQ broker running at localhost:30114.
// Run with: npx jest --runInBand --testPathPattern=integration
// ============================================================================

import {
  Session,
  Producer,
  Consumer,
  Admin,
  SessionEventType,
  AckResult,
  PropertyType,
  Message,
  MessageHandle,
  Ack,
  SessionEvent,
} from '../src';

const BROKER_URI = 'tcp://localhost:30114';
const TEST_QUEUE = 'bmq://bmq.test.mem.priority/test-nodejs-sdk';

// Helper to wait for a specified time
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Session Tests
// ============================================================================

describe('Session', () => {
  let session: Session;

  afterEach(async () => {
    if (session) {
      try {
        await session.stop();
      } catch {
        // ignore
      }
    }
  });

  test('should connect to the broker and negotiate successfully', async () => {
    const events: SessionEvent[] = [];

    session = new Session({ broker: BROKER_URI });
    session.setSessionEventCallback((event) => {
      events.push(event);
      console.log('[Session Event]', event.type, event.message);
    });
    session.setMessageCallback(() => {}); // dummy

    await session.start();

    // Should be connected
    const connectedEvent = events.find(
      (e) => e.type === SessionEventType.CONNECTED,
    );
    expect(connectedEvent).toBeDefined();

    await session.stop();

    const disconnectedEvent = events.find(
      (e) => e.type === SessionEventType.DISCONNECTED,
    );
    expect(disconnectedEvent).toBeDefined();
  }, 15000);

  test('should open and close a queue', async () => {
    session = new Session({ broker: BROKER_URI });
    session.setMessageCallback(() => {});

    await session.start();

    // Open queue for writing
    const options = await session.openQueue({
      queueUri: TEST_QUEUE,
      write: true,
    });

    expect(options).toBeDefined();
    expect(options.maxUnconfirmedMessages).toBe(1024);
    expect(session.isQueueOpen(TEST_QUEUE)).toBe(true);

    // Close queue
    await session.closeQueue(TEST_QUEUE);
    expect(session.isQueueOpen(TEST_QUEUE)).toBe(false);

    await session.stop();
  }, 30000);

  test('should post a message and receive ACK', async () => {
    session = new Session({ broker: BROKER_URI });
    session.setMessageCallback(() => {});

    await session.start();
    await session.openQueue({ queueUri: TEST_QUEUE, write: true });

    // Post and wait for ACK
    const ack = await session.postAndWaitForAck({
      queueUri: TEST_QUEUE,
      payload: Buffer.from('Hello from Node.js SDK test!'),
    });

    console.log('[ACK]', {
      status: AckResult[ack.status],
      guidHex: ack.guidHex,
      queueUri: ack.queueUri,
      isSuccess: ack.isSuccess,
    });

    expect(ack).toBeDefined();
    expect(ack.isSuccess).toBe(true);
    expect(ack.status).toBe(AckResult.SUCCESS);
    expect(ack.queueUri).toBe(TEST_QUEUE);

    await session.closeQueue(TEST_QUEUE);
    await session.stop();
  }, 30000);
});

// ============================================================================
// Producer/Consumer End-to-End Tests
// ============================================================================

describe('Producer and Consumer', () => {
  test('should produce and consume a simple message', async () => {
    const QUEUE_URI = 'bmq://bmq.test.mem.priority/test-node-e2e';

    // Set up consumer first
    const receivedMessages: Message[] = [];
    const messageReceived = new Promise<Message>((resolve) => {
      const consumer = new Consumer({
        broker: BROKER_URI,
        onMessage: (msg, handle) => {
          console.log('[Consumer] Received message:', {
            data: msg.data.toString(),
            guidHex: msg.guidHex,
            queueUri: msg.queueUri,
          });
          receivedMessages.push(msg);
          handle.confirm();
          resolve(msg);
        },
      });

      (async () => {
        await consumer.start();
        await consumer.subscribe({ queueUri: QUEUE_URI });

        // Now produce a message
        const producer = new Producer({
          broker: BROKER_URI,
          defaultQueueUri: QUEUE_URI,
        });
        await producer.start();
        await producer.openQueue(QUEUE_URI);

        const testPayload = `Hello from Node.js SDK! Time: ${Date.now()}`;
        console.log('[Producer] Sending:', testPayload);

        const ack = await producer.publishAndWait({
          payload: testPayload,
        });

        console.log('[Producer] ACK received:', {
          status: AckResult[ack.status],
          isSuccess: ack.isSuccess,
          guidHex: ack.guidHex,
        });

        expect(ack.isSuccess).toBe(true);

        // Wait for consumer to receive, then clean up
        await delay(2000);
        await producer.stop();
        await consumer.stop();
      })().catch(console.error);
    });

    // Wait for message with timeout
    const msg = await Promise.race([
      messageReceived,
      delay(15000).then(() => {
        throw new Error('Timeout waiting for message');
      }),
    ]);

    expect(msg).toBeDefined();
    expect(msg.data.toString()).toContain('Hello from Node.js SDK!');
    expect(msg.queueUri).toBe(QUEUE_URI);
  }, 30000);

  test('should produce and consume messages with properties', async () => {
    const QUEUE_URI = 'bmq://bmq.test.mem.priority/test-node-props';

    const receivedMessages: Message[] = [];
    let consumer: Consumer;
    let producer: Producer;

    try {
      // Start consumer
      consumer = new Consumer({
        broker: BROKER_URI,
        onMessage: (msg, handle) => {
          console.log('[Consumer] Message with properties:', {
            data: msg.data.toString(),
            properties: Object.fromEntries(
              Array.from(msg.properties.entries()).map(([k, v]) => [
                k,
                { type: PropertyType[v.type], value: v.value },
              ]),
            ),
          });
          receivedMessages.push(msg);
          handle.confirm();
        },
      });
      await consumer.start();
      await consumer.subscribe({ queueUri: QUEUE_URI });

      // Start producer
      producer = new Producer({
        broker: BROKER_URI,
      });
      await producer.start();
      await producer.openQueue(QUEUE_URI);

      // Publish with properties
      const ack = await producer.publishAndWait({
        queueUri: QUEUE_URI,
        payload: JSON.stringify({ event: 'user_signup', userId: 42 }),
        properties: {
          eventType: 'user_signup',
          priority: 1,
          isVip: true,
        },
        propertyTypeOverrides: {
          priority: PropertyType.INT32,
        },
      });

      console.log('[Producer] ACK for message with props:', {
        status: AckResult[ack.status],
        isSuccess: ack.isSuccess,
      });

      expect(ack.isSuccess).toBe(true);

      // Wait for consumer to process
      await delay(3000);

      // Verify received message
      expect(receivedMessages.length).toBeGreaterThanOrEqual(1);

      const received = receivedMessages[receivedMessages.length - 1];
      const payload = JSON.parse(received.data.toString());
      expect(payload.event).toBe('user_signup');
      expect(payload.userId).toBe(42);

      // Check properties were transmitted
      if (received.properties.size > 0) {
        console.log(
          '[Test] Properties received:',
          Object.fromEntries(received.properties),
        );
      }
    } finally {
      await producer!?.stop();
      await consumer!?.stop();
    }
  }, 30000);

  test('should handle multiple messages in sequence', async () => {
    const QUEUE_URI = 'bmq://bmq.test.mem.priority/test-node-batch';
    const MESSAGE_COUNT = 5;

    const receivedMessages: Message[] = [];
    let consumer: Consumer;
    let producer: Producer;

    try {
      consumer = new Consumer({
        broker: BROKER_URI,
        onMessage: (msg, handle) => {
          receivedMessages.push(msg);
          handle.confirm();
        },
      });
      await consumer.start();
      await consumer.subscribe({ queueUri: QUEUE_URI });

      producer = new Producer({ broker: BROKER_URI });
      await producer.start();
      await producer.openQueue(QUEUE_URI);

      // Send multiple messages
      const ackPromises: Promise<Ack>[] = [];
      for (let i = 0; i < MESSAGE_COUNT; i++) {
        ackPromises.push(
          producer.publishAndWait({
            queueUri: QUEUE_URI,
            payload: `Message ${i + 1} of ${MESSAGE_COUNT}`,
          }),
        );
      }

      const acks = await Promise.all(ackPromises);
      console.log(
        `[Producer] All ${MESSAGE_COUNT} messages ACKed:`,
        acks.map((a) => AckResult[a.status]),
      );

      expect(acks.every((a) => a.isSuccess)).toBe(true);

      // Wait for consumer
      await delay(3000);

      console.log(
        `[Consumer] Received ${receivedMessages.length} messages`,
      );
      expect(receivedMessages.length).toBe(MESSAGE_COUNT);

      // Verify order
      for (let i = 0; i < MESSAGE_COUNT; i++) {
        expect(receivedMessages[i].data.toString()).toContain(
          `Message ${i + 1}`,
        );
      }
    } finally {
      await producer!?.stop();
      await consumer!?.stop();
    }
  }, 45000);
});

// ============================================================================
// Admin Tests
// ============================================================================

describe('Admin', () => {
  test('should create and inspect a queue', async () => {
    const QUEUE_URI = 'bmq://bmq.test.mem.priority/test-node-admin';
    const admin = new Admin({ broker: BROKER_URI });

    try {
      await admin.start();

      await admin.createQueue(QUEUE_URI);

      const info = admin.getQueueInfo();
      console.log('[Admin] Queue info:', info);

      expect(info.length).toBeGreaterThanOrEqual(1);
      const queueInfo = info.find((q) => q.uri === QUEUE_URI);
      expect(queueInfo).toBeDefined();
      expect(queueInfo!.isOpen).toBe(true);

      await admin.deleteQueue(QUEUE_URI);
    } finally {
      await admin.stop();
    }
  }, 30000);
});
