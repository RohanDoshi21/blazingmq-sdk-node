#!/usr/bin/env node
// ============================================================================
// BlazingMQ Node.js SDK — End-to-End Demo Script
//
// Demonstrates producing and consuming messages through a live BlazingMQ broker.
//
// Usage:
//   node examples/run-e2e.js
//
// Prerequisites:
//   - npm run build (to compile the SDK)
//   - BlazingMQ broker running at localhost:30114
// ============================================================================

const { Producer, Consumer, AckResult, PropertyType } = require('../dist');

const BROKER = 'tcp://localhost:30114';
const QUEUE = 'bmq://bmq.test.mem.priority/nodejs-e2e-demo';

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   BlazingMQ Node.js SDK — End-to-End Demo   ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const received = [];
  let resolveAll;
  const allReceived = new Promise((r) => { resolveAll = r; });

  // ── Consumer ──────────────────────────────────────────────
  const consumer = new Consumer({
    broker: BROKER,
    onMessage: (msg, handle) => {
      received.push(msg.data.toString());
      console.log(`  📥 [Consumer] "${msg.data.toString()}"`);

      if (msg.properties.size > 0) {
        const props = {};
        for (const [k, v] of msg.properties) {
          props[k] = `${v.value} (${PropertyType[v.type]})`;
        }
        console.log(`     Properties:`, props);
      }

      handle.confirm();
      console.log(`     ✓ Confirmed (GUID: ${msg.guidHex.substring(0, 16)}…)\n`);

      if (received.length >= 6) resolveAll();
    },
  });

  console.log('1️⃣  Starting consumer...');
  await consumer.start();
  await consumer.subscribe({
    queueUri: QUEUE,
    options: { maxUnconfirmedMessages: 100, consumerPriority: 1 },
  });
  console.log('   Consumer subscribed to:', QUEUE, '\n');

  // ── Producer ──────────────────────────────────────────────
  const producer = new Producer({ broker: BROKER });

  console.log('2️⃣  Starting producer...');
  await producer.start();
  await producer.openQueue(QUEUE);
  console.log('   Producer opened queue:', QUEUE, '\n');

  // ── Publish Messages ──────────────────────────────────────
  console.log('3️⃣  Publishing messages...\n');

  // Simple text messages
  for (let i = 1; i <= 3; i++) {
    const text = `Hello from Node.js SDK! [${i}/3]`;
    const ack = await producer.publishAndWait({ queueUri: QUEUE, payload: text });
    console.log(`  📤 [Producer] "${text}" → ${AckResult[ack.status]}`);
  }

  console.log();

  // Messages with properties
  const events = [
    {
      data: { event: 'user_signup', userId: 42 },
      props: { eventType: 'user_signup', priority: 1, isVip: true },
    },
    {
      data: { event: 'order_placed', orderId: 'ORD-123', total: 99.99 },
      props: { eventType: 'order_placed', priority: 2 },
    },
    {
      data: { event: 'notification', message: 'Welcome!' },
      props: { eventType: 'notification', priority: 0 },
    },
  ];

  for (const { data, props } of events) {
    const ack = await producer.publishAndWait({
      queueUri: QUEUE,
      payload: JSON.stringify(data),
      properties: props,
    });
    console.log(`  📤 [Producer] ${JSON.stringify(data)} → ${AckResult[ack.status]}`);
  }

  // ── Wait for all to be consumed ───────────────────────────
  console.log('\n4️⃣  Waiting for all messages to be consumed...\n');
  await Promise.race([
    allReceived,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 10s')), 10000)),
  ]);

  // ── Summary ───────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════');
  console.log(`✅ SUCCESS! ${received.length} messages produced, delivered, and confirmed.`);
  console.log('══════════════════════════════════════════════════\n');

  // ── Cleanup ───────────────────────────────────────────────
  console.log('5️⃣  Cleaning up...');
  await producer.closeQueue(QUEUE);
  await producer.stop();
  await consumer.stop();
  console.log('   Done!\n');
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
