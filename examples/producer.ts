// ============================================================================
// BlazingMQ Node.js SDK — Producer Example
//
// This example demonstrates how to produce messages to a BlazingMQ queue.
//
// Usage:
//   npx ts-node examples/producer.ts
//
// Prerequisites:
//   - BlazingMQ broker running at localhost:30114
// ============================================================================

import { Producer, AckResult } from '../src';

const BROKER_URI = 'tcp://localhost:30114';
const QUEUE_URI = 'bmq://bmq.test.mem.priority/example-queue';

async function main() {
  console.log('BlazingMQ Producer Example');
  console.log('=========================\n');

  // Create a producer
  const producer = new Producer({
    broker: BROKER_URI,
    onSessionEvent: (event) => {
      console.log(`[Session] ${event.type}: ${event.message}`);
    },
  });

  try {
    // Connect to the broker
    console.log(`Connecting to ${BROKER_URI}...`);
    await producer.start();
    console.log('Connected!\n');

    // Open a queue for writing
    console.log(`Opening queue: ${QUEUE_URI}`);
    await producer.openQueue(QUEUE_URI);
    console.log('Queue opened!\n');

    // Publish simple messages
    console.log('Publishing messages...\n');

    for (let i = 1; i <= 5; i++) {
      const payload = `Hello from Node.js SDK! Message #${i}`;

      const ack = await producer.publishAndWait({
        queueUri: QUEUE_URI,
        payload,
      });

      console.log(`  Message ${i}: "${payload}"`);
      console.log(`    ACK: ${AckResult[ack.status]} | GUID: ${ack.guidHex}\n`);
    }

    // Publish a message with properties
    console.log('Publishing message with properties...\n');

    const ack = await producer.publishAndWait({
      queueUri: QUEUE_URI,
      payload: JSON.stringify({
        event: 'user_signup',
        userId: 42,
        email: 'user@example.com',
      }),
      properties: {
        eventType: 'user_signup',
        priority: 1,
        isVip: false,
      },
    });

    console.log(`  Message with properties ACK: ${AckResult[ack.status]}\n`);

    // Close queue and disconnect
    await producer.closeQueue(QUEUE_URI);
    console.log('Queue closed.');

    await producer.stop();
    console.log('Disconnected.');
  } catch (error) {
    console.error('Error:', error);
    await producer.stop();
    process.exit(1);
  }
}

main();
