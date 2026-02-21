// ============================================================================
// BlazingMQ Node.js SDK — Consumer Example
//
// This example demonstrates how to consume messages from a BlazingMQ queue.
//
// Usage:
//   npx ts-node examples/consumer.ts
//
// Prerequisites:
//   - BlazingMQ broker running at localhost:30114
//   - Run the producer example first to publish messages
// ============================================================================

import { Consumer, Message, MessageHandle, PropertyType } from '../src';

const BROKER_URI = 'tcp://localhost:30114';
const QUEUE_URI = 'bmq://bmq.test.mem.priority/example-queue';

let messageCount = 0;

function onMessage(message: Message, handle: MessageHandle): void {
  messageCount++;
  console.log(`\n--- Message #${messageCount} ---`);
  console.log(`  Queue:   ${message.queueUri}`);
  console.log(`  GUID:    ${message.guidHex}`);
  console.log(`  Payload: ${message.data.toString()}`);

  // Print properties if present
  if (message.properties.size > 0) {
    console.log('  Properties:');
    for (const [key, entry] of message.properties) {
      console.log(`    ${key}: ${entry.value} (${PropertyType[entry.type]})`);
    }
  }

  // Confirm the message — this tells the broker we've processed it
  handle.confirm();
  console.log('  ✓ Confirmed');
}

async function main() {
  console.log('BlazingMQ Consumer Example');
  console.log('=========================\n');

  const consumer = new Consumer({
    broker: BROKER_URI,
    onMessage,
    onSessionEvent: (event) => {
      console.log(`[Session] ${event.type}: ${event.message}`);
    },
  });

  try {
    console.log(`Connecting to ${BROKER_URI}...`);
    await consumer.start();
    console.log('Connected!\n');

    console.log(`Subscribing to: ${QUEUE_URI}`);
    await consumer.subscribe({ queueUri: QUEUE_URI });
    console.log('Subscribed! Waiting for messages...\n');
    console.log('(Press Ctrl+C to stop)\n');

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\n\nShutting down...');
      await consumer.stop();
      console.log(`Received ${messageCount} messages total.`);
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the process alive
    await new Promise(() => {});
  } catch (error) {
    console.error('Error:', error);
    await consumer.stop();
    process.exit(1);
  }
}

main();
