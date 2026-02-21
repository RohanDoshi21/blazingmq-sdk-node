#!/usr/bin/env node
// ============================================================================
// Example: Consumer
//
// Subscribes to a BlazingMQ queue and prints received messages.
//
// Usage:
//   npm run build && node examples/consumer.js
//
// Prerequisites:
//   - BlazingMQ broker running at localhost:30114
//   - Run the producer example first to publish some messages
// ============================================================================

const { Consumer, PropertyType } = require('../dist');

const BROKER = process.env.BMQ_BROKER_URI || 'tcp://localhost:30114';
const QUEUE = 'bmq://bmq.test.mem.priority/example-queue';

let count = 0;

async function main() {
  const consumer = new Consumer({
    broker: BROKER,
    onMessage: (msg, handle) => {
      count++;
      console.log(`\n--- Message #${count} ---`);
      console.log(`  Payload: ${msg.data.toString()}`);
      console.log(`  GUID:    ${msg.guidHex}`);

      if (msg.properties.size > 0) {
        console.log('  Properties:');
        for (const [key, entry] of msg.properties) {
          console.log(`    ${key}: ${entry.value} (${PropertyType[entry.type]})`);
        }
      }

      handle.confirm();
      console.log('  ✓ Confirmed');
    },
  });

  await consumer.start();
  await consumer.subscribe({ queueUri: QUEUE });
  console.log(`Listening on ${QUEUE}... (Ctrl+C to stop)`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log(`\nShutting down... (received ${count} messages)`);
    await consumer.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
