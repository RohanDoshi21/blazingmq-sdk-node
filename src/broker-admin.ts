// ============================================================================
// BlazingMQ Node.js SDK — Broker Admin API
//
// Provides direct admin command interface to a BlazingMQ broker.
// Sends admin commands and parses structured responses for:
//   - Cluster management (status, health, nodes, partitions)
//   - Domain management (info, purge, reconfigure, list queues)
//   - Queue operations (purge, internals, message listing)
//   - Statistics (broker stats, queue stats, domain stats)
//   - Storage management (summaries, partition control)
//   - Broker configuration inspection
//
// This module communicates with the broker over the BMQ binary protocol,
// performing a full negotiation handshake before sending AdminCommand
// control messages and receiving AdminCommandResponse payloads.
// ============================================================================

import * as os from 'os';
import { EventEmitter } from 'events';
import { BmqConnection } from './transport/connection';
import {
  buildControlEvent,
  parseControlPayload,
  buildHeartbeatResponse,
} from './protocol/codec';
import {
  EventType,
  PROTOCOL_VERSION,
  SDK_VERSION,
  SDK_NAME,
  SDK_VERSION_STRING,
  SDK_FEATURES,
} from './protocol/constants';

// ============================================================================
// Types
// ============================================================================

export interface BrokerAdminOptions {
  /** Broker host. Default: localhost */
  host?: string;
  /** Broker admin port. Default: 30114 */
  port?: number;
  /** Command timeout in ms. Default: 10000 */
  timeout?: number;
}

// --- Cluster Types ---

export interface ClusterNodeStatus {
  description: string;
  isAvailable: boolean;
  status: string; // E_UNKNOWN, E_STARTING, E_AVAILABLE, E_STOPPING, E_UNAVAILABLE
  primaryForPartitionIds: number[];
}

export interface ElectorInfo {
  electorState: string; // DORMANT, FOLLOWER, CANDIDATE, LEADER
  leaderNode: string;
  leaderStatus: string; // UNDEFINED, PASSIVE, ACTIVE
  leaderMessageSequence?: { electorTerm: number; sequenceNumber: number };
}

export interface PartitionInfo {
  partitionId: number;
  numQueuesMapped: number;
  numActiveQueues: number;
  primaryNode: string;
  primaryLeaseId: number;
  primaryStatus: string;
}

export interface ClusterQueueInfo {
  uri: string;
  partitionId: number;
  isCreated: boolean;
  numActiveAppIds: number;
}

export interface ClusterStorageSummary {
  totalMappedBytes: number;
  fileStores: Array<{
    partitionId: number;
    numMappedFiles: number;
    totalMappedBytes: number;
  }>;
}

export interface ClusterStatus {
  name: string;
  description: string;
  selfNodeDescription: string;
  isHealthy: boolean;
  nodeStatuses: ClusterNodeStatus[];
  electorInfo: ElectorInfo;
  partitionsInfo: PartitionInfo[];
  queuesInfo: ClusterQueueInfo[];
  clusterStorageSummary: ClusterStorageSummary;
}

// --- Domain Types ---

export interface CapacityMeter {
  name: string;
  messages: number;
  messageCapacity: number;
  bytes: number;
  byteCapacity: number;
}

export interface StorageQueueInfo {
  queueUri: string;
  queueKey: string;
  partitionId: number;
  numMessages: number;
  numBytes: number;
  isPersistent: boolean;
  internalQueueId?: number;
}

export interface DomainInfo {
  name: string;
  configJson: string;
  clusterName: string;
  capacityMeter: CapacityMeter;
  queueUris: string[];
  storageContent: StorageQueueInfo[];
}

// --- Queue Types ---

export interface QueueHandleInfo {
  clientDescription: string;
  handleParametersJson: string;
  isClientClusterMember: boolean;
}

export interface QueueConsumerInfo {
  appId: string;
  numConsumers: number;
  maxUnconfirmedMessages: number;
  maxUnconfirmedBytes: number;
  consumerPriority: number;
}

export interface QueueInternals {
  queueUri: string;
  state: string;
  partitionId: number;
  storageInfo: {
    numMessages: number;
    numBytes: number;
    virtualStorages: number;
  };
  handles: QueueHandleInfo[];
  consumers: QueueConsumerInfo[];
}

export interface PurgeResult {
  queue: string;
  appId: string;
  numMessagesPurged: number;
  numBytesPurged: number;
}

