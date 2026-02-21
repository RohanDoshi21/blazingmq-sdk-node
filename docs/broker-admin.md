# Broker Admin API

This document describes the `BrokerAdmin` class — a direct admin command interface
for monitoring and managing a BlazingMQ broker instance via its admin TCP port.

## Overview

Unlike the `Admin` class (which manages queues through the standard client
protocol), `BrokerAdmin` connects to the broker's **admin port** and sends
text-based admin commands. This provides access to operations not available
through the normal client protocol:

- **Cluster management** — node health, elector state, partitions, storage
- **Domain management** — config, capacity, purge, reconfigure
- **Queue operations** — internals, message listing, purge
- **Statistics** — broker-wide stats, queue metrics, tunables
- **Broker configuration** — runtime config dump
- **Danger zone** — shutdown, terminate

```
┌──────────────────────┐
│     BrokerAdmin      │  Layer 4+: Admin Operations
│  (Admin Commands)    │
├──────────────────────┤
│     TCP Socket       │  Direct TCP connection (not BlazingMQ protocol)
├──────────────────────┤
│  Broker Admin Port   │  Default: 30114
└──────────────────────┘
```

## Connection Model

`BrokerAdmin` opens a **new TCP connection for each command**. This is by design:

- The broker's admin interface is text-based (send command, receive response, close).
- No persistent connection state to manage or heartbeat.
- Safe for infrequent admin operations; not designed for high-frequency polling.
- Each command has a configurable timeout (default: 10 seconds).

## Quick Start

```typescript
import { BrokerAdmin } from 'blazingmq-node';

const admin = new BrokerAdmin({
  host: 'localhost',   // broker host
  port: 30114,         // broker admin port
  timeout: 10000,      // command timeout (ms)
});

// Check connectivity
const isUp = await admin.ping();
console.log('Broker reachable:', isUp);

// Get cluster health
const clusters = await admin.listClusters();
const status = await admin.getClusterStatus(clusters[0]);
console.log('Cluster healthy:', status.isHealthy);
console.log('Nodes:', status.nodeStatuses.length);

// Get statistics
const stats = await admin.getStats();
console.log('Connected clients:', stats.clientsCount);
console.log('Active queues:', stats.queuesCount);

// Inspect a domain
const domain = await admin.getDomainInfo('bmq.test.mem.priority');
console.log('Queues:', domain.queueUris);
console.log('Messages:', domain.capacityMeter.messages);
```

## API Reference

### Constructor

