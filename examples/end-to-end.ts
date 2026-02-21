// ============================================================================
// BlazingMQ Node.js SDK — End-to-End Example
//
// This example starts both a producer and consumer, demonstrating real-time
// message delivery through a BlazingMQ queue.
//
// Usage:
//   npx ts-node examples/end-to-end.ts
//
// Prerequisites:
//   - BlazingMQ broker running at localhost:30114
// ============================================================================

import { Producer, Consumer, AckResult, PropertyType, Message, MessageHandle } from '../src';

const BROKER_URI = 'tcp://localhost:30114';
const QUEUE_URI = 'bmq://bmq.test.mem.priority/e2e-demo';

async function main() {
  console.log('BlazingMQ End-to-End Demo');
  console.log('========================\n');

  // ── Step 1: Start the consumer ────────────────────────────────

  const receivedMessages: string[] = [];
  let resolveAllReceived: () => void;
  const allReceived = new Promise<void>((resolve) => {
    resolveAllReceived = resolve;
  });

  const consumer = new Consumer({
    broker: BROKER_URI,
    onMessage: (msg: Message, handle: MessageHandle) => {
      const text = msg.data.toString();
      receivedMessages.push(text);
      console.log(`  📥 [Consumer] Received: "${text}"`);

      if (msg.properties.size > 0) {
        for (const [key, entry] of msg.properties) {
          console.log(`     Property: ${key} = ${entry.value} (${PropertyType[entry.type]})`);
        }
      }

      handle.confirm();
      console.log(`     ✓ Confirmed (GUID: ${msg.guidHex.substring(0, 16)}...)`);

      if (receivedMessages.length >= 6) {
        resolveAllReceived();
      }
    },
    onSessionEvent: (event) => {
      console.log(`  📡 [Consumer Session] ${event.type}`);
    },
  });

  console.log('Starting consumer...');
  await consumer.start();
  await consumer.subscribe({
    queueUri: QUEUE_URI,
    options: {
      maxUnconfirmedMessages: 100,
      consumerPriority: 1,
    },
  });
  console.log('Consumer subscribed and ready.\n');

  // ── Step 2: Start the producer ────────────────────────────────

  const producer = new Producer({
    broker: BROKER_URI,
    onSessionEvent: (event) => {
      console.log(`  📡 [Producer Session] ${event.type}`);
    },
  });

  console.log('Starting producer...');
  await producer.start();
  await producer.openQueue(QUEUE_URI);
  console.log('Producer ready.\n');

  // ── Step 3: Publish messages ──────────────────────────────────

  console.log('Sending messages...\n');

  // Simple text messages
  for (let i = 1; i <= 3; i++) {
    const payload = `Hello from Node.js! Message ${i}/${3}`;
    const ack = await producer.publishAndWait({
      queueUri: QUEUE_URI,
      payload,
    });
    console.log(`  📤 [Producer] Sent: "${payload}" → ACK: ${AckResult[ack.status]}`);
  }

  console.log();

  // Messages with properties
  const events = [
    {
      payload: { event: 'user_signup', userId: 100 },
      props: { eventType: 'user_signup', priority: 1 } as Record<string, string | number | boolean>,
    },
    {
      payload: { event: 'order_placed', orderId: 'ORD-42', amount: 99.99 },
      props: { eventType: 'order_placed', priority: 2, isUrgent: true } as Record<string, string | number | boolean>,
    },
    {
      payload: { event: 'notification', message: 'Welcome to BlazingMQ!' },
      props: { eventType: 'notification', priority: 0 } as Record<string, string | number | boolean>,
    },
  ];

  for (const { payload, props } of events) {
    const ack = await producer.publishAndWait({
      queueUri: QUEUE_URI,
      payload: JSON.stringify(payload),
      properties: props,
    });
    console.log(`  📤 [Producer] Sent: ${JSON.stringify(payload)} → ACK: ${AckResult[ack.status]}`);
  }

  // ── Step 4: Wait for all messages to be consumed ──────────────

  console.log('\nWaiting for all messages to be consumed...');
  await Promise.race([
    allReceived,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), 10000),
    ),
  ]);

  // ── Step 5: Clean up ──────────────────────────────────────────

  console.log(`\n✅ All ${receivedMessages.length} messages delivered and confirmed!\n`);

  console.log('Cleaning up...');
  await producer.closeQueue(QUEUE_URI);
  await producer.stop();
  await consumer.stop();
  console.log('Done!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
