// ============================================================================
// BrokerAdmin Integration Tests
//
// Tests run against a real BlazingMQ broker at localhost:30114 (default).
// Override with BMQ_TEST_HOST / BMQ_TEST_PORT environment variables.
//
// Prerequisites:
//   - BlazingMQ broker running (e.g. docker/single-node)
//   - Domain "bmq.test.mem.priority" configured
//   - Queue "example-queue" opened by at least one consumer
// ============================================================================

import { BrokerAdmin } from '../src/broker-admin';
import type {
  ClusterInfo,
  ClusterStatus,
  DomainInfo,
  QueueInternals,
  BrokerStats,
  BrokerConfig,
} from '../src/broker-admin';

const BROKER_HOST = process.env.BMQ_TEST_HOST || 'localhost';
const BROKER_PORT = Number(process.env.BMQ_TEST_PORT) || 30114;
const TIMEOUT = 15000;

// Known fixtures from the running single-node broker
const TEST_CLUSTER = 'local';
const TEST_DOMAIN = 'bmq.test.mem.priority';
const TEST_QUEUE = 'example-queue';

jest.setTimeout(TIMEOUT);

describe('BrokerAdmin (integration)', () => {
  let admin: BrokerAdmin;

  beforeAll(() => {
    admin = new BrokerAdmin({
      host: BROKER_HOST,
      port: BROKER_PORT,
      timeout: TIMEOUT,
    });
  });

  // ==========================================================================
  // Health & Connectivity
  // ==========================================================================

  describe('Health & Connectivity', () => {
    test('ping returns true when broker is reachable', async () => {
      const ok = await admin.ping();
      expect(ok).toBe(true);
    });

    test('ping returns false for unreachable broker', async () => {
      const badAdmin = new BrokerAdmin({ host: '127.0.0.1', port: 1, timeout: 2000 });
      const ok = await badAdmin.ping();
      expect(ok).toBe(false);
    });

    test('help returns non-empty command listing', async () => {
      const helpText = await admin.help();
      expect(typeof helpText).toBe('string');
      expect(helpText.length).toBeGreaterThan(0);
      expect(helpText).toContain('CLUSTERS');
      expect(helpText).toContain('DOMAINS');
      expect(helpText).toContain('STAT');
    });

    test('sendCommand returns string response', async () => {
      const response = await admin.sendCommand('HELP');
      expect(typeof response).toBe('string');
      expect(response.length).toBeGreaterThan(0);
    });

    test('sendCommand rejects on bad connection', async () => {
      const badAdmin = new BrokerAdmin({ host: '127.0.0.1', port: 1, timeout: 2000 });
      await expect(badAdmin.sendCommand('HELP')).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Cluster Management
  // ==========================================================================

  describe('Cluster Management', () => {
    test('listClusters returns array of ClusterInfo', async () => {
      const clusters: ClusterInfo[] = await admin.listClusters();

      expect(Array.isArray(clusters)).toBe(true);
      expect(clusters.length).toBeGreaterThan(0);

      const cluster = clusters[0];
      expect(typeof cluster.name).toBe('string');
      expect(typeof cluster.locality).toBe('string');
      expect(Array.isArray(cluster.nodes)).toBe(true);
      expect(cluster.nodes.length).toBeGreaterThan(0);
      expect(typeof cluster.nodes[0].hostName).toBe('string');
      expect(typeof cluster.nodes[0].nodeId).toBe('number');
    });

    test('listClusters includes the test cluster', async () => {
      const clusters = await admin.listClusters();
      const names = clusters.map((c) => c.name);
      expect(names).toContain(TEST_CLUSTER);
    });

    test('getClusterStatus returns ClusterStatus', async () => {
      const status: ClusterStatus = await admin.getClusterStatus(TEST_CLUSTER);

      // Top-level fields
      expect(status.name).toBe(TEST_CLUSTER);
      expect(typeof status.description).toBe('string');
      expect(typeof status.selfNodeDescription).toBe('string');
      expect(typeof status.isHealthy).toBe('boolean');

      // Node statuses
      expect(status.nodeStatuses).toBeDefined();
      expect(Array.isArray(status.nodeStatuses.nodes)).toBe(true);
      expect(status.nodeStatuses.nodes.length).toBeGreaterThan(0);
      const node = status.nodeStatuses.nodes[0];
      expect(typeof node.description).toBe('string');
      expect(typeof node.status).toBe('string');
      expect(Array.isArray(node.primaryForPartitionIds)).toBe(true);

      // Elector info
      expect(typeof status.electorInfo.electorState).toBe('string');
      expect(typeof status.electorInfo.leaderNode).toBe('string');
      expect(typeof status.electorInfo.leaderStatus).toBe('string');

      // Partitions
      expect(status.partitionsInfo).toBeDefined();
      expect(Array.isArray(status.partitionsInfo.partitions)).toBe(true);
      if (status.partitionsInfo.partitions.length > 0) {
        const part = status.partitionsInfo.partitions[0];
        expect(typeof part.numQueuesMapped).toBe('number');
        expect(typeof part.numActiveQueues).toBe('number');
        expect(typeof part.primaryNode).toBe('string');
        expect(typeof part.primaryLeaseId).toBe('number');
        expect(typeof part.primaryStatus).toBe('string');
      }

      // Queues
      expect(status.queuesInfo).toBeDefined();
      expect(Array.isArray(status.queuesInfo.storages)).toBe(true);

      // Storage summary
      expect(status.clusterStorageSummary).toBeDefined();
      expect(typeof status.clusterStorageSummary.clusterFileStoreLocation).toBe('string');
      expect(Array.isArray(status.clusterStorageSummary.fileStores)).toBe(true);
    });

    test('getClusterStatus shows healthy cluster', async () => {
      const status = await admin.getClusterStatus(TEST_CLUSTER);
      expect(status.isHealthy).toBe(true);
    });

    test('getClusterStatus includes storage info for queues', async () => {
      const status = await admin.getClusterStatus(TEST_CLUSTER);
      const storages = status.queuesInfo.storages;

      if (storages.length > 0) {
        const s = storages[0];
        expect(typeof s.queueUri).toBe('string');
        expect(typeof s.queueKey).toBe('string');
        expect(typeof s.partitionId).toBe('number');
        expect(typeof s.numMessages).toBe('number');
        expect(typeof s.numBytes).toBe('number');
        expect(typeof s.isPersistent).toBe('boolean');
      }
    });

    test('forceGcQueues returns response string', async () => {
      const result = await admin.forceGcQueues(TEST_CLUSTER);
      expect(typeof result).toBe('string');
    });
  });

  // ==========================================================================
  // Domain Management
  // ==========================================================================

  describe('Domain Management', () => {
    test('getDomainInfo returns DomainInfo', async () => {
      const info: DomainInfo = await admin.getDomainInfo(TEST_DOMAIN);

      expect(info.name).toBe(TEST_DOMAIN);
      expect(typeof info.configJson).toBe('string');
      expect(info.configJson.length).toBeGreaterThan(0);
      expect(typeof info.clusterName).toBe('string');

      // Capacity meter
      expect(info.capacityMeter).toBeDefined();
      expect(typeof info.capacityMeter.numMessages).toBe('number');
      expect(typeof info.capacityMeter.messageCapacity).toBe('number');
      expect(typeof info.capacityMeter.numBytes).toBe('number');
      expect(typeof info.capacityMeter.byteCapacity).toBe('number');
      expect(typeof info.capacityMeter.isDisabled).toBe('boolean');
      expect(info.capacityMeter.messageCapacity).toBeGreaterThan(0);
      expect(info.capacityMeter.byteCapacity).toBeGreaterThan(0);

      // Queue URIs
      expect(Array.isArray(info.queueUris)).toBe(true);

      // Config is valid JSON
      expect(() => JSON.parse(info.configJson)).not.toThrow();
    });

    test('getDomainInfo includes the test queue', async () => {
      const info = await admin.getDomainInfo(TEST_DOMAIN);
      const hasQueue = info.queueUris.some((uri) =>
        uri.includes(TEST_QUEUE),
      );
      expect(hasQueue).toBe(true);
    });

    test('getDomainInfo config contains queue limits', async () => {
      const info = await admin.getDomainInfo(TEST_DOMAIN);
      const config = JSON.parse(info.configJson);
      expect(config.storage).toBeDefined();
      expect(config.storage.queueLimits).toBeDefined();
      expect(typeof config.storage.queueLimits.messages).toBe('number');
      expect(typeof config.storage.queueLimits.bytes).toBe('number');
    });

    test('reconfigureDomain returns response string', async () => {
      const result = await admin.reconfigureDomain(TEST_DOMAIN);
      expect(typeof result).toBe('string');
    });

    test('clearDomainCache with specific domain', async () => {
      const result = await admin.clearDomainCache(TEST_DOMAIN);
      expect(typeof result).toBe('string');
    });

    test('clearDomainCache for ALL', async () => {
      const result = await admin.clearDomainCache();
      expect(typeof result).toBe('string');
    });
  });

  // ==========================================================================
  // Queue Operations
  // ==========================================================================

  describe('Queue Operations', () => {
    test('getQueueInternals returns QueueInternals', async () => {
      const internals: QueueInternals = await admin.getQueueInternals(
        TEST_DOMAIN,
        TEST_QUEUE,
      );

      // State
      expect(internals.state).toBeDefined();
      expect(typeof internals.state.uri).toBe('string');
      expect(internals.state.uri).toContain(TEST_QUEUE);
      expect(typeof internals.state.partitionId).toBe('number');
      expect(typeof internals.state.key).toBe('string');

      // Storage
      expect(internals.state.storage).toBeDefined();
      expect(typeof internals.state.storage.numMessages).toBe('number');
      expect(typeof internals.state.storage.numBytes).toBe('number');
      expect(Array.isArray(internals.state.storage.virtualStorages)).toBe(true);

      // Capacity meter
      expect(internals.state.capacityMeter).toBeDefined();
      expect(typeof internals.state.capacityMeter.messageCapacity).toBe('number');
      expect(typeof internals.state.capacityMeter.byteCapacity).toBe('number');
      expect(internals.state.capacityMeter.messageCapacity).toBeGreaterThan(0);

      // Handles
      expect(Array.isArray(internals.state.handles)).toBe(true);

      // Queue metadata
      expect(internals.queue).toBeDefined();
    });

    test('getQueueInternals shows parent capacity meter', async () => {
      const internals = await admin.getQueueInternals(TEST_DOMAIN, TEST_QUEUE);
      const parent = internals.state.capacityMeter.parent;
      expect(parent).toBeDefined();
      expect(typeof parent!.messageCapacity).toBe('number');
      expect(typeof parent!.byteCapacity).toBe('number');
    });

    test('getQueueInternals includes virtual storages', async () => {
      const internals = await admin.getQueueInternals(TEST_DOMAIN, TEST_QUEUE);
      const vs = internals.state.storage.virtualStorages;
      expect(vs.length).toBeGreaterThan(0);
      expect(typeof vs[0].appId).toBe('string');
      expect(typeof vs[0].numMessages).toBe('number');
    });

    test('purgeQueue returns response text', async () => {
      const result = await admin.purgeQueue(TEST_DOMAIN, TEST_QUEUE);
      expect(typeof result).toBe('string');
    });

    test('purgeDomain returns response text', async () => {
      const result = await admin.purgeDomain(TEST_DOMAIN);
      expect(typeof result).toBe('string');
    });
  });

  // ==========================================================================
  // Statistics
  // ==========================================================================

  describe('Statistics', () => {
    test('getStats returns BrokerStats with domainQueues', async () => {
      const stats: BrokerStats = await admin.getStats();

      expect(stats.domainQueues).toBeDefined();
      expect(stats.domainQueues.domains).toBeDefined();
      expect(typeof stats.domainQueues.domains).toBe('object');
    });

    test('getStats includes the test domain', async () => {
      const stats = await admin.getStats();
      const domainNames = Object.keys(stats.domainQueues.domains);
      expect(domainNames).toContain(TEST_DOMAIN);
    });

    test('getStats includes queue stat values', async () => {
      const stats = await admin.getStats();
      const domainQueues = stats.domainQueues.domains[TEST_DOMAIN];
      expect(domainQueues).toBeDefined();

      const queueUris = Object.keys(domainQueues);
      expect(queueUris.length).toBeGreaterThan(0);

      const queueUri = queueUris.find((u) => u.includes(TEST_QUEUE));
      expect(queueUri).toBeDefined();

      const values = domainQueues[queueUri!].values;
      expect(typeof values).toBe('object');

      // Verify well-known stat fields exist
      expect(typeof values.queue_put_msgs).toBe('number');
      expect(typeof values.queue_push_msgs).toBe('number');
      expect(typeof values.queue_ack_msgs).toBe('number');
      expect(typeof values.queue_confirm_msgs).toBe('number');
      expect(typeof values.queue_nack_msgs).toBe('number');
      expect(typeof values.queue_producers_count).toBe('number');
      expect(typeof values.queue_consumers_count).toBe('number');
      expect(typeof values.queue_content_msgs).toBe('number');
      expect(typeof values.queue_content_bytes).toBe('number');
      expect(typeof values.queue_cfg_msgs).toBe('number');
      expect(typeof values.queue_cfg_bytes).toBe('number');
      expect(typeof values.queue_role).toBe('number');
      expect(typeof values.queue_ack_time_avg).toBe('number');
      expect(typeof values.queue_ack_time_max).toBe('number');
      expect(typeof values.queue_confirm_time_avg).toBe('number');
      expect(typeof values.queue_confirm_time_max).toBe('number');
      expect(typeof values.queue_queue_time_avg).toBe('number');
      expect(typeof values.queue_queue_time_max).toBe('number');
    });

    test('getStats queue capacity matches domain config', async () => {
      const [stats, domainInfo] = await Promise.all([
        admin.getStats(),
        admin.getDomainInfo(TEST_DOMAIN),
      ]);

      const config = JSON.parse(domainInfo.configJson);
      const queueLimits = config.storage.queueLimits;

      const domainQueues = stats.domainQueues.domains[TEST_DOMAIN];
      const queueUri = Object.keys(domainQueues).find((u) =>
        u.includes(TEST_QUEUE),
      )!;
      const values = domainQueues[queueUri].values;

      expect(values.queue_cfg_msgs).toBe(queueLimits.messages);
      expect(values.queue_cfg_bytes).toBe(queueLimits.bytes);
    });

    test('listTunables returns a string', async () => {
      const result = await admin.listTunables();
      expect(typeof result).toBe('string');
    });
  });

  // ==========================================================================
  // Broker Configuration
  // ==========================================================================

  describe('Broker Configuration', () => {
    test('getBrokerConfig returns raw and parsed', async () => {
      const config: BrokerConfig = await admin.getBrokerConfig();

      expect(typeof config.raw).toBe('string');
      expect(config.raw.length).toBeGreaterThan(0);
      // parsed may be null if the response isn't JSON
      if (config.parsed !== null) {
        expect(typeof config.parsed).toBe('object');
      }
    });
  });

  // ==========================================================================
  // Edge Cases & Error Handling
  // ==========================================================================

  describe('Edge Cases', () => {
    test('getClusterStatus rejects for non-existent cluster', async () => {
      await expect(
        admin.getClusterStatus('nonexistent-cluster-xyz'),
      ).rejects.toThrow(/No status returned|Expected JSON/);
    });

    test('getQueueInternals rejects for non-existent queue', async () => {
      await expect(
        admin.getQueueInternals(TEST_DOMAIN, 'nonexistent-queue-xyz'),
      ).rejects.toThrow(/No internals returned|Expected JSON/);;
    });

    test('constructor uses defaults when no options provided', () => {
      const a = new BrokerAdmin();
      // Should not throw — defaults to localhost:30114
      expect(a).toBeInstanceOf(BrokerAdmin);
    });

    test('constructor respects custom options', () => {
      const a = new BrokerAdmin({
        host: '10.0.0.1',
        port: 12345,
        timeout: 5000,
      });
      expect(a).toBeInstanceOf(BrokerAdmin);
    });
  });
});
