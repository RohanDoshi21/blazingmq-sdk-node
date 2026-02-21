// ============================================================================
// BlazingMQ Node.js SDK — Unit Tests for BrokerAdmin
//
// These tests exercise the BrokerAdmin class by mocking the BMQ binary
// protocol over TCP.  No live broker is required.
// ============================================================================

import * as net from 'net';
import { EventEmitter } from 'events';
import {
  BrokerAdmin,
  ClusterStorageSummary,
  QueueInternals,
} from '../src/broker-admin';
import {
  buildControlEvent,
  parseControlPayload,
  decodeEventHeader,
} from '../src/protocol/codec';
import { EventType, EVENT_HEADER_SIZE } from '../src/protocol/constants';

// ============================================================================
// Mock BMQ Broker Helper
// ============================================================================

/**
 * Creates a local TCP server that speaks the BMQ binary protocol:
 *   1. Receives ClientIdentity negotiation → replies with BrokerResponse
 *   2. Receives AdminCommand → extracts the command string, calls `handler`,
 *      and replies with an AdminCommandResponse containing the handler result
 *   3. Handles Disconnect gracefully
 *
 * The `handler` receives the raw admin command string and returns the text
 * that should appear in the AdminCommandResponse.
 *
 * When `captureCommands` is provided, each received admin command string
 * is pushed into the array so tests can verify what was sent.
 */