export interface QueueMessage {
  guid: string;
  offset: number;
  size: number;
  arrivalTimestamp: string;
  properties: Record<string, unknown>;
}

// --- Stats Types ---

export interface QueueStats {
  uri: string;
  role: string; // PRIMARY, REPLICA, PROXY
  messagesCount: number;
  messagesCapacity: number;
  bytesCount: number;
  bytesCapacity: number;
  putMessagesDelta: number;
  putBytesDelta: number;
  pushMessagesDelta: number;
  pushBytesDelta: number;
  ackMessagesDelta: number;
  confirmMessagesDelta: number;
  nackCount: number;
  numProducers: number;
  numConsumers: number;
  ackTimeAvg: number;
  ackTimeMax: number;
  confirmTimeAvg: number;
  confirmTimeMax: number;
  queueTimeAvg: number;
  queueTimeMax: number;
}

export interface DomainStats {
  name: string;
  configuredMessages: number;
  configuredBytes: number;
  queueCount: number;
  queueCountOpen: number;
}

export interface BrokerStats {
  clientsCount: number;
  queuesCount: number;
  domains: DomainStats[];
  queues: QueueStats[];
}

// --- Broker Config Types ---

export interface BrokerConfig {
  raw: string;
  parsed: Record<string, unknown> | null;
}

// ============================================================================
// BrokerAdmin Class
// ============================================================================

/**
 * Admin client for sending management commands to a BlazingMQ broker.
 *
 * Connects to the broker's admin port and provides a structured API
 * for all admin operations: cluster management, domain management,
 * queue operations, statistics, and configuration.
 *
 * @example
 * ```typescript
 * const admin = new BrokerAdmin({ host: 'localhost', port: 30114 });
 *
 * // Get cluster status
 * const clusters = await admin.listClusters();
 * const status = await admin.getClusterStatus('my-cluster');
 *
 * // Get domain info
 * const domainInfo = await admin.getDomainInfo('bmq.test.mem.priority');
 *
 * // Purge a queue
 * const result = await admin.purgeQueue('bmq.test.mem.priority', 'my-queue');
 *
 * // Get statistics
 * const stats = await admin.getStats();
 * ```
 */
export class BrokerAdmin extends EventEmitter {
  private options: Required<BrokerAdminOptions>;

  constructor(options: BrokerAdminOptions = {}) {
    super();
    this.options = {
      host: options.host ?? 'localhost',
      port: options.port ?? 30114,
      timeout: options.timeout ?? 10000,
    };
  }

  // ============================================================================
  // Low-Level Command Execution
  // ============================================================================