```typescript
new BrokerAdmin(options?: BrokerAdminOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | `'localhost'` | Broker hostname or IP |
| `port` | `number` | `30114` | Broker admin port |
| `timeout` | `number` | `10000` | Command timeout in milliseconds |

### Health & Connectivity

| Method | Returns | Description |
|--------|---------|-------------|
| `ping()` | `Promise<boolean>` | Check if broker is reachable |
| `help()` | `Promise<string>` | Get list of supported admin commands |
| `sendCommand(cmd)` | `Promise<string>` | Send a raw admin command |

### Cluster Management

| Method | Returns | Description |
|--------|---------|-------------|
| `listClusters()` | `Promise<string[]>` | List all active cluster names |
| `getClusterStatus(cluster)` | `Promise<ClusterStatus>` | Full cluster health: nodes, elector, partitions, queues, storage |
| `forceGcQueues(cluster)` | `Promise<string>` | Trigger garbage collection of idle queues |
| `getClusterStorageSummary(cluster)` | `Promise<ClusterStorageSummary>` | Storage byte counts per partition |
| `getPartitionSummary(cluster, partitionId)` | `Promise<any>` | Detailed partition info |
| `setPartitionState(cluster, partitionId, enable)` | `Promise<string>` | Enable or disable a partition |
| `getStorageQueueStatus(cluster, domain)` | `Promise<StorageQueueInfo[]>` | Queue storage status within a cluster/domain |

### Domain Management

| Method | Returns | Description |
|--------|---------|-------------|
| `getDomainInfo(domain)` | `Promise<DomainInfo>` | Domain config, capacity, queues, storage content |
| `purgeDomain(domain)` | `Promise<PurgeResult[]>` | Purge all queues in a domain |
| `purgeQueue(domain, queue, appId?)` | `Promise<PurgeResult>` | Purge a specific queue (default appId: `'*'`) |
| `getQueueInternals(domain, queue)` | `Promise<QueueInternals>` | Handles, consumers, storage, routing info |
| `listQueueMessages(domain, queue, offset?, count?, appId?)` | `Promise<QueueMessage[]>` | List messages in a queue |
| `reconfigureDomain(domain)` | `Promise<string>` | Hot-reload domain config from disk |
| `clearDomainCache(domain?)` | `Promise<string>` | Clear domain resolver cache (omit arg for ALL) |

### Statistics

| Method | Returns | Description |
|--------|---------|-------------|
| `getStats()` | `Promise<BrokerStats>` | Broker-wide statistics: clients, queues, per-queue metrics |
| `listTunables()` | `Promise<string>` | List available tunable parameters |
| `getTunable(param)` | `Promise<string>` | Get current value of a tunable |
| `setTunable(param, value)` | `Promise<string>` | Set a tunable parameter value |

### Broker Configuration

| Method | Returns | Description |
|--------|---------|-------------|
| `getBrokerConfig()` | `Promise<BrokerConfig>` | Dump current broker config (raw + parsed JSON) |

### Danger Zone

| Method | Returns | Description |
|--------|---------|-------------|
| `shutdown()` | `Promise<string>` | Graceful broker shutdown (drain connections, flush storage) |
| `terminate()` | `Promise<string>` | Immediate broker termination (may cause data loss) |

## Type Reference

### ClusterStatus

```typescript
interface ClusterStatus {
  name: string;                          // Cluster name
  description: string;                   // Cluster description
  selfNodeDescription: string;           // Current node's identity
  isHealthy: boolean;                    // Overall health
  nodeStatuses: ClusterNodeStatus[];     // Per-node health
  electorInfo: ElectorInfo;              // Leader election state
  partitionsInfo: PartitionInfo[];       // Per-partition info
  queuesInfo: ClusterQueueInfo[];        // Queues in the cluster
  clusterStorageSummary: ClusterStorageSummary; // Storage usage
}
```

### ClusterNodeStatus

```typescript
interface ClusterNodeStatus {
  description: string;             // Node address (e.g. "host:port")
  isAvailable: boolean;            // Node reachability
  status: string;                  // E_UNKNOWN | E_STARTING | E_AVAILABLE | E_STOPPING | E_UNAVAILABLE
  primaryForPartitionIds: number[]; // Partition IDs this node is primary for
}
```

### ElectorInfo

```typescript
interface ElectorInfo {
  electorState: string;   // DORMANT | FOLLOWER | CANDIDATE | LEADER
  leaderNode: string;     // Current leader node description
  leaderStatus: string;   // UNDEFINED | PASSIVE | ACTIVE
  leaderMessageSequence?: {
    electorTerm: number;
    sequenceNumber: number;
  };
}
```

### PartitionInfo

```typescript
interface PartitionInfo {
  partitionId: number;
  numQueuesMapped: number;
  numActiveQueues: number;
  primaryNode: string;
  primaryLeaseId: number;
  primaryStatus: string;
}
```

### DomainInfo

```typescript
interface DomainInfo {
  name: string;
  configJson: string;                 // Raw domain config JSON
  clusterName: string;                // Owning cluster
  capacityMeter: CapacityMeter;       // Current usage vs limits
  queueUris: string[];                // Active queue URIs
  storageContent: StorageQueueInfo[]; // Per-queue storage detail
}
```

### CapacityMeter

```typescript
interface CapacityMeter {
  name: string;
  messages: number;            // Current message count
  messageCapacity: number;     // Max messages
  bytes: number;               // Current bytes used
  byteCapacity: number;        // Max bytes
}
```

### QueueInternals

```typescript
interface QueueInternals {
  queueUri: string;
  state: string;                // OPEN, CLOSED, etc.
  partitionId: number;
  storageInfo: {
    numMessages: number;
    numBytes: number;
    virtualStorages: number;
  };
  handles: QueueHandleInfo[];   // Connected client handles
  consumers: QueueConsumerInfo[]; // Consumer groups
}
```

### QueueStats

```typescript
interface QueueStats {
  uri: string;
  role: string;                  // PRIMARY | REPLICA | PROXY
  messagesCount: number;         // Current messages in queue
  messagesCapacity: number;      // Max messages
  bytesCount: number;            // Current bytes
  bytesCapacity: number;         // Max bytes
  putMessagesDelta: number;      // PUT rate (messages/interval)
  putBytesDelta: number;         // PUT rate (bytes/interval)
  pushMessagesDelta: number;     // PUSH rate (messages/interval)
  pushBytesDelta: number;        // PUSH rate (bytes/interval)
  ackMessagesDelta: number;      // ACK rate
  confirmMessagesDelta: number;  // CONFIRM rate
  nackCount: number;             // Negative acknowledgments
  numProducers: number;          // Connected producers
  numConsumers: number;          // Connected consumers
  ackTimeAvg: number;            // Average ACK latency (ms)
  ackTimeMax: number;            // Max ACK latency (ms)
  confirmTimeAvg: number;        // Average CONFIRM latency (ms)
  confirmTimeMax: number;        // Max CONFIRM latency (ms)
  queueTimeAvg: number;          // Average queue time (ms)
  queueTimeMax: number;          // Max queue time (ms)
}
```

### BrokerStats

```typescript
interface BrokerStats {
  clientsCount: number;       // Total connected clients
  queuesCount: number;        // Total active queues
  domains: DomainStats[];     // Per-domain stats
  queues: QueueStats[];       // Per-queue stats
}
```

### BrokerConfig

```typescript
interface BrokerConfig {
  raw: string;                           // Raw config text
  parsed: Record<string, unknown> | null; // Parsed JSON (null if not JSON)
}
```

### PurgeResult

```typescript
interface PurgeResult {
  queue: string;
  appId: string;
  numMessagesPurged: number;
  numBytesPurged: number;
}
```

## Response Parsing

`BrokerAdmin` handles two types of broker responses:

1. **JSON responses** — Parsed automatically and mapped to TypeScript interfaces
   with safe defaults for missing fields.
2. **Text responses** — Returned as raw strings. Where possible (e.g., `getStats`),
   the parser extracts key values using regex patterns.

All response parsers are defensive: missing fields are filled with safe defaults
(empty strings, zero numbers, empty arrays) rather than throwing errors. This
ensures the admin API is resilient to broker version differences.

## Error Handling

```typescript
try {
  const status = await admin.getClusterStatus('my-cluster');
} catch (err) {
  if (err.message.includes('timed out')) {
    // Command took too long — broker may be overloaded
  } else if (err.message.includes('failed')) {
    // TCP connection failed — broker may be down
  }
}
```

Errors are thrown as standard `Error` instances with descriptive messages:
- `"Admin command timed out after Xms: COMMAND"` — Timeout
- `"Admin command failed: REASON"` — TCP connection error

## Broker Command Reference

The broker's admin interface accepts text commands over TCP. `BrokerAdmin`
wraps these into typed methods, but you can also use `sendCommand()` directly:

```typescript
// Equivalent to admin.listClusters()
const raw = await admin.sendCommand('CLUSTERS LIST');

