#!/usr/bin/env node
// ============================================================================
// Example: Producer
//
// Publishes messages to a BlazingMQ queue with delivery confirmation (ACK).
//
// Usage:
//   npm run build && node examples/producer.js
//
// Prerequisites:
//   - BlazingMQ broker running at localhost:30114
// ============================================================================

const { Producer, AckResult } = require('../dist');

const BROKER = process.env.BMQ_BROKER_URI || 'tcp://localhost:30114';
const QUEUE = 'bmq://bmq.test.mem.priority/example-queue';

async function main() {
  const producer = new Producer({ broker: BROKER });

  await producer.start();
  await producer.openQueue(QUEUE);

  // Simple text messages
  for (let i = 1; i <= 3; i++) {
    const ack = await producer.publishAndWait({
      queueUri: QUEUE,
      payload: `Hello from Node.js SDK! Message ${i}`,
    });
    console.log(`Message ${i}: ACK ${AckResult[ack.status]}`);
  }

  // Message with typed properties
  const ack = await producer.publishAndWait({
    queueUri: QUEUE,
    payload: JSON.stringify({ event: 'user_signup', userId: 42 }),
    properties: {
      eventType: 'user_signup',
      priority: 1,
      isVip: true,
    },
  });
  console.log(`Message with properties: ACK ${AckResult[ack.status]}`);

  await producer.closeQueue(QUEUE);
  await producer.stop();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
