// ============================================================================
// BlazingMQ Node.js SDK — Broker Admin API
//
// Admin command interface to a BlazingMQ broker. Query commands use native
// JSON output via the ENCODING JSON_COMPACT protocol flag.  Mutation and
// text-only commands return raw strings.
//
// Types reflect the broker's native JSON structures — no custom text parsing.
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
// Types — Broker Native JSON Structures
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

export interface ClusterInfo {
  locality: string;
  name: string;
  nodes: Array<{
    hostName: string;
    nodeId: number;
    dataCenter: string;
  }>;
}

export interface ClusterNodeStatus {
  description: string;
  status: string;
  primaryForPartitionIds: number[];
}

export interface ElectorInfo {
  electorState: string;
  leaderNode: string;
  leaderStatus: string;
  leaderMessageSequence?: {
    electorTerm: number;
    sequenceNumber: number;
  };
}

export interface PartitionInfo {
  numQueuesMapped: number;
  numActiveQueues: number;
  primaryNode: string;
  primaryLeaseId: number;
  primaryStatus: string;
}

export interface StorageInfo {
  queueUri: string;
  queueKey: string;
  partitionId: number;
  numMessages: number;
  numBytes: number;
  isPersistent: boolean;
  internalQueueId: number;
}

export interface FileStoreSummary {
  primaryNodeDescription: string;
  primaryLeaseId: number;
  sequenceNum: number;
  isAvailable: boolean;
  totalMappedBytes: number;
  numOutstandingRecords: number;
  numUnreceiptedMessages: number;
  storageContent: { storages: StorageInfo[] };
  fileSets?: Array<Record<string, unknown>>;
  activeFileSet?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FileStoreInfo {
  partitionId: number;
  state: string;
  summary: FileStoreSummary;
}

export interface ClusterStorageSummary {
  clusterFileStoreLocation: string;
  fileStores: FileStoreInfo[];
}

export interface ClusterStatus {
  name: string;
  description: string;
  selfNodeDescription: string;
  isHealthy: boolean;
  nodeStatuses: { nodes: ClusterNodeStatus[] };
  electorInfo: ElectorInfo;
  partitionsInfo: { partitions: PartitionInfo[] };
  queuesInfo: { storages: StorageInfo[] };
  clusterStorageSummary: ClusterStorageSummary;
}

// --- Domain Types ---

export interface CapacityMeter {
  name: string;
  isDisabled: boolean;
  numMessages: number;
  messageCapacity: number;
  numMessagesReserved: number;
  numBytes: number;
  byteCapacity: number;
  numBytesReserved: number;
}

export interface DomainInfo {
  name: string;
  configJson: string;
  clusterName: string;
  capacityMeter: CapacityMeter;
  queueUris: string[];
  storageContent: Record<string, unknown>;
}

// --- Queue Types ---

export interface VirtualStorage {
  appId: string;
  appKey: string;
  numMessages: number;
}

export interface QueueHandle {
  clientDescription: string;
  parametersJson: string;
  isClientClusterMember: boolean;
  subStreams: Array<Record<string, unknown>>;
}

export interface QueueState {
  uri: string;
  handleParametersJson: string;
  streamParametersJson: string;
  id: number;
  key: string;
  partitionId: number;
  storage: {
    numMessages: number;
    numBytes: number;
    virtualStorages: VirtualStorage[];
  };
  capacityMeter: CapacityMeter & { parent?: CapacityMeter };
  handles: QueueHandle[];
}

export interface QueueInternals {
  state: QueueState;
  queue: Record<string, unknown>;
}

// --- Stats Types ---

export interface QueueStatValues {
  [key: string]: number;
}

export interface DomainQueueStats {
  [queueUri: string]: { values: QueueStatValues };
}

export interface BrokerStats {
  domainQueues: {
    domains: Record<string, DomainQueueStats>;
  };
}

// --- Purge Types ---

export interface PurgeResult {
  queue: string;
  appId: string;
  numMessagesPurged: number;
  numBytesPurged: number;
}

// --- Message Types ---

export interface QueueMessage {
  guid: string;
  offset: number;
  size: number;
  arrivalTimestamp: string;
  properties: Record<string, unknown>;
}

// --- Config Types ---

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
 * Query commands use `ENCODING JSON_COMPACT` for native JSON responses.
 * Mutation commands (purge, reconfigure, GC, shutdown) return raw text.
 *
 * @example
 * ```typescript
 * const admin = new BrokerAdmin({ host: 'localhost', port: 30114 });
 * const clusters = await admin.listClusters();
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

  // ==========================================================================
  // Low-Level Command Execution
  // ==========================================================================

  /**
   * Send a raw admin command to the broker and return the text response.
   *
   * Opens a new TCP connection, performs BMQ protocol negotiation,
   * sends an AdminCommand, and awaits the AdminCommandResponse.
   */
  async sendCommand(command: string): Promise<string> {
    const conn = new BmqConnection({
      host: this.options.host,
      port: this.options.port,
      connectTimeout: this.options.timeout,
      reconnect: false,
    });

    conn.on('error', () => {});

    try {
      await conn.connect();

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
          guidInfo: { clientId: '', nanoSecondsFromEpoch: 0 },
          userAgent: `${SDK_NAME}/${SDK_VERSION_STRING} (admin)`,
        },
      };

      conn.send(buildControlEvent(clientIdentity));

      const negoResponse = await this.waitForEvent(
        conn,
        EventType.CONTROL,
        this.options.timeout,
      );
      const negoParsed = parseControlPayload(negoResponse);

      if (
        negoParsed.brokerResponse?.result?.category &&
        negoParsed.brokerResponse.result.category !== 'E_SUCCESS'
      ) {
        throw new Error(
          `Broker rejected negotiation: ${
            negoParsed.brokerResponse.result.message ||
            negoParsed.brokerResponse.result.category
          }`,
        );
      }

      conn.send(buildControlEvent({ rId: 1, adminCommand: { command } }));

      const responseBuf = await this.waitForEvent(
        conn,
        EventType.CONTROL,
        this.options.timeout,
      );
      const responseParsed = parseControlPayload(responseBuf);
      const text =
        responseParsed.adminCommandResponse?.text ??
        responseParsed.raw ??
        '';

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
   * Send a command with ENCODING JSON_COMPACT and parse the JSON response.
   * Throws if the broker does not return valid JSON.
   */
  private async sendJsonCommand<T = unknown>(command: string): Promise<T> {
    const response = await this.sendCommand(
      `ENCODING JSON_COMPACT ${command}`,
    );
    try {
      return JSON.parse(response) as T;
    } catch {
      throw new Error(
        `Expected JSON response for "${command}": ${response.substring(0, 200)}`,
      );
    }
  }

  /**
   * Wait for a specific event type from the connection.
   * Automatically responds to heartbeat requests.
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
        if (type === EventType.HEARTBEAT_REQ) {
          try {
            conn.send(buildHeartbeatResponse());
          } catch {
            // Ignore
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

  // ==========================================================================
  // Health & Connectivity
  // ==========================================================================

  /** Ping the broker to verify connectivity. */
  async ping(): Promise<boolean> {
    try {
      await this.sendCommand('HELP');
      return true;
    } catch {
      return false;
    }
  }

  /** Get help text listing all supported admin commands. */
  async help(): Promise<string> {
    return this.sendCommand('HELP');
  }

  // ==========================================================================
  // Cluster Management
  // ==========================================================================

  /** List all active clusters and their nodes. */
  async listClusters(): Promise<ClusterInfo[]> {
    const result = await this.sendJsonCommand<{
      clusterList?: { clusters?: ClusterInfo[] };
    }>('CLUSTERS LIST');
    return result.clusterList?.clusters ?? [];
  }

  /** Get detailed status for a specific cluster. */
  async getClusterStatus(clusterName: string): Promise<ClusterStatus> {
    const result = await this.sendJsonCommand<{
      clusterStatus?: ClusterStatus;
    }>(`CLUSTERS CLUSTER ${clusterName} STATUS`);
    if (!result.clusterStatus) {
      throw new Error(`No status returned for cluster "${clusterName}"`);
    }
    return result.clusterStatus;
  }

  /** Force garbage collection of idle queues. */
  async forceGcQueues(clusterName: string): Promise<string> {
    return this.sendCommand(
      `CLUSTERS CLUSTER ${clusterName} FORCE_GC_QUEUES`,
    );
  }

  /** Get storage summary for a cluster. */
  async getClusterStorageSummary(
    clusterName: string,
  ): Promise<unknown> {
    return this.sendJsonCommand(
      `CLUSTERS CLUSTER ${clusterName} STORAGE SUMMARY`,
    );
  }

  /** Get summary for a specific partition. */
  async getPartitionSummary(
    clusterName: string,
    partitionId: number,
  ): Promise<unknown> {
    return this.sendJsonCommand(
      `CLUSTERS CLUSTER ${clusterName} STORAGE PARTITION ${partitionId} SUMMARY`,
    );
  }

  /** Enable or disable a partition. */
  async setPartitionState(
    clusterName: string,
    partitionId: number,
    enable: boolean,
  ): Promise<string> {
    const action = enable ? 'ENABLE' : 'DISABLE';
    return this.sendCommand(
      `CLUSTERS CLUSTER ${clusterName} STORAGE PARTITION ${partitionId} ${action}`,
    );
  }

  /** Get queue status in storage for a domain within a cluster. */
  async getStorageQueueStatus(
    clusterName: string,
    domainName: string,
  ): Promise<unknown> {
    return this.sendJsonCommand(
      `CLUSTERS CLUSTER ${clusterName} STORAGE DOMAIN ${domainName} QUEUE_STATUS`,
    );
  }

  // ==========================================================================
  // Domain Management
  // ==========================================================================

  /** Get detailed info about a domain including config and queues. */
  async getDomainInfo(domainName: string): Promise<DomainInfo> {
    const result = await this.sendJsonCommand<{
      domainInfo?: DomainInfo;
    }>(`DOMAINS DOMAIN ${domainName} INFOS`);
    if (!result.domainInfo) {
      throw new Error(`No info returned for domain "${domainName}"`);
    }
    return result.domainInfo;
  }

  /** Purge all queues in a domain. Returns raw response text. */
  async purgeDomain(domainName: string): Promise<string> {
    return this.sendCommand(`DOMAINS DOMAIN ${domainName} PURGE`);
  }

  /** Purge a specific queue. Returns raw response text. */
  async purgeQueue(
    domainName: string,
    queueName: string,
    appId: string = '*',
  ): Promise<string> {
    return this.sendCommand(
      `DOMAINS DOMAIN ${domainName} QUEUE ${queueName} PURGE APPID ${appId}`,
    );
  }

  /** Get queue internals (handles, consumers, routing, storage). */
  async getQueueInternals(
    domainName: string,
    queueName: string,
  ): Promise<QueueInternals> {
    const result = await this.sendJsonCommand<{
      queueInternals?: QueueInternals;
    }>(`DOMAINS DOMAIN ${domainName} QUEUE ${queueName} INTERNALS`);
    if (!result.queueInternals) {
      throw new Error(
        `No internals returned for queue "${queueName}" in domain "${domainName}"`,
      );
    }
    return result.queueInternals;
  }

  /** List messages in a queue. */
  async listQueueMessages(
    domainName: string,
    queueName: string,
    offset: number = 0,
    count: number = 100,
    appId?: string,
  ): Promise<QueueMessage[]> {
    const appIdPart = appId ? ` ${appId}` : '';
    const response = await this.sendJsonCommand<{ messages?: QueueMessage[] }>(
      `DOMAINS DOMAIN ${domainName} QUEUE ${queueName} LIST${appIdPart} ${offset} ${count}`,
    );
    return response.messages ?? [];
  }

  /** Hot-reload domain configuration from disk. */
  async reconfigureDomain(domainName: string): Promise<string> {
    return this.sendCommand(`DOMAINS RECONFIGURE ${domainName}`);
  }

  /** Clear domain resolver cache. */
  async clearDomainCache(domainName?: string): Promise<string> {
    const target = domainName ?? 'ALL';
    return this.sendCommand(`DOMAINS RESOLVER CACHE_CLEAR ${target}`);
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  /**
   * Get all broker statistics.
   *
   * The broker returns a double-encoded response: the outer JSON has a
   * `stats` field containing a stringified inner JSON object with the
   * actual domain/queue statistics.
   */
  async getStats(): Promise<BrokerStats> {
    const result = await this.sendJsonCommand<{ stats: string }>(
      'STAT SHOW',
    );
    return JSON.parse(result.stats) as BrokerStats;
  }

  /** List tunable stat parameters. */
  async listTunables(): Promise<string> {
    return this.sendCommand('STAT LIST_TUNABLES');
  }

  /** Get a stat tunable value. */
  async getTunable(param: string): Promise<string> {
    return this.sendCommand(`STAT GET ${param}`);
  }

  /** Set a stat tunable value. */
  async setTunable(param: string, value: string | number): Promise<string> {
    return this.sendCommand(`STAT SET ${param} ${value}`);
  }

  // ==========================================================================
  // Broker Configuration
  // ==========================================================================

  /** Dump the current broker configuration. */
  async getBrokerConfig(): Promise<BrokerConfig> {
    const response = await this.sendCommand('BROKERCONFIG DUMP');
    try {
      return { raw: response, parsed: JSON.parse(response) };
    } catch {
      return { raw: response, parsed: null };
    }
  }

  // ==========================================================================
  // Danger Zone
  // ==========================================================================

  /** Initiate a graceful broker shutdown. */
  async shutdown(): Promise<string> {
    return this.sendCommand('DANGER SHUTDOWN');
  }

  /** Terminate the broker immediately. */
  async terminate(): Promise<string> {
    return this.sendCommand('DANGER TERMINATE');
  }
}