// Equivalent to admin.getClusterStatus('my-cluster')
const raw2 = await admin.sendCommand('CLUSTERS CLUSTER my-cluster STATUS');

// Equivalent to admin.purgeQueue('bmq.test', 'orders')
const raw3 = await admin.sendCommand('DOMAINS DOMAIN bmq.test QUEUE orders PURGE APPID *');
```

**Full command tree:**

| Category | Command | Description |
|----------|---------|-------------|
| General | `HELP` | List available commands |
| Clusters | `CLUSTERS LIST` | List clusters |
| Clusters | `CLUSTERS CLUSTER <name> STATUS` | Cluster status |
| Clusters | `CLUSTERS CLUSTER <name> FORCE_GC_QUEUES` | Force queue GC |
| Clusters | `CLUSTERS CLUSTER <name> STORAGE SUMMARY` | Storage summary |
| Clusters | `CLUSTERS CLUSTER <name> STORAGE PARTITION <id> SUMMARY` | Partition detail |
| Clusters | `CLUSTERS CLUSTER <name> STORAGE PARTITION <id> ENABLE\|DISABLE` | Toggle partition |
| Clusters | `CLUSTERS CLUSTER <name> STORAGE DOMAIN <dom> QUEUE_STATUS` | Queue storage status |
| Domains | `DOMAINS DOMAIN <name> INFOS` | Domain info |
| Domains | `DOMAINS DOMAIN <name> PURGE` | Purge domain |
| Domains | `DOMAINS DOMAIN <name> QUEUE <q> PURGE APPID <id>` | Purge queue |
| Domains | `DOMAINS DOMAIN <name> QUEUE <q> INTERNALS` | Queue internals |
| Domains | `DOMAINS DOMAIN <name> QUEUE <q> LIST [appId] <off> <count>` | List messages |
| Domains | `DOMAINS RECONFIGURE <name>` | Hot-reload config |
| Domains | `DOMAINS RESOLVER CACHE_CLEAR <name\|ALL>` | Clear resolver cache |
| Stats | `STAT SHOW` | Broker statistics |
| Stats | `STAT LIST_TUNABLES` | List tunable params |
| Stats | `STAT GET <param>` | Get tunable value |
| Stats | `STAT SET <param> <value>` | Set tunable value |
| Config | `BROKERCONFIG DUMP` | Dump broker config |
| Danger | `DANGER SHUTDOWN` | Graceful shutdown |
| Danger | `DANGER TERMINATE` | Immediate termination |