function createMockBroker(
  handler: (command: string) => string,
  captureCommands?: string[],
): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let readBuffer = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        readBuffer = Buffer.concat([readBuffer, chunk]);

        // Process complete events from the buffer
        while (readBuffer.length >= EVENT_HEADER_SIZE) {
          const word0 = readBuffer.readUInt32BE(0);
          const eventLength = word0 & 0x7fffffff;

          if (eventLength < EVENT_HEADER_SIZE || readBuffer.length < eventLength) {
            break; // Need more data
          }

          const eventBuf = readBuffer.subarray(0, eventLength);
          readBuffer = readBuffer.subarray(eventLength);

          const header = decodeEventHeader(eventBuf);

          if (header.type === EventType.CONTROL) {
            let payload: any;
            try {
              payload = parseControlPayload(eventBuf);
            } catch {
              continue;
            }

            if (payload.clientIdentity) {
              // Negotiation — reply with BrokerResponse
              const brokerResponse = {
                brokerResponse: {
                  result: { category: 'E_SUCCESS', code: 0, message: '' },
                  protocolVersion: 1,
                  brokerVersion: 999999,
                  isDeprecatedSdk: false,
                },
              };
              socket.write(buildControlEvent(brokerResponse));
            } else if (payload.adminCommand) {
              // Admin command — call handler and reply
              const command = payload.adminCommand.command;
              if (captureCommands) {
                captureCommands.push(command);
              }

              const responseText = handler(command);
              const rId = payload.rId ?? 0;
              const adminResponse = {
                rId,
                adminCommandResponse: { text: responseText },
              };
              socket.write(buildControlEvent(adminResponse));
            } else if (payload.disconnect !== undefined) {
              // Disconnect — reply and close
              const rId = payload.rId ?? 0;
              const disconnectResponse = {
                rId,
                disconnectResponse: {},
              };
              socket.write(buildControlEvent(disconnectResponse));
              socket.end();
            }
          } else if (header.type === EventType.HEARTBEAT_RSP) {
            // Client replying to heartbeat — ignore
          }
        }
      });

      socket.on('error', () => {
        // Ignore client-side connection resets
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

function closeMockBroker(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ============================================================================
// BrokerAdmin Construction
// ============================================================================

describe('BrokerAdmin', () => {
  describe('constructor', () => {
    test('uses default options when none provided', () => {
      const admin = new BrokerAdmin();
      // We can't directly inspect private fields, but we can verify it's
      // an EventEmitter instance with the right prototype
      expect(admin).toBeInstanceOf(BrokerAdmin);
      expect(admin).toBeInstanceOf(EventEmitter);
    });

    test('accepts custom options', () => {
      const admin = new BrokerAdmin({
        host: '10.0.0.1',
        port: 9999,
        timeout: 5000,
      });
      expect(admin).toBeInstanceOf(BrokerAdmin);
    });
  });

  // ============================================================================
  // sendCommand — raw TCP command/response
  // ============================================================================

  describe('sendCommand', () => {
    let server: net.Server;
    let port: number;

    afterEach(async () => {
      if (server) await closeMockBroker(server);
    });

    test('sends command and receives text response', async () => {
      ({ server, port } = await createMockBroker((cmd) => {
        if (cmd === 'HELP') return 'Available commands: HELP, CLUSTERS, DOMAINS, STAT\n';
        return 'UNKNOWN COMMAND\n';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const response = await admin.sendCommand('HELP');
      expect(response).toContain('Available commands');
      expect(response).toContain('HELP');
    });

    test('returns trimmed response', async () => {
      ({ server, port } = await createMockBroker(() => '  hello  \n\n'));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const response = await admin.sendCommand('TEST');
      expect(response).toBe('hello');
    });

    test('rejects on connection error', async () => {
      // Use a port that nothing is listening on
      const admin = new BrokerAdmin({ host: '127.0.0.1', port: 1 });
      await expect(admin.sendCommand('HELP')).rejects.toThrow(/ECONNREFUSED|EACCES|connect/);
    });

    test('rejects on timeout', async () => {
      // Server that never responds
      const hangServer = net.createServer((_socket) => {
        // Intentionally don't respond or close
      });
      await new Promise<void>((resolve) => {
        hangServer.listen(0, '127.0.0.1', () => resolve());
      });
      const hangPort = (hangServer.address() as net.AddressInfo).port;

      const admin = new BrokerAdmin({
        host: '127.0.0.1',
        port: hangPort,
        timeout: 200,
      });

      await expect(admin.sendCommand('HELP')).rejects.toThrow('timed out');
      hangServer.close();
    });
  });

  // ============================================================================
  // ping
  // ============================================================================

  describe('ping', () => {
    let server: net.Server;
    let port: number;

    afterEach(async () => {
      if (server) await closeMockBroker(server);
    });

    test('returns true when broker is reachable', async () => {
      ({ server, port } = await createMockBroker(() => 'HELP TEXT'));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const result = await admin.ping();
      expect(result).toBe(true);
    });

    test('returns false when broker is unreachable', async () => {
      const admin = new BrokerAdmin({ host: '127.0.0.1', port: 1 });
      const result = await admin.ping();
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // help
  // ============================================================================

  describe('help', () => {
    let server: net.Server;
    let port: number;

    afterEach(async () => {
      if (server) await closeMockBroker(server);
    });

    test('returns help text from broker', async () => {
      const helpText = 'COMMANDS:\n  HELP\n  CLUSTERS LIST\n  DOMAINS DOMAIN <name>\n  STAT SHOW';
      ({ server, port } = await createMockBroker(() => helpText));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const result = await admin.help();
      expect(result).toContain('COMMANDS');
      expect(result).toContain('CLUSTERS LIST');
    });
  });

  // ============================================================================
  // Cluster Management
  // ============================================================================

  describe('Cluster Management', () => {
    let server: net.Server;
    let port: number;

    afterEach(async () => {
      if (server) await closeMockBroker(server);
    });

    test('listClusters parses JSON response', async () => {
      ({ server, port } = await createMockBroker((cmd) => {
        if (cmd === 'CLUSTERS LIST') {
          return JSON.stringify({ clusters: ['cluster-1', 'cluster-2', 'cluster-3'] });
        }
        return '{}';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const clusters = await admin.listClusters();
      expect(clusters).toEqual(['cluster-1', 'cluster-2', 'cluster-3']);
    });

    test('listClusters falls back to text parsing', async () => {
      // Real broker text format:
      //   The following clusters are active:
      //       [LOCAL ] cluster-alpha:
      //           localhost           0      UNSPECIFIED
      //       [LOCAL ] cluster-beta:
      //           localhost           0      UNSPECIFIED
      const textOutput = [
        'The following clusters are active:',
        '      [LOCAL ] cluster-alpha:',
        '          localhost           0      UNSPECIFIED',
        '      [LOCAL ] cluster-beta:',
        '          localhost           0      UNSPECIFIED',
      ].join('\n');
      ({ server, port } = await createMockBroker(() => textOutput));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const clusters = await admin.listClusters();
      expect(clusters).toContain('cluster-alpha');
      expect(clusters).toContain('cluster-beta');
    });

    test('getClusterStatus parses full JSON response', async () => {
      const mockStatus = {
        description: 'Production cluster',
        selfNodeDescription: 'node-1.example.com:30114',
        isHealthy: true,
        nodeStatuses: [
          {
            description: 'node-1.example.com:30114',
            isAvailable: true,
            status: 'E_AVAILABLE',
            primaryForPartitionIds: [0, 1],
          },
          {
            description: 'node-2.example.com:30114',
            isAvailable: true,
            status: 'E_AVAILABLE',
            primaryForPartitionIds: [2, 3],
          },
        ],
        electorInfo: {
          electorState: 'LEADER',
          leaderNode: 'node-1.example.com:30114',
          leaderStatus: 'ACTIVE',
        },
        partitionsInfo: [
          {
            partitionId: 0,
            numQueuesMapped: 5,
            numActiveQueues: 3,
            primaryNode: 'node-1.example.com:30114',
            primaryLeaseId: 42,
            primaryStatus: 'ACTIVE',
          },
        ],
        queuesInfo: [
          {
            uri: 'bmq://bmq.test.mem.priority/orders',
            partitionId: 0,
            isCreated: true,
            numActiveAppIds: 2,
          },
        ],
        clusterStorageSummary: {
          totalMappedBytes: 104857600,
          fileStores: [
            { partitionId: 0, numMappedFiles: 4, totalMappedBytes: 26214400 },
          ],
        },
      };

      ({ server, port } = await createMockBroker((cmd) => {
        if (cmd.startsWith('CLUSTERS CLUSTER')) return JSON.stringify(mockStatus);
        return '{}';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const status = await admin.getClusterStatus('prod-cluster');

      expect(status.name).toBe('prod-cluster');
      expect(status.isHealthy).toBe(true);
      expect(status.nodeStatuses).toHaveLength(2);
      expect(status.nodeStatuses[0].isAvailable).toBe(true);
      expect(status.nodeStatuses[0].status).toBe('E_AVAILABLE');
      expect(status.nodeStatuses[0].primaryForPartitionIds).toEqual([0, 1]);
      expect(status.electorInfo.electorState).toBe('LEADER');
      expect(status.electorInfo.leaderNode).toBe('node-1.example.com:30114');
      expect(status.partitionsInfo).toHaveLength(1);
      expect(status.partitionsInfo[0].numQueuesMapped).toBe(5);
      expect(status.queuesInfo).toHaveLength(1);
      expect(status.queuesInfo[0].uri).toContain('orders');
      expect(status.clusterStorageSummary.totalMappedBytes).toBe(104857600);
    });

    test('getClusterStatus handles non-JSON response gracefully', async () => {
      // Real broker text format includes "Is Healthy : Yes" which the regex parser detects
      const textOutput = [
        'Cluster: test',
        'Is Healthy : Yes',
        'Nodes: (none)',
      ].join('\n');
      ({ server, port } = await createMockBroker(() => textOutput));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const status = await admin.getClusterStatus('test');

      expect(status.name).toBe('test');
      expect(status.isHealthy).toBe(true);
      expect(status.nodeStatuses).toEqual([]);
    });

    test('forceGcQueues sends correct command', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return 'GC completed for 3 queues';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const result = await admin.forceGcQueues('my-cluster');
      expect(receivedCmd).toBe('CLUSTERS CLUSTER my-cluster FORCE_GC_QUEUES');
      expect(result).toContain('GC completed');
    });

    test('getClusterStorageSummary returns parsed data', async () => {
      const mockSummary: ClusterStorageSummary = {
        totalMappedBytes: 536870912,
        fileStores: [
          { partitionId: 0, numMappedFiles: 8, totalMappedBytes: 134217728 },
          { partitionId: 1, numMappedFiles: 6, totalMappedBytes: 134217728 },
        ],
      };

      ({ server, port } = await createMockBroker(() => JSON.stringify(mockSummary)));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const summary = await admin.getClusterStorageSummary('my-cluster');
      expect(summary.totalMappedBytes).toBe(536870912);
      expect(summary.fileStores).toHaveLength(2);
    });

    test('getPartitionSummary sends correct command', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return JSON.stringify({ partitionId: 2, status: 'active' });
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      await admin.getPartitionSummary('prod', 2);
      expect(receivedCmd).toBe('CLUSTERS CLUSTER prod STORAGE PARTITION 2 SUMMARY');
    });

    test('setPartitionState sends ENABLE/DISABLE', async () => {
      const cmds: string[] = [];
      ({ server, port } = await createMockBroker((cmd) => {
        cmds.push(cmd);
        return 'OK';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      await admin.setPartitionState('c1', 0, true);
      await admin.setPartitionState('c1', 1, false);
      expect(cmds[0]).toBe('CLUSTERS CLUSTER c1 STORAGE PARTITION 0 ENABLE');
      expect(cmds[1]).toBe('CLUSTERS CLUSTER c1 STORAGE PARTITION 1 DISABLE');
    });

    test('getStorageQueueStatus parses queue list', async () => {
      ({ server, port } = await createMockBroker(() =>
        JSON.stringify({
          queues: [
            { queueUri: 'bmq://dom/q1', queueKey: 'k1', partitionId: 0, numMessages: 100, numBytes: 5000, isPersistent: true },
            { queueUri: 'bmq://dom/q2', queueKey: 'k2', partitionId: 1, numMessages: 0, numBytes: 0, isPersistent: false },
          ],
        }),
      ));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const queues = await admin.getStorageQueueStatus('c1', 'bmq.test');
      expect(queues).toHaveLength(2);
      expect(queues[0].queueUri).toContain('q1');
      expect(queues[0].isPersistent).toBe(true);
      expect(queues[1].numMessages).toBe(0);
    });
  });

  // ============================================================================
  // Domain Management
  // ============================================================================

  describe('Domain Management', () => {
    let server: net.Server;
    let port: number;

    afterEach(async () => {
      if (server) await closeMockBroker(server);
    });

    test('getDomainInfo parses full response', async () => {
      const mockDomain = {
        name: 'bmq.test.mem.priority',
        configJson: '{"mode":"priority","storage":"in-memory"}',
        clusterName: 'local-cluster',
        capacityMeter: {
          name: 'bmq.test.mem.priority',
          messages: 1500,
          messageCapacity: 100000,
          bytes: 524288,
          byteCapacity: 67108864,
        },
        queueUris: [
          'bmq://bmq.test.mem.priority/orders',
          'bmq://bmq.test.mem.priority/events',
        ],
        storageContent: [
          {
            queueUri: 'bmq://bmq.test.mem.priority/orders',
            queueKey: 'abc123',
            partitionId: 0,
            numMessages: 1200,
            numBytes: 450000,
            isPersistent: false,
          },
        ],
      };

      ({ server, port } = await createMockBroker(() => JSON.stringify(mockDomain)));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const info = await admin.getDomainInfo('bmq.test.mem.priority');

      expect(info.name).toBe('bmq.test.mem.priority');
      expect(info.clusterName).toBe('local-cluster');
      expect(info.capacityMeter.messages).toBe(1500);
      expect(info.capacityMeter.messageCapacity).toBe(100000);
      expect(info.queueUris).toHaveLength(2);
      expect(info.storageContent).toHaveLength(1);
      expect(info.storageContent[0].numMessages).toBe(1200);
    });

    test('getDomainInfo handles non-JSON gracefully', async () => {
      ({ server, port } = await createMockBroker(() => 'Domain info not available'));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const info = await admin.getDomainInfo('unknown-domain');

      expect(info.name).toBe('unknown-domain');
      expect(info.queueUris).toEqual([]);
      expect(info.capacityMeter.messages).toBe(0);
    });

    test('purgeDomain sends correct command and parses response', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return JSON.stringify({
          purgedQueues: [
            { queue: 'orders', appId: '*', numMessagesPurged: 150, numBytesPurged: 65536 },
            { queue: 'events', appId: '*', numMessagesPurged: 30, numBytesPurged: 12000 },
          ],
        });
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const results = await admin.purgeDomain('bmq.test.mem.priority');

      expect(receivedCmd).toBe('DOMAINS DOMAIN bmq.test.mem.priority PURGE');
      expect(results).toHaveLength(2);
      expect(results[0].numMessagesPurged).toBe(150);
    });

    test('purgeQueue sends correct command with appId', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return JSON.stringify({
          queue: 'orders',
          appId: 'app1',
          numMessagesPurged: 42,
          numBytesPurged: 16384,
        });
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const result = await admin.purgeQueue('bmq.test', 'orders', 'app1');

      expect(receivedCmd).toBe('DOMAINS DOMAIN bmq.test QUEUE orders PURGE APPID app1');
      expect(result.numMessagesPurged).toBe(42);
      expect(result.appId).toBe('app1');
    });

    test('purgeQueue defaults appId to wildcard', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return JSON.stringify({ queue: 'q', appId: '*', numMessagesPurged: 0, numBytesPurged: 0 });
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      await admin.purgeQueue('bmq.test', 'my-queue');
      expect(receivedCmd).toContain('APPID *');
    });

    test('getQueueInternals returns parsed data', async () => {
      const mockInternals: QueueInternals = {
        queueUri: 'bmq://bmq.test/orders',
        state: 'OPEN',
        partitionId: 0,
        storageInfo: { numMessages: 500, numBytes: 200000, virtualStorages: 2 },
        handles: [
          {
            clientDescription: 'producer-app:12345',
            handleParametersJson: '{"flags":2}',
            isClientClusterMember: false,
          },
        ],
        consumers: [
          {
            appId: '__default',
            numConsumers: 3,
            maxUnconfirmedMessages: 1024,
            maxUnconfirmedBytes: 33554432,
            consumerPriority: 0,
          },
        ],
      };

      ({ server, port } = await createMockBroker(() => JSON.stringify(mockInternals)));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const internals = await admin.getQueueInternals('bmq.test', 'orders');

      expect(internals.state).toBe('OPEN');
      expect(internals.handles).toHaveLength(1);
      expect(internals.consumers).toHaveLength(1);
      expect(internals.consumers[0].numConsumers).toBe(3);
    });

    test('listQueueMessages parses message list', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return JSON.stringify({
          messages: [
            { guid: 'ABCD1234', offset: 0, size: 256, arrivalTimestamp: '2025-01-01T00:00:00Z', properties: { type: 'order' } },
            { guid: 'EFGH5678', offset: 256, size: 128, arrivalTimestamp: '2025-01-01T00:00:01Z', properties: {} },
          ],
        });
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const messages = await admin.listQueueMessages('bmq.test', 'orders', 0, 50, 'app1');

      expect(receivedCmd).toBe('DOMAINS DOMAIN bmq.test QUEUE orders LIST app1 0 50');
      expect(messages).toHaveLength(2);
      expect(messages[0].guid).toBe('ABCD1234');
      expect(messages[1].size).toBe(128);
    });

    test('listQueueMessages works without optional appId', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return JSON.stringify({ messages: [] });
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      await admin.listQueueMessages('bmq.test', 'q1');
      expect(receivedCmd).toBe('DOMAINS DOMAIN bmq.test QUEUE q1 LIST 0 100');
    });

    test('reconfigureDomain sends correct command', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return 'Domain reconfigured successfully';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const result = await admin.reconfigureDomain('bmq.test.persistent');
      expect(receivedCmd).toBe('DOMAINS RECONFIGURE bmq.test.persistent');
      expect(result).toContain('reconfigured');
    });

    test('clearDomainCache with specific domain', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return 'Cache cleared';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      await admin.clearDomainCache('bmq.test');
      expect(receivedCmd).toBe('DOMAINS RESOLVER CACHE_CLEAR bmq.test');
    });

    test('clearDomainCache without arg clears ALL', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return 'Cache cleared';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      await admin.clearDomainCache();
      expect(receivedCmd).toBe('DOMAINS RESOLVER CACHE_CLEAR ALL');
    });
  });

  // ============================================================================
  // Statistics
  // ============================================================================

  describe('Statistics', () => {
    let server: net.Server;
    let port: number;

    afterEach(async () => {
      if (server) await closeMockBroker(server);
    });

    test('getStats parses JSON broker statistics', async () => {
      const mockStats = {
        broker: { clientsCount: 15, queuesCount: 8 },
        domains: [
          { name: 'bmq.test.mem.priority', configuredMessages: 100000, configuredBytes: 67108864, queueCount: 3, queueCountOpen: 2 },
        ],
        queues: [
          {
            uri: 'bmq://bmq.test.mem.priority/orders',
            role: 'PRIMARY',
            messagesCount: 1200,
            messagesCapacity: 100000,
            bytesCount: 500000,
            bytesCapacity: 67108864,
            putMessagesDelta: 350,
            putBytesDelta: 150000,
            pushMessagesDelta: 340,
            pushBytesDelta: 145000,
            ackMessagesDelta: 340,
            confirmMessagesDelta: 335,
            nackCount: 2,
            numProducers: 3,
            numConsumers: 5,
            ackTimeAvg: 0.8,
            ackTimeMax: 12.0,
            confirmTimeAvg: 1.2,
            confirmTimeMax: 45.0,
            queueTimeAvg: 2.0,
            queueTimeMax: 89.0,
          },
        ],
      };

      ({ server, port } = await createMockBroker(() => JSON.stringify(mockStats)));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const stats = await admin.getStats();

      expect(stats.clientsCount).toBe(15);
      expect(stats.queuesCount).toBe(8);
      expect(stats.domains).toHaveLength(1);
      expect(stats.domains[0].name).toBe('bmq.test.mem.priority');
      expect(stats.queues).toHaveLength(1);

      const q = stats.queues[0];
      expect(q.uri).toContain('orders');
      expect(q.role).toBe('PRIMARY');
      expect(q.putMessagesDelta).toBe(350);
      expect(q.nackCount).toBe(2);
      expect(q.ackTimeAvg).toBe(0.8);
      expect(q.numProducers).toBe(3);
      expect(q.numConsumers).toBe(5);
    });

    test('getStats parses text fallback for client/queue counts', async () => {
      ({ server, port } = await createMockBroker(
        () => 'Stats:\n  clients: 7\n  queues: 4\n  uptime: 3600s',
      ));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const stats = await admin.getStats();
      expect(stats.clientsCount).toBe(7);
      expect(stats.queuesCount).toBe(4);
      expect(stats.domains).toEqual([]);
      expect(stats.queues).toEqual([]);
    });

    test('getStats handles snake_case fields in queue data', async () => {
      const mockStats = {
        broker: { clientsCount: 1, queuesCount: 1 },
        queues: [
          {
            uri: 'bmq://d/q',
            role: 'PRIMARY',
            messages_current: 50,
            messages_max: 10000,
            bytes_current: 2000,
            bytes_max: 5000000,
            put_messages_delta: 100,
            put_bytes_delta: 40000,
            push_messages_delta: 95,
            push_bytes_delta: 38000,
            ack_delta: 95,
            confirm_delta: 90,
            nack: 1,
            nb_producer: 2,
            nb_consumer: 4,
            ack_time_avg: 1.5,
            ack_time_max: 20,
            confirm_time_avg: 2.0,
            confirm_time_max: 50,
            queue_time_avg: 3.0,
            queue_time_max: 100,
          },
        ],
      };

      ({ server, port } = await createMockBroker(() => JSON.stringify(mockStats)));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const stats = await admin.getStats();
      const q = stats.queues[0];

      // Verifies the snake_case fallback mapping works
      expect(q.messagesCount).toBe(50);
      expect(q.messagesCapacity).toBe(10000);
      expect(q.putMessagesDelta).toBe(100);
      expect(q.pushMessagesDelta).toBe(95);
      expect(q.ackMessagesDelta).toBe(95);
      expect(q.confirmMessagesDelta).toBe(90);
      expect(q.nackCount).toBe(1);
      expect(q.numProducers).toBe(2);
      expect(q.numConsumers).toBe(4);
    });

    test('listTunables returns text', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return 'QUEUE_GC_INTERVAL\nQUEUE_CONSUMER_DELIVERY_TIMEOUT';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const result = await admin.listTunables();
      expect(receivedCmd).toBe('STAT LIST_TUNABLES');
      expect(result).toContain('QUEUE_GC_INTERVAL');
    });

    test('getTunable sends correct command', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return '60000';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const value = await admin.getTunable('QUEUE_GC_INTERVAL');
      expect(receivedCmd).toBe('STAT GET QUEUE_GC_INTERVAL');
      expect(value).toBe('60000');
    });

    test('setTunable sends correct command with value', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return 'OK';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      await admin.setTunable('QUEUE_GC_INTERVAL', 30000);
      expect(receivedCmd).toBe('STAT SET QUEUE_GC_INTERVAL 30000');
    });

    test('setTunable accepts string values', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return 'OK';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      await admin.setTunable('SOME_PARAM', 'enabled');
      expect(receivedCmd).toBe('STAT SET SOME_PARAM enabled');
    });
  });

  // ============================================================================
  // Broker Configuration
  // ============================================================================

  describe('Broker Configuration', () => {
    let server: net.Server;
    let port: number;

    afterEach(async () => {
      if (server) await closeMockBroker(server);
    });

    test('getBrokerConfig parses JSON config', async () => {
      const mockConfig = {
        appConfig: {
          brokerInstanceName: 'bmqbrkr-001',
          hostName: 'broker.example.com',
          hostDataCenter: 'DC1',
        },
        networkInterfaces: { tcpInterface: { port: 30114 } },
      };

      ({ server, port } = await createMockBroker(() => JSON.stringify(mockConfig)));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const config = await admin.getBrokerConfig();

      expect(config.parsed).not.toBeNull();
      expect(config.parsed?.appConfig).toBeDefined();
      expect(config.raw).toContain('bmqbrkr-001');
    });

    test('getBrokerConfig handles non-JSON config', async () => {
      ({ server, port } = await createMockBroker(() => 'appConfig:\n  name: broker-1\n  port: 30114'));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const config = await admin.getBrokerConfig();

      expect(config.parsed).toBeNull();
      expect(config.raw).toContain('broker-1');
    });
  });

  // ============================================================================
  // Danger Zone
  // ============================================================================

  describe('Danger Zone', () => {
    let server: net.Server;
    let port: number;

    afterEach(async () => {
      if (server) await closeMockBroker(server);
    });

    test('shutdown sends DANGER SHUTDOWN', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return 'Shutting down...';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const result = await admin.shutdown();
      expect(receivedCmd).toBe('DANGER SHUTDOWN');
      expect(result).toContain('Shutting down');
    });

    test('terminate sends DANGER TERMINATE', async () => {
      let receivedCmd = '';
      ({ server, port } = await createMockBroker((cmd) => {
        receivedCmd = cmd;
        return 'Terminating...';
      }));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const result = await admin.terminate();
      expect(receivedCmd).toBe('DANGER TERMINATE');
      expect(result).toContain('Terminating');
    });
  });

  // ============================================================================
  // Response Parsing Edge Cases
  // ============================================================================

  describe('Response Parsing Edge Cases', () => {
    let server: net.Server;
    let port: number;

    afterEach(async () => {
      if (server) await closeMockBroker(server);
    });

    test('cluster status with missing fields uses safe defaults', async () => {
      ({ server, port } = await createMockBroker(() => JSON.stringify({ isHealthy: false })));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const status = await admin.getClusterStatus('empty-cluster');

      expect(status.name).toBe('empty-cluster');
      expect(status.isHealthy).toBe(false);
      expect(status.description).toBe('');
      expect(status.nodeStatuses).toEqual([]);
      expect(status.electorInfo.electorState).toBe('UNKNOWN');
      expect(status.partitionsInfo).toEqual([]);
      expect(status.queuesInfo).toEqual([]);
    });

    test('domain info with missing fields uses safe defaults', async () => {
      ({ server, port } = await createMockBroker(() => JSON.stringify({ clusterName: 'c1' })));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const info = await admin.getDomainInfo('partial');

      expect(info.name).toBe('partial');
      expect(info.clusterName).toBe('c1');
      expect(info.queueUris).toEqual([]);
      expect(info.storageContent).toEqual([]);
      expect(info.capacityMeter.messages).toBe(0);
    });

    test('stats with empty JSON returns zero counts', async () => {
      ({ server, port } = await createMockBroker(() => '{}'));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const stats = await admin.getStats();

      expect(stats.clientsCount).toBe(0);
      expect(stats.queuesCount).toBe(0);
      expect(stats.domains).toEqual([]);
      expect(stats.queues).toEqual([]);
    });

    test('queue stats with empty data returns zeroed fields', async () => {
      const mockStats = {
        broker: { clientsCount: 0, queuesCount: 1 },
        queues: [{ uri: 'bmq://d/q' }],
      };

      ({ server, port } = await createMockBroker(() => JSON.stringify(mockStats)));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const stats = await admin.getStats();
      const q = stats.queues[0];

      expect(q.uri).toBe('bmq://d/q');
      expect(q.role).toBe('UNKNOWN');
      expect(q.messagesCount).toBe(0);
      expect(q.bytesCount).toBe(0);
      expect(q.putMessagesDelta).toBe(0);
      expect(q.nackCount).toBe(0);
      expect(q.ackTimeAvg).toBe(0);
    });

    test('purgeDomain with non-array response wraps in array', async () => {
      ({ server, port } = await createMockBroker(() =>
        JSON.stringify({
          queue: 'single',
          appId: '*',
          numMessagesPurged: 10,
          numBytesPurged: 4096,
        }),
      ));

      const admin = new BrokerAdmin({ host: '127.0.0.1', port });
      const results = await admin.purgeDomain('domain');
      expect(results).toHaveLength(1);
      expect(results[0].queue).toBe('single');
    });
  });
});