  /**
   * Send a raw admin command to the broker and return the response.
   *
   * For each command a new TCP connection is opened, the BMQ protocol
   * negotiation is performed, an AdminCommand control message is sent,
   * and the AdminCommandResponse is awaited before disconnecting.
   */
  async sendCommand(command: string): Promise<string> {
    const conn = new BmqConnection({
      host: this.options.host,
      port: this.options.port,
      connectTimeout: this.options.timeout,
      reconnect: false,
    });

    // Prevent Node.js from throwing on the EventEmitter 'error' event.
    // Connection errors are surfaced via the rejected connect() promise.
    conn.on('error', () => {});

    try {
      // 1. Connect
      await conn.connect();

      // 2. Negotiate — send ClientIdentity as TCPADMIN, await BrokerResponse
      const clientIdentity = {
        clientIdentity: {
          protocolVersion: PROTOCOL_VERSION,
          sdkVersion: SDK_VERSION,
          clientType: 'E_TCPADMIN',
          processName: process.argv[1] || 'node-admin',
          pid: process.pid,
          sessionId: 1,
          hostName: os.hostname(),
          features: SDK_FEATURES,
          clusterName: '',
          clusterNodeId: -1,
          sdkLanguage: 'E_JAVA',
          guidInfo: {
            clientId: '',
            nanoSecondsFromEpoch: 0,
          },
          userAgent: `${SDK_NAME}/${SDK_VERSION_STRING} (admin)`,
        },
      };

      conn.send(buildControlEvent(clientIdentity));

      const negoResponse = await this.waitForEvent(conn, EventType.CONTROL, this.options.timeout);
      const negoParsed = parseControlPayload(negoResponse);

      if (negoParsed.brokerResponse?.result?.category &&
          negoParsed.brokerResponse.result.category !== 'E_SUCCESS') {
        throw new Error(
          `Broker rejected negotiation: ${negoParsed.brokerResponse.result.message || negoParsed.brokerResponse.result.category}`,
        );
      }

      // 3. Send AdminCommand
      const rId = 1;
      const adminMsg = {
        rId,
        adminCommand: { command },
      };
      conn.send(buildControlEvent(adminMsg));

      // 4. Await AdminCommandResponse
      const responseBuf = await this.waitForEvent(conn, EventType.CONTROL, this.options.timeout);
      const responseParsed = parseControlPayload(responseBuf);
      const text = responseParsed.adminCommandResponse?.text ?? responseParsed.raw ?? '';

      // 5. Graceful disconnect
      try {
        conn.send(buildControlEvent({ rId: 2, disconnect: {} }));
      } catch {
        // Ignore
      }

      return typeof text === 'string' ? text.trim() : JSON.stringify(text);
    } finally {
      try {
        await conn.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Wait for a specific event type from the connection.
   * Automatically responds to HEARTBEAT_REQ events while waiting.
   */
  private waitForEvent(
    conn: BmqConnection,
    expectedType: EventType,
    timeoutMs: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.removeListener('event', handler);
        reject(new Error(`Admin command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (type: EventType, data: Buffer) => {
        // Auto-reply to heartbeat requests to keep the connection alive
        if (type === EventType.HEARTBEAT_REQ) {
          try {
            conn.send(buildHeartbeatResponse());
          } catch {
            // Ignore — connection may be closing
          }
          return;
        }

        if (type === expectedType) {
          clearTimeout(timer);
          conn.removeListener('event', handler);
          resolve(data);
        }
      };

      conn.on('event', handler);
    });
  }

  /**
   * Send a command and parse the JSON response.
   */
  private async sendJsonCommand(command: string): Promise<any> {
    const response = await this.sendCommand(command);
    try {
      return JSON.parse(response);
    } catch {
      // If not JSON, return as raw
      return { raw: response };
    }
  }

  // ============================================================================
  // Health & Connectivity
  // ============================================================================

  /**
   * Ping the broker to check connectivity.
   */
  async ping(): Promise<boolean> {
    try {
      await this.sendCommand('HELP');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get help text listing all supported commands.
   */
  async help(): Promise<string> {
    return this.sendCommand('HELP');
  }

  // ============================================================================
  // Cluster Management
  // ============================================================================

  /**
   * List all active clusters.
   */
  async listClusters(): Promise<string[]> {
    const response = await this.sendCommand('CLUSTERS LIST');
    try {
      const parsed = JSON.parse(response);
      return parsed.clusters || [];
    } catch {
      // Parse from text format:
      //   The following clusters are active:
      //       [LOCAL ] local:
      //           localhost           0      UNSPECIFIED
      const names: string[] = [];
      const lines = response.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s+\[\s*\w+\s*\]\s+(\S+?):/);
        if (match) {
          names.push(match[1]);
        }
      }
      return names;
    }
  }

  /**
   * Get detailed status of a specific cluster.
   */
  async getClusterStatus(clusterName: string): Promise<ClusterStatus> {
    const response = await this.sendJsonCommand(
      `CLUSTERS CLUSTER ${clusterName} STATUS`
    );
    return this.parseClusterStatus(clusterName, response);
  }

  /**
   * Force garbage collection of idle queues in a cluster.
   */
  async forceGcQueues(clusterName: string): Promise<string> {
    return this.sendCommand(`CLUSTERS CLUSTER ${clusterName} FORCE_GC_QUEUES`);
  }

  /**
   * Get storage summary for a cluster.
   */
  async getClusterStorageSummary(clusterName: string): Promise<ClusterStorageSummary> {
    const response = await this.sendJsonCommand(
      `CLUSTERS CLUSTER ${clusterName} STORAGE SUMMARY`
    );
    return response as ClusterStorageSummary;
  }

  /**
   * Get partition details for a cluster.
   */
  async getPartitionSummary(
    clusterName: string,
    partitionId: number,
  ): Promise<any> {
    return this.sendJsonCommand(
      `CLUSTERS CLUSTER ${clusterName} STORAGE PARTITION ${partitionId} SUMMARY`
    );
  }

  /**
   * Enable or disable a partition.
   */
  async setPartitionState(
    clusterName: string,
    partitionId: number,
    enable: boolean,
  ): Promise<string> {
    const action = enable ? 'ENABLE' : 'DISABLE';
    return this.sendCommand(
      `CLUSTERS CLUSTER ${clusterName} STORAGE PARTITION ${partitionId} ${action}`
    );
  }

  /**
   * Get queue status in storage for a domain within a cluster.
   */
  async getStorageQueueStatus(
    clusterName: string,
    domainName: string,
  ): Promise<StorageQueueInfo[]> {
    const response = await this.sendJsonCommand(
      `CLUSTERS CLUSTER ${clusterName} STORAGE DOMAIN ${domainName} QUEUE_STATUS`
    );
    return response.queues || [];
  }

  // ============================================================================
  // Domain Management
  // ============================================================================

  /**
   * Get detailed info about a domain, including config and queues.
   */
  async getDomainInfo(domainName: string): Promise<DomainInfo> {
    const response = await this.sendJsonCommand(
      `DOMAINS DOMAIN ${domainName} INFOS`
    );
    return this.parseDomainInfo(domainName, response);
  }

  /**
   * Purge all queues in a domain.
   */
  async purgeDomain(domainName: string): Promise<PurgeResult[]> {
    const response = await this.sendJsonCommand(
      `DOMAINS DOMAIN ${domainName} PURGE`
    );
    return response.purgedQueues || [response];
  }

  /**
   * Purge a specific queue in a domain.
   */
  async purgeQueue(
    domainName: string,
    queueName: string,
    appId: string = '*',
  ): Promise<PurgeResult> {
    const response = await this.sendJsonCommand(
      `DOMAINS DOMAIN ${domainName} QUEUE ${queueName} PURGE APPID ${appId}`
    );
    return response as PurgeResult;
  }

  /**
   * Get queue internals (handles, consumers, routing info).
   */
  async getQueueInternals(
    domainName: string,
    queueName: string,
  ): Promise<QueueInternals> {
    const response = await this.sendJsonCommand(
      `DOMAINS DOMAIN ${domainName} QUEUE ${queueName} INTERNALS`
    );
    return response as QueueInternals;
  }

  /**
   * List messages in a queue.
   */
  async listQueueMessages(
    domainName: string,
    queueName: string,
    offset: number = 0,
    count: number = 100,
    appId?: string,
  ): Promise<QueueMessage[]> {
    const appIdPart = appId ? ` ${appId}` : '';
    const response = await this.sendJsonCommand(
      `DOMAINS DOMAIN ${domainName} QUEUE ${queueName} LIST${appIdPart} ${offset} ${count}`
    );
    return response.messages || [];
  }

  /**
   * Hot-reload domain configuration from disk.
   */
  async reconfigureDomain(domainName: string): Promise<string> {
    return this.sendCommand(`DOMAINS RECONFIGURE ${domainName}`);
  }

  /**
   * Clear domain resolver cache.
   */
  async clearDomainCache(domainName?: string): Promise<string> {
    const target = domainName ?? 'ALL';
    return this.sendCommand(`DOMAINS RESOLVER CACHE_CLEAR ${target}`);
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * Get all broker statistics.
   */
  async getStats(): Promise<BrokerStats> {
    const response = await this.sendCommand('STAT SHOW');
    return this.parseStats(response);
  }

  /**
   * List tunable stat parameters.
   */
  async listTunables(): Promise<string> {
    return this.sendCommand('STAT LIST_TUNABLES');
  }

  /**
   * Get a stat tunable value.
   */
  async getTunable(param: string): Promise<string> {
    return this.sendCommand(`STAT GET ${param}`);
  }

  /**
   * Set a stat tunable value.
   */
  async setTunable(param: string, value: string | number): Promise<string> {
    return this.sendCommand(`STAT SET ${param} ${value}`);
  }

  // ============================================================================
  // Broker Configuration
  // ============================================================================

  /**
   * Dump the current broker configuration.
   */
  async getBrokerConfig(): Promise<BrokerConfig> {
    const response = await this.sendCommand('BROKERCONFIG DUMP');
    try {
      return { raw: response, parsed: JSON.parse(response) };
    } catch {
      return { raw: response, parsed: null };
    }
  }

  // ============================================================================
  // Danger Zone
  // ============================================================================

  /**
   * Initiate a graceful broker shutdown.
   */
  async shutdown(): Promise<string> {
    return this.sendCommand('DANGER SHUTDOWN');
  }

  /**
   * Terminate the broker immediately.
   */
  async terminate(): Promise<string> {
    return this.sendCommand('DANGER TERMINATE');
  }

  // ============================================================================
  // Response Parsers
  // ============================================================================

  private parseClusterStatus(name: string, data: any): ClusterStatus {
    if (data.raw) {
      // Parse the text-format cluster status output
      const text: string = data.raw;
      const isHealthy = /Is Healthy\s*:\s*Yes/i.test(text);

      // Parse nodes
      const nodeStatuses: ClusterNodeStatus[] = [];
      const nodeRegex = /\[([^\]]+)\]\s*\n\s*IsConnected:\s*(\S+)\s*\n\s*Node Status:\s*(\S+)\s*\n\s*Primary for partitions:\s*\[([^\]]*)\]/g;
      let nodeMatch;
      while ((nodeMatch = nodeRegex.exec(text)) !== null) {
        const partitions = nodeMatch[4].trim()
          ? nodeMatch[4].trim().split(/\s+/).map(Number)
          : [];
        nodeStatuses.push({
          description: nodeMatch[1].trim(),
          isAvailable: nodeMatch[3].trim() === 'E_AVAILABLE',
          status: nodeMatch[3].trim(),
          primaryForPartitionIds: partitions,
        });
      }

      // Parse elector info
      const electorState = text.match(/Self State\s*:\s*(\S+)/)?.[1] ?? 'UNKNOWN';
      const leaderNode = text.match(/Leader Node\s*:\s*(.+)/)?.[1]?.trim() ?? '';
      const leaderStatus = text.match(/Leader Status\s*:\s*(\S+)/)?.[1] ?? 'UNDEFINED';

      // Parse partitions
      const partitionsInfo: PartitionInfo[] = [];
      const partRegex = /PartitionId:\s*(\d+)\s*\n\s*Num Queues\s*:\s*mapped\s*\((\d+)\),\s*active\s*\((\d+)\)\s*\n\s*Primary Node\s*:\s*(.+)\n\s*Primary LeaseId:\s*(\d+)\s*\n\s*Primary Status\s*:\s*(\S+)/g;
      let partMatch;
      while ((partMatch = partRegex.exec(text)) !== null) {
        partitionsInfo.push({
          partitionId: parseInt(partMatch[1], 10),
          numQueuesMapped: parseInt(partMatch[2], 10),
          numActiveQueues: parseInt(partMatch[3], 10),
          primaryNode: partMatch[4].trim(),
          primaryLeaseId: parseInt(partMatch[5], 10),
          primaryStatus: partMatch[6].trim(),
        });
      }

      return {
        name,
        description: text,
        selfNodeDescription: '',
        isHealthy,
        nodeStatuses,
        electorInfo: {
          electorState,
          leaderNode,
          leaderStatus,
        },
        partitionsInfo,
        queuesInfo: [],
        clusterStorageSummary: { totalMappedBytes: 0, fileStores: [] },
      };
    }

    return {
      name,
      description: data.description ?? '',
      selfNodeDescription: data.selfNodeDescription ?? '',
      isHealthy: data.isHealthy ?? true,
      nodeStatuses: (data.nodeStatuses ?? []).map((n: any) => ({
        description: n.description ?? '',
        isAvailable: n.isAvailable ?? false,
        status: n.status ?? 'E_UNKNOWN',
        primaryForPartitionIds: n.primaryForPartitionIds ?? [],
      })),
      electorInfo: {
        electorState: data.electorInfo?.electorState ?? 'UNKNOWN',
        leaderNode: data.electorInfo?.leaderNode ?? '',
        leaderStatus: data.electorInfo?.leaderStatus ?? 'UNDEFINED',
      },
      partitionsInfo: (data.partitionsInfo ?? []).map((p: any) => ({
        partitionId: p.partitionId ?? 0,
        numQueuesMapped: p.numQueuesMapped ?? 0,
        numActiveQueues: p.numActiveQueues ?? 0,
        primaryNode: p.primaryNode ?? '',
        primaryLeaseId: p.primaryLeaseId ?? 0,
        primaryStatus: p.primaryStatus ?? '',
      })),
      queuesInfo: (data.queuesInfo ?? []).map((q: any) => ({
        uri: q.uri ?? q.queueUri ?? '',
        partitionId: q.partitionId ?? 0,
        isCreated: q.isCreated ?? false,
        numActiveAppIds: q.numActiveAppIds ?? 0,
      })),
      clusterStorageSummary: data.clusterStorageSummary ?? {
        totalMappedBytes: 0,
        fileStores: [],
      },
    };
  }

  private parseDomainInfo(name: string, data: any): DomainInfo {
    if (data.raw) {
      return {
        name,
        configJson: '{}',
        clusterName: '',
        capacityMeter: {
          name,
          messages: 0,
          messageCapacity: 0,
          bytes: 0,
          byteCapacity: 0,
        },
        queueUris: [],
        storageContent: [],
      };
    }

    return {
      name: data.name ?? name,
      configJson: data.configJson ?? JSON.stringify(data.config ?? {}),
      clusterName: data.clusterName ?? '',
      capacityMeter: {
        name: data.capacityMeter?.name ?? name,
        messages: data.capacityMeter?.messages ?? 0,
        messageCapacity: data.capacityMeter?.messageCapacity ?? 0,
        bytes: data.capacityMeter?.bytes ?? 0,
        byteCapacity: data.capacityMeter?.byteCapacity ?? 0,
      },
      queueUris: data.queueUris ?? [],
      storageContent: (data.storageContent ?? []).map((s: any) => ({
        queueUri: s.queueUri ?? '',
        queueKey: s.queueKey ?? '',
        partitionId: s.partitionId ?? 0,
        numMessages: s.numMessages ?? 0,
        numBytes: s.numBytes ?? 0,
        isPersistent: s.isPersistent ?? false,
        internalQueueId: s.internalQueueId,
      })),
    };
  }

  private parseStats(raw: string): BrokerStats {
    const stats: BrokerStats = {
      clientsCount: 0,
      queuesCount: 0,
      domains: [],
      queues: [],
    };

    try {
      const parsed = JSON.parse(raw);
      if (parsed.broker) {
        stats.clientsCount = parsed.broker.clientsCount ?? 0;
        stats.queuesCount = parsed.broker.queuesCount ?? 0;
      }
      if (parsed.domains) {
        stats.domains = parsed.domains.map((d: any) => ({
          name: d.name ?? '',
          configuredMessages: d.configuredMessages ?? 0,
          configuredBytes: d.configuredBytes ?? 0,
          queueCount: d.queueCount ?? 0,
          queueCountOpen: d.queueCountOpen ?? 0,
        }));
      }
      if (parsed.queues) {
        stats.queues = parsed.queues.map((q: any) => this.parseQueueStats(q));
      }
    } catch {
      // Parse from text format
      const lines = raw.split('\n');
      for (const line of lines) {
        const clientMatch = line.match(/clients?\s*:\s*(\d+)/i);
        if (clientMatch) stats.clientsCount = parseInt(clientMatch[1], 10);
        const queueMatch = line.match(/queues?\s*:\s*(\d+)/i);
        if (queueMatch) stats.queuesCount = parseInt(queueMatch[1], 10);
      }
    }

    return stats;
  }

  private parseQueueStats(data: any): QueueStats {
    return {
      uri: data.uri ?? data.queueUri ?? '',
      role: data.role ?? 'UNKNOWN',
      messagesCount: data.messagesCount ?? data.messages_current ?? 0,
      messagesCapacity: data.messagesCapacity ?? data.messages_max ?? 0,
      bytesCount: data.bytesCount ?? data.bytes_current ?? 0,
      bytesCapacity: data.bytesCapacity ?? data.bytes_max ?? 0,
      putMessagesDelta: data.putMessagesDelta ?? data.put_messages_delta ?? 0,
      putBytesDelta: data.putBytesDelta ?? data.put_bytes_delta ?? 0,
      pushMessagesDelta: data.pushMessagesDelta ?? data.push_messages_delta ?? 0,
      pushBytesDelta: data.pushBytesDelta ?? data.push_bytes_delta ?? 0,
      ackMessagesDelta: data.ackMessagesDelta ?? data.ack_delta ?? 0,
      confirmMessagesDelta: data.confirmMessagesDelta ?? data.confirm_delta ?? 0,
      nackCount: data.nackCount ?? data.nack ?? 0,
      numProducers: data.numProducers ?? data.nb_producer ?? 0,
      numConsumers: data.numConsumers ?? data.nb_consumer ?? 0,
      ackTimeAvg: data.ackTimeAvg ?? data.ack_time_avg ?? 0,
      ackTimeMax: data.ackTimeMax ?? data.ack_time_max ?? 0,
      confirmTimeAvg: data.confirmTimeAvg ?? data.confirm_time_avg ?? 0,
      confirmTimeMax: data.confirmTimeMax ?? data.confirm_time_max ?? 0,
      queueTimeAvg: data.queueTimeAvg ?? data.queue_time_avg ?? 0,
      queueTimeMax: data.queueTimeMax ?? data.queue_time_max ?? 0,
    };
  }
}
