import { createLibp2p, type ConnectionMonitorInit, type Libp2p } from 'libp2p';
import { noise, type ICryptoInterface } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify, identifyPush } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayServer, type CircuitRelayServerInit } from '@libp2p/circuit-relay-v2';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { ConnectionGater, PeerId, PrivateKey } from '@libp2p/interface';
import { clusterService } from './cluster/service.js';
import { blockTransferService } from './cluster/block-transfer-service.js';
import { repoService } from './repo/service.js';
import { StorageRepo, resolvePendLeaseMs } from './storage/storage-repo.js';
import { BlockStorage } from './storage/block-storage.js';
import { withReadCache, type ReadCacheLease, type ResolvedReadCache } from './storage/with-read-cache.js';
import type { IRawStorage } from './storage/i-raw-storage.js';
import type { StoreDurability } from './storage/store-durability.js';
import { durabilityWindowMs, resolveDurabilityWindowPolicy, type DurabilityWindowFor, type DurabilityWindowPolicy, type StorageDurabilityOptions } from './storage/durability-window.js';
import { memoryNodeStorage, type NodeStorage } from './storage/node-storage.js';
import { KvUnderReplicationLedger } from './repo/kv-under-replication-ledger.js';
import { KvHlcClockStore } from './storage/kv-hlc-clock-store.js';
import type { IPieceStore } from './blob/piece-store.js';
import { LocalBlobService } from './blob/local-blob-service.js';
import { BlobCacheBudget, DEFAULT_BLOB_CACHE_BUDGET_BYTES } from './blob/cache-budget.js';
import { blobProtocolService } from './blob/blob-protocol-service.js';
import { blobAcceptanceOf } from './blob/accepts-blobs.js';
import { BlobProtocolClient } from './blob/blob-protocol-client.js';
import { BlobFetcher } from './blob/blob-fetcher.js';
import type { BlobHolderDeps } from './blob/blob-holders.js';
import { buildBlobProtocol, type BlobAnnounceAnswer } from './blob/blob-protocol.js';
import { NodeBlobService } from './blob/node-blob-service.js';
import { BlobCopyDrain, type BlobCopyDrainConfig } from './blob/blob-copy-drain.js';
import { OwedBlobLedger } from './blob/owed-blob-ledger.js';
import { BlobReferenceCheck } from './blob/reference-check.js';
import { BlobAnnounceReceiver, type BlobHoldPolicy } from './blob/announce-receiver.js';
import { BlobCohortReaction } from './blob/cohort-reaction.js';
import { resolveReclaimGraceMs } from './blob/reclaim-marks.js';
import { BlobReclaimPass } from './blob/reclaim-pass.js';
import { seedHeldBlobs } from './blob/held-blob-seed.js';
import { AnnounceLimiter } from './blob/announce-limiter.js';
import { createNodeNetworkTransactor } from './node-network-transactor.js';
import { answerFromArchiveResponse, claimFromConsultAnswer, lineageFromSyncResponse, servableProof, serveLineageAnswer, type ArchiveServingRepo } from './storage/block-archive.js';
import type { BlockLineageAsk } from './cluster/solo-ahead.js';
import { createServedRepoProxy } from './repo/served-repo-proxy.js';
import { seedOwnedBlocksFromStorage } from './owned-block-seed.js';
import { clusterMember, type ReconcileBlockCallback, type CommitCertificateSink, type BlockHoldersSink, type CohortCommitAppliedSink, type DeriveExpectedClusterCallback } from './cluster/cluster-repo.js';
import { createReconcileBlock } from './cluster/reconcile-block.js';
import { resolveClusterPolicy, type ClusterPolicyOptions, type ResolvedClusterPolicy } from './cluster/cluster-policy.js';
import { assertClusterSizeCoupling } from './cluster/cluster-size-coupling.js';
import type { Libp2pConnectionTimeouts } from './connection-monitor.js';
import { createCommitCertStore, makeClusterCommitCertExtractor, type CommitCertStore } from './cluster/commit-cert.js';
import { coordinatorRepo } from './repo/coordinator-repo.js';
import { Libp2pKeyPeerNetwork, type BootstrapContactOptions, type NetworkStatePersistence } from './libp2p-key-network.js';
import { mergePeerAddresses, publishableAddrsForPeer, type AddressLog } from './peer-address-book.js';
import type { OptimysticClientNode, OptimysticClientNodeAttachments, OptimysticNode, OptimysticNodeAttachments, OptimysticNodeAttachmentsBase } from './optimystic-node.js';
import { ClusterClient } from './cluster/client.js';
import type { IRepo, ICluster, ITransactionValidator, BlockId, ActionRev, IBlockChangeNotifier, BlobDigest, BlobRef, BlobScope } from '@optimystic/db-core';
import type { ITransactionStateStore } from './cluster/i-transaction-state-store.js';
import { PersistentTransactionStateStore } from './cluster/persistent-transaction-state-store.js';
import { networkManagerService, type NetworkManagerService } from './network/network-manager-service.js';
import { assertCircuitRelayTransport, assertRelayAddrsAdvertisable, planRelayListenAddrs, superviseRelayReservations, type RelayReservationSupervisorOptions } from './network/relay-reservation.js';
import { BootstrapContactTracker, planBootstrapTargets } from './network/bootstrap-contact.js';
import { combineIdentifyObservers, identifyOnConnectionOpen, type IdentifyOnOpenHost } from './network/identify-on-open.js';
import { IdentifyProgress } from './network/identify-progress.js';
import { throttleProtocolMerges } from './network/protocol-merge-throttle.js';
import { filterStorageClaimMerges } from './network/storage-claim-filter.js';
import { buildRepoProtocol, storageServingProtocols } from './network/storage-protocols.js';
import { KeyNetworkCohortReachability } from './network/cohort-reachability.js';
import { holePunchingWanted } from './network/hole-punching.js';
import type { SpreadOnChurnConfig, SpreadOnChurnMonitor } from './cluster/spread-on-churn.js';
import { BlockTransferCoordinator } from './cluster/block-transfer.js';
import { buildBlockTransferProtocol, pushBlockToPeers } from './cluster/block-transfer-service.js';
import { PreparedStreams } from './network/prepared-streams.js';
import { UnderReplicationDrain, type UnderReplicationDrainConfig } from './repo/under-replication-drain.js';
import { assertReportedRevision, recordHeldCopy, type HeldCopyDeps } from './repo/owed-copies.js';
import { RebalanceMonitor, type RebalanceMonitorConfig } from './cluster/rebalance-monitor.js';
import { fretService, Libp2pFretService } from 'p2p-fret';
import { syncService } from './sync/service.js';
import { SyncClient } from './sync/client.js';
import { buildSyncProtocol } from './sync/protocol.js';
import { resolveBootstrapContactTimeoutMs, resolveLibp2pDialTimeoutMs, resolveLinkDeadlines, resolvePingHandlerTimeoutMs, withinRequestBudget, type LinkDeadlines, type RpcDeadlineDefaults } from './rpc-deadline.js';
import type { ClusterLatestAnswer, ClusterLatestCallback } from './repo/coordinator-repo.js';
import type { ClusterLatestBatchCallback } from './repo/consult-round.js';
import { RestorationCoordinator } from './storage/restoration-coordinator.js';
import { RingSelector } from './storage/ring-selector.js';
import { RingShiftCoordinator } from './storage/ring-shift-coordinator.js';
import { StorageMonitor } from './storage/storage-monitor.js';
import type { StorageMonitorConfig } from './storage/storage-monitor.js';
import { ArachnodeFretAdapter } from './storage/arachnode-fret-adapter.js';
import type { RestoreCallback, BlockArchive } from './storage/struct.js';
import type { FretService } from 'p2p-fret';
import { createCohortTopicHost, type CohortTopicHostOptions } from './cohort-topic/host.js';
import { CommitLogTrustAnchor } from './cohort-topic/commit-log-trust-anchor.js';
import { proofThresholds } from './cluster/certified-claims.js';
import { attachCohortChangeBridge } from './cohort-topic/change-bridge.js';
import { Libp2pReactivityNotifyTransport, registerNotifyHandler } from './reactivity/notify-transport.js';
import {
	Libp2pReactivityRecoverTransport,
	createLibp2pRecoverDialer,
	registerRecoverHandler,
	createRecoverRequestSigners,
} from './reactivity/recover-transport.js';
import { ReactivityForwarderHost, reactivityDirectSubscribers } from './reactivity/forwarder-host.js';
import { ReactivityOriginationManager, liveOriginationContext } from './reactivity/origination-manager.js';
import { ReactivityPushStateGossipDriver, registerPushStateGossipHandler, type ReactivityGossipCollection } from './reactivity/push-state-gossip.js';
import { RotationReRegistrationScheduler } from './reactivity/rotation-rereg-scheduler.js';
import { ReactivitySubscriberRegistry } from './reactivity/subscriber-registry.js';
import { ReactivityCollectionWatch } from './reactivity/collection-watch.js';
import { peerIdToBytes } from './cohort-topic/peer-codec.js';
import { DEFAULT_REACTIVITY_PROTOCOLS, reactivityProtocolList } from './reactivity/protocols.js';
import { registerMatchmakingQueryHandler } from './matchmaking/query-transport.js';
import { ArrivalPushDriver } from './matchmaking/arrival-push-driver.js';
import { ArrivalPushReceiver, registerArrivalPushHandler } from './matchmaking/arrival-push-receiver.js';
import { createArrivalPushSend } from './matchmaking/arrival-push-send.js';
import { DEFAULT_MATCHMAKING_PROTOCOLS, matchmakingProtocolList } from './matchmaking/protocols.js';
import { signPeer } from './cohort-topic/peer-sig.js';
import {
	createNotificationVerifier,
	createCorrelationReplayGuard,
	createStickyCohortHintCache,
	reactivityNodePolicy,
	reactivityRootCoord,
	createTierAddressing,
	createRingHash,
	createSlotAssigner,
	Tier,
	b64urlToBytes,
	bytesToB64url,
	type NotificationV1,
	type CohortRef,
	type PushState,
	type PushStateGossipV1,
	type PushStateInit,
	type NotificationVerifier,
} from '@optimystic/db-core';
import { HlcClock, routingKeyForBlob, routingKeyForBlock } from '@optimystic/db-core';
import { PartitionDetector } from './cluster/partition-detector.js';
import { assertSuperMajorityCoupling } from './cluster/supermajority-coupling.js';
import { createLogger } from './logger.js';
import { PeerReputationService } from './reputation/peer-reputation.js';
import type { IPeerReputation } from './reputation/types.js';
import type { AuthorizeInboundStream, InboundStreamAuthorizationInit } from './inbound-authorization.js';
import { admittedBy, createNetworkMembershipGate, type IsNetworkMember, type NetworkMembershipGate } from './network-membership-gate.js';
import { DisputeService } from './dispute/dispute-service.js';
import { DisputeClient } from './dispute/client.js';
import { sampleArbitrators } from './dispute/arbitrator-selection.js';
import type { DisputeConfig } from './dispute/types.js';

type Libp2pInit = NonNullable<Parameters<typeof createLibp2p>[0]>;
export type Libp2pTransports = NonNullable<Libp2pInit['transports']>;

/** A service that accepts post-construction injection of the running libp2p node. */
interface SetLibp2pCapable {
	setLibp2p(libp2p: Libp2p): void;
}

/** A service that accepts post-start injection of the peer-reputation view. */
interface SetReputationCapable {
	setReputation(reputation: IPeerReputation): void;
}

/**
 * The custom services that receive post-assembly dependency injection. Reaching them through this
 * typed record (rather than `(node as any).services?.fret?.setLibp2p?.(...)`) removes the silent
 * optional-chaining skips: a call like `wired.fret.setLibp2p(node)` is checked against these
 * interfaces at build time (a caller-side typo or wrong-arity call fails tsc), and if the service is
 * absent at runtime the property access throws (fail-fast) instead of being quietly no-op'd. Note the
 * config-side `services` map is itself cast (see the comment at its declaration), so a service RENAME
 * is caught here at runtime, not by tsc, and a signature change on the real service is caught only at
 * that service's own definition. `fret` and `networkManager` are unconditionally present in that
 * config, so a throw here is a genuine wiring bug, not a missing service; `repo` is present exactly on a
 * node that serves blocks (`NodeOptions.servesBlocks`), and read only there.
 */
type WiredServices = {
	fret: SetLibp2pCapable;
	networkManager: SetLibp2pCapable & SetReputationCapable;
	repo?: SetLibp2pCapable;
};

/**
 * Logger for the best-effort in-factory service wiring. These injections run during `createLibp2p`
 * internals against the unreliable `components.libp2p` proxy; the real node is re-injected
 * post-construction (see the load-bearing block after `createLibp2p`), so a failure here is logged,
 * not fatal.
 */
const wiringLog = createLogger('node-wiring');
/** The blob protocol's own channel, for the `held` frames the node answers before anything acts on them. */
const blobLog = createLogger('blob:protocol');
/** The blob copy channel, which the blob cohort monitor and its reaction also log under, so one filter shows a blob's whole copy story. */
const blobCopyLog = createLogger('blob:copy');

/**
 * `ClusterPolicyOptions` is intersected in, not restated: `resolveClusterPolicy` consumes those
 * fields structurally, so a second copy of the shape here would let a newly added knob compile and
 * be silently ignored. See `cluster/cluster-policy.ts` for what each one resolves to.
 */
export type NodeOptions = ClusterPolicyOptions & {
	/**
	 * Network port. Only used by the default `listenAddrs` fallback.
	 * For non-TCP transports (e.g. WebSockets), set `listenAddrs` explicitly.
	 */
	port?: number;
	/**
	 * WebSocket listen port. When set, the Node `createLibp2pNode` defaulting
	 * branch adds `webSockets()` to the transports and `/ip4/<wsHost>/tcp/<wsPort>/ws`
	 * to the listen addrs. Browsers and other WS-only peers (RN, web) can dial here.
	 * Ignored when `transports`/`listenAddrs` are explicitly provided.
	 */
	wsPort?: number;
	/** Interface to bind the WS listener to. Defaults to `0.0.0.0`. */
	wsHost?: string;
	/**
	 * Drop the default TCP transport and TCP listen addr. Useful for browser-only
	 * bootstraps that listen on `/ws` (typically fronted as `/wss`) only.
	 * Ignored when `transports`/`listenAddrs` are explicitly provided.
	 */
	disableTcp?: boolean;
	/**
	 * Multiaddrs of peers this node joins its network through; each must end in the peer's
	 * `/p2p/<id>`. A circuit address (`<relay>/p2p/<relay id>/p2p-circuit/p2p/<partner id>`) names
	 * the partner behind the relay. An entry naming this node itself is ignored.
	 *
	 * The node dials them the moment it has started. Naming a peer here tells the node that the
	 * peer may hold what the node is about to look for, and the node holds itself to that:
	 *
	 * - A cohort lookup that would come back with nobody but this node in it waits, once and
	 *   bounded by {@link NodeOptions.bootstrapContactTimeoutMs}, while one of these peers is on
	 *   its way into view (its dial, or identify on its connection, is in flight).
	 * - Until every one of them has been heard from at least once, the node does not conclude
	 *   that a block it lacks was never created. Opening or creating a collection on it then
	 *   fails with a `BlockUnavailableError` whose reason is `'cohort-unreachable'`, which is
	 *   retryable, instead of founding a second copy of a collection another machine already
	 *   holds. So a peer that is gone for good should be taken out of this list; an empty list
	 *   is a node that founds its own network.
	 *
	 * Heard from means identify has settled what the peer is. A peer on another network (a relay,
	 * another group's node used as infrastructure) refuses this network's identify, and that
	 * refusal is its answer: the node then knows the peer holds nothing of its own, and founds
	 * what it needs. A host whose connection gater refuses the dial has kept the node from
	 * hearing from the peer, and the second rule applies until something else connects them.
	 */
	bootstrapNodes: string[];
	/**
	 * The most a cohort lookup waits for a bootstrap peer to join this node's view, in
	 * milliseconds; see {@link NodeOptions.bootstrapNodes}. Unset, it is derived from the declared
	 * link round trip (`LinkDeadlines.bootstrapContactTimeoutMs`): twelve round trips, ten for the
	 * connection open the bootstrap dial runs under and two for identify, and never less than 10 s.
	 * A host that raises `connectionManager.dialTimeout` should raise this with it. `0` never
	 * waits; the second rule there still holds, and is then the only one, so an open made before
	 * the peer has answered is refused where it would have waited. A value that is not a finite number
	 * of milliseconds from 0 up throws at node construction.
	 */
	bootstrapContactTimeoutMs?: number;
	networkName: string;
	/**
	 * Whether this node stores blocks for the network and takes part in agreeing on writes. Default true.
	 * false: a client. It registers none of the four storage protocols (repo, cluster, sync,
	 * block-transfer), so every other node of this build classifies it as not serving from its identify
	 * list, it is in no cohort, and it never coordinates. Its reads and writes go to the network's
	 * serving machines. The options that configure only serving subsystems (`storageDurability`,
	 * `validator`, `onCommitCertificate`, `dispute`, `blockTransfer`, `rebalance`, `spreadOnChurn`,
	 * `underReplicationDrain`, `arachnode`, `responsibilityK`) are ignored on a client, with one
	 * `node-wiring` line naming those it was given.
	 * {@link NodeOptions.storage} is NOT among them: a client uses its key-value store and its pieces.
	 * A client still registers the blob protocol, gated by `authorizeInboundStream`. See
	 * docs/internals.md §Client nodes.
	 */
	servesBlocks?: boolean;
	fretProfile?: 'edge' | 'core';
	id?: string; // optional peer id
	relay?: boolean; // enable relay service
	/**
	 * Init passed to `circuitRelayServer(...)` when `relay` is enabled.
	 *
	 * `@libp2p/circuit-relay-v2` defaults to `applyDefaultLimit: true`, which
	 * stamps every reservation with `Limit { data: 128 KiB, duration: 2 min }`
	 * and resets the relayed stream once either cap is hit — silently killing
	 * long-lived service↔browser circuits. Trusted local clusters (e.g. the
	 * reference-peer service nodes) should pass
	 * `{ reservations: { applyDefaultLimit: false } }` to lift the cap.
	 */
	relayServerInit?: CircuitRelayServerInit;
	/**
	 * Whether this node runs libp2p's hole-punching service (`@libp2p/dcutr`), which tries to turn a
	 * relayed connection into a direct one.
	 *  - Unset: automatic. The node runs it only when its advertised addresses
	 *    ({@link NodeOptions.announceAddrs}, else {@link NodeOptions.listenAddrs} plus
	 *    {@link NodeOptions.appendAnnounceAddrs}) include one another machine could dial directly
	 *    — not a circuit address, and a DNS name or a non-loopback IP (`holePunchingWanted` in
	 *    `network/hole-punching.ts`). A relay-only or loopback-only node leaves it out: hole punching
	 *    can never succeed for it, and costs three relayed streams per relayed connection.
	 *  - `true`: always run it. For a relay-only node that peers with public addresses regularly
	 *    reach through a relay, so it can dial those peers directly.
	 *  - `false`: never run it.
	 */
	holePunching?: boolean;
	/**
	 * Every store this node persists to, as one value: the block store, the key-value store and the
	 * piece store ({@link NodeStorage}, which states who owns the read cache in front of the block
	 * store). Each storage package opens all of it over one location in one call; there is no part of
	 * it a host can leave out, and the node closes none of it — a host that supplies one closes it
	 * after `stop()`.
	 *
	 * Absent → `memoryNodeStorage()`, with one `node-wiring` `WARN:` line naming everything the node
	 * is then keeping in memory and what is lost with each. Pass `memoryNodeStorage()` yourself to
	 * say the memory case was intended and get no warning.
	 *
	 * A client (`servesBlocks: false`) uses two thirds of it — the key-value store and the pieces —
	 * and never touches the block store, so this is NOT a serving-only option.
	 */
	storage?: NodeStorage;
	/**
	 * How long a storage write may wait before it is forced onto disk, computed per write from the size
	 * of the cohort its consensus ran on (see `durabilityWindowMs` in `storage/durability-window.ts`).
	 * Defaults assume machines lose power independently, one loss per machine per 30 days, and accept a
	 * one-in-10^9 chance of losing an acknowledged write, with no window above 5000 ms. Set
	 * `independentFailures: false` when machines share power, so every write syncs before it is reported.
	 * Applies only on storage that can sync (`durability: 'power-loss'`). A value out of range throws at
	 * node construction.
	 */
	storageDurability?: StorageDurabilityOptions;
	/**
	 * The blob service's settings. `digest` is the hashing port that names every piece (docs/blobs.md
	 * §References and pieces), default `defaultBlobDigest()`. A supplied digest is used as given:
	 * checking it against the known answers (`checkBlobDigest` in `@optimystic/db-core`) before handing
	 * it over is the host's call.
	 *
	 * `hold` is whether this node takes blobs it is merely responsible for (docs/blobs.md §Placement,
	 * copying and durability), default `'eager'`. An `'on-demand'` node declines every announcement,
	 * never takes a `responsible` hold, and still holds what it put, pinned or read. This is how a
	 * phone joins a group without storing every file in it.
	 *
	 * `copy` is the drain that announces each blob this node owes to its cohort until every member
	 * that accepts blobs holds it (`BlobCopyDrain` in `packages/db-p2p/src/blob/blob-copy-drain.ts`),
	 * on serving and client nodes alike — a client is often the machine a blob was put on. Its fields
	 * are `DrainScheduler`'s, defaulting as the under-replication drain's do. `enabled: false` builds
	 * no drain at all, and then `node.blobs.announce` REJECTS rather than recording an entry nothing
	 * would ever send; such a node still serves, fetches and holds blobs.
	 *
	 * `cacheBudgetBytes` is how many bytes of blobs this node may keep purely because it read them
	 * (`BlobCacheBudget` in `packages/db-p2p/src/blob/cache-budget.ts`, docs/blobs.md §Lifetime),
	 * default `DEFAULT_BLOB_CACHE_BUDGET_BYTES` (256 MiB). Over the budget, the least recently read of
	 * those blobs lose their `cached` hold and are swept; a blob held for any other reason — pinned,
	 * owed or responsible — is never counted or evicted, and a blob being read is never evicted. `0`
	 * keeps no such blob beyond the ones being read. Anything but an integer at or above 0 throws.
	 *
	 * `reclaimGraceMs` is how long a blob must have been found listed nowhere before this node gives
	 * its `responsible` or `owed` hold back (`BlobReclaimPass` in
	 * `packages/db-p2p/src/blob/reclaim-pass.ts`, docs/blobs.md §Lifetime), default
	 * `DEFAULT_RECLAIM_GRACE_MS` (7 days). Two counting passes at least this far apart must both have
	 * found the blob unlisted, so the period is a floor on the real time between them, not a timer.
	 * Anything below `MIN_RECLAIM_GRACE_MS` (1 hour), or not finite, throws.
	 */
	blobs?: { digest?: BlobDigest; hold?: BlobHoldPolicy; cacheBudgetBytes?: number; reclaimGraceMs?: number; copy?: Partial<BlobCopyDrainConfig> & { enabled?: boolean } };
	/**
	 * Override libp2p listen multiaddrs. An entry naming a relay (`<relay address>/p2p/<relay id>/p2p-circuit`)
	 * is not handed to libp2p as written: the node listens on a bare `/p2p-circuit` and keeps the
	 * reservation on that relay itself (`superviseRelayReservation` in `network/relay-reservation.ts`).
	 * Such an entry needs a circuit-relay transport and cannot be combined with {@link NodeOptions.announceAddrs},
	 * which would hide the circuit address; both are rejected before anything starts.
	 */
	listenAddrs?: string[];
	/**
	 * Timings of the supervisor that keeps each relay named by {@link NodeOptions.listenAddrs}
	 * reserved. Every field defaults; the one a host is most likely to change is `renewMs`, how often
	 * a held reservation is re-requested so a relay that forgot it holds it again (5 min by default).
	 * Ignored when no listen address names a relay.
	 */
	relayReservation?: RelayReservationSupervisorOptions;
	/**
	 * Multiaddrs to advertise INSTEAD OF the listen addrs. For a node behind a NAT / reverse proxy /
	 * DNS front that binds one address but is reachable at another. When non-empty these REPLACE the
	 * advertised set entirely — observed/relayed addresses and {@link NodeOptions.appendAnnounceAddrs}
	 * are all dropped from it. An empty array means "unset" (libp2p's own semantics).
	 */
	announceAddrs?: string[];
	/**
	 * Multiaddrs to advertise IN ADDITION TO the listen addrs. Ignored while
	 * {@link NodeOptions.announceAddrs} is non-empty.
	 */
	appendAnnounceAddrs?: string[];
	/** Override libp2p transports. */
	transports?: Libp2pTransports;

	/**
	 * Responsibility K - the replica set size for determining cluster membership.
	 * This is distinct from kBucketSize (DHT routing) and clusterSize (consensus quorum).
	 * On the repo path, a node checks whether it is in the top responsibilityK peers
	 * (by XOR distance) for the key and redirects to closer peers if not. On the cluster
	 * update path it is a small-mesh bypass threshold: when the record's peer set is
	 * smaller than this, the update is processed locally regardless of membership;
	 * otherwise a non-member redirects to the responsible peers.
	 * Default: 1 (only the closest/member peer is responsible)
	 */
	responsibilityK?: number;

	/** Arachnode storage configuration */
	arachnode?: {
		enableRingZulu?: boolean; // default: true
		storage?: StorageMonitorConfig;
	};

	/**
	 * Churn-resilient spread protocol tuning. Absent -> enabled with defaults
	 * (see SpreadOnChurnConfig). Set { enabled: false } to disable spread on this node.
	 * `pushDialTimeoutMs` and `pushResponseTimeoutMs` default to the node's RPC deadlines
	 * ({@link NodeOptions.rpcDeadlines}, else derived from {@link NodeOptions.linkRoundTripMs}); a value
	 * set here wins.
	 */
	spreadOnChurn?: Partial<SpreadOnChurnConfig>;

	/**
	 * Rebalance reaction tuning. Drives the RebalanceMonitor + BlockTransferCoordinator
	 * confirm-lost/replicate-grown path when arachnode/FRET are available (the only place fretAdapter
	 * exists). The grown arm is what pushes a block this node keeps to peers
	 * that newly became co-responsible for it — the founder case: anything committed while the
	 * deployment was one node gets its second copy only through this path (bounded per pass by
	 * `growthBlockBudget`). Absent -> enabled with defaults (see RebalanceMonitorConfig). Set
	 * { enabled: false } to disable the rebalance reaction (including the grown arm) on this node.
	 * When arachnode is disabled or FRET is absent the rebalance path stays inert regardless of this
	 * flag (rebalance is a resilience optimization — except for singly-held blocks, where the grown
	 * arm is currently the only mechanism that ever creates a second copy).
	 */
	rebalance?: Partial<RebalanceMonitorConfig> & { enabled?: boolean };

	/**
	 * Under-replication drain tuning. The drain sends the copies the under-replication ledger says
	 * this node still owes — blocks it acknowledged below full replication — to the missing members
	 * as they become reachable, and fires `onBlockDurabilityReached` on the node's `storageRepo` when
	 * a block finally has every copy. It needs only the key network and the node's own storage, so it
	 * runs whether or not arachnode/FRET rebalancing is enabled. Absent -> enabled with defaults (see
	 * `UnderReplicationDrainConfig`). Set { enabled: false } to leave the ledger unsent on this node.
	 * The push deadlines are separate because they bound the wire, not the pass: `pushDialTimeoutMs`
	 * and `pushResponseTimeoutMs`, which default to the node's RPC deadlines
	 * ({@link NodeOptions.rpcDeadlines}, else derived from {@link NodeOptions.linkRoundTripMs}; 3000 and
	 * 10000 when neither is declared) — the same defaults spread-on-churn uses. A value set here wins.
	 */
	underReplicationDrain?: Partial<UnderReplicationDrainConfig> & { enabled?: boolean; pushDialTimeoutMs?: number; pushResponseTimeoutMs?: number };

	/**
	 * The node's cohort reachability gate (`node.cohortReachability`), which the offline queue asks
	 * before it submits. `wakeDebounceMs` is how long after the last `connection:open` or
	 * `peer:identify` the gate's `onChange` listeners are woken; default `DEFAULT_WAKE_DEBOUNCE_MS`
	 * (500 ms), long enough to coalesce a connection with the identify that follows it.
	 */
	cohortReachability?: { wakeDebounceMs?: number };

	/** Transaction validator for cluster consensus */
	validator?: ITransactionValidator;

	/** Optional persistence for network state (HWM, FRET table, which of its peers serve this network) across restarts */
	persistence?: NetworkStatePersistence;

	/** Dispute protocol configuration */
	dispute?: Partial<DisputeConfig>;

	/**
	 * Block-transfer (churn re-replication) receiver tuning.
	 *
	 * `requirePushCertificate` (default `true`) refuses a pushed block that carries no verifying
	 * cohort commit proof — see `BlockTransferServiceInit.requirePushCertificate` for why that is
	 * the default. It is exposed here because the migration it exists for is a DEPLOYMENT decision
	 * and the escape hatch lives on the RECEIVER: a node still holding pre-proof blocks cannot
	 * certify them (the signatures no longer exist), so under the strict default those blocks never
	 * gain a new holder — which also means `BlockTransferCoordinator.confirmReplicated` never
	 * confirms them, so a rebalance never releases them and a ring shift's confirm phase aborts on
	 * them (`docs/arachnode-ring-handoff.md` § Phase B). Clearing the backlog means running the
	 * receivers with this `false` until every such block has been rewritten under current code.
	 * That backlog no longer grows from commits: every `CoordinatorRepo.commit` path under current
	 * code attaches a proof, solo cohorts included (the lone member self-signs one via
	 * `mintSoloCommitProof`). Still uncertifiable: blocks whose last write predates that, blocks
	 * committed without a content digest (the retention rule stores no proof for those), and
	 * revisions landed by the read-driven promotion in `StorageRepo.get`, which has no proof to
	 * attach — the last of those heal when a push back-fills one.
	 */
	blockTransfer?: { requirePushCertificate?: boolean };

	/**
	 * Optional sink for the consensus commit certificate, fired per committed consensus record just
	 * before the record is applied to local storage, with the collection tails the record committed
	 * (see {@link CommitCertificateSink}; a sink that ignores the third argument still works). This is
	 * the cluster-side half of the reactivity origination path: a caller wiring reactivity supplies a
	 * {@link CommitCertStore}'s `put` here, then resolves it via {@link makeClusterCommitCertExtractor}
	 * when it installs the change-notifier bridge ({@link attachCohortChangeBridge}) on the running
	 * node. Absent → zero cost (no cert is assembled).
	 */
	onCommitCertificate?: CommitCertificateSink;

	/**
	 * Opt-in cohort-topic substrate activation (reactivity / matchmaking origination). Default OFF →
	 * the node keeps today's bare `blockChangeNotifier = storageRepo` behavior at zero cohort cost (no
	 * host, no cert store; a caller-supplied {@link onCommitCertificate} is the only sink). When
	 * `enabled`, the node-base constructs the cohort-topic host post-assembly — serving root placement with
	 * the key network's storage rule as the root group, so a collection's reactivity tree is rooted at the
	 * group that stores its log tail — and installs the change-notifier origination bridge, which announces
	 * every commit whose tail this node applied: reactivity origination is live for ALL collections created
	 * on the node.
	 *
	 * A failure to construct the host (or a missing FRET service) **hard-fails** node startup: the
	 * operator opted in, so silently degrading to the bare notifier would hide misconfiguration.
	 */
	cohortTopic?: {
		/** Master switch. Absent/`false` → dormant, zero cost. */
		enabled: boolean;
		/**
		 * Requested size of every cohort that is NOT a root-placed root — the tiers below a reactivity
		 * tree's root, and every matchmaking cohort — assembled as the `wantK` FRET peers nearest the
		 * cohort's coordinate. A reactivity root is the tail block's storage group, `clusterSize` wide, and
		 * is not governed by this. Default 16 (the host's default).
		 */
		wantK?: number;
		/**
		 * Optional pass-through host tuning (profile / minSigs / fanout / gossipIntervalMs / antiDos / promotion).
		 * `rootGroup` is bound by the node to the key network's storage rule and the consensus
		 * super-majority ratio, so it cannot be supplied here.
		 */
		host?: Omit<CohortTopicHostOptions, 'privateKey' | 'wantK' | 'rootGroup'>;
	};

	/**
	 * Optional Ed25519 private key for this node. When provided, the libp2p
	 * node uses this identity instead of generating a fresh keypair. Use this
	 * to persist peer identity across process restarts.
	 *
	 * Accepts a libp2p `PrivateKey` (as returned by `generateKeyPair('Ed25519')`
	 * or `privateKeyFromProtobuf(...)` from `@libp2p/crypto/keys`).
	 */
	privateKey?: PrivateKey;

	/**
	 * Optional predicate deciding whether a remote peer may open one of the Optimystic database
	 * protocols on this node (`repo`, `cluster`, `sync`, `block-transfer`, and the blob protocol; on a
	 * client node, which registers only the blob protocol of these, that one). It is consulted once per
	 * inbound stream, before any frame is decoded or any operation executed.
	 *
	 * This is deliberately ONE node-level option threaded to every gated service rather than one
	 * option per service: "is this peer allowed to talk to my database?" is a property of the node,
	 * not of the protocol, and independently-settable options make it easy to secure four surfaces and
	 * silently miss the fifth. (Each service still accepts the same option in its own init, so the
	 * services stay independently testable and usable outside this factory.)
	 *
	 * Absent → no check at all, and today's behavior exactly. Supplied → fail-closed: `false`, a
	 * throw, a rejection, or a timeout all deny and abort the stream. `remotePeerId` is the
	 * dialing peer's `PeerId.toString()`. See {@link AuthorizeInboundStream} and
	 * `docs/internals.md` § Inbound Stream Authorization.
	 *
	 * NOTE: this covers the database protocols named above only. The dispute, reactivity, matchmaking,
	 * cohort-topic and libp2p built-in (identify/ping/…) protocols this node also registers are
	 * NOT gated by it. To refuse a peer at the connection level instead — every protocol at once,
	 * including identify — use {@link NodeOptions.connectionGater}.
	 */
	authorizeInboundStream?: AuthorizeInboundStream;

	/**
	 * Deadline for {@link NodeOptions.authorizeInboundStream}; expiry denies the stream (a hanging
	 * predicate would otherwise pin an inbound stream slot). Defaults to
	 * `DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS` (5s). Ignored when no predicate is supplied.
	 */
	authorizeInboundStreamTimeoutMs?: number;

	/**
	 * Optional predicate answering "is this peer a member of this node's network?", consulted
	 * wherever this node chooses peers to hold or coordinate its writes. Without it, a peer counts
	 * as serving this network when its peerStore protocol list names this network's `cluster` or
	 * `repo` protocol — a list any connected peer can fill by advertising them in its own identify.
	 * (A stream on one does not write them: `network/storage-claim-filter.ts`.) Supplied, a remote
	 * peer it refuses is never a cohort member and never a coordinator, whatever its protocol list
	 * says.
	 *
	 * A separate option from {@link NodeOptions.authorizeInboundStream}, which answers who may SEND
	 * to this node; this one answers who this node sends TO. An embedder whose database is private
	 * needs both: with only the authorization predicate, any connected peer that advertises this
	 * network's storage protocols can still be chosen as a cohort member and sent every write to
	 * the blocks it lands near.
	 *
	 * Synchronous — it runs inside every cohort assembly's per-peer loop, so keep it an in-memory
	 * lookup. Fail closed: only a literal `true` admits; a throw or a non-boolean refuses, logged.
	 * This node is always a member, so the predicate may list remote members only. `peerId` is
	 * `PeerId.toString()` (base58btc). Read live on every lookup, so admitting or removing a member
	 * takes effect on the next one. Absent → no check at all. See {@link IsNetworkMember} and
	 * `docs/internals.md` § Network Membership Predicate.
	 */
	isNetworkMember?: IsNetworkMember;

	/**
	 * Optional libp2p connection gater. The libp2p browser default denies
	 * dialing insecure WebSockets and private/loopback addresses; callers
	 * that need to dial local or unsecured bootstraps (web reference dev,
	 * Playwright e2e, RN simulators) supply a permissive gater here.
	 */
	connectionGater?: ConnectionGater;

	/**
	 * Optional crypto primitives for Noise, the connection encrypter every node runs. Unset → Noise's
	 * own default, which is OpenSSL and WebAssembly on Node but pure JavaScript under React Native,
	 * because Metro honours `@chainsafe/libp2p-noise`'s `browser` field and that maps the default to
	 * `pureJsCrypto`. On a slow phone the pure-JS handshake and per-frame ChaCha20-Poly1305 dominate
	 * a sync; an app with native crypto passes it here.
	 *
	 * The value must implement every member of `ICryptoInterface` (SHA-256, HKDF, X25519 key
	 * generation and shared-key derivation, ChaCha20-Poly1305 encrypt and decrypt). The usual shape
	 * spreads `noisePureJsCrypto` and overrides the hot functions with native ones.
	 *
	 * This swaps local primitives only: the wire protocol is unchanged, so a node with native crypto
	 * interoperates with one without. It is deliberately not a general `connectionEncrypters`
	 * override — Noise stays the only encrypter, so every node can talk to every other.
	 */
	noiseCrypto?: ICryptoInterface;

	/**
	 * Optional settings for libp2p's connection monitor, which pings every open connection on an
	 * interval and — unless told otherwise — aborts the connection when a ping does not answer in
	 * time. Unset → libp2p's own defaults (ping every 10s, each ping given 5s to answer). The value
	 * is libp2p's own `ConnectionMonitorInit`, passed through unchanged; this package substitutes no
	 * default of its own.
	 *
	 * A peer whose event loop is saturated — a phone running Noise in pure JavaScript, see
	 * {@link NodeOptions.noiseCrypto} — can miss that 5s deadline while perfectly healthy. Its
	 * connections are then dropped, it re-dials, and it pays another handshake, which is slower
	 * still. Such a deployment widens the deadline with `pingTimeout.minTimeout` (milliseconds) AND
	 * moves `pingInterval` above it, both ends alike — a connection either peer's monitor gives up
	 * on is closed for both:
	 *
	 * ```
	 * connectionMonitor: { pingInterval: 35_000, pingTimeout: { minTimeout: 30_000, maxTimeout: 30_000 } }
	 * ```
	 *
	 * Raising the deadline alone does not work, because the monitor opens a ping stream every
	 * `pingInterval` whether or not the previous one has answered, and it pings on
	 * `/ipfs/ping/1.0.0` — the protocol the `@libp2p/ping` service registered in `services` below
	 * also serves, with `maxOutboundStreams: 1`. libp2p reads that limit off the registrar, so the
	 * monitor's second stream to a peer still owing an answer is refused locally with
	 * `TooManyOutboundProtocolStreamsError`, which the monitor's catch cannot tell from a late reply:
	 * it aborts the connection. The deadline a peer actually gets is therefore
	 * `min(minTimeout, pingInterval)` — `minTimeout: 30_000` under the default 10s interval buys 10s,
	 * not 30. `test/connection-monitor-ping-overlap.spec.ts` reproduces both halves on two real nodes.
	 *
	 * What the patient shape costs is how long a genuinely dead peer is held: the next ping is due
	 * within `pingInterval` of the freeze and then waits out `minTimeout`, so the connection is
	 * reclaimed within about `pingInterval + minTimeout` — a little over a minute for the numbers
	 * above. A large `maxTimeout` is not a ten-minute grace period; see the next paragraph for what
	 * it does.
	 *
	 * `pingTimeout` is an adaptive-timeout init: the monitor reports each ping's duration back to it
	 * (`AdaptiveTimeout.cleanUp`, called after every ping), and the next ping's deadline is 1.2 times
	 * the moving average of those durations (a ping that ran out its deadline is entered at twice its
	 * duration), held between `minTimeout` and `maxTimeout`. Setting the two equal, as above, pins the
	 * deadline at exactly `minTimeout`, which is what the arithmetic in the paragraphs above assumes.
	 *
	 * NOTE: a `maxTimeout` left ABOVE `minTimeout` lets the deadline adapt upward between the two, but
	 * for ONE ping only. The average decays over `pingTimeout.interval` (5s by default), which is
	 * shorter than any ping interval a patient deadline can use, so by the next ping the stalled
	 * sample has almost fully decayed and one fast reply puts the deadline back at `minTimeout`. A
	 * peer that stalls intermittently is still dropped (4 of 4, measured on libp2p 3.3.11). So the
	 * adaptation buys tolerance of a single slow ping, not a deadline that grows toward `maxTimeout`;
	 * and since the monitor keeps one `AdaptiveTimeout` for all of a node's connections, the one ping
	 * it does buy is bought for every connection on the node, off whichever peer was slowest.
	 */
	connectionMonitor?: ConnectionMonitorInit;

	/**
	 * How long this node lets an INBOUND ping stream (`/ipfs/ping/1.0.0`) live before aborting it, in
	 * milliseconds — `@libp2p/ping`'s `timeout`, which it otherwise fixes at 10s. The timer covers the
	 * whole stream: the echo, waiting for the pinger to close its side, and the final close, so a slow
	 * outbound queue on this node eats into it. When it fires first, this node resets the stream, the
	 * pinging node's connection monitor cannot tell the reset from a dead peer, and it aborts the
	 * connection — so a peer's {@link connectionMonitor} deadline is capped at THIS node's handler
	 * timeout, the same shape as the `pingInterval` cap above, from the other end of the stream.
	 *
	 * Unset → twice `connectionMonitor.pingTimeout.maxTimeout` when `pingTimeout` declares either bound
	 * (libp2p's 60s default `maxTimeout` standing in when only `minTimeout` is declared; never below
	 * 10s, never above 2^31 − 1), else 10s as before. That default assumes the peers pinging this node have
	 * their monitor configured like this one — the same "both ends alike" assumption the
	 * `connectionMonitor` advice makes. A declared value is used as given, never raised; one that is not
	 * a finite number above zero, or is above 2^31 − 1, throws when the node is built.
	 *
	 * Cost: a stalled inbound ping stream is held up to this long, bounded per connection by
	 * `@libp2p/ping`'s `maxInboundStreams`.
	 */
	pingHandlerTimeoutMs?: number;

	/**
	 * Explicit connection-manager deadlines, passed to libp2p unchanged. Each one set here overrides
	 * the value derived from {@link NodeOptions.linkRoundTripMs}; a deployment that declares its link
	 * round trip has no need to set any of them.
	 *
	 * - `dialTimeout` — how long an outbound dial may take, socket through upgrade, when the caller
	 *   passes no abort signal of its own. The same value bounds each dial FRET's maintenance redial
	 *   makes (FRET's `dialTimeoutMs`): FRET's dials carry a signal, so libp2p's limit would not
	 *   otherwise reach them. Unlike the other two, it is checked: a value that is not a finite number
	 *   above zero, or is above 2^31 − 1, throws at node construction. libp2p would take `0` and fail
	 *   every signal-less dial at once; FRET refuses it.
	 * - `inboundUpgradeTimeout` — how long an inbound connection may take to finish its upgrade
	 *   (encryption + muxer) before this node discards it.
	 * - `addressDialTimeout` — how long one address of a peer may take to connect, inside any dial,
	 *   including the RPC clients' own.
	 *
	 * Unset, each is derived from the declared round trip and floors at libp2p's own default:
	 * `dialTimeout` is `LinkDeadlines.libp2pDialTimeoutMs` (10s, or ten round trips),
	 * `inboundUpgradeTimeout` is `LinkDeadlines.inboundUpgradeTimeoutMs` (10s, or five round trips), and
	 * `addressDialTimeout` is `LinkDeadlines.addressDialTimeoutMs` (6s, or ten round trips). The two
	 * outbound limits take ten because a circuit dial through a relay this node is not connected to
	 * opens that connection inside them; the listener's limit runs only over its own upgrade. When only
	 * the listener's limit is too short, the dialer's dial succeeds against a connection the listener
	 * has already discarded, and every stream on it dies with `Unexpected EOF`, so an override belongs
	 * on every node — each node is the listener for someone. An override of `addressDialTimeout` wants
	 * a `dialTimeout` at least as long, or the second cuts off what the first allows.
	 *
	 * NOTE: `dialTimeout` governs only dials that carry no signal. This package's own RPC clients dial
	 * under their own deadlines, which the same declaration derives (`resolveLinkDeadlines` in
	 * `rpc-deadline.ts`) and this option does not change; {@link NodeOptions.rpcDeadlines} sets those.
	 */
	connectionManager?: Libp2pConnectionTimeouts;

	/**
	 * Explicit deadlines for this package's own RPCs, used exactly as given in place of the values
	 * derived from {@link NodeOptions.linkRoundTripMs} — with no floor, so a value below the derived
	 * one is honoured too. They reach every RPC client the node builds (cluster consensus, sync,
	 * dispute, block pushes). Through `node.linkDeadlines` the dial deadline also reaches a host's
	 * `NetworkTransactor`, which applies it to each `RepoClient` dial; a `RepoClient` takes no response
	 * deadline, since the transactor's own budget bounds its reply.
	 *
	 * - `dialTimeoutMs` — how long a request may take to connect and negotiate its stream. The rebalance
	 *   transfer deadline (`transferTimeoutMs`, at least 30 s) and the transaction budget
	 *   (`transactionTimeoutMs`, at least 30 s and four dials) are derived from it, so they follow an
	 *   explicit value.
	 * - `responseTimeoutMs` — how long a request waits for the reply once its stream is open.
	 *
	 * A caller's own per-request value wins over these, and so do the `push*` fields of
	 * {@link NodeOptions.spreadOnChurn} and {@link NodeOptions.underReplicationDrain}; these win over
	 * the values derived from `linkRoundTripMs`. Time an application adds to every connection — its own
	 * admission checks at a relay or a target — belongs here and in
	 * {@link NodeOptions.connectionManager}, on top of what the round trip derives.
	 *
	 * Keep `dialTimeoutMs` no longer than `connectionManager.addressDialTimeout`: libp2p applies that
	 * limit to each address inside every dial, the RPC clients' included, so a longer RPC dial is cut
	 * off at it. Nothing enforces the relationship.
	 *
	 * A field that is not a finite number above zero throws at node construction, as does a
	 * `dialTimeoutMs` above `MAX_RPC_DIAL_TIMEOUT_MS` (the transaction budget, four dials, has to fit a
	 * 32-bit timer) or a `responseTimeoutMs` above 2^31 − 1.
	 */
	rpcDeadlines?: Partial<RpcDeadlineDefaults>;

	/**
	 * The slowest round trip, in milliseconds, between any two nodes that will talk to each other,
	 * relayed hops included. Every network deadline the node applies is derived from it
	 * (`resolveLinkDeadlines` in `rpc-deadline.ts`): the RPC clients' dial and response deadlines,
	 * the block pushes', libp2p's connection deadlines, FRET's maintenance deadlines (its liveness
	 * ping and announce, neighbour-snapshot fetch, stabilization tick and outbound route budget, which
	 * FRET derives itself from this value), and — when `clusterPolicy.cohortQueryTimeoutMs`
	 * is not declared — the read path's per-peer budget. Each derived value floors at the constant it
	 * replaces, so absent means the LAN deadlines exactly.
	 *
	 * The dial deadlines are sized for a relayed dial through a relay this node is not yet connected
	 * to, which opens that connection first. The round trip of that first leg, dialer to relay, is
	 * taken to be at most this value: it is one hop of the relayed path this value covers. That
	 * overestimates the leg, but it is the only number available.
	 *
	 * Declare it on every node, with the same value: each node dials some and is dialed by others.
	 * An explicit per-deadline setting still wins over the derived value — {@link NodeOptions.connectionManager},
	 * {@link NodeOptions.rpcDeadlines}, the `push*` fields of {@link NodeOptions.spreadOnChurn} and
	 * {@link NodeOptions.underReplicationDrain}, `clusterPolicy.cohortQueryTimeoutMs`, and a caller's own
	 * `dialTimeoutMs`.
	 *
	 * A value that is not a finite number above zero, or is above `MAX_LINK_ROUND_TRIP_MS`, throws at
	 * node construction: falling back to the LAN deadlines would silently keep them on the one
	 * deployment that declared its links slower.
	 */
	linkRoundTripMs?: number;
};

/** Options for a node that stores blocks for its network: {@link NodeOptions.servesBlocks} unset or `true`. */
export type ServingNodeOptions = NodeOptions & { servesBlocks?: true };

/** Options for a client node, which stores no blocks: {@link NodeOptions.servesBlocks} `false`. */
export type ClientNodeOptions = NodeOptions & { servesBlocks: false };

/**
 * On a client, log once the options it was given that configure only the serving subsystems it does
 * not build, so a host that expected one to take effect can see why it did not. The ONE list of such
 * options: a serving-only option added later is added here.
 */
function logIgnoredServingOptions(options: NodeOptions): void {
	// NOT `storage`: a client reads two thirds of that value (the key-value store and the pieces) and
	// only leaves its block store alone, so reporting it as ignored would be a lie.
	const servingOnly = [
		'storageDurability', 'validator', 'onCommitCertificate', 'dispute',
		'blockTransfer', 'rebalance', 'spreadOnChurn', 'underReplicationDrain', 'arachnode', 'responsibilityK'
	] as const satisfies readonly (keyof NodeOptions)[];
	const given = servingOnly.filter(name => options[name] !== undefined);
	if (given.length > 0) {
		wiringLog('client node (servesBlocks: false) stores no blocks, so it ignores: %s', given.join(', '));
	}
}

/**
 * `options` with an undeclared `clusterPolicy.cohortQueryTimeoutMs` filled from the declared link
 * round trip. A declared budget wins. With no round trip declared the fill is
 * `DEFAULT_COHORT_QUERY_TIMEOUT_MS`, which is what resolution falls back to anyway.
 */
function withLinkDerivedCohortBudget(options: NodeOptions, deadlines: LinkDeadlines): NodeOptions {
	return {
		...options,
		clusterPolicy: {
			...options.clusterPolicy,
			cohortQueryTimeoutMs: options.clusterPolicy?.cohortQueryTimeoutMs ?? deadlines.cohortQueryTimeoutMs
		}
	};
}

/**
 * Put the write-through read cache in front of the node's block store. This is the single place the
 * network node resolves its `IRawStorage`, so it is the single place the cache is wired
 * (`withReadCache` states the exclusions: memory storage, and storage that already reports
 * `readCached`, pass through unchanged — the memory default from `memoryNodeStorage()` takes the
 * first of those, so it stays unwrapped with nothing to release).
 *
 * `lease` is this node's claim on the (possibly shared) cache, and the ONLY thing its stop path
 * may release — a host that supplied an already-cached storage, in either documented
 * construction, keeps owning it (see {@link ResolvedReadCache}).
 */
function resolveStorage(storage: IRawStorage, networkName: string): ResolvedReadCache {
	// NOTE: the label is the network name, so N nodes on one network in one process over N DISTINCT
	// stores produce N identically-labelled rows in `SharedCachePool.stats()` (the pool keys on a
	// monotonic store id, not the label); N nodes over ONE store share a single row, labelled by
	// whichever node wrapped first. Harmless while the label is only read by a human eyeballing
	// occupancy; if pool stats ever need to attribute bytes to a SPECIFIC node, fold the peer id
	// in — it is not known here, so that would mean labelling after node construction rather than
	// at resolve time.
	return withReadCache(storage, `node:${networkName}`);
}

/** What a flushed write survives, phrased for an operator reading the node's start-up log. */
const STORAGE_DURABILITY_LINES: Record<StoreDurability, string> = {
	'none': 'storage: in memory — nothing written survives a restart',
	'process-crash': 'storage: a flushed write survives this process crashing, but not an operating-system crash or power cut',
	'power-loss': 'storage: a flushed write survives a power cut or operating-system crash',
};

/**
 * Report, once at start-up, what the resolved storage's writes survive. Keep this the ONE line
 * that says so: a later report about the same storage (a backend that cannot sync, say) extends
 * this function rather than logging from somewhere else.
 */
function logStorageDurability(durability: StoreDurability, policy: DurabilityWindowPolicy): void {
	wiringLog('%s%s', STORAGE_DURABILITY_LINES[durability], durabilityWindowClause(durability, policy));
}

/** Largest cohort size the start-up line spells a window out for. */
const LOGGED_WINDOW_COHORT_LIMIT = 10;

/** What the durability window means on this storage, appended to the start-up storage line. */
function durabilityWindowClause(durability: StoreDurability, policy: DurabilityWindowPolicy): string {
	switch (durability) {
		case 'none':
			return '';
		case 'process-crash':
			return '; this backend cannot sync, so a power cut may lose any write the operating system has not yet written out, whatever the window';
		case 'power-loss': {
			if (!policy.independentFailures) {
				return '; every write is synced before it is reported held';
			}
			const limit = Math.min(policy.declaredCohortSize, LOGGED_WINDOW_COHORT_LIMIT);
			const windows = Array.from({ length: Math.max(limit, 1) }, (_, i) => `n=${i + 1} ${durabilityWindowMs(i + 1, policy)}ms`);
			return `; a write may wait for its sync up to: ${windows.join(', ')} (independent failures assumed; storageDurability.independentFailures=false makes every write sync first)`;
		}
	}
}

/**
 * Resolve the node's storage: whatever the host supplied, or `memoryNodeStorage()` with ONE
 * `node-wiring` `WARN:` line naming everything the node is then keeping in memory and what is lost
 * with each. The test is the PRESENCE OF THE OPTION, not the durability of the stores behind it,
 * which is the point of taking the whole value: a host that passes `memoryNodeStorage()` has said it
 * meant the memory case and gets no warning, and there is no longer a part of its storage a host can
 * drop by accident.
 *
 * The warning is LOUD on purpose: a silent fallback would look like the under-replication ledger
 * works and then fail the one case it exists for — a shortfall recorded before a restart being there
 * after it.
 *
 * NOTE: a host can still hand-build a `NodeStorage` whose parts disagree — a `FileRawStorage` beside
 * a `MemoryKVStore` — and that case is silent, where the three separate options each warned for
 * themselves. It is the host's deliberate composition and `IKVStore` has no `durability` to report,
 * so the node cannot tell. If a host is ever bitten by a mixed set, give `IKVStore` the `durability`
 * field `IPieceStore` and `IRawStorage` already have and name the memory parts in this same line.
 */
function resolveNodeStorage(supplied: NodeStorage | undefined, servesBlocks: boolean): NodeStorage {
	if (supplied !== undefined) {
		return supplied;
	}
	wiringLog(servesBlocks
		? 'WARN: no NodeOptions.storage supplied — keeping ALL of this node\'s storage in memory, so nothing it writes survives a restart. The blocks it holds for the network go with it, so it comes back holding nothing and its cohort has to restore every one. The under-replication ledger (blocks it acknowledged before every cohort member held them) goes, so copies owed at shutdown are never sent. The state of an agreement in flight goes, so a commit it was still broadcasting is not resumed and a record it promised on is not restored. The HLC clock\'s high-water mark goes, so a node restarted with its wall clock behind can stamp new changes below ones it stamped before. The blob records and the owed-blob ledger go, so a restart sweeps every blob it held, and the blob pieces go with them. Supply NodeOptions.storage — the block store, key-value store and piece store your platform\'s storage package opens over one location — or memoryNodeStorage() to say this was meant.'
		: 'WARN: no NodeOptions.storage supplied — keeping ALL of this client\'s storage in memory, so nothing it writes survives a restart. The HLC clock\'s high-water mark goes, so a client restarted with its wall clock behind can stamp new changes below ones it stamped before. The blob records and the owed-blob ledger go, so a restart sweeps every blob it held, and the blob pieces go with them — including a blob its own host put that no committed row references yet, whose only copy this machine holds. Supply NodeOptions.storage — the block store, key-value store and piece store your platform\'s storage package opens over one location — or memoryNodeStorage() to say this was meant.');
	return memoryNodeStorage();
}

/**
 * Resolve how many bytes of read-only blob cache this node may keep ({@link NodeOptions.blobs}'s
 * `cacheBudgetBytes`). A value that is not a whole number of bytes at or above 0 throws rather than
 * being rounded or ignored: a budget read as something other than what the host declared would either
 * evict blobs it meant to keep or keep blobs it meant to be rid of.
 */
function resolveBlobCacheBudgetBytes(declared: number | undefined): number {
	if (declared === undefined) {
		return DEFAULT_BLOB_CACHE_BUDGET_BYTES;
	}
	if (!Number.isSafeInteger(declared) || declared < 0) {
		throw new RangeError(`blobs.cacheBudgetBytes must be an integer number of bytes at or above 0, got ${declared}`);
	}
	return declared;
}

/**
 * Resolve the full FRET engine the cohort-topic host needs.
 *
 * `createCohortTopicHost` consumes the complete {@link FretService} engine surface — notably
 * `setActivityHandler` (and `routeAct`, size estimation, …). The value at `node.services.fret` is the
 * libp2p `Libp2pFretService` *wrapper*, which re-exports only a subset (`assembleCohort`, `routeAct`, …)
 * and keeps the real engine private behind its lazy `ensure()` accessor. By the time activation runs the
 * engine is already initialized — the wrapper's `Startable.start()` ran during `node.start()` — and the
 * engine and wrapper share one underlying routing store, so the host and the forwarder's child-cohort reads
 * observe the same cohort state. Returns the engine when reachable; otherwise the value as-is (a test may inject a
 * raw engine that needs no unwrapping).
 */
function resolveFretEngine(fret: FretService | undefined): FretService | undefined {
	if (!fret) {
		return undefined;
	}
	const candidate = fret as unknown as { ensure?: () => FretService };
	return typeof candidate.ensure === 'function' ? candidate.ensure() : fret;
}

/**
 * The tail bytes of the root a collection's current served reactivity {@link PushState} belongs to, or
 * `undefined` if the node serves none. The forwarder host keys its served map by root tail, but a **backfill**
 * recover request carries only a collectionId — so the drain-redirect binding resolves the collection's current
 * root here (the highest-`lastRevision` served PushState) before consulting `rotationRedirectFor`. While the
 * old root is the only served state this resolves it (and its drain gate redirects); once the new root is
 * served this resolves the new one (no gate → no redirect), exactly as the recover serve's backfill path intends.
 */
function resolveCurrentServedRoot(forwarderHost: ReactivityForwarderHost, collectionId: string): Uint8Array | undefined {
	const ps = forwarderHost.pushStateForCollection(collectionId);
	return ps === undefined ? undefined : b64urlToBytes(ps.tailIdAtJoin);
}

/**
 * The protocols a node's own clients send requests on that get a prepared stream: repo, cluster, sync
 * and block-transfer, under the same ids the four services register. Dispute is left out — rare, and
 * off by default, so a prepared stream for it would almost always expire unused. A client node sends
 * steady requests on `repo` alone (its reads and writes); it runs no consensus, repair or pushes.
 *
 * The blob protocol is left out on both roles. A prepared stream saves one negotiation round trip on a
 * small request, and `ProtocolClient` resends a request once when such a stream fails before its reply
 * begins, which assumes a small idempotent request and a single reply. A blob `get` moves up to 16
 * pieces, against which one round trip is negligible; the blob client does not go through
 * `ProtocolClient`; and a pool would hold an idle blob stream open per peer for 30 s after every
 * request. `Libp2pKeyPeerNetwork.connect` opens a fresh stream for a protocol the pool does not list.
 */
function preparedStreamProtocols(protocolPrefix: string, servesBlocks: boolean): string[] {
	if (!servesBlocks) return [buildRepoProtocol(protocolPrefix)];
	return [
		...storageServingProtocols(protocolPrefix),
		buildSyncProtocol(protocolPrefix),
		buildBlockTransferProtocol(protocolPrefix)
	];
}

/** Late-bound seams of the serving role: each is built after `node.start()` and read at call time by something built before it. */
interface LateServingBindings {
	/** How a block storage restores a revision it lacks; the restoration coordinator once Arachnode runs. */
	restore: RestoreCallback;
	/** The cluster member the `cluster` protocol service answers through. */
	cluster?: ICluster;
	/** The coordinated repo the `repo` and `sync` services answer through once it exists. */
	coordinatedRepo?: IRepo;
	/** Where block-holder evidence goes: the rebalance monitor, when one is built. */
	blockHolders?: BlockHoldersSink;
}

/**
 * The serving role's half built before libp2p exists: the block store, the repo over it, and what the
 * four storage protocol services answer through. A client node builds none of it.
 */
interface ServingStore {
	rawStorage: IRawStorage;
	/** This node's lease on the read cache in front of `rawStorage`, the one thing its stop releases (see {@link resolveStorage}). */
	lease: ReadCacheLease | undefined;
	storageRepo: StorageRepo;
	underReplicationLedger: KvUnderReplicationLedger;
	/**
	 * Where the member keeps the record it promised on and the coordinator keeps the record it is
	 * broadcasting — the state of an agreement in flight, which only matters across a restart. Built
	 * over the node's own key-value store, so it is exactly as durable as this node's other
	 * bookkeeping; a node whose store is in memory keeps it only for this process.
	 */
	transactionStateStore: ITransactionStateStore;
	/** The one window function: the member's apply of a consensus record and the coordinator's own fallback apply flush with the window for the record's cohort. */
	durabilityWindowFor: DurabilityWindowFor;
	late: LateServingBindings;
	clusterProxy: ICluster;
	repoProxy: ArchiveServingRepo;
	/**
	 * Who is evidenced to hold each block this node holds, for the rebalance monitor (so it neither
	 * pushes a block back to a peer that already has it nor pulls a copy it already holds). Five
	 * producers report through this one sink: the cluster member after a durable consensus apply, the
	 * coordinator on acknowledging a cohort commit, the block-transfer service for the peer that pushed
	 * an accepted replica, the reconcile closure for the peers that corroborated a restored revision,
	 * and the embedder through `node.reportBlockHeld`. Built here, before libp2p, because the
	 * `blockTransfer` service factory is evaluated at `createLibp2p`. Late-bound on purpose — the monitor
	 * is built much later inside the Arachnode gate, and not at all when rebalance or FRET is off, in
	 * which case reports fall on the floor.
	 */
	onBlockHolders: BlockHoldersSink;
}

/**
 * Build the serving role's storage half (see {@link ServingStore}). Resolves the durability policy
 * first, so a bad value throws before storage is acquired and there is nothing to release.
 */
function prepareServingStore(
	options: NodeOptions,
	consensusConfig: ResolvedClusterPolicy,
	storage: NodeStorage,
	hlcClock: HlcClock,
	linkDeadlines: LinkDeadlines
): ServingStore {
	const kvStore = storage.kv;
	// Read from the one resolved cluster policy, never a second copy of the size or threshold.
	const durabilityWindowPolicy = resolveDurabilityWindowPolicy(options.storageDurability, consensusConfig);
	const { storage: rawStorage, lease } = resolveStorage(storage.blocks, options.networkName);
	logStorageDurability(rawStorage.durability, durabilityWindowPolicy);
	const durabilityWindowFor: DurabilityWindowFor = cohortSize => durabilityWindowMs(cohortSize, durabilityWindowPolicy);
	// A shortfall entry describes a commit in the block store, whose flush may have been given a
	// window; a strict flush of that store first keeps the entry off disk until the commit it names is
	// on it (storage.md Invariant 6, write order 8). Nothing to sync after a solo commit, which was
	// strict; one early sync for a `majority` commit that fell short, a degraded case.
	// NOTE: `noteReplicationShortfall` records every block of a commit concurrently, so this runs
	// once per block; `WriteGroup` shares one sync among concurrent strict flushes with nothing to
	// seal, and every production store runs over it. A backend that synced on every flush regardless
	// would pay one sync per block here — coalesce in `noteReplicationShortfall` if one ever does.
	const underReplicationLedger = new KvUnderReplicationLedger(kvStore, { beforeRecord: () => rawStorage.flush() });

	// The node's own transaction state store, over the same key-value store: a serving node ALWAYS
	// has one, so `ClusterMember` and `CoordinatorRepo` always persist what an in-flight agreement
	// needs to be resumed after a restart, and the two `recoverTransactions` passes at start always
	// run. Its three key prefixes are declared in `NODE_KV_NAMESPACES`, which is what keeps a
	// file-backed store sharing the block store's directory from listing them as blocks. A client
	// builds none of this — it runs neither a member nor a coordinator.
	const transactionStateStore = new PersistentTransactionStateStore(kvStore);

	// The restore starts as a placeholder that finds nothing, rebound once the restoration
	// coordinator exists after start.
	const late: LateServingBindings = { restore: async (_blockId, _rev?) => undefined };

	// The factory reads `late.restore` each time it builds a block storage, so a block storage created
	// after the rebinding restores through the coordinator. The node's HLC clock is raised to every pend
	// this repo stores.
	const storageRepo = new StorageRepo(rawStorage, {
		createBlockStorage: (blockId, store) => new BlockStorage(blockId, store, late.restore),
		clock: hlcClock,
		// How long a pending record this node stores reserves its block, derived from the budget this
		// node's declared link round trip gives one transactor operation — so a slow-link deployment
		// gets a proportionally longer lease rather than the LAN figure.
		pendLeaseMs: resolvePendLeaseMs(linkDeadlines.transactionTimeoutMs),
	});

	const clusterProxy: ICluster = {
		async update(record) {
			if (!late.cluster) {
				throw new Error('ClusterMember not initialized');
			}
			return await late.cluster.update(record);
		}
	};

	// Built by a named factory, not an inline literal: see `createServedRepoProxy` for why (an
	// inline object here is unreachable from every test that does not boot a libp2p node, which is
	// how it served every repair archive without its commit proof). The coordinated repo is read per
	// call because it is bound after the cluster is assembled.
	const repoProxy = createServedRepoProxy(storageRepo, () => late.coordinatedRepo);

	const onBlockHolders: BlockHoldersSink = (holders) => late.blockHolders?.(holders);

	return { rawStorage, lease, storageRepo, underReplicationLedger, transactionStateStore, durabilityWindowFor, late, clusterProxy, repoProxy, onBlockHolders };
}

/**
 * The ONE authorization slice, spread verbatim into every gated protocol service's init: the four
 * database services and the blob service. Building it once (rather than repeating two option reads per
 * service) is what makes "secured four surfaces, missed the fifth" impossible: a new gated service is a
 * spread of this object, and dropping it from one is visible at the call site. Absent
 * `authorizeInboundStream` → every service constructs its gate as `undefined` and the inbound path is
 * byte-for-byte what it was before this option existed.
 */
function inboundAuthorizationOf(options: NodeOptions): InboundStreamAuthorizationInit {
	return {
		...(options.authorizeInboundStream ? { authorizeInboundStream: options.authorizeInboundStream } : {}),
		...(options.authorizeInboundStreamTimeoutMs !== undefined
			? { authorizeInboundStreamTimeoutMs: options.authorizeInboundStreamTimeoutMs }
			: {})
	};
}

/**
 * The four storage protocol services a serving node registers — `cluster`, `repo`, `sync` and
 * `blockTransfer` — keyed as they appear in the libp2p services map. A client registers none of them,
 * which is what tells every other node it serves nothing.
 *
 * `liveNode` resolves the running node at REQUEST time. Service factories must never close over
 * `components.libp2p`: `components` is libp2p's Proxy, whose getter THROWS
 * `MissingServiceError('libp2p not set')` for any key it does not hold — and `libp2p` is not a
 * component. The throw happens on the property read, so neither `?.` nor a following
 * `if (!libp2p) return` can catch it; it escapes as an application error on whatever request touched
 * it. Same reason fret/networkManager/repo take the node via setLibp2p.
 */
function storageProtocolServices(
	serving: ServingStore,
	options: NodeOptions,
	superMajorityThreshold: number,
	inboundAuthorization: InboundStreamAuthorizationInit,
	liveNode: () => Libp2p | undefined
): NonNullable<Libp2pInit['services']> {
	const protocolPrefix = `/optimystic/${options.networkName}`;
	return {
		cluster: (components: any) => {
			const addressLog: AddressLog = createLogger('peer-address-book', components.peerId?.toString());
			const serviceFactory = clusterService({
				protocolPrefix,
				responsibilityK: options.responsibilityK ?? 1,
				...inboundAuthorization
			});
			return serviceFactory({
				registrar: components.registrar,
				cluster: serving.clusterProxy,
				// Identity for membership scoping on the update path. peerId is a core
				// libp2p component, available at service-construction time.
				peerId: components.peerId,
				// Fallback addr resolver for redirect targets whose multiaddrs are not
				// already embedded in record.peers. A redirect payload is handed to a THIRD
				// party, so it answers with `publishableAddrsForPeer` — the same rule, and the
				// same function, `findCluster` uses to fill a cluster record: the publishable
				// half of our live connections plus the peer's own advertised addresses.
				getConnectionAddrs: async (peerId: any) => {
					const node = liveNode();
					if (!node) return [];
					const conns = node.getConnections?.(peerId) ?? [];
					return await publishableAddrsForPeer(node, conns, peerId, addressLog);
				},
				// Inbound cluster records carry each cohort member's multiaddrs. libp2p only
				// propagates addresses between directly-connected peers, so for a cohort chosen
				// by key position this is often the ONLY way this node learns how to reach a
				// relay-only sibling. Same late-binding shape as getConnectionAddrs above:
				// the node resolves at request time, not at service construction.
				recordPeerAddresses: (peerId: any, multiaddrs: string[]) => {
					const node = liveNode();
					if (!node) return;
					mergePeerAddresses(node, peerId, multiaddrs, addressLog);
				}
			});
		},

		repo: (components: any) => {
			const serviceFactory = repoService({
				protocolPrefix,
				responsibilityK: options.responsibilityK ?? 1,
				...inboundAuthorization
			});
			// RepoService.checkRedirect needs the running node (its `keyNetwork` attachment for
			// the responsible set, self id for the membership check, connection addrs for
			// redirect targets). The libp2p components.libp2p proxy does NOT reliably resolve
			// from inside a service at request time, so the node is injected explicitly
			// post-construction via setLibp2p(node) — the same mechanism networkManager/fret
			// use — rather than forwarded here. checkRedirect asks the node's own key network for
			// the block's routing key (`routingKeyForBlock`), the same call the writer and the
			// coordinator make — one rule, so a correctly routed request is never redirected.
			return serviceFactory({
				registrar: components.registrar,
				repo: serving.repoProxy
			});
		},

		sync: (components: any) => {
			const serviceFactory = syncService({
				protocolPrefix,
				...inboundAuthorization
			});
			return serviceFactory({
				registrar: components.registrar,
				repo: serving.repoProxy
			});
		},

		// Block-transfer protocol handler for churn re-replication. Wired to the
		// *local* storageRepo (not repoProxy): a pushed replica must land in this
		// node's own storage, not be re-routed through the cluster-coordinated repo.
		blockTransfer: (components: any) => {
			const serviceFactory = blockTransferService({
				protocolPrefix,
				// Absent → the strict default inside the service; see `blockTransfer` on the options.
				...(options.blockTransfer?.requirePushCertificate !== undefined
					? { requirePushCertificate: options.blockTransfer.requirePushCertificate }
					: {}),
				...inboundAuthorization
			});
			return serviceFactory({
				registrar: components.registrar,
				repo: serving.storageRepo,
				// Verifying a pushed block's commit proof needs the cohort's super-majority fraction.
				// Read from the SAME resolved `consensusConfig` the member and coordinator read (whose
				// coupling `assertSuperMajorityCoupling` already asserts) — a third copy resolving
				// its own default would defeat that.
				superMajorityThreshold,
				// A received replica is a block this node now holds, and its sender demonstrably holds
				// it too — without this the next rebalance check pushes the copy straight back to the
				// sender and pulls it again over `/sync`.
				onBlockHolders: serving.onBlockHolders
			});
		}
	};
}

export async function createLibp2pNodeBase(
	options: NodeOptions,
	defaults: {
		listenAddrs: string[];
		transports: Libp2pTransports;
	}
): Promise<OptimysticNode | OptimysticClientNode> {
	// First, before anything is acquired: a declared round trip or RPC deadline that is not usable
	// throws, and there is nothing yet to release. Every network deadline below is read off this one result.
	const linkDeadlines = resolveLinkDeadlines(options.linkRoundTripMs, options.rpcDeadlines);
	const bootstrapContactTimeoutMs = resolveBootstrapContactTimeoutMs(options.bootstrapContactTimeoutMs, linkDeadlines);
	// One value for libp2p's connection manager and FRET's maintenance redial, so the two cannot drift.
	const libp2pDialTimeoutMs = resolveLibp2pDialTimeoutMs(options.connectionManager?.dialTimeout, linkDeadlines);
	const pingHandlerTimeoutMs = resolvePingHandlerTimeoutMs(options.pingHandlerTimeoutMs, options.connectionMonitor);

	// Every cluster-policy default lives in `cluster/cluster-policy.ts` — including WHY the admission
	// gate and the repair corroboration floor resolve to different values when nothing is declared,
	// and why they take TWO operator fields (`clusterPolicy.assumedClusterSize`, which sets both, and
	// `clusterPolicy.repairCorroborationClusterSize`, which sets the repair yardstick alone so a host
	// can tighten repair without also raising the low-confidence write floor). Resolved ONCE, here,
	// before anything that reads a cluster size is constructed: `networkManagerService` below,
	// `Libp2pKeyPeerNetwork`, and the spread-on-churn monitor init must all read `consensusConfig.clusterSize`
	// rather than `options.clusterSize` directly, or they can each apply their own fallback default and
	// silently disagree (ticket bug-cluster-size-resolution-single-source). `assertClusterSizeCoupling`
	// below is the fail-fast backstop if a future edit reintroduces that split.
	//
	// The cohort budget is filled from the declared link round trip BEFORE resolution, so the member,
	// the coordinator and `reconcilePassTimeoutMs` all read the one resolved number.
	const consensusConfig = resolveClusterPolicy(withLinkDerivedCohortBudget(options, linkDeadlines));
	const servesBlocks = options.servesBlocks !== false;
	if (!servesBlocks) logIgnoredServingOptions(options);
	const bootstrapTargets = planBootstrapTargets(options.bootstrapNodes ?? []);
	// All of this node's storage, as one value: the host supplied it or it is in memory, and there is
	// no third case in which a part of it is missing.
	const nodeStorage = resolveNodeStorage(options.storage, servesBlocks);
	const kvStore = nodeStorage.kv;
	// The node's single-machine blob service, on both roles: the machine a blob is put on holds its
	// only copy until its reference commits, and a client is often that machine (docs/blobs.md §The
	// node's blob service). Started once the node has, below, where `node.blobs` is built over it.
	const pieceStore = nodeStorage.pieces;
	const blobs = new LocalBlobService({ pieces: pieceStore, kv: kvStore, digest: options.blobs?.digest });
	// Read here, before the blob protocol service entry below closes over it: an on-demand node declines
	// every announcement, including the ones that arrive before the receiver exists.
	const blobHold: BlobHoldPolicy = options.blobs?.hold ?? 'eager';
	// Read here rather than where the budget is built, below: this is before `createLibp2p` and
	// `node.start()`, so a misconfigured host gets the error instead of a started node to roll back.
	const blobCacheBudgetBytes = resolveBlobCacheBudgetBytes(options.blobs?.cacheBudgetBytes);
	// Here for the same reason, and because this one decides when data is DELETED: a host that
	// mistyped the grace period is told before the node starts reclaiming on it.
	const blobReclaimGraceMs = resolveReclaimGraceMs(options.blobs?.reclaimGraceMs);
	// Bound after libp2p has started, below, since the receiver needs the node's key network and fetcher
	// while the service entry is built before them.
	let blobReceiver: BlobAnnounceReceiver | undefined;
	// The membership check the `held` closure below applies, bound beside the receiver once the gate
	// exists. Until then every `held` is dropped: nothing this node announced can have been fetched yet,
	// so such a frame is unsolicited.
	let blobPeerAdmitted: (peerId: string) => boolean = () => false;
	// The owed-copies drain, built after the receiver below (so its stop runs before the receiver's)
	// and bound here because `node.blobs` and the `held` closure both reach it. Read, not captured, on
	// every use: both are only reachable after the factory has assigned it.
	let blobCopies: BlobCopyDrain | undefined;
	const blobCopyWanted = (options.blobs?.copy?.enabled ?? true) !== false;
	// The monitor that follows the cohort of the blobs this node keeps for the network, built below the
	// drain but declared here so the drain's `onHolderConfirmed` can reach it. Read, not captured, for
	// the same reason `blobCopies` is: it exists only once the factory has assigned it.
	let blobRebalanceMonitor: RebalanceMonitor | undefined;
	// Built once: it gates the four storage protocol services on a serving node and the blob protocol on both roles.
	const inboundAuthorization = inboundAuthorizationOf(options);

	const nodePrivateKey = options.privateKey ?? await generateKeyPair('Ed25519');
	// The node's one HLC clock (docs/crdt-sync.md §Migration Path, Stage 1), its mark loaded before
	// anything can write: a serving node's storage repo raises it to every pend it stores, and a
	// transactor a host builds over the node mints from it (`node.hlcClock`). Kept in `kvStore`, which
	// on a client holds nothing else but the blob records.
	const hlcClock = await HlcClock.start({
		nodeId: peerIdFromPrivateKey(nodePrivateKey).toString(),
		store: new KvHlcClockStore(kvStore),
	});

	// The serving role's storage half, built before libp2p because the four storage protocol services
	// answer through it. A client builds none of it (docs/internals.md §Client nodes).
	const serving = servesBlocks ? prepareServingStore(options, consensusConfig, nodeStorage, hlcClock, linkDeadlines) : undefined;

	// The running node, bound immediately after `createLibp2p` below. Service factories that need the
	// node at REQUEST time read it through this binding, never `components.libp2p` (see
	// `storageProtocolServices`).
	let liveNode: Libp2p | undefined;

	// A listen address naming a relay (`<relay>/p2p/<id>/p2p-circuit`, the only shape a phone or browser
	// can take) is handed to libp2p as a bare `/p2p-circuit` and the relay is supervised by this node
	// instead, so the reservation survives relay restarts, dropped relay connections and libp2p's own
	// renewal. See `network/relay-reservation.ts` for why the configured shape cannot recover.
	// NOTE: accepted tradeoff — a bare `/p2p-circuit` listener also turns on libp2p's relay discovery,
	// whose topology handler can reserve on ANY connected peer serving the relay hop protocol (every
	// Optimystic node started with `relay: true` does), and that reservation takes the pending slot
	// meant for the named relay. The node then stays reachable, but through that other relay, so a
	// partner that enrolled its circuit address through the named relay cannot dial it until that
	// reservation drops; the supervisor reports it as `relay-reservation:slot-taken` and retries at its
	// backoff cap. It happens only when a relay-only node is directly connected to a second relay server,
	// and Sereus runs with the same behaviour. Revisit on a deployment that connects relay-only nodes to
	// more than one relay server, or when the ticket below is taken.
	// NOTE: the installed circuit-relay-v2 (4.2) renews a reservation in place and re-applies a
	// `configured` reservation for the relay a listener already published. So the supervisor could keep
	// the host's configured address and ask again with 'configured', which would drop the rewrite and
	// the discovery side effect above. Not done: ticket
	// `debt-relay-supervisor-can-keep-the-configured-listen-address`.
	const relayPlan = planRelayListenAddrs(options.listenAddrs ?? defaults.listenAddrs);
	assertRelayAddrsAdvertisable(relayPlan.supervisedRelays, options.announceAddrs);
	const listenAddrs = relayPlan.listenAddrs;
	const holePunching = holePunchingWanted({
		holePunching: options.holePunching,
		listenAddrs,
		announceAddrs: options.announceAddrs,
		appendAnnounceAddrs: options.appendAnnounceAddrs
	});
	if (!holePunching) {
		wiringLog(options.holePunching === false
			? 'hole punching off: NodeOptions.holePunching is false'
			: 'hole punching off: no directly dialable listen or announce address');
	}
	const transports = options.transports ?? defaults.transports;

	// --- cohort-topic substrate activation (opt-in; default off → today's bare behavior, zero cost) ---
	const cohortEnabled = options.cohortTopic?.enabled === true;
	// Resolved once: the host's non-root cohort width, also used by the forwarder's child-cohort reads below.
	const cohortWantK = options.cohortTopic?.wantK ?? 16;
	// When enabled on a serving node, the cluster member records the consensus commit cert into this store
	// synchronously, BEFORE `storageRepo.commit` emits the change event the bridge's extractor resolves it
	// from (see cluster-repo.ts §captureConsensusCommitCert). Created early because the sink must be passed
	// into `clusterMember(...)`. Composed with any caller-supplied `onCommitCertificate` so both fire. A
	// client applies no commits, so it originates nothing and keeps no store.
	const certStore: CommitCertStore | undefined = cohortEnabled && serving ? createCommitCertStore() : undefined;
	const onCommitCertificate: CommitCertificateSink | undefined = certStore
		// `certStore.put` runs FIRST so origination's cert capture cannot be defeated by a throwing caller
		// sink: the whole composed call is isolated in `ClusterMember.captureCommitCert`, so a caller sink
		// that threw before the store was written would make that commit silently never originate. Ordering
		// the store first keeps origination correct regardless of the caller sink (`put` never throws).
		? (actionId, cert, tailIds): void => { certStore.put(actionId, cert, tailIds); options.onCommitCertificate?.(actionId, cert, tailIds); }
		: options.onCommitCertificate;

	const libp2pOptions: Libp2pInit = {
		start: false,
		privateKey: nodePrivateKey,
		// NOTE: libp2p's `AddressManagerInit` also carries `noAnnounce` and `announceFilter`; neither is
		// exposed on `NodeOptions`. Add them here the same way if a deployment ever needs to suppress a
		// specific advertised address rather than replace the whole set.
		addresses: {
			listen: listenAddrs,
			...(options.announceAddrs ? { announce: options.announceAddrs } : {}),
			...(options.appendAnnounceAddrs ? { appendAnnounce: options.appendAnnounceAddrs } : {})
		},
		connectionManager: {
			// `autoDial`, `minConnections`, and `dialQueue` were stale libp2p option keys silently
			// ignored under the former `libp2pOptions as any` (removed with this change). This libp2p
			// version has no such keys — auto-dial is now default connection-manager behavior with no
			// direct replacement — so they are dropped rather than re-cast. See review handoff.
			maxConnections: 16,
			// Always explicit, so the undeclared fallback (10_000, libp2p's own default) does not move
			// with libp2p. Both ends: every node is someone's listener.
			inboundUpgradeTimeout: options.connectionManager?.inboundUpgradeTimeout ?? linkDeadlines.inboundUpgradeTimeoutMs,
			dialTimeout: libp2pDialTimeoutMs,
			// libp2p applies this inside every dial, signalled or not, so left at its 6 s default it cut off
			// a relayed connection open on a slow link whatever the dial's own deadline said.
			addressDialTimeout: options.connectionManager?.addressDialTimeout ?? linkDeadlines.addressDialTimeoutMs
		},
		...(options.connectionGater ? { connectionGater: options.connectionGater } : {}),
		transports,
		connectionEncrypters: [noise({ crypto: options.noiseCrypto })],
		// Straight through, including `undefined`: libp2p reads an absent `connectionMonitor` as
		// "use my defaults", so a default of our own here would silently override them.
		connectionMonitor: options.connectionMonitor,
		streamMuxers: [yamux()],
		services: {
			// `@libp2p/identify` is the ONE service here whose protocol id it builds itself:
			// `Identify`/`IdentifyPush` both emit `/${protocolPrefix}/id[/push]/1.0.0`, always
			// prepending the leading slash (its own default is the BARE `'ipfs'`). So this
			// prefix must stay slash-LESS — passing `/optimystic/...` yields the malformed
			// double-slash `//optimystic/<net>/id/1.0.0`. Every other service below
			// (cluster/repo/sync/blockTransfer) concatenates its own template literal and so
			// takes the slash-PREFIXED `protocolPrefix` form; do not unify the two.
			// Locked by `identify-protocol-id.spec.ts`.
			// `runOnConnectionOpen: false` because this node runs identify on connection open itself
			// (`identifyOnConnectionOpen`, installed below before `start()`): the same call on the
			// same event, with its outcome observed. The built-in trigger discards the one outcome
			// that says a peer is not on this network at all.
			identify: identify({
				protocolPrefix: `optimystic/${options.networkName}`,
				runOnConnectionOpen: false
			}),
			// identify/push propagates *later* address/protocol changes (relay reservation,
			// AutoNAT-learned observed addr, a service registered post-start) to already-connected
			// peers. Without it those peers keep the stale snapshot from the initial identify.
			// Two consequences, both now covered by tests rather than asserted here:
			//  - Addresses: a relay-only peer's reservation completes AFTER its first connection to
			//    the relay, so the circuit address is exactly the one identify cannot have carried.
			//    The relay's peerStore entry stays empty and a later dial by peer id alone fails
			//    with NoValidAddressesError against a reachable peer — `relay-address-propagation.spec.ts`
			//    (its gated control reproduces that failure with push removed).
			//  - Protocols: `membershipOf` in `libp2p-key-network.ts` classifies a peer serves/
			//    foreign/unknown purely from the peerStore protocol list, so a cluster/repo handler
			//    registered post-start never flips an already-connected peer to `serves` —
			//    `identify-push-propagation.spec.ts`.
			identifyPush: identifyPush({
				protocolPrefix: `optimystic/${options.networkName}`
			}),
			// NOTE: constructed with only `timeout` (see {@link NodeOptions.pingHandlerTimeoutMs}), so
			// `@libp2p/ping`'s own `maxOutboundStreams: 1` is still the outbound
			// limit the registrar reports for `/ipfs/ping/1.0.0` to every caller on this node —
			// including libp2p's connection monitor, which pings on that same protocol. That limit is
			// what makes an overlapping ping abort the connection, and so what makes the deadline rule
			// in {@link NodeOptions.connectionMonitor} (`pingInterval` above `pingTimeout.minTimeout`)
			// necessary. Raising it here would retire that rule, change what every node accepts from an
			// application's own pings, and falsify `test/connection-monitor-ping-overlap.spec.ts` plus
			// both documents it backs — re-check all three before doing so.
			ping: ping({ timeout: pingHandlerTimeoutMs }),
			// DCUtR (hole punching) upgrades a relayed node↔node connection to a direct one. It runs
			// only on a node that advertises an address another machine could dial directly
			// (`holePunchingWanted`, overridden by `NodeOptions.holePunching`). Any other node —
			// relay-only, or listening only on loopback — can never complete dcutr's relayed exchange,
			// which needs a dialable address from both sides; the side that received the relayed
			// connection still makes three attempts at it: three wasted streams per relayed connection.
			// Leaving the service out on one side silences the pair, since dcutr starts only toward a
			// peer that advertises it too.
			// NOTE: accepted tradeoff — a node left without dcutr by the rule also loses the one
			// upgrade that can work for it: when a peer with a public address reaches it through a
			// relay, it would have dialed that peer directly. `holePunching: true` restores that per
			// node; revisit if relay-only nodes are found staying on relayed links to public peers that
			// could have been direct.
			...(holePunching ? { dcutr: dcutr() } : {}),
			// AutoNAT learns this node's public reachability through peer dial-back. It depends on
			// `identify` above and stays on every node: on a relay-only node it has nothing to confirm,
			// but nothing measured shows it costing streams there. Gate it by the same rule if it does.
			autoNAT: autoNAT(),
			// NOTE: no `pubsub` service. `@chainsafe/libp2p-gossipsub` (currently at 14.1.2, the newest
			// published version) is built against `@libp2p/interface@^2` — its `Stream` still expects
			// `.sink`/`.source`. Under libp2p 3 `Stream extends MessageStream` (event target +
			// AsyncIterable), which has neither, so `it-pipe`'s `isDuplex` check on the outbound stream
			// fails and `OutboundStream`'s constructor throws `fns.shift(...) is not a function`
			// synchronously — before gossipsub's own `.catch` can attach. Gossipsub logs and swallows
			// it, so the service reports as running while never sending a subscription to any peer:
			// `publish` always resolves with zero recipients. Verified end-to-end against this repo's
			// installed dependency tree (gotchoices/Optimystic#9). Nothing in this repo uses `pubsub`
			// today — re-add only against a gossipsub release built for libp2p 3.

			// Circuit relay server - enables this node to relay connections for other peers
			...(options.relay ? { relay: circuitRelayServer(options.relayServerInit) } : {}),

			// The four storage protocol services, registered only by a node that stores blocks: their
			// absence from a client's identify list is what keeps it out of every cohort.
			...(serving ? storageProtocolServices(serving, options, consensusConfig.superMajorityThreshold, inboundAuthorization, () => liveNode) : {}),

			// The blob protocol, on both roles and gated like the storage protocols: a client holds the
			// blobs its own host put, and until a row referencing one commits it holds the only copy, so
			// readers fetch it from the writer (docs/blobs.md §Placement, copying and durability).
			blob: (components: any) => blobProtocolService({
				protocolPrefix: `/optimystic/${options.networkName}`,
				blobs,
				pieces: pieceStore,
				progressTimeoutMs: linkDeadlines.responseTimeoutMs,
				// An announcement that arrives while the node is still starting is answered as a node whose
				// responsibility is undetermined answers, which the announcer's drain asks about again.
				onAnnounce: (peer, ref, scope) => blobReceiver
					? blobReceiver.decide(peer, ref, scope)
					: Promise.resolve<BlobAnnounceAnswer>(blobHold === 'on-demand' ? 'declined' : 'not-responsible'),
				// A `held` adds its sender to the blob's owed entry and re-counts the blob's durability; a
				// non-member's is dropped unread, as its announce is.
				onHeld: (peer, ref) => {
					if (!blobPeerAdmitted(peer)) {
						blobLog('held:dropped-non-member peer=%s ref=%s', peer, ref);
						return;
					}
					blobLog('held:received peer=%s ref=%s', peer, ref);
					void blobCopies?.noteHeld(peer, ref).catch(error =>
						blobLog('held:settle-failed peer=%s ref=%s err=%s', peer, ref, error instanceof Error ? error.message : String(error)));
				},
				...inboundAuthorization
			})({ registrar: components.registrar }),

			networkManager: (components: any) => {
				const svcFactory = networkManagerService({
					clusterSize: consensusConfig.clusterSize,
					expectedRemotes: (options.bootstrapNodes?.length ?? 0) > 0,
					allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
					clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5
				});
				const svc = svcFactory(components);
				// Best-effort proxy-time injection; the real node is re-injected post-construction below.
				try { (svc as SetLibp2pCapable).setLibp2p(components.libp2p); }
				catch (err) { wiringLog('networkManager in-factory setLibp2p failed (proxy); real node injected post-construction: %o', err); }
				return svc;
			},
			fret: (components: any) => {
				// NOTE: a client (`servesBlocks: false`) given bootstrap peers defaults to 'core' like any node, and so
				// keeps core's larger neighbour sets and forwarding share. Fine while clients are a minority of the
				// ring; if FRET maintenance shows up as a cost on client phones, default a client to 'edge' here.
				const svcFactory = fretService({
					k: 15,
					m: 8,
					capacity: 2048,
					profile: options.fretProfile ?? ((options.bootstrapNodes?.length ?? 0) > 0 ? 'core' : 'edge'),
					networkName: options.networkName,
					// FRET dials with a signal, so libp2p's `dialTimeout` never bounds its redials; this does.
					dialTimeoutMs: libp2pDialTimeoutMs,
					// FRET derives its maintenance ping, snapshot, tick and route budgets from this; undefined keeps its constants.
					linkRoundTripMs: options.linkRoundTripMs,
					// NOTE: FRET's `seedFromBootstraps` seeds the FIRST `/p2p/` id of each entry, so a partner's circuit
					// address (`<relay>/p2p/<relay>/p2p-circuit/p2p/<partner>`) seeds the relay, not the partner. Harmless
					// today: the partner is learned once its connection opens, and the relay is classified foreign. If a
					// phone ever fails to find a partner it was given only as a circuit bootstrap, fix FRET to take the last id.
					bootstraps: options.bootstrapNodes ?? []
				});
				const svc = svcFactory(components) as Libp2pFretService;
				// Best-effort proxy-time injection; the real node is re-injected post-construction below.
				try { (svc as SetLibp2pCapable).setLibp2p(components.libp2p); }
				catch (err) { wiringLog('fret in-factory setLibp2p failed (proxy); real node injected post-construction: %o', err); }
				return svc;
			}

			// [dispute-subsystem-dormant] The /optimystic/<network>/dispute/1.0.0 handler
			// (disputeProtocolService / DisputeProtocolService) is intentionally NOT registered here.
			// The subsystem is staged dormant pending arbitrator-set anchoring — without it, a peer
			// minting throwaway keypairs can forge a synthetic super-majority and pass resolution.
			// Gate: tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring
			// Wiring plan: tickets/backlog/feat-dispute-subsystem-live-activation
		},
		// The node dials its bootstrap peers itself, the moment it has started (`bootstrapContact`
		// below). This discovery entry stays for what it writes to the peerStore a second later:
		// each bootstrap address, which is what lets FRET re-probe by peer id a bootstrap peer that
		// was down at start, and the `bootstrap` tag, which keeps that peer's connection from being
		// pruned first under `maxConnections`. Its own dial at that point reuses the connection
		// ours opened, or is one more attempt when ours failed.
		peerDiscovery: [
			...(options.bootstrapNodes?.length ? [bootstrap({ list: options.bootstrapNodes })] : [])
		],
	};

	const node = await createLibp2p(libp2pOptions);

	// Bind the closure-captured node BEFORE start(): the cluster service's address-learning and
	// redirect-addr resolvers read it on every inbound request, and the first one can arrive as
	// soon as the protocol handler goes live in start().
	liveNode = node;

	// Release this node's lease on the raw-storage read cache when the node stops. Installed FIRST
	// — before start() and before every other stop wrapper — so it runs LAST in the wrapper chain,
	// after every monitor and service that may still read storage during its own stop. Only wired
	// when the seam handed out a lease: a MemoryRawStorage passes through unwrapped, and a
	// host-supplied `CachedRawStorage` stays the host's to dispose. Releasing a lease is safe even
	// when other nodes share the cache — it is cleared and unregistered only when the last lease
	// goes, so stopping one node never blinds the others. A skipped release leaks only cold
	// entries the pool evicts under pressure; the point of the polite release is honest pool
	// occupancy on a long-lived provider node. A client builds no serving store, so it never reaches this seam and holds no lease.
	const lease = serving?.lease;
	if (lease) {
		const previousStop = node.stop.bind(node);
		node.stop = async () => {
			try {
				await previousStop();
			} finally {
				await lease.release();
			}
		};
	}

	// Inject the REAL libp2p node into the services that need it, before start(). These are
	// load-bearing and the node has NOT started yet, so any throw fails fast and rejects node
	// creation (nothing started leaks) — far better than the service silently falling back to the
	// unreliable `components.libp2p` proxy and surfacing later as routing/consensus failures.
	const wired = node.services as unknown as WiredServices;
	wired.fret.setLibp2p(node);
	wired.networkManager.setLibp2p(node);
	// RepoService.checkRedirect resolves the key network / self id / connection
	// addrs through this injected node (the components.libp2p proxy is unreliable
	// from inside a service at request time). Done before start() so the protocol
	// handler is live with a resolvable node from its first request; the `keyNetwork`
	// attachment itself arrives after start(), and until then checkRedirect handles locally.
	// A client registers no repo service.
	if (serving) {
		if (!wired.repo) throw new Error('the repo service is missing from a node that serves blocks');
		wired.repo.setLibp2p(node);
	}

	// What this node establishes about its configured bootstrap peers, from its first connection on:
	// built here so it observes identify (which this node triggers itself, see the `identify`
	// service above) before anything can connect.
	const bootstrapContact = new BootstrapContactTracker(node.peerId, bootstrapTargets);
	// Every identify exchange in flight, with any peer: a cohort view that names nobody but this node
	// while one is in flight may be about to widen, which the cohort reachability gate reads.
	const identifyProgress = new IdentifyProgress();
	identifyOnConnectionOpen(node as unknown as IdentifyOnOpenHost, combineIdentifyObservers(bootstrapContact, identifyProgress));
	// Network-namespaced protocol prefix, threaded into the key network so coordinator/
	// cohort selection is scoped to peers that serve THIS network's cluster/repo protocol.
	// A peer that only belongs to another network sharing the same physical nodes/
	// bootstraps registers a different (network-namespaced) identify protocol, so it is
	// never selected and can't drag this network's super-majority below quorum.
	const protocolPrefix = `/optimystic/${options.networkName}`;
	// libp2p merges a stream's protocol into the remote peer's record on every stream, both ends, at a
	// cost that showed up on phones (GitHub #40). Until libp2p/js-libp2p#3692 ships, cap that at once a
	// minute per peer and protocol; the module says when to delete this.
	throttleProtocolMerges(node.peerStore, node.peerId);
	// The same merge would record a peer that merely sends this node a storage request as serving
	// storage; only the peer's own identify may say that. Installed outside the throttle, so a dropped
	// merge never reaches its bookkeeping, and kept when the throttle goes.
	filterStorageClaimMerges(node.peerStore, node.peerId, protocolPrefix);

	// A relay-naming listen address with no circuit-relay transport can never be reserved on. Checked
	// here, before start(), so the caller sees the omission by name rather than libp2p's generic
	// unsupported-listen-address error for the bare `/p2p-circuit` the plan substituted.
	assertCircuitRelayTransport(node, relayPlan.supervisedRelays);

	await node.start();

	// Reach for the configured bootstrap peers at once. Left to the discovery entry above, the
	// first dial is a second away, and for that second this node believes it is alone: whatever it
	// opens and does not find locally, it founds from scratch (GitHub issue #27). Not awaited, and
	// nothing to release: the key network below reads the contact's progress, and stopping the
	// node aborts any dial still in flight.
	bootstrapContact.dial(node);

	// Everything from here to the `return` runs against an ALREADY STARTED node (open transports,
	// listening addresses, running services). A rejection out of that span used to hand the caller an
	// error and no handle, leaving the node running with its listener port still bound — unrecoverable
	// for the caller and enough to block the port for the next start attempt. So the whole post-start
	// body rolls back: see the `catch` at the bottom of this function.
	try {
		// Keep every relay-naming listen address's reservation alive (see `relayPlan` above). Started
		// first, with its stop wrapper installed before anything is awaited, so the rollback `catch`
		// below stops it too. Awaiting the first drives keeps today's startup contract: a relay that
		// cannot be reserved rejects node creation, naming the relay, exactly as libp2p's own
		// `listen()` on the configured shape did. A host that would rather start offline and let the
		// supervisor recover is a separate decision, not an option here.
		if (relayPlan.supervisedRelays.length > 0) {
			const relaySupervisors = superviseRelayReservations(node, relayPlan.supervisedRelays, options.relayReservation);
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				try {
					relaySupervisors.stop();
				} finally {
					await previousStop();
				}
			};
			await relaySupervisors.awaitFirstDrives();
		}

		// Initialize peer reputation service
		const reputation = new PeerReputationService({ selfPeerId: node.peerId.toString() });

		// Initialize cluster coordination components
		const bootstrap: BootstrapContactOptions | undefined = bootstrapContact.peerIds.length > 0
			? { contact: bootstrapContact, contactTimeoutMs: bootstrapContactTimeoutMs }
			: undefined;
		// Built once, here, and handed to every peer-selection path that must obey it (`undefined`
		// without a predicate, which every consumer skips): the key network, and, on a serving node, the
		// four senders that take peers from FRET directly — spread-on-churn, the ring-shift confirm,
		// restoration and the under-replication drain.
		const membership = createNetworkMembershipGate(options.isNetworkMember, node.peerId.toString(),
			createLogger('network-membership', node.peerId.toString()));
		// Streams negotiated ahead of the request that takes them, so a request to a peer this node is
		// already talking to skips the protocol negotiation's round trip (`network/prepared-streams.ts`).
		// Its stop wrapper is installed at once, so a startup rollback closes it too; it reports its
		// background opens under the same peer-suffixed `open-protocol-stream` namespace the key network does.
		const preparedStreams = new PreparedStreams(node, {
			protocols: preparedStreamProtocols(protocolPrefix, servesBlocks),
			deadlines: linkDeadlines,
			streamOpenLog: createLogger('open-protocol-stream', node.peerId.toString())
		});
		{
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				try {
					preparedStreams.close();
				} finally {
					await previousStop();
				}
			};
		}
		const keyNetwork = new Libp2pKeyPeerNetwork(node, consensusConfig.clusterSize, undefined, bootstrap, options.persistence, reputation, protocolPrefix, linkDeadlines, membership, preparedStreams);
		await keyNetwork.initFromPersistedState();
		// One detector per node, beside the key network: the serving role feeds it (goodbyes, failed
		// consults) and both drains suppress their passes while it reports a partition. A client feeds
		// it nothing, and an unfed detector counts no recent goodbye and no consecutively-failing peer,
		// so it never reports a partition and never suppresses a client's blob passes.
		const partitionDetector = new PartitionDetector();
		// The offline queue's reachability gate (`node.cohortReachability`). Outside every optional
		// subsystem's gate: it needs only the key network, the identify count and the node's events. Its
		// stop wrapper is installed at once, so a startup rollback releases its event listeners too.
		const cohortReachability = new KeyNetworkCohortReachability({
			keyNetwork,
			selfId: node.peerId.toString(),
			identifying: () => identifyProgress.inFlight(),
			events: node,
			wakeDebounceMs: options.cohortReachability?.wakeDebounceMs
		});
		{
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				try {
					cohortReachability.stop();
				} finally {
					await previousStop();
				}
			};
		}

		// Inject reputation into NetworkManagerService. Load-bearing and non-optional: the service is
		// unconditionally present, so a throw is a real wiring bug. The node has already started here, but
		// no ad-hoc stop is needed: the post-start rollback `catch` at the bottom of this function stops it.
		wired.networkManager.setReputation(reputation);

		// The FRET service, read by the serving role and by cohort-topic activation.
		const fretSvc = (node as any).services?.fret as FretService | undefined;

		const networkManager = (node as any).services?.networkManager as NetworkManagerService | undefined;

		// See the comment above `consensusConfig` for why every cluster-size consumer must read the SAME
		// resolved value. This throws at construction (rather than letting a node come up mismatched) if a
		// future edit gives `keyNetwork` or `networkManager` their own fallback again. A client runs it too:
		// it builds both.
		assertClusterSizeCoupling(consensusConfig.clusterSize, { keyNetwork, networkManager });

		// The serving role: every subsystem that assumes this node holds blocks, built as one unit, and
		// not at all on a client (docs/internals.md §Client nodes). Each stop wrapper inside it is
		// installed right after its resource, so the rollback below unwinds whatever of it was built.
		const served = serving
			? await wireServingRole({
				node, options, serving, keyNetwork, protocolPrefix, linkDeadlines, consensusConfig, reputation,
				fretSvc, nodePrivateKey, onCommitCertificate, membership, networkManager, pieceStore,
				partitionDetector
			})
			: undefined;

		// The start-up sweep removes the pieces of a put a crash interrupted. Its stop wrapper follows at
		// once, so the rollback below stops the service too.
		blobs.start();
		{
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				try {
					await blobs.stop();
				} finally {
					await previousStop();
				}
			};
		}
		// Its stop wrapper runs before the blob service's, so no fetched piece is stored after that.
		const blobTransfer = wireBlobFetcher({ node, protocolPrefix, linkDeadlines, keyNetwork, membership, reputation, blobs });
		// The byte budget over the blobs this node kept only because it read them (docs/blobs.md
		// §Lifetime). Built before `node.blobs`, which triggers it after every read or fetch that pulled
		// something; its stop wrapper goes on AFTER the blob service's (installed above), so it runs
		// BEFORE it and no enforcement writes a record or sweeps once the blob service has stopped.
		const blobCacheBudget = new BlobCacheBudget({
			records: blobs,
			budgetBytes: blobCacheBudgetBytes,
			log: createLogger('blob:reclaim', node.peerId.toString()),
		});
		{
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				try {
					await blobCacheBudget.stop();
				} finally {
					await previousStop();
				}
			};
		}
		// Once, now: a budget lowered across a restart is applied to what the last run cached.
		blobCacheBudget.request();
		// `node.blobs`. The blob protocol service keeps answering from `blobs`: a peer's stat is about
		// what this node holds, and must not start a probe of its own.
		const nodeBlobs = new NodeBlobService({
			local: blobs,
			fetcher: blobTransfer.fetcher,
			client: blobTransfer.client,
			holders: blobTransfer.holders,
			probeTimeoutMs: linkDeadlines.responseTimeoutMs,
			// Reader repair (docs/blobs.md §Placement, copying and durability): the receiver is built a few
			// lines below, before anything can read through this service.
			afterFetchedWhole: ref => blobReceiver?.keepAfterRead(ref),
			requestCacheEnforcement: () => blobCacheBudget.request(),
			// Left off entirely when the drain is disabled, so `announce` rejects rather than taking a
			// hold on a blob nothing would announce. Bound through the `let` above, as
			// `afterFetchedWhole` is: the drain is built below, before the factory returns.
			...(blobCopyWanted
				? {
					oweCopies: async (ref: BlobRef, scope: BlobScope): Promise<void> => {
						if (blobCopies === undefined) throw new Error(`Blob ${ref} cannot be announced yet: its copy drain is still starting`);
						await blobCopies.owe(ref, scope);
					}
				}
				: {}),
		});
		// The node's own reader of committed state, for deciding whether a blob is referenced (docs/blobs.md
		// §Who may fetch and who may store). Built the way a host's transactor over the node is, but with no
		// change notifier: it reads, it does not watch. Not attached to the node, so no host writes through a
		// transactor that would never hear of its own commits. It never pends or cancels, so it never owes a
		// cancel and needs no `stop()` on the node's way down.
		const committedReader = createNodeNetworkTransactor({
			peerId: node.peerId,
			keyNetwork,
			coordinatedRepo: served?.coordinatedRepo,
			storageRepo: served?.storageRepo,
			protocolPrefix,
			linkDeadlines,
			clock: hlcClock,
		});
		const blobReferences = new BlobReferenceCheck({ transactor: committedReader });
		// The receiving half of `announce`, on both roles: a client is in no cohort, so it answers
		// `not-responsible` to everything (and `declined` when it is on-demand), which is honest and
		// costs no read. Its stop wrapper goes on at once, ahead of the fetcher's (installed earlier, so
		// it runs after this one): a pull that ends after the receiver stops sends no `held`.
		blobPeerAdmitted = peer => admittedBy(membership, peer);
		blobReceiver = new BlobAnnounceReceiver({
			selfId: node.peerId.toString(),
			hold: blobHold,
			keyNetwork,
			membership,
			limiter: new AnnounceLimiter(),
			references: blobReferences,
			local: blobs,
			fetcher: blobTransfer.fetcher,
			client: blobTransfer.client,
			// Both ends abort a blob stream that moves no bytes for one response timeout, and nothing moves
			// while the receiver reads committed state; the other half of the timeout is for the answer frame.
			answerWithinMs: linkDeadlines.responseTimeoutMs / 2,
		});
		{
			const receiver = blobReceiver;
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				receiver.stop();
				await previousStop();
			};
		}
		// Finishes the pulls a restart interrupted: the `responsible` hold is flushed before `fetching` is
		// answered, so the references to resume are in this node's own blob records.
		void blobReceiver.resume().catch(error => blobLog('resume:failed err=%s', error instanceof Error ? error.message : String(error)));

		// --- The owed-copies drain: announce each owed blob until its cohort holds it ---
		// On BOTH roles, unlike the block drain: a client (`servesBlocks: false`) is often the machine a
		// blob was put on and the only holder of it until the cohort copies it, so it must announce and
		// must report durability (docs/blobs.md §Placement, copying and durability). Built after the
		// receiver so its stop wrapper runs BEFORE the receiver's and the fetcher's: no announcement goes
		// out once the node has begun stopping. The ledger is built whatever the drain's setting — its
		// index loads lazily, so an unused one costs a constructor — and exposed for diagnostics.
		const owedBlobLedger = new OwedBlobLedger(kvStore);
		if (blobCopyWanted) {
			const { enabled: _blobCopyEnabled, ...blobCopyConfig } = options.blobs?.copy ?? {};
			blobCopies = new BlobCopyDrain({
				libp2p: node,
				selfId: node.peerId.toString(),
				hold: blobHold,
				keyNetwork,
				partitionDetector,
				membership,
				blobProtocol: blobTransfer.blobProtocol,
				ledger: owedBlobLedger,
				records: blobs,
				announce: (peerId, ref, scope) => blobTransfer.client.announce(peerIdFromString(peerId), ref, scope),
				acceptance: peerIds => blobAcceptanceOf(keyNetwork, blobTransfer.blobProtocol, peerIds),
				// A `whole` answer or an arriving `held` also counts for the cohort monitor's growth arm, so
				// it stops re-announcing that reference to that peer.
				onHolderConfirmed: (ref, peerId) => blobRebalanceMonitor?.recordBlockHolders({ blockIds: [ref], holders: [peerId] }),
			}, blobCopyConfig);
			{
				const drain = blobCopies;
				const previousStop = node.stop.bind(node);
				node.stop = async () => {
					try {
						await drain.stop();
					} finally {
						await previousStop();
					}
				};
			}
			await blobCopies.start();
		}
		// --- Giving back the blobs committed state no longer lists ---
		// The reference pass of docs/blobs.md §Lifetime, on BOTH roles like the copy drain and unlike the
		// blob rebalance monitor: a client takes no `responsible` hold, but it is often the machine a blob
		// was put on, so it owns owed entries and must drop the ones whose rows are gone — and its
		// `aloneFor` is answerable, since it has a key network, while its `responsibleMarks()` is simply
		// empty. Its stop wrapper goes on immediately, after the blob service's (installed above), so it
		// runs BEFORE it and no pass writes a record or sweeps once the blob service has stopped.
		const blobReclaim = new BlobReclaimPass({
			records: blobs,
			owed: owedBlobLedger,
			transactor: committedReader,
			cohort: cohortReachability,
			partitionDetector,
			// The row the cache budget already created; the two mechanisms are independent and share it.
			log: createLogger('blob:reclaim', node.peerId.toString()),
		}, { graceMs: blobReclaimGraceMs });
		{
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				try {
					await blobReclaim.stop();
				} finally {
					await previousStop();
				}
			};
		}
		blobReclaim.start();
		// --- Following the cohort of the blobs this node keeps for the network ---
		// A second `RebalanceMonitor`, over blob references instead of block ids: the cohort comparison it
		// makes for blocks, made for blobs by giving it the blob routing rule (docs/blobs.md §Placement,
		// copying and durability, *When the cohort changes*). It is built here, not inside the serving
		// role, because the blob service, the drain and the reaction it reacts with are built here; the two
		// handles it needs exist only inside that role's arachnode gate, which hands them back. A client
		// (`servesBlocks: false`) runs no serving role and so gets no blob monitor — which is right: it is
		// in no cohort and never takes a `responsible` hold (`BlobAnnounceReceiver` answers
		// `not-responsible`), and its owed blobs are followed by the drain on its own passes. Without FRET
		// or with arachnode disabled this stays inert exactly as the block reaction does, and a wiring
		// failure is logged and non-fatal for the same reason: following a cohort is a resilience
		// mechanism, and the drain still keeps a writer's copies moving without it.
		if (served?.arachnode && (options.rebalance?.enabled ?? true) !== false) {
			// Hoisted out of the `try` so the catch below can drop it: a failure after the feed is
			// subscribed but before the stop wrapper is installed would otherwise leave a listener adding
			// to a monitor nothing ever reads or tears down.
			let offHoldsFeed: (() => void) | undefined;
			try {
				// Its own tracked set, never the shared owned-block set: these ids are blob references, placed
				// by a different routing rule. Its was-responsible memory (`responsibilitySnapshot`) is
				// per-monitor already.
				const heldBlobRefs = new Set<string>();
				// `options.rebalance` is shared with the block monitor: one switch and one set of tuning for
				// "react to cohort changes". Constructed directly rather than through
				// `NetworkManagerService.initRebalanceMonitor`, which holds the block instance.
				const monitor = new RebalanceMonitor({
					libp2p: node,
					fret: served.arachnode.fret,
					partitionDetector,
					fretAdapter: served.arachnode.fretAdapter,
					trackedBlocks: heldBlobRefs,
					keyNetwork,
					clusterSize: consensusConfig.clusterSize,
					// Every id in `heldBlobRefs` came from a blob record, so it is a canonical reference.
					routingKeyOf: id => routingKeyForBlob(id as BlobRef),
					logName: 'blob:copy',
				}, options.rebalance);
				// The tracked set is the references kept for the NETWORK — an `owed` or a `responsible` hold.
				// A pin or a `cached` hold is this node's own business: a node does not announce a blob it
				// merely read. Fed before the seed below, so a hold taken during the seed is not missed.
				//
				// Best-effort iteration safety, as the owned-block set's eviction already accepts: this can
				// add to or delete from the set while a check is mid-`for...of` over it, which does not throw
				// in JavaScript — entries are visited best-effort — so it is documented rather than locked.
				//
				// NOTE: tracking an `owed`-only reference buys little — the release arm skips it
				// (`release:not-responsible`) and `BlobCopyDrain` already follows its cohort on every pass,
				// so the growth arm only duplicates announcements the drain would send, at one `findCluster`
				// per owed reference per check. Kept because it is the one thing that still announces a
				// writer's owed blobs when `blobs.copy.enabled` is false while owed entries from an earlier
				// run remain, and because `owed` is as much "kept for the network" as `responsible` is. If a
				// node holding many owed references ever shows these checks or announcements as costly, feed
				// only `responsible` here and leave owed blobs entirely to the drain.
				offHoldsFeed = blobs.onHoldsChanged((ref, holds) => {
					if (holds.some(hold => hold.kind === 'owed' || hold.kind === 'responsible')) {
						monitor.trackBlock(ref);
					} else {
						monitor.untrackBlock(ref);
					}
				});
				const reaction = new BlobCohortReaction({
					selfId: node.peerId.toString(),
					membership,
					partitionDetector,
					records: blobs,
					owed: owedBlobLedger,
					acceptance: peerIds => blobAcceptanceOf(keyNetwork, blobTransfer.blobProtocol, peerIds),
					// Absent when the copy drain is switched off, and then nothing declines; such a node still
					// follows the cohort of the blobs it holds `responsible`.
					declining: blobCopies,
					announce: (peerId, ref, scope) => blobTransfer.client.announce(peerIdFromString(peerId), ref, scope),
					stat: (peerId, refs) => blobTransfer.client.stat(peerIdFromString(peerId), refs),
				});
				// `onRebalance` fires synchronously from the monitor's debounced check, so the reaction is
				// hopped off its emit loop; a rejection out of `handle` is a local fault (an unreadable
				// record), logged rather than left unhandled, and nothing is recorded, so the next check
				// retries — as the block reaction's handler does.
				//
				// NOTE: no in-flight guard. The handler starts a reaction and returns, so a check landing
				// before the previous reaction settles runs a second one over the same references. Unlikely
				// (`minRebalanceIntervalMs` is 60 s and a reaction is a few round trips) and benign if it
				// happens: `releaseResponsible` is idempotent, duplicate announcements are what
				// `AnnounceLimiter` is for, and two reactions over one snapshot agree on their outcomes. If
				// overlapping reactions ever do show up, hold one in-flight promise here and skip a check
				// that lands on top of it, as `BlockTransferCoordinator` does with its `inFlight` keys.
				// (`RebalanceMonitor.recordGrowthOutcome`'s own NOTE already accepts the one effect two
				// racing checks have on its state: one growth attempt double-counted.) A reaction still in
				// flight when the node stops is the same shape and equally benign: `monitor.stop()` does not
				// wait for it, so its remaining announcements go out while the transports are still up and
				// its last record write either lands or rejects into the catch below — a hold left unreleased
				// is the safe direction and is re-detected on the next run.
				monitor.onRebalance((event) => {
					reaction.handleRebalanceEvent(event).then(async (result) => {
						// In turn: at most a cohort's worth per check, each one serialized record write. The feed
						// above untracks the reference when the release leaves no `owed` hold behind.
						for (const ref of result.released) await blobs.releaseResponsible(ref);
						for (const ref of result.retained) monitor.retainLost(ref);
						for (const [ref, outcome] of result.growth) monitor.recordGrowthOutcome(ref, outcome);
					}).catch((err) => { blobCopyLog('reaction:failed err=%o', err); });
				});
				await monitor.start();
				blobRebalanceMonitor = monitor;
				let seedStopping = false;
				{
					const previousStop = node.stop.bind(node);
					node.stop = async () => {
						seedStopping = true;
						offHoldsFeed?.();
						try {
							await monitor.stop();
						} finally {
							await previousStop();
						}
					};
				}
				// After `start()`: holder evidence is ignored while the monitor is stopped. Fire-and-forget so
				// a large record store never holds up startup, and cancellable through the stop wrapper above,
				// exactly as the owned-block seed is.
				void seedHeldBlobs({ records: blobs, owed: owedBlobLedger, monitor, isStopping: () => seedStopping })
					.catch((err) => { wiringLog('held-blob-seed seed failed: %o', err); });
			} catch (err) {
				offHoldsFeed?.();
				wiringLog('blob rebalance wiring init failed: %o', err);
			}
		}
		// Expose for tests/diagnostics, as the block drain and its ledger are exposed.
		(node as any).blobCopyDrain = blobCopies;
		(node as any).owedBlobLedger = owedBlobLedger;
		(node as any).blobCacheBudget = blobCacheBudget;
		(node as any).blobReclaimPass = blobReclaim;
		(node as any).blobRebalanceMonitor = blobRebalanceMonitor;

		// The host-facing attachment surface, declared once in `optimystic-node.ts` and written here
		// through typed object literals so every field is type-checked AND a field added to
		// `OptimysticNodeAttachmentsBase` (or to either role's shape) but never assigned here is a compile
		// error rather than an `undefined` a host reads as present. Keeping it typed is load-bearing: when
		// `node.keyNetwork` was reachable only through a cast, three hosts found it easier to build a
		// SECOND Libp2pKeyPeerNetwork from constructor defaults — a different cohort width and no
		// network-membership filter than this node's own consensus path uses for the same key
		// (ticket bug-second-key-network-built-with-defaults).
		const shared: OptimysticNodeAttachmentsBase = {
			keyNetwork,
			reputation,
			// The node's libp2p Ed25519 identity key. Exposed on the same attachment surface as
			// coordinatedRepo/keyNetwork so a host can bind a client-transaction signer to it (the Quereus
			// collection-factory's getSigner reuses this via signPeer). libp2p does not surface the private
			// key on its public `Libp2p` interface, so this attachment is the sanctioned in-process handle.
			// Ed25519 by construction (options.privateKey defaults to generateKeyPair('Ed25519')).
			peerPrivateKey: nodePrivateKey,
			linkDeadlines,
			cohortReachability,
			hlcClock,
			blobs: nodeBlobs,
			blobReclaim,
		};
		const attachments: OptimysticNodeAttachments | OptimysticClientNodeAttachments = served
			? {
				...shared,
				servesBlocks: true,
				coordinatedRepo: served.coordinatedRepo,
				storageRepo: served.storageRepo,
				// The StorageRepo is the single commit funnel for both the coordinated and
				// direct paths, so it is the node's per-collection change-notifier origin. This is the
				// default; the cohort-topic activation block below REPLACES it with the origination-decorating
				// bridge notifier when the substrate is enabled.
				blockChangeNotifier: served.storageRepo,
				disputeService: served.disputeService,
				reportBlockHeld: served.reportBlockHeld,
			}
			: { ...shared, servesBlocks: false };
		Object.assign(node, attachments);

		// --- Cohort-topic origination activation (post-node: consumes the fully-assembled node + FRET) ---
		// This is the only place that is after the node + FRET are assembled (node.start() done, fretSvc
		// available) yet before any caller can capture `blockChangeNotifier` — the Quereus collection-factory
		// captures it once, immediately after createLibp2pNode returns, and reuses that reference as
		// `localChangeNotifier` for every NetworkTransactor it builds. Installing the bridge here makes the
		// origination path live for ALL collections created on the node.
		if (cohortEnabled) {
			// The host needs the full FRET engine surface; node.services.fret is the wrapper (see resolveFretEngine).
			const fret = resolveFretEngine(fretSvc);
			// The root group at a ring coordinate: the key network's storage rule in coordinate form. One
			// binding, shared by the host (root placement) and the forwarder-side reads below (push-state
			// gossip authenticity, recover targets), so no site can derive a root group by a different rule.
			// The change bridge (installed below, beside the origination manager it feeds) is what makes
			// origination live on this node.
			const rootGroupAt = (coord: Uint8Array): Promise<readonly string[]> => keyNetwork.servingCohortAt(coord);
			// The cohort consult the trust anchor asks through. A client has no storage to answer a self ask
			// from, and is never in a root group, so the anchor never asks it about itself; a self ask answers
			// "holds nothing", which is true.
			const latestClaim: ClusterLatestCallback = served?.clusterLatestCallback ?? clientClusterLatest(node.peerId,
				remoteClusterLatest(keyNetwork, protocolPrefix, linkDeadlines, consensusConfig.cohortQueryTimeoutMs));
			if (!fret) {
				// Operator opted in; degrading silently to the bare notifier would hide misconfiguration.
				// (The started node is torn down by the post-start rollback `catch` at the bottom of this function.)
				throw new Error('cohortTopic enabled but the FRET service is unavailable on the node');
			}

			// The reactivity root's membership anchor for a node OUTSIDE the tail's group (the ordinary
			// subscriber): the host's FRET anchor can judge a root cert only from a group snapshot this node is
			// in, so without this every distant root cert was trusted on first use. This anchor asks the tail's
			// storage group — `rootGroupAt`, the same rule the host serves the root under — for the tail block's
			// latest certified commit proof, through the node's own latest-revision consult (same per-peer
			// budget, self served from local storage), and judges the cert's signers against the cohort that
			// proof names. `docs/reactivity.md` §Authentication and integrity.
			const commitLogAnchor = new CommitLogTrustAnchor({
				membersAt: rootGroupAt,
				// The anchor reads only the claim and its proof, so it is not handed the archive to hold.
				// NOTE: it says nothing of what this node holds, so a peer sends the block's bytes, which are
				// thrown away here. Fine — it runs once per distant root certificate, not per read; if anchor
				// lookups ever show in request accounting, give the request a claims-only mode.
				latestClaimFrom: async (peerIdStr, blockId) => {
					const answer = await latestClaim(peerIdFromString(peerIdStr), blockId);
					if (!answer) return undefined;
					const { archive: _archive, ...claim } = answer;
					return claim;
				},
				thresholds: proofThresholds(consensusConfig.superMajorityThreshold),
				hash: createRingHash(),
			});

			const host = await createCohortTopicHost(node, fret, {
				...(options.cohortTopic!.host ?? {}),
				// Wire the node's reputation service in as the production backing for the bootstrap-evidence
				// referee verifier (the `{ isBanned, getScore }` view `PeerReputationService` satisfies), so a
				// configured cohort genuinely gates cold-root `bootstrap: true` (PoW always; reputation when a
				// referee endorsement is offered; a signed reference to an existing parent topic on any tier).
				// The node service is the *default* backing — a caller that supplies its own `antiDos.reputation`
				// (or any other `antiDos` override) still wins, since the caller spread comes last.
				antiDos: { reputation, ...(options.cohortTopic!.host?.antiDos) },
				// committedParentTopicReader (the T0/T1 committed-tier parent-reference existence backing) is
				// intentionally left unwired: no coord-keyed committed-membership index exists yet (the
				// transaction-log commit certificate is keyed by action, not by coord_0). So the host default
				// fails T0/T1 parent-ref existence closed — a FRET-cached cert must not vouch for committed-tier
				// existence (committed-tier integrity) — while T2/T3 parent-ref consults the FRET membership cache
				// for real. The dedicated committed backing is the follow-on `cohort-topic-parent-ref-tx-log-content`;
				// an operator may still pass one via cohortTopic.host.committedParentTopicReader.
				privateKey: nodePrivateKey, // real k − x threshold signing
				wantK: cohortWantK,
				// Root placement (docs/reactivity.md §Origination point): a root-placed topic's root group is the
				// key network's serving cohort at the root coordinate — the SAME assembly `findCluster` places a
				// block with, so a reactivity tree rooted at `H(routingKeyForBlock(tailId))` sits on exactly the
				// machines that store the tail, which are the machines that apply and announce its commits. The
				// threshold is the consensus super-majority ratio the commit certificate was captured under.
				rootGroup: { membersAt: rootGroupAt, quorumRatio: consensusConfig.superMajorityThreshold },
				// FRET first, then this; a caller's own anchor (a harness) replaces the commit-log one.
				trustAnchor: options.cohortTopic!.host?.trustAnchor ?? commitLogAnchor,
				// The host's dials open streams under this node's hedge and dead-connection delays.
				streamOpen: options.cohortTopic!.host?.streamOpen ?? linkDeadlines,
			});

			// --- Cohort-topic + reactivity + matchmaking teardown ---
			// Installed HERE, immediately after `host` exists and BEFORE the ~230 lines of reactivity /
			// matchmaking wiring below, because the post-start rollback only unwinds resources whose stop
			// wrapper is already installed at the moment of the throw. With the wrapper at the END of the
			// block (where it used to live) a throw mid-wiring left the host's gossip timer and cohort-topic
			// protocol handlers running. The bindings it releases are therefore declared up front and
			// undefined-guarded — same idiom as `offOwnedBlockFeed` above — so this tears down exactly what
			// has been created so far, whether that is the host alone or the whole wiring.
			//
			// Ordering (load-bearing): release reactivity timers + protocol handlers BEFORE host.stop()
			// (which clears the cohort gossip timer + unhandles the cohort-topic protocols) BEFORE the node's
			// transports close (previousStop). Composes with the existing arachnode + clusterMember stop
			// wrappers (each calls its captured previousStop last). `node.unhandle` on a protocol that was
			// never registered does not throw — libp2p's registrar deletes each id from its handler map
			// (a miss is silently ignored) and then re-patches the peer store's advertised protocol list —
			// so the handler releases need no separate registration flags.
			const reactivityProtocols = DEFAULT_REACTIVITY_PROTOCOLS;
			const matchmakingProtocols = DEFAULT_MATCHMAKING_PROTOCOLS;
			let unsubscribeCohortBridge: (() => void) | undefined;
			let offInboundNotify: (() => void) | undefined;
			let pushStateGossip: ReactivityPushStateGossipDriver | undefined;
			let reactivityRotation: RotationReRegistrationScheduler | undefined;
			let reactivityWatch: ReactivityCollectionWatch | undefined;
			let arrivalPushDriver: ArrivalPushDriver | undefined;
			let unsubscribeArrivalPush: (() => void) | undefined;
			{
				const previousStop = node.stop.bind(node);
				node.stop = async (): Promise<void> => {
					try {
						// The watch service first: its subscriptions' ticks and scheduled moves must not run
						// against a scheduler or a host that has already stopped.
						await reactivityWatch?.stop();
						reactivityRotation?.stop();
						pushStateGossip?.stop();
						offInboundNotify?.();
						await node.unhandle(reactivityProtocolList(reactivityProtocols));
						// No new pushes once the host stops reporting arrivals; the driver's coalescing timers go with it.
						unsubscribeArrivalPush?.();
						arrivalPushDriver?.stop();
						await node.unhandle(matchmakingProtocolList(matchmakingProtocols));
						unsubscribeCohortBridge?.();
						await host.stop();
					} finally {
						await previousStop();
					}
				};
			}

			// Expose the host so the reactivity origination wiring (and the activation test) can install
			// `CohortTopicService.onLocalCommit`.
			(node as any).cohortTopicHost = host;

			// --- Reactivity notification transport (origination → fan-out → inbound delivery → push-state gossip) ---
			// Compose notify + forwarder-host + push-state-gossip onto the cohort-topic host so a committed change
			// on a tail-cohort member actually reaches subscribers on OTHER nodes over real sockets. The change
			// bridge above fires `onLocalCommit`; this is what the emitted notifications travel over.
			// (docs/reactivity.md §Notification origination / §Propagation.) Reactivity reuses the canonical,
			// network-agnostic protocol IDs, matching the cohort-topic family's production default.
			const selfPeerId = node.peerId.toString();
			const reactivityProfile = host.profile; // Edge ⇒ subscriber-only via the policy gate; Core forwards.
			const reactivityPolicy = reactivityNodePolicy(reactivityProfile);
			// The ratio every reactivity verifier on this node applies to a root group's signers:
			// `ceil(|group| × ratio)`, the formula `captureCommitCert` signs the group's commit certificate under.
			const reactivityQuorumRatio = consensusConfig.superMajorityThreshold;

			// Node-level subscriber registry, keyed by the collection's topic: a constructed
			// ReactivitySubscriptionManager registers here so a socket-delivered NotificationV1 reaches it. The
			// collection watch service (step 7 below) is what constructs managers and registers them.
			const reactivitySubscribers = new ReactivitySubscriberRegistry();
			(node as any).reactivitySubscribers = reactivitySubscribers;

			// 1. Notify transport — unicast NotificationV1 send + inbound subscribe. selfPeerId guards self-dials.
			const notify = new Libp2pReactivityNotifyTransport(node, { selfPeerId, streamOpen: linkDeadlines });

			// 2. Forwarder host — turns the forward decision into live fan-out over the notify transport.
			const forwarderHost = new ReactivityForwarderHost({
				transport: notify,
				selfPeerId,
				profile: reactivityProfile,
				pushStateInit: (topicId: Uint8Array, n: NotificationV1): PushStateInit => ({
					collectionId: n.collectionId,
					topicId: bytesToB64url(topicId),
					tailIdAtJoin: n.tailId,
					deltaMaxBytes: reactivityPolicy.deltaMaxBytes,
				}),
				verifierFor: (): NotificationVerifier => createNotificationVerifier({ verifier: host.service.verifier(), tier: Tier.T3, quorumRatio: reactivityQuorumRatio }),
				directSubscribers: (topicId: Uint8Array, rootTail: Uint8Array): string[] => {
					// Read the direct-subscriber records of the engine serving THIS root: the one at the root
					// coordinate of the notification's tail, placed as a root. Looking up by topic alone would also
					// find the outgoing root's engine of the same topic during its drain window. The adapter
					// filters to reactivity appState and maps participantId bytes → dialable peer-id strings (the
					// transport's `peerIdFromString` space) — NOT base64url, which would silently fail to dial. No
					// engine here (no subscriber has registered at this root) ⇒ [].
					//
					// NOTE: this is only what THIS member's registry holds, so for up to one gossip round (5 s)
					// after a registration is admitted, a commit announced by a different member of the same
					// group reaches nobody. Harmless today — the watcher's first keep-alive is 30 s away and
					// gossip has long since converged — but it is why a test that pushes immediately after a
					// watch attaches has to wait for the registration to replicate. If that window ever matters,
					// the announcer must ask the group for its subscribers rather than only itself.
					const engine = host.registry.findByCoord(reactivityRootCoord(rootTail));
					return engine === undefined || !engine.rootPlaced ? [] : reactivityDirectSubscribers(engine, topicId);
				},
				// No childCohorts until cohort-topic-parent-child-link populates PushState.childCohorts (single
				// tier-0 reach today); wire the resolver anyway. A child cohort's primary is the FRET-nearest member
				// of its coord, returned as a peer-id string (the dial space).
				resolveChildPrimary: (ref: CohortRef): string | undefined => {
					const peers = fret.assembleCohort(b64urlToBytes(ref.coord), cohortWantK);
					return peers.length > 0 ? peers[0] : undefined;
				},
				deliverLocal: (topicId: Uint8Array, n: NotificationV1): void => reactivitySubscribers.deliver(topicId, n),
			});

			// Inbound notify frames → forwarder host (subscriber role delivers in-process; forwarder role fans out).
			// NOTE: the five `register*Handler` helpers below (notify / pushStateGossip / recover /
			// matchmaking query / arrival push) all call `registerProtocolHandler(...)` fire-and-forget (`void`), so a rejected
			// registration escapes the post-start rollback `catch` as an UNHANDLED rejection instead of
			// failing node creation. Harmless today — every protocol id here is a fixed constant registered
			// exactly once, so the only realistic rejection is a duplicate, and that needs a caller to pass
			// overlapping custom `cohortTopic.host.protocols`. If any of these ids ever becomes
			// caller-configurable, or a helper grows a registration that can genuinely fail, make them await
			// their `registerProtocolHandler` so the failure reaches the rollback.
			registerNotifyHandler(node, reactivityProtocols.notify, notify);
			offInboundNotify = notify.onNotification((from, n): void => { void forwarderHost.onInbound(from, n); });

			// 3. Origination emit — install onLocalCommit: a member commit builds a NotificationV1 and ingests it.
			// A serving node only: a client applies no commits, so it announces none and holds no cert store. The
			// rest of the reactivity stack below runs on a client too, for its subscriber role.
			if (served && certStore) {
				const origination = new ReactivityOriginationManager({
					service: host.service,
					// The collection id and tail go on the notification in the pinned encodings a subscriber registers
					// under (see liveOriginationContext); a tail-less event never originates.
					resolveContext: (event) => liveOriginationContext(event, reactivityPolicy.deltaMaxBytes),
					// The host ingests at the root n.tailId names, on reactivityNotificationTopicId(n) =
					// reactivityCollectionTopicId(b64urlToBytes(n.collectionId)); since n.collectionId =
					// b64url(reactivityCollectionIdBytes(id)), this is the SAME topic a subscriber registers under — closing
					// the encoding loop. The root the verifier derives comes from n.tailId = b64url(reactivityTailBytes(tail)).
					emit: (n): void => { void forwarderHost.ingest(n); },
					// Observe-rotation: when a commit names a tail other than the one this node last announced at, the
					// old root has rotated. Start its drain so the recover serve begins redirecting to the new root (the
					// `reactivity-rotation-recover-redirect-drain` markRotated seam). `oldTail` is in the reactivity tail
					// encoding the host keys a root's state by; the redirect carries the collection's unchanged topic.
					markRotated: (oldTail, redirect, now): void => forwarderHost.markRotated(oldTail, redirect, now),
				});
				origination.install();

				// Origination gate: the bridge announces a commit iff this node applied its log tail
				// (`selfAppliedTail` in change-bridge.ts) — this node is then in the tail's storage group, which is
				// the topic's root group under the host's root placement above. No ring read is needed. Every commit
				// naming a tail also reaches the origination manager's tail observer, gate or no gate, so a machine in
				// the old tail's group but not the new one still sees its root rotate.
				unsubscribeCohortBridge = attachCohortChangeBridge(
					node as unknown as { blockChangeNotifier?: IBlockChangeNotifier },
					{
						source: served.storageRepo,
						service: host.service,
						extractCommitCert: makeClusterCommitCertExtractor(certStore),
						observeTailCommit: (event): void => origination.observeTailCommit(event),
					},
				).unsubscribe;
			}

			// 4. PushState gossip — periodic intra-cohort convergence so any member (not just the primary) can
			// serve a replay/backfill. Rides the host's cohort gossip transport (no second transport). A served
			// push state belongs to one root, and that root's cohort is the root group at its tail's root
			// coordinate: a topic id cannot be inverted, so each site keys on the tail the push state joined under
			// (`tailIdAtJoin`), which every gossip frame carries.
			// A frame resolves to this node's push state at the root it names, and only if that state is for the
			// frame's topic: a frame naming a root this node serves under another topic is dropped, never merged.
			const servedPushStateForGossip = (g: PushStateGossipV1): PushState | undefined => {
				const served = forwarderHost.pushStateForRoot(b64urlToBytes(g.tailIdAtJoin));
				return served !== undefined && served.topicId === g.topicId ? served : undefined;
			};
			pushStateGossip = new ReactivityPushStateGossipDriver({
				gossipTransport: host.gossipTransport,
				liveCollections: (): ReactivityGossipCollection[] => forwarderHost.livePushStates().map((pushState) => ({
					pushState,
					cohortCoord: reactivityRootCoord(b64urlToBytes(pushState.tailIdAtJoin)),
				})),
				pushStateForGossip: servedPushStateForGossip,
				// Authenticity gate: accept gossip only from a member of the root group serving the frame's root
				// (per-frame peer-sig envelope signing is deferred — reactivity-pushstate-gossip's hardening backlog).
				// A frame for a root this node serves no push state for is let through: there is nothing to
				// protect, and the resolve step drops it as unserved.
				// NOTE: reads the key network's serving cohort per inbound frame (one per collection per member
				// for each change to its push state, plus one per refresh, 30 s by default). If it shows in
				// profiles, memoize per tail with a TTL of one gossip interval.
				isCohortMember: async (fromPeerId: string, g: PushStateGossipV1): Promise<boolean> => {
					const served = servedPushStateForGossip(g);
					if (served === undefined) return true;
					return (await rootGroupAt(reactivityRootCoord(b64urlToBytes(served.tailIdAtJoin)))).includes(fromPeerId);
				},
			});
			registerPushStateGossipHandler(node, reactivityProtocols.pushStateGossip, pushStateGossip);
			pushStateGossip.start();

			// 5. Recover RPC — the pull companion to notify (docs/reactivity.md §Backfill RPC / §Resume). A
			// subscriber that detected a gap, or woke from sleep past the live tail, asks a serving cohort member
			// "what did I miss?" and is brought current over a real request-reply socket. The SERVE side is live
			// here: this node answers RecoverRequestV1 frames against its live forwarder PushStates. The OUTBOUND
			// transport + signers are handed to the collection watch service (step 7 below), whose managers send
			// backfill and resume requests through them.
			//
			// Node-level sticky cohort-hint cache (keyed by collectionId), shared between the outbound transport's
			// sticky-primary lookup and each manager's rotation-invalidation so both see ONE cache. It starts
			// empty ⇒ the transport falls through to the cohort-walk (any member holding the gossiped PushState
			// answers); populating the sticky primary is a one-RT optimization, not a correctness need.
			const reactivityCohortHintCache = createStickyCohortHintCache();
			// tail bytes → dialable root-group member peer-id strings: the SAME root-group read the push-state-gossip
			// authenticity gate uses (`rootGroupAt` at the tail's root coordinate), so a recover walk reaches exactly
			// the group that holds the topic's gossiped PushState. The key network returns peer-id strings (the
			// recover dialer's `peerIdFromString` space), matching the notify dial-target space.
			const resolveReactivityCohort = (tailId: Uint8Array): Promise<readonly string[]> =>
				rootGroupAt(reactivityRootCoord(tailId));

			// Outbound transport: exposes the db-core BackfillTransport / ResumeTransport seams against this node.
			// maxBytes is left undefined so the dialer + handler default to DEFAULT_STREAM_MAX_BYTES, matching the
			// notify transport's default (constructed above without an override) — one frame ceiling across the
			// family. The dials open streams under this node's hedge and dead-connection delays.
			const recover = new Libp2pReactivityRecoverTransport({
				dialer: createLibp2pRecoverDialer(node, reactivityProtocols.recover, undefined, linkDeadlines),
				selfPeerId,
				cohortHintCache: reactivityCohortHintCache,
				resolveCohort: resolveReactivityCohort,
			});

			// Inbound serve handler: decode (bounded) → verify the dialing peer's signature → freshness/replay gate →
			// resolve the live PushState off the forwarder host → serveBackfill/serveResume → reply (a decline on any
			// failure; the subscriber's transport tries the next cohort member). One node-level replay guard is shared
			// across all recover requests — a plain pruned-on-access map, so no new timer to tear down.
			registerRecoverHandler(node, reactivityProtocols.recover, {
				pushStateForRoot: forwarderHost.pushStateForRoot.bind(forwarderHost),
				pushStateForCollection: forwarderHost.pushStateForCollection.bind(forwarderHost),
				replayGuard: createCorrelationReplayGuard(),
				rotationFor: (req, now) => {
					// Drain-window redirect: a recover reaching an OLD (rotated, still-draining) root is bounced to
					// the new root (reactivity-rotation-recover-redirect-drain). A resume names the stale root (its
					// latestKnownTailId); a backfill names none, so resolve the collection's current served root.
					// rotationRedirectFor returns the gate's redirect while draining and undefined once drained (then
					// evicting the gate + the old root's served PushState).
					const oldTail = req.tailId ?? resolveCurrentServedRoot(forwarderHost, req.collectionId);
					return oldTail === undefined ? undefined : forwarderHost.rotationRedirectFor(oldTail, now);
				},
			});

			// The subscriber's synchronous request signers over the node's Ed25519 key (resolves the recover wiring's
			// lone design point — see recover-transport.ts §createRecoverRequestSigners). The collection watch
			// service feeds them to each manager alongside recover.backfillTransport(() => manager.tail, collectionId)
			// / recover.resumeTransport(() => manager.tail, collectionId), so a recover targets the current root.
			const recoverSigners = createRecoverRequestSigners(nodePrivateKey);

			// The recover seams stay exposed for diagnostics and tests (mirrors `reactivitySubscribers` above).
			(node as any).reactivityRecover = recover;
			(node as any).reactivityRecoverSigners = recoverSigners;
			(node as any).reactivityCohortHintCache = reactivityCohortHintCache;

			// 6. Rotation re-registration scheduler — the host timer that moves a subscriber to the rotated tree
			// when its manager surfaces a `RotationNotice` (`reactivity-rotation-rereg-scheduler`). Constructed with
			// the default unref'd `setTimeout` timer so an idle re-registration never pins the process. ONE scheduler
			// serves every subscription on the node: it de-duplicates by successor tail, which is sound because the
			// watch service keeps one subscription per collection. The MOVE is the watch service's: it finds the
			// subscription waiting on the successor tail and has its manager follow it — a registration at the root
			// registers again, one below the root only updates its root key (a timer that fires before the service
			// exists, which only a throw mid-wiring could produce, finds nothing to move).
			reactivityRotation = new RotationReRegistrationScheduler({
				reRegister: (plan): Promise<void> => reactivityWatch?.reRegister(plan) ?? Promise.resolve(),
			});
			(node as any).reactivityRotation = reactivityRotation;

			// 7. Collection watch service — the host-facing surface of everything above: one call per collection an
			// application wants to be woken for. It builds one subscription manager per collection, registers it in
			// `reactivitySubscribers` under the collection's topic, renews it, and has it follow the tail on a
			// rotation (driving the scheduler above). It also hears this node's own storage: the per-collection
			// feed holds a table's event until the action's other collections pending here have landed, so the
			// wake it gives a watcher is one whose local re-read sees the whole commit.
			const scheduler = reactivityRotation;
			reactivityWatch = new ReactivityCollectionWatch({
				service: host.service,
				profile: reactivityProfile,
				quorumRatio: reactivityQuorumRatio,
				subscribers: reactivitySubscribers,
				// A client stores nothing, so it has no local feed; every wake it gets comes over the network.
				...(served ? { localChanges: served.storageRepo } : {}),
				scheduleRotation: (notice): void => scheduler.schedule(notice),
				// The live root group at a registration's root key, so the service can notice a registration a
				// walk left outside the group that announces its tail's commits. `resolveReactivityCohort` is
				// `rootGroupAt` — the placement rule itself, read fresh — deliberately NOT the host's snapshot
				// view, which `snapshots.ensure` may answer from a snapshot up to one gossip interval old.
				// The register walk that REPAIRS such a registration reads the same rule live (the router's
				// `rootGroupMembers`, `createCohortTopicHost` in `cohort-topic/host.ts`, is bound to
				// `snapshots.live`), so detector and repair agree and the repair can reach a different group.
				rootGroupMembers: resolveReactivityCohort,
				recover,
				recoverSigners,
				cohortHintCache: reactivityCohortHintCache,
				// The coordinate the cohort-topic service registers this node under: its member-id bytes.
				subscriberCoord: bytesToB64url(peerIdToBytes(selfPeerId)),
			});
			const watchAttachment: Pick<OptimysticNodeAttachments, 'reactivityWatch'> = { reactivityWatch };
			Object.assign(node, watchAttachment);

			// Single-member signatures over the node peer key: the matchmaking query reply and the arrival push.
			const signWithNodeKey = async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(nodePrivateKey, payload));

			// --- Matchmaking QueryV1 RPC — cohort serve side (docs/matchmaking.md §Seeker query) ---
			// The server half of the seeker query transport: a remote seeker dials `/optimystic/matchmaking/1.0.0/query`
			// and this node answers with its cohort's locally-held provider/seeker registrations, signed by the node
			// peer key. Matchmaking is layered ABOVE the cohort-topic substrate, so it owns its own protocol family
			// and is wired here (the composition root) over the host's PUBLIC surface only — mirroring the reactivity
			// registration above; nothing reaches into host.ts internals. The seeker half is
			// `createLibp2pMatchmakingSeekerSession`, which an application builds over this node.
			registerMatchmakingQueryHandler(node, matchmakingProtocols.query, {
				registry: host.registry,
				// db-core default tier addressing: createTierAddressing(createRingHash()) is byte-identical to the
				// host's internal addressing for the tier-0 coord (peer- and fanout-independent), and the handler
				// only ever derives coord_0(topicId) — matchmaking topics are not root-placed.
				addressing: createTierAddressing(createRingHash()),
				sign: signWithNodeKey,
				// Anti-DoS rate-limit seam (backlog matchmaking-query-rate-limit) intentionally left unwired here:
				// default-allow. When that ticket lands it passes a `gate: (from, topicId) => boolean` that limits on
				// the connection's verified `from` peer (NOT the self-asserted query.requesterId).
			});

			// --- Matchmaking arrival push (docs/matchmaking.md §Arrival push on provider arrival) ---
			// Seeker side: one receiver holds the walks on this node that wait on pushes. An application passes it to
			// `createLibp2pMatchmakingSeekerSession` as `arrivalPush`, so its walks opt in.
			const arrivalPushReceiver = new ArrivalPushReceiver();
			registerArrivalPushHandler(node, matchmakingProtocols.arrivalPush, arrivalPushReceiver);
			const arrivalPushAttachment: Pick<OptimysticNodeAttachments, 'matchmakingArrivalPush'> = { matchmakingArrivalPush: arrivalPushReceiver };
			Object.assign(node, arrivalPushAttachment);
			// Cohort side: every provider record that becomes present on one of this node's engines is pushed to the
			// selected seekers whose slot primary is this node, under the slot rule registration renewal uses.
			arrivalPushDriver = new ArrivalPushDriver({
				selfPeerId,
				slots: createSlotAssigner(createRingHash()),
				sign: signWithNodeKey,
				send: createArrivalPushSend({ node, receiver: arrivalPushReceiver, protocol: matchmakingProtocols.arrivalPush, streamOpen: linkDeadlines }),
			});
			unsubscribeArrivalPush = host.onRecordAdded(arrivalPushDriver.onRecordAdded);
		}

		return node as unknown as OptimysticNode | OptimysticClientNode;
	} catch (err) {
		// Post-start rollback. node.stop() runs whatever teardown wrappers were installed BEFORE the throw
		// (each wrapper is registered next to the resource it releases, precisely so this unwinds as much as
		// exists) and closes the transports. A rollback failure must never mask the real startup error, so it
		// is logged and swallowed; `err` is what the caller sees.
		try {
			await node.stop();
		} catch (stopErr) {
			wiringLog('rollback stop failed after startup error: %o', stopErr);
		}
		throw err;
	}
}

/**
 * Ask one REMOTE cohort peer, over the sync protocol, what it holds of a block — the half of a
 * {@link ClusterLatestCallback} that leaves this node. Shared by the serving node's callback, which
 * answers a self ask from its own storage first, and a client's, which has no storage and answers a
 * self ask with "holds nothing". Three-way contract: an answer is the peer's claim, `undefined` is the
 * peer answering that it holds nothing, and a REJECTION is silence; transport errors propagate.
 */
function remoteClusterLatest(
	keyNetwork: Libp2pKeyPeerNetwork,
	protocolPrefix: string,
	linkDeadlines: LinkDeadlines,
	cohortQueryTimeoutMs: number
): ClusterLatestCallback {
	return async (peerId, blockId, _context?, held?) => {
		const syncClient = new SyncClient(peerId, keyNetwork, protocolPrefix, linkDeadlines);
		// No try/catch: a dial or protocol failure rejects through to the coordinator, which counts
		// the peer silent. The budget is the same resolved `cohortQueryTimeoutMs` the coordinator
		// deadlines this call with, so the two fire together: the coordinator's deadline is what
		// classifies a late peer as silent, and this one tears the stream down at that moment. It
		// also replaces the sync client's own dial deadline, which, when shorter than the budget,
		// failed every consult on a slow link before the larger budget could take effect.
		// NOTE: the budget does not cover opening a cold relayed connection (up to about ten round
		// trips), and when it expires it aborts the open this request started: libp2p 3.3.11 runs a
		// dial under its first caller's signal, and a later caller joins that dial without extending
		// it. So a node whose only traffic to a peer is read-path requests (this consult and
		// `fetchArchiveFromPeer`, which commit-path reconciliation uses too) never opens a cold relayed
		// connection to it. The dials that can are the ones under the full RPC dial deadline: consensus
		// rounds, repo requests and block pushes. FRET's own RPCs cannot either; their deadlines are
		// fixed at a few seconds whatever the declared round trip. Fine while a coordinator's cohort
		// members are also its consensus peers. If a node ever has to read from a peer nothing else
		// dials, size this budget for a cold open.
		// Always the form that says what this node holds — an empty map meaning "nothing" — so a peer on
		// this build answers in `answers` either way, and sends the bytes only when it is ahead.
		const response = await withinRequestBudget(peerId.toString(), syncClient.getProtocol(), cohortQueryTimeoutMs,
			options => syncClient.requestBlock({ blockId, rev: undefined, held: held ? { [blockId]: held } : {} }, options));
		// A peer on an older build ignores `held` and answers with the original single archive, full bytes.
		const answer = response.answers ? response.answers[blockId] : answerFromArchiveResponse(response);
		// An answer map that leaves out the asked block is malformed, not "holds nothing": reject, so
		// the coordinator counts the peer silent rather than reading an absent claim into it.
		if (!answer) throw new Error(`consult answer from ${peerId.toString()} omits block ${blockId}`);
		return claimFromConsultAnswer(answer);
	};
}

/**
 * A client's cohort consult: every ask goes to the remote peer. A client is in no cohort, so no caller
 * asks it about itself; if one did, "holds nothing" is the true answer.
 */
function clientClusterLatest(self: PeerId, remote: ClusterLatestCallback): ClusterLatestCallback {
	return async (peerId, blockId, context?, held?) => peerId.equals(self) ? undefined : await remote(peerId, blockId, context, held);
}

/**
 * The node's blob protocol client and the fetcher over it (docs/blobs.md §Moving pieces between
 * machines), on both roles: a client fetches too. Candidates are chosen by the node's own key network,
 * membership gate and reputation, through one `BlobHolderDeps` the fetcher and `NodeBlobService`'s stat
 * probe share, and fetched pieces are checked with the digest the blob service names them by. The stop
 * wrapper is installed at once, so a startup rollback stops the fetcher too; it runs before the blob
 * service's own stop, which was installed earlier, so no fetched piece is stored after it.
 */
function wireBlobFetcher(ctx: {
	node: Libp2p;
	protocolPrefix: string;
	linkDeadlines: LinkDeadlines;
	keyNetwork: Libp2pKeyPeerNetwork;
	membership: NetworkMembershipGate | undefined;
	reputation: PeerReputationService;
	blobs: LocalBlobService;
}): { client: BlobProtocolClient; fetcher: BlobFetcher; holders: BlobHolderDeps; blobProtocol: string } {
	const { node, protocolPrefix, linkDeadlines, keyNetwork, membership, reputation, blobs } = ctx;
	const blobProtocol = buildBlobProtocol(protocolPrefix);
	const client = new BlobProtocolClient({
		peerNetwork: keyNetwork,
		protocolPrefix,
		deadlines: linkDeadlines,
		acceptance: id => blobAcceptanceOf(keyNetwork, blobProtocol, [id]).then(answers => answers[id] ?? 'unknown'),
	});
	const holders: BlobHolderDeps = {
		selfPeerId: node.peerId.toString(),
		blobProtocol,
		keyNetwork,
		membership,
		reputation,
		isConnected: id => node.getConnections(peerIdFromString(id)).length > 0,
	};
	const fetcher = new BlobFetcher({ client, holders, reputation, store: blobs.fetchStore() });
	const previousStop = node.stop.bind(node);
	node.stop = async () => {
		try {
			await fetcher.stop();
		} finally {
			await previousStop();
		}
	};
	return { client, fetcher, holders, blobProtocol };
}

/** What {@link wireServingRole} reads from the factory: the started node and the pieces every role builds. */
interface ServingRoleContext {
	node: Libp2p;
	options: NodeOptions;
	serving: ServingStore;
	keyNetwork: Libp2pKeyPeerNetwork;
	protocolPrefix: string;
	linkDeadlines: LinkDeadlines;
	consensusConfig: ResolvedClusterPolicy;
	reputation: PeerReputationService;
	fretSvc: FretService | undefined;
	nodePrivateKey: PrivateKey;
	onCommitCertificate: CommitCertificateSink | undefined;
	membership: NetworkMembershipGate | undefined;
	networkManager: NetworkManagerService | undefined;
	/** The blob service's piece store, whose bytes the Arachnode storage monitor counts toward this node's use. */
	pieceStore: IPieceStore;
	/** The node's one partition detector, built beside the key network; this role is the only half that feeds it. */
	partitionDetector: PartitionDetector;
}

/** What the rest of the factory reads back from the serving role. */
interface ServingRole {
	storageRepo: StorageRepo;
	coordinatedRepo: IRepo;
	reportBlockHeld: OptimysticNodeAttachments['reportBlockHeld'];
	/** The cohort consult, self answered from local storage; the cohort-topic trust anchor reads it too. */
	clusterLatestCallback: ClusterLatestCallback;
	disputeService: DisputeService | undefined;
	/**
	 * FRET and its arachnode adapter, when arachnode is enabled and FRET is present. The blob cohort
	 * monitor is built from these in the factory, beside the blob service it reacts with.
	 */
	arachnode?: { fret: FretService; fretAdapter: ArachnodeFretAdapter };
}

/**
 * Build, on a started node, everything that assumes this node holds blocks: repair and restoration,
 * the cluster member and the coordinated repo, the resilience monitors (spread-on-churn, the
 * under-replication drain, rebalance and ring shifts), Arachnode, the owned-block seed and the
 * dispute service. One unit, so a client (`NodeOptions.servesBlocks: false`) skips all of it with one
 * test. Each stop wrapper is installed on `node` right after the resource it releases, as the
 * factory's startup rollback requires.
 */
async function wireServingRole(ctx: ServingRoleContext): Promise<ServingRole> {
	const {
		node, options, serving, keyNetwork, protocolPrefix, linkDeadlines, consensusConfig, reputation,
		fretSvc, nodePrivateKey, onCommitCertificate, membership, networkManager, pieceStore,
		partitionDetector
	} = ctx;
	const { storageRepo, rawStorage, underReplicationLedger, transactionStateStore, durabilityWindowFor, onBlockHolders } = serving;
	const createClusterClient = (peerId: any) => ClusterClient.create(peerId, keyNetwork, protocolPrefix, linkDeadlines);

	// Fetch a block archive from one cohort peer over the sync protocol, bounded by the same
	// per-peer budget the latest-revision consult uses (`consensusConfig.cohortQueryTimeoutMs`,
	// read off the one resolved policy above) so an unreachable peer can't stall reconciliation.
	// The budget bounds the whole request and nothing inside it is shorter — see
	// `withinRequestBudget`. Mirrors the SyncClient query in `remoteClusterLatest`, but returns
	// the full archive (which carries the materialized block) rather than only the latest ActionRev.
	//
	// A timed-out fetch resolves to "no archive", exactly as a peer that holds nothing does — the
	// pass moves on to the next peer. Only the number is configurable; the contract is unchanged.
	//
	// The read path's acquisition reaches this only for a peer its consult has no archive from:
	// the consult made this same request and hands its archives on (`ConsultedArchives`).
	const fetchArchiveFromPeer = async (peerIdStr: string, blockId: BlockId): Promise<BlockArchive | undefined> => {
		let peerId: ReturnType<typeof peerIdFromString>;
		try {
			peerId = peerIdFromString(peerIdStr);
		} catch {
			return undefined;
		}
		if (peerId.equals(node.peerId)) return undefined;
		const syncClient = new SyncClient(peerId, keyNetwork, protocolPrefix, linkDeadlines);
		try {
			const response = await withinRequestBudget(peerIdStr, syncClient.getProtocol(), consensusConfig.cohortQueryTimeoutMs,
				options => syncClient.requestBlock({ blockId, rev: undefined }, options));
			return response.success ? response.archive : undefined;
		} catch {
			// Peer unreachable, out of budget, or an unreadable reply — the caller falls back to the
			// next cohort peer. `protocol-client` has already logged a dial failure or a budget expiry
			// (`dial:fail`, `dial:aborted`, `response:aborted`); an unreadable reply it does not log.
			return undefined;
		}
	};

	// Ask one cohort peer whether ITS current content for a block was built from a given pair, over
	// the sync protocol (`SyncRequest.lineageOf`), answered from that peer's own records with the
	// cluster skipped. Both repair paths ask it, and only for the shape the claim data cannot settle:
	// a lone machine's single-signer certified claim one revision ahead of the pair the rest of the
	// cohort backs (`settleSoloAhead` in `cluster/solo-ahead.ts`). The commit-path reconcile takes it
	// as `askLineage`, the read path as `blockLineageCallback`.
	//
	// A dial failure, a budget expiry or an unreadable reply rejects, and the round counts a rejection
	// as a silent claimant, i.e. `unknown`. The budget is the consult's, and so is its limit: a
	// claimant reachable only over a cold relayed connection nothing else has opened reads as silent
	// (the `NOTE:` in `remoteClusterLatest`). Neither path should ever ask this node itself,
	// since its own claim is excluded from the claim set, but a self ask reads local storage through
	// the same function the sync service answers with rather than dialing self.
	const blockLineageCallback: BlockLineageAsk = async (peerIdStr, blockId, target) => {
		const peerId = peerIdFromString(peerIdStr);
		if (peerId.equals(node.peerId)) return await serveLineageAnswer(storageRepo, blockId, target);
		const syncClient = new SyncClient(peerId, keyNetwork, protocolPrefix, linkDeadlines);
		const response = await withinRequestBudget(peerIdStr, syncClient.getProtocol(), consensusConfig.cohortQueryTimeoutMs,
			options => syncClient.requestBlock({ blockId, blockIds: [blockId], rev: undefined, lineageOf: { [blockId]: target } }, options));
		return lineageFromSyncResponse(response, blockId);
	};

	// Active reconciliation for a block this member committed without a materializable base
	// (cohort drift, or a refused `missing-base-revision` commit). See `reconcile-block.ts` for
	// the corroboration rules — in particular why both quorums are capped by how many peers
	// could answer at all, which is what lets a genuinely two-node cohort heal.
	// NOTE: this and the CoordinatorRepo below must cap against the SAME
	// repairCorroborationClusterSize, or the two restoration paths disagree about how much trust a
	// lone peer gets. Safe today because both read the one `resolveClusterPolicy` result above; if
	// either ever resolves its own value, add a fail-fast coupling check like
	// `assertSuperMajorityCoupling` rather than relying on proximity.
	const reconcileBlock: ReconcileBlockCallback = createReconcileBlock({
		selfPeerId: node.peerId.toString(),
		fetchArchive: fetchArchiveFromPeer,
		// The 4th parameter is a proof reconcile verified against these exact bytes; it is
		// persisted so the repaired replica serves it onward (see StorageRepo.saveReplicatedBlock).
		saveReplicatedBlock: (blockId, block, source, verifiedProof) =>
			storageRepo.saveReplicatedBlock(blockId, block, source, verifiedProof),
		simpleMajorityThreshold: consensusConfig.simpleMajorityThreshold,
		superMajorityThreshold: consensusConfig.superMajorityThreshold,
		repairCorroborationClusterSize: consensusConfig.repairCorroborationClusterSize,
		reputation,
		// A restored block is one this node now holds, and the peers that corroborated the revision
		// hold it too. Reported only on a successful restore — a decline persists nothing.
		onBlockHolders,
		askLineage: blockLineageCallback
		// `anchoring` (proof layer-2, `ProofAnchoring`) is intentionally NOT wired here yet — nor
		// is the coordinator's `proofAnchoring` below: a real implementation re-derives the
		// block's cohort from `keyNetwork.findCluster` (the same source `deriveExpectedCluster`
		// uses) and needs a churn-tolerance window so historic cohort rotation does not read as an
		// anomaly flood. Until then certification runs on layer-1 cryptography and LOGS the
		// unanchored residual. See `feat-cluster-membership-threshold-cert-anchoring`, and the
		// matching `recomputeArbitratorSet` note at the clusterMember construction below.
	});

	// Member-side membership derivation for the admission gate: independently re-derive this block's
	// responsible cluster from the SAME source the coordinator uses (IKeyNetwork.findCluster), plus FRET's
	// network-size confidence. A member gates a coordinator-declared peer set against this view before
	// voting, so a self-shrunk minority-partition set cannot be voted into super-majority (see cluster-repo
	// admitMembership). No FRET ⇒ confidence 0 ⇒ the gate fails closed for any downsize.
	const deriveExpectedCluster: DeriveExpectedClusterCallback = async (blockId) => {
		const peers = await keyNetwork.findCluster(routingKeyForBlock(blockId));
		let confidence = 0;
		if (fretSvc) {
			try {
				confidence = fretSvc.getNetworkSizeEstimate().confidence;
			} catch {
				// Leave confidence 0 → fail closed for downsizing.
			}
		}
		return { peers: peers ?? {}, confidence };
	};

	// A consensus commit the member applies — whichever node coordinated it — marks its blocks
	// freshly checked in the coordinator's read-repair window, by the rule the coordinator's own
	// commits stamp under (`CoordinatorRepo.noteCohortCommitApplied`). Late-bound because the member
	// is built before the coordinator it reports to; bound right after the coordinator below.
	let cohortCommitAppliedTarget: CohortCommitAppliedSink | undefined;
	const onCohortCommitApplied: CohortCommitAppliedSink = (applied) => cohortCommitAppliedTarget?.(applied);

	const member = clusterMember({
		storageRepo,
		peerNetwork: keyNetwork,
		peerId: node.peerId,
		privateKey: nodePrivateKey,
		protocolPrefix,
		partitionDetector,
		fretService: fretSvc,
		validator: options.validator,
		reputation,
		consensusConfig,
		stateStore: transactionStateStore,
		reconcileBlock,
		onCommitCertificate,
		onBlockHolders,
		onCohortCommitApplied,
		deriveExpectedCluster,
		createClusterClient,
		durabilityWindowFor
		// `recomputeArbitratorSet` (invalidation layer-2) is intentionally NOT wired here yet: a live FRET
		// recompute needs a churn-tolerance window so it does not false-reject legitimate certificates from
		// late-joiners (a liveness regression). Until that is tuned against live topology — and the
		// cohort-topic membership-cert trust anchor (layer 3) lands — invalidation verification runs on the
		// challenger-bound set + membership + dedup (layer 1) and LOGS the residual anchoring gap. See
		// `verifyInvalidationCertificate` and `tickets/plan/cohort-topic-membership-cert-trust-anchoring.md`.
	});
	serving.late.cluster = member;

	// Cleanup cluster member intervals on node stop. Installed HERE, immediately after clusterImpl
	// exists, rather than further down: the post-start rollback only unwinds resources whose stop
	// wrapper is already installed at the moment of the throw, so a wrapper trailing its resource by
	// hundreds of lines leaves those intervals running on a failed startup. Same reasoning as the
	// owned-block-feed wrapper below.
	{
		const previousStop = node.stop.bind(node);
		node.stop = async () => {
			try {
				member.dispose();
			} finally {
				// Never let a dispose failure strand the transports — same try/finally shape every
				// other wrapper in this chain uses.
				await previousStop();
			}
		};
	}

	const coordinatorRepoFactory = coordinatorRepo(
		keyNetwork,
		createClusterClient,
		{
			// clusterSize is now part of consensusConfig (member + coordinator share one reference).
			...consensusConfig,
			// Read by the coordinator only: its first hold after a read-repair consult a silent peer left unarmed.
			retryBackoffBaseMs: linkDeadlines.retryBackoffBaseMs
		},
		fretSvc,
		reputation,
		transactionStateStore
	);

	// Create callback for querying cluster peers for their latest block revision. Three-way
	// contract (see ClusterLatestCallback): a ClusterLatestAnswer is the peer's claim, a resolved
	// `undefined` is the peer answering "I hold nothing", and a REJECTION is silence — the
	// coordinator counts it as "did not answer" and refuses to report an authoritative absent
	// over it. Transport errors must therefore propagate, not collapse into `undefined` (that
	// collapse let a slow two-node cohort report a missing block as authoritatively absent —
	// ticket cluster-read-consult-cannot-report-unreachable).
	//
	// The claim carries the cohort's commit proof for the claimed revision when the answering
	// peer retained one. It is attached UNVERIFIED — a peer chooses what to send. Both repair
	// paths verify it before weighing it (the shared layer in `cluster/certified-claims.ts`):
	// the coordinator's certifyClaim pass in `queryClusterForLatest`, and reconcile's
	// certification pass in `cluster/reconcile-block.ts`.
	const askRemote = remoteClusterLatest(keyNetwork, protocolPrefix, linkDeadlines, consensusConfig.cohortQueryTimeoutMs);
	const clusterLatestCallback: ClusterLatestCallback = async (peerId, blockId, context?, held?) => {
		// Self-read short-circuit: dialling self via SyncClient is a round trip
		// with no remote on the other end, and on nodes without listen addresses
		// (solo WebSocket-only, bare-RN, etc.) the self-dial can hang the dial
		// queue. Read directly from the local storage repo instead. The catch stays:
		// a local storage error is not a cohort peer being unreachable, and the
		// coordinator ignores a self rejection anyway.
		if (peerId.equals(node.peerId)) {
			try {
				const result = await storageRepo.get({ blockIds: [blockId], context });
				const latest = result[blockId]?.state?.latest;
				if (!latest) return undefined;
				// The SAME lookup a peer serving an archive uses, so a self answer and a remote
				// answer attach proofs by one rule (including the mis-pairing guard). It never
				// throws — a proof fault degrades to "no proof", never to a lost claim.
				const proof = await servableProof(storageRepo, blockId, latest);
				return proof ? { ...latest, proof } : latest;
			} catch {
				return undefined;
			}
		}
		return await askRemote(peerId, blockId, context, held);
	};

	// The same consult for several blocks of one read in one request (`ConsultRound` in
	// `repo/consult-round.ts`), under the same budget and three-way contract as the single callback
	// above, which still asks this node itself and the blocks an older peer answers one at a time.
	// Each block's answer is projected by the same function as there (`claimFromConsultAnswer`): the
	// claim and its proof, read out of ONE revision entry so a serving peer cannot pair a proof with
	// a revision it does not certify, and the archive the acquisition that follows reuses instead of
	// asking again. That archive is attached even when its bytes were left out as 'held' — safe only
	// because such a peer is never ahead of this node — and not when they were left out as 'size',
	// where the peer may be ahead; the reasoning is at `claimFromConsultAnswer`.
	const clusterLatestBatchCallback: ClusterLatestBatchCallback = async (peerId, asks) => {
		const blockIds = asks.map(ask => ask.blockId);
		const held: Record<BlockId, ActionRev> = {};
		for (const ask of asks) if (ask.held) held[ask.blockId] = ask.held;
		const syncClient = new SyncClient(peerId, keyNetwork, protocolPrefix, linkDeadlines);
		// No try/catch, as above: a dial or protocol failure rejects, and every block asked reads silent.
		const response = await withinRequestBudget(peerId.toString(), syncClient.getProtocol(), consensusConfig.cohortQueryTimeoutMs,
			options => syncClient.requestBlock({ blockId: blockIds[0]!, blockIds, held, rev: undefined }, options));
		if (!response.answers) {
			// A peer on a build that predates `held` answered the first block alone, the original way.
			return { answers: new Map([[blockIds[0]!, claimFromConsultAnswer(answerFromArchiveResponse(response))]]), unbatched: true };
		}
		const answers = new Map<BlockId, ClusterLatestAnswer | undefined>();
		for (const blockId of blockIds) {
			const answer = response.answers[blockId];
			// A block the answer map leaves out stays out, so the round reads that block alone as silent.
			if (answer) answers.set(blockId, claimFromConsultAnswer(answer));
		}
		return { answers };
	};

	const coordinator = coordinatorRepoFactory({
		storageRepo,
		localCluster: member,
		localPeerId: node.peerId,
		clusterLatestCallback,
		clusterLatestBatchCallback,
		// Read-driven acquisition shares the commit path's reconcile callback verbatim: same bounded
		// archive fetch, same (rev, actionId) and content quorums, same monotonic saveReplicatedBlock
		// funnel. `clusterLatestCallback` alone can only tell the reader WHICH revision the cohort
		// holds; this is what moves the bytes. Only reached once a corroborated revision exists, so a
		// genuinely absent block still costs no archive fetch.
		acquireBlockFromCohort: reconcileBlock,
		blockLineageCallback,
		// Records who is still missing each block of a commit acknowledged below `full`; the
		// under-replication drain below sends those copies.
		underReplicationLedger,
		onBlockHolders,
		// A `full` commit that settles a ledger entry announces it through the same callable the
		// drain emits through, so a host hears one event per entry whichever of the two removed it.
		onBlockDurabilityReached: (event) => storageRepo.emitBlockDurabilityReached(event),
		durabilityWindowFor
	});
	serving.late.coordinatedRepo = coordinator;
	cohortCommitAppliedTarget = (applied) => coordinator.noteCohortCommitApplied(applied);

	// Fail-fast coupling: the cluster member (what accepts a super-majority as sufficient) and the
	// coordinator (what declares a transaction committed on that super-majority) MUST run the same
	// threshold, or the node would come up able to disagree with itself mid-consensus. Both are fed from
	// the single `consensusConfig` above; this asserts on their RESOLVED values so any future drift throws
	// HERE at construction. See `assertSuperMajorityCoupling`.
	assertSuperMajorityCoupling(member, coordinator);

	// Recover persisted transaction state. Unconditional: a serving node always has a transaction
	// state store (see `prepareServingStore`). NOT before the node answers — libp2p started above and
	// both bindings a request reaches (`late.cluster`, `late.coordinatedRepo`) are already set, which
	// is deliberate: deferring the coordinated repo past this point would serve an inbound pend or
	// commit from the bare storage repo, with no consensus. A cohort peer retrying a commit to a
	// machine that has just come back is exactly the traffic to expect here, so both passes leave a
	// hash already live in memory to its delivery rather than overwriting it. Member first, then
	// coordinator: the member restores the records it promised on, so a coordinator resuming a commit
	// broadcast in the same pass finds this machine's own participant state already in place.
	await member.recoverTransactions();
	await coordinator.recoverTransactions();

	// --- Shared owned-block set for the resilience monitors ---
	// SpreadOnChurnMonitor (sender) and RebalanceMonitor (responsibility tracker) both act on "the
	// blocks this node physically holds". They share ONE Set so the two can never drift: a single
	// owned-block feed populates it, and the rebalance responsibility-loss signal evicts from it
	// (in the rebalance block below). Both monitors take this exact instance via deps.trackedBlocks.
	const ownedBlocks = new Set<string>();
	// Single owned-block feed: every block this node commits OR receives as a replica fires
	// storageRepo.onAnyCollectionChange. Subscribe to storageRepo DIRECTLY (not
	// node.blockChangeNotifier): the cohort-topic activation block below may replace
	// blockChangeNotifier with a decorating bridge, but storageRepo keeps emitting on its own
	// surface regardless of that opt-in. NOTE: this feed does NOT re-emit blocks already durable
	// from a previous run; those are seeded once at startup by the storage-enumeration scan wired
	// below (seedOwnedBlocksFromStorage), so a restarted node protects on-disk data without waiting
	// for each block to be touched again. Registered lazily the first time a
	// monitor that reads ownedBlocks is wired, so when BOTH monitors are disabled no subscription
	// leaks; torn down exactly once in the stop wrapper below.
	let offOwnedBlockFeed: (() => void) | undefined;
	const ensureOwnedBlockFeed = (): void => {
		if (offOwnedBlockFeed) return;
		offOwnedBlockFeed = storageRepo.onAnyCollectionChange((e) => {
			for (const blockId of e.blockIds) ownedBlocks.add(blockId);
		});
	};
	// Single owned-block-feed teardown. Registered up front (before either monitor's own stop
	// wrapper) so it runs regardless of WHICH monitor subscribed the feed - including the
	// spread-disabled / rebalance-only case. Idempotent: offOwnedBlockFeed is undefined-guarded.
	{
		const previousStop = node.stop.bind(node);
		node.stop = async () => {
			try {
				offOwnedBlockFeed?.();
			} finally {
				await previousStop();
			}
		};
	}

	// --- Churn-resilient spread: drive SpreadOnChurnMonitor on a live node ---
	// Nothing previously activated the SENDING side of the churn-resilient spread protocol on a
	// real node. Here we init + start the monitor (sharing ownedBlocks) and ensure the single
	// owned-block feed is live, so a debounced connection:close re-pushes the node's blocks to
	// expansion-cohort peers (the receiver durably persists each push via saveReplicatedBlock).
	let spreadMonitor: SpreadOnChurnMonitor | undefined;
	if (networkManager && (options.spreadOnChurn?.enabled ?? true) !== false) {
		try {
			spreadMonitor = networkManager.initSpreadOnChurnMonitor(
				partitionDetector,
				storageRepo,
				keyNetwork,
				consensusConfig.clusterSize,
				protocolPrefix,
				ownedBlocks,
				{
					pushDialTimeoutMs: linkDeadlines.dialTimeoutMs,
					pushResponseTimeoutMs: linkDeadlines.responseTimeoutMs,
					...options.spreadOnChurn
				},
				membership,
			);
			await spreadMonitor.start();
			ensureOwnedBlockFeed();
		} catch (err) {
			// Spread is a resilience optimization, not a correctness requirement - a wiring
			// failure (e.g. FRET briefly unavailable) must NOT hard-fail node startup, unlike the
			// operator-opted-in cohortTopic block. Log and continue with spread inert.
			wiringLog('spread-on-churn init failed: %o', err);
		}
	}

	// Expose for tests/diagnostics (mirrors node.keyNetwork / node.reputation).
	(node as any).spreadOnChurnMonitor = spreadMonitor;

	// Disposal: stop the spread monitor deterministically before the transports close. Composes
	// with the arachnode / clusterMember / cohort-topic stop wrappers (each calls its captured
	// previousStop last). Idempotent (SpreadOnChurnMonitor.stop early-returns when not running), so
	// a double node.stop() does not throw. The owned-block feed teardown is the separate up-front
	// wrapper above (shared across both monitors).
	{
		const previousStop = node.stop.bind(node);
		node.stop = async () => {
			try {
				if (spreadMonitor) await spreadMonitor.stop();
			} finally {
				await previousStop();
			}
		};
	}

	// --- Under-replication drain: send the copies the ledger says this node still owes ---
	// The coordinator repo above records, per block it acknowledged below `full`, who is still
	// missing a copy; this pushes those copies as the missing members become reachable and fires
	// the full-replication event on storageRepo when a block has every copy. Deliberately OUTSIDE
	// the arachnode `if (fret)` gate below: it needs the key network (cohort re-resolution for an
	// entry that could not name its members), the node's own store and dialer, and libp2p's
	// connection events — not the fretAdapter or the restoration coordinator. It overlaps the
	// rebalance growth arm and spread-on-churn on purpose: all three may push the same block to
	// the same peer, and the receiver is idempotent, so no cross-monitor coordination is added.
	// The sink it emits through is one method wide, so it can reach nothing else on the repo.
	let underReplicationDrain: UnderReplicationDrain | undefined;
	if ((options.underReplicationDrain?.enabled ?? true) !== false) {
		const { enabled: _enabled, pushDialTimeoutMs, pushResponseTimeoutMs, ...drainConfig } = options.underReplicationDrain ?? {};
		underReplicationDrain = new UnderReplicationDrain({
			libp2p: node,
			ledger: underReplicationLedger,
			keyNetwork,
			partitionDetector,
			protocolPrefix,
			membership,
			pushBlock: (blockId, peerIds) => pushBlockToPeers(storageRepo, keyNetwork, blockId, peerIds, {
				reason: 'replication',
				protocolPrefix,
				dialTimeoutMs: pushDialTimeoutMs ?? linkDeadlines.dialTimeoutMs,
				responseTimeoutMs: pushResponseTimeoutMs ?? linkDeadlines.responseTimeoutMs
			}),
			emit: (event) => storageRepo.emitBlockDurabilityReached(event)
		}, drainConfig);
		await underReplicationDrain.start();
		const previousStop = node.stop.bind(node);
		node.stop = async () => {
			try {
				await underReplicationDrain!.stop();
			} finally {
				await previousStop();
			}
		};
	}
	// Expose for tests/diagnostics (mirrors node.spreadOnChurnMonitor / node.rebalanceMonitor).
	(node as any).underReplicationDrain = underReplicationDrain;
	(node as any).underReplicationLedger = underReplicationLedger;

	// --- Embedder holder reports (`node.reportBlockHeld`, attached with the host surface below) ---
	// Outside the drain's `enabled` gate: disabling the drain stops pushing, not recording, and the
	// ledger half needs only the ledger, the key network and the repo's event sink, all built above
	// unconditionally. The rebalance half goes through the same late-bound sink as the other
	// producers, so it is a no-op wherever no monitor was built.
	const heldCopyDeps: HeldCopyDeps = {
		ledger: underReplicationLedger,
		keyNetwork,
		selfId: node.peerId.toString(),
		emit: (event) => storageRepo.emitBlockDurabilityReached(event)
	};
	const reportBlockHeld: OptimysticNodeAttachments['reportBlockHeld'] = async (blockId, rev, peerId) => {
		// Ahead of both halves, so a malformed report reaches neither.
		assertReportedRevision(rev);
		// Before the ledger, because it is synchronous and never throws: the monitor hears it even when the ledger rejects.
		onBlockHolders({ blockIds: [blockId], holders: [peerId] });
		await recordHeldCopy(heldCopyDeps, blockId, rev, peerId);
	};

	// Initialize Arachnode ring membership and restoration
	// Handed back on the serving result for the blob cohort monitor, which needs these two handles but is
	// built in the factory beside the blob service, the drain and the reaction it reacts with.
	let arachnodeHandles: ServingRole['arachnode'];
	const enableArachnode = options.arachnode?.enableRingZulu ?? true;
	if (enableArachnode) {
		// A child of the file's own `node-wiring` channel (same nesting convention as
		// `storage:restoration` and `network:get-manager`): these lines explain a half-started
		// node, so `optimystic:db-p2p:node-wiring*` shows them next to the rest of the wiring
		// story, while the child name still lets ring/rebalance chatter be filtered on its own.
		// Unconditional — the previous `(node as any).logger?.forComponent?.(...)` reach-through
		// silently dropped every one of these lines when the node exposed no logger.
		const log = createLogger('node-wiring:arachnode');
		const fret = (node as any).services?.fret as any;

		if (fret) {
			const fretAdapter = new ArachnodeFretAdapter(fret, node.peerId.toString());
			arachnodeHandles = { fret, fretAdapter };

			// Blocks whose shed range has been RELEASED (Phase C of a ring shift, or a confirmed
			// rebalance release). This is the GC-eligibility signal the future storage sweep
			// (`st-storage-sweep-archival-and-capacity-estimate`) must consult: a block's local bytes may
			// be reclaimed ONLY once it appears here, so an unconfirmed / still-served range is never
			// swept. Populated strictly after replication is confirmed. See
			// docs/arachnode-ring-handoff.md § Part 2 (Local bytes vs. tracking).
			// NOTE: no sweep consumes this set yet; it is the coordinated eligibility handoff the sweep
			// ticket will read. Until then it grows unbounded — bound it when the sweep lands.
			const gcEligible = new Set<string>();
			(node as any).gcEligibleBlocks = gcEligible;

			// The ring-shift state machine (advertise→confirm→release). Wired inside the rebalance block
			// below (it needs the BlockTransferCoordinator confirmer + the cohort-size floor); left
			// undefined when the rebalance reaction is not wired, in which case ring shifts stay inert —
			// a move-out is unsafe without the confirm/release path.
			let ringShift: RingShiftCoordinator | undefined;

			// Piece bytes count toward this node's use once: added here unless the block store already
			// measures them (`blockStoreCountsPieces`).
			const storageMonitor = new StorageMonitor(rawStorage, options.arachnode?.storage ?? {}, pieceStore);
			const ringSelector = new RingSelector(fretAdapter, storageMonitor, {
				minCapacity: 100 * 1024 * 1024,
				thresholds: {
					moveOut: 0.85,
					moveIn: 0.40
				},
				// Damping so the ring decision cannot thrash near a boundary
				// (docs/arachnode-ring-handoff.md § Part 1).
				smoothingAlpha: 0.2,
				deadband: 0.5,
				minDwellMs: 10 * 60 * 1000
			});

			// Determine and announce ring membership
			const peerId = node.peerId.toString();
			const arachnodeInfo = await ringSelector.createArachnodeInfo(peerId);
			fretAdapter.setArachnodeInfo(arachnodeInfo);

			log('Announced Arachnode membership: Ring %d', arachnodeInfo.ringDepth);

			// Setup restoration coordinator with FRET adapter
			const restorationCoordinatorV2 = new RestorationCoordinator(
				fretAdapter,
				// The node's own IPeerNetwork, not an inline `dialProtocol` lambda: the lambda opened
				// streams without `runOnLimitedConnection`, so a block holder reachable only through a
				// relay looked like a peer that simply did not have the block, and it dropped the
				// caller's AbortSignal, so `SyncClient`'s per-peer dial deadline never bounded a dial.
				keyNetwork,
				`/optimystic/${options.networkName}`,
				node.peerId.toString(),
				linkDeadlines,
				membership
			);

			serving.late.restore = async (blockId, rev?) => {
				return await restorationCoordinatorV2.restore(blockId, rev);
			};

			// --- Rebalance reaction: drive RebalanceMonitor + react via BlockTransferCoordinator ---
			// Nothing previously activated the rebalance path on a real node: initRebalanceMonitor was
			// never called, the monitor was never start()ed, and BlockTransferCoordinator (the
			// confirm-lost / push-grown reaction primitive) was never constructed in src. This block
			// lives inside the arachnode `if (fret)` gate because the fretAdapter it needs only exists
			// here. When arachnode is disabled or FRET is absent the rebalance path stays inert
			// (acceptable: rebalance is a resilience optimization). A wiring failure here is non-fatal
			// (log + continue), unlike the operator-opted-in cohortTopic block.
			if (networkManager && (options.rebalance?.enabled ?? true) !== false) {
				try {
					// repo → the LOCAL storageRepo (not repoProxy/coordinatedRepo): a pushed replica must
					// land in / be read from this node's own storage, same reasoning as the blockTransfer
					// service handler registration. protocolPrefix (/optimystic/<networkName>) MUST match
					// the prefix the node registers its block-transfer handler under, or every lost-block
					// push dials the wrong protocol and fails to connect.
					const coordinator = new BlockTransferCoordinator(
						storageRepo,
						keyNetwork,
						partitionDetector,
						protocolPrefix,
						{ transferTimeoutMs: linkDeadlines.transferTimeoutMs },
					);

					const rebalanceMonitor = networkManager.initRebalanceMonitor(
						partitionDetector,
						fretAdapter,
						ownedBlocks,
						keyNetwork,
						options.rebalance,
					);
					await rebalanceMonitor.start();
					serving.late.blockHolders = (holders) => rebalanceMonitor.recordBlockHolders(holders);

					// onRebalance fires synchronously from the monitor's debounced check; the coordinator's
					// reaction (confirm lost / push grown, each partition-guarded) is async, so hop it off
					// the handler rather than blocking the monitor's emit loop. handleRebalanceEvent can
					// REJECT (a coding bug inside the coordinator — every per-peer error it makes is already
					// caught) and a bare `void` would surface that as an unhandled rejection (process-fatal
					// on Node >=15); the reaction is a resilience optimization, so swallow + log instead.
					//
					// event.gained needs no action here: RebalanceMonitor only ever reports a block gained
					// when this node already stores it (trackedBlocks is built from this node's own owned
					// blocks — see RebalanceEvent.gained's doc), so the shared owned-block set already has
					// it and there is nothing to fetch.
					//
					// A LOST block is NO LONGER released synchronously: doing so stopped spreading a block
					// whose push to the new owners might fail, drop it below the replication floor, and let a
					// later sweep reclaim it (docs/arachnode-ring-handoff.md § Why the current code violates
					// it #2). Instead the release is GATED on confirmation — the coordinator returns the lost
					// blocks it confirmed replicated to ≥ floor new owners, and ONLY those are untracked
					// (authoritative eviction from the shared set — complements spread's lazy self-prune) and
					// marked GC-eligible. A lost block whose push failed / was partition-skipped stays
					// tracked and served, and is retried on the next rebalance.
					//
					// Best-effort iteration safety: this eviction can mutate ownedBlocks while
					// SpreadOnChurnMonitor (or this monitor) is mid for...of over the same Set inside an
					// async loop. Adding/deleting a Set entry during iteration does not throw in JS — entries
					// are visited best-effort — which is acceptable for a resilience mechanism, so we
					// document it here rather than add locking.
					//
					// The event's `grown` arm (blocks this node KEEPS whose cohort acquired new peers — the
					// founder/cohort-growth case): handleRebalanceEvent pushes each grown block to the newly
					// co-responsible peers and returns a per-block GrowthOutcome in `result.growth`, which is
					// fed back into the monitor here. The monitor records a peer as seen ONLY off that
					// feedback (a confirmed replica, or a block that otherwise reached its floor), so a failed
					// push is re-detected on the next check instead of being silently dropped — bounded by
					// growthMaxAttempts, after which the monitor abandons the peer for that block (visible in
					// getGrowthDiagnostics). Nothing is released or untracked off the grown arm — the node
					// keeps serving the block either way. On the catch path NOTHING is recorded: the monitor's
					// state stays un-advanced and the next check retries, the correct outcome for a reaction
					// that threw.
					rebalanceMonitor.onRebalance((event) => {
						coordinator.handleRebalanceEvent(event).then((result) => {
							for (const blockId of result.released) {
								rebalanceMonitor.untrackBlock(blockId); // also evicts from the shared ownedBlocks set
								gcEligible.add(blockId);                 // confirmed replicated → safe to sweep
							}
							for (const [blockId, outcome] of result.growth) {
								rebalanceMonitor.recordGrowthOutcome(blockId, outcome);
							}
							if (result.underReplicated.length > 0) {
								const growthDiag = rebalanceMonitor.getGrowthDiagnostics();
								log('cohort-growth: %d of %d grown blocks not confirmed on new peers this pass ' +
									'(awaiting-confirmation=%d given-up-pairs=%d)',
									result.underReplicated.length, event.grown.size,
									growthDiag.blocksAwaitingConfirmation, growthDiag.abandonedPairs);
							}
						}).catch((err) => {
							// NOTE: accepted tradeoff — recording nothing here means growthMaxAttempts (which
							// only counts RECORDED incomplete outcomes) never bounds a reaction that throws
							// every time, so the re-check timer retries it at growthRecheckIntervalMs forever,
							// logging each failure. Kept deliberately: per-peer errors are already caught
							// inside the coordinator, so a throw out of handleRebalanceEvent is a coding bug,
							// and a loud unbounded retry is the right way to surface one — silently abandoning
							// the block would hide it and leave the block singly held. Revisit if a legitimate
							// recoverable condition is ever allowed to throw out of the reaction.
							log('rebalance reaction failed: %o', err);
						});
					});

					// Ring-shift handoff (advertise→confirm→release). It needs the confirmer (this
					// coordinator) and the cohort-size floor (this monitor), so it is wired here. The
					// `onRelease` callback runs Phase C's local effect: stop serving/spreading the shed
					// range and mark it GC-eligible — the same authoritative eviction the confirmed-rebalance
					// release performs.
					ringShift = new RingShiftCoordinator({
						fretAdapter,
						ringSelector,
						fret,
						partitionDetector,
						confirmer: coordinator,
						ownedBlocks,
						selfPeerId: peerId,
						membership,
						getFloor: () => rebalanceMonitor.getCohortSize(),
						onRelease: (blockIds) => {
							for (const blockId of blockIds) {
								rebalanceMonitor.untrackBlock(blockId);
								gcEligible.add(blockId);
							}
						}
					});
					// Reconcile any stale `moving` advertisement left by a crash mid-handoff (no-op unless
					// arachnode metadata survived a restart still marked `moving`).
					ringShift.reconcileOnStart();

					// Feed owned blocks via the SINGLE shared feed (idempotent — already live if the spread
					// block above wired it). Both monitors read the same ownedBlocks set this populates.
					ensureOwnedBlockFeed();

					// Expose for tests/diagnostics (mirrors node.spreadOnChurnMonitor).
					(node as any).rebalanceMonitor = rebalanceMonitor;
					(node as any).blockTransferCoordinator = coordinator;
					(node as any).ringShiftCoordinator = ringShift;

					// Disposal: stop the monitor before transports close. Composes with the other stop
					// wrappers (each calls its captured previousStop last). Idempotent — RebalanceMonitor.stop()
					// early-returns when not running (NetworkManagerService.stop() also stops it). The shared
					// owned-block feed teardown is the separate up-front wrapper (not duplicated here).
					const previousStop = node.stop.bind(node);
					node.stop = async () => {
						try {
							await rebalanceMonitor.stop();
						} finally {
							await previousStop();
						}
					};
				} catch (err) {
					// Rebalance is a resilience optimization, not a correctness requirement - a wiring
					// failure (e.g. FRET briefly unavailable) must NOT hard-fail node startup.
					log('rebalance wiring init failed: %o', err);
				}
			}

			// Monitor capacity and adjust ring periodically. The damped `shouldTransition()` decides
			// WHETHER/where to move (docs/arachnode-ring-handoff.md § Part 1); the RingShiftCoordinator
			// carries the move out through the advertise→confirm→release handoff (§ Part 2) so a shift
			// never drops a key below its replication floor. The old unilateral `setArachnodeInfo` flip —
			// which changed advertised responsibility instantly with no data handoff — is gone.
			//
			// Ring shifts run ONLY when `ringShift` is wired (i.e. the rebalance reaction is enabled): a
			// move-out is unsafe without the confirm/release path, so a node with the rebalance reaction
			// disabled stays at its bootstrap ring rather than flipping unsafely.
			const monitorInterval = setInterval(async () => {
				if (!ringShift) return;
				const transition = await ringSelector.shouldTransition();
				if (transition.shouldMove && transition.direction && transition.newRingDepth !== undefined) {
					log('Ring transition needed: moving %s to Ring %d', transition.direction, transition.newRingDepth);
					try {
						const outcome = await ringShift.executeShift({
							direction: transition.direction,
							newRingDepth: transition.newRingDepth
						});
						log('Ring shift outcome: %o', outcome);
					} catch (err) {
						log('Ring shift failed: %o', err);
					} finally {
						// Measure the minimum dwell from the SETTLED shift (completed or rolled back), not
						// just the trigger stamped inside shouldTransition (docs/arachnode-ring-handoff.md §1.3).
						ringSelector.recordShiftSettled();
					}
				}
			}, 60_000);

			// Cleanup on node stop
			const originalStop = node.stop.bind(node);
			node.stop = async () => {
				clearInterval(monitorInterval);
				await originalStop();
			};
		} else {
			log('FRET service not available, Arachnode disabled');
		}
	}

	// --- Seed the shared owned-block set from already-durable storage ---
	// Blocks durable from a previous run are otherwise untracked until next touched (see the
	// onAnyCollectionChange comment above where ownedBlocks is declared). Placed here, AFTER both
	// monitor-wiring blocks (spread ~line 862, rebalance ~line 974) have had their chance to call
	// ensureOwnedBlockFeed():
	//   - Gate on offOwnedBlockFeed: only seed when a monitor actually consumes ownedBlocks; if both
	//     are disabled the set is unused and the scan (plus the background task) is wasted work.
	//   - Feed-before-scan ordering is load-bearing: because the feed is already live, a block
	//     committed/replicated DURING the scan is caught by the feed; Set.add is idempotent so the
	//     overlap is harmless. Scanning before subscribing would drop a block committed in the gap.
	//   - Fire-and-forget so a large store never blocks startup; the .catch keeps a scan rejection
	//     from becoming an unhandled rejection.
	//   - Cancellable: a stop wrapper flips seedStopping so the scan loop breaks against a
	//     stopping/closing backend rather than running the enumeration to completion.
	// NOTE: a concurrent rebalance release can untrackBlock (delete from ownedBlocks) a confirmed-
	// released block while this scan is still running, and the scan could then re-add that id. Benign
	// transient: the block is still in the metadata store (no sweep reclaims metadata yet), so a
	// re-added released block is simply re-evaluated and re-released on the next rebalance tick. Right
	// after a restart, responsibility-loss detection lags this fast metadata scan, so the window is
	// small. Accepted rather than synchronized.
	if (offOwnedBlockFeed && typeof rawStorage.listBlockIds === 'function') {
		let seedStopping = false;
		const previousStop = node.stop.bind(node);
		node.stop = async () => {
			seedStopping = true;
			await previousStop();
		};
		void seedOwnedBlocksFromStorage(rawStorage, ownedBlocks, () => seedStopping)
			.catch((err) => { wiringLog('owned-block-seed seed failed: %o', err); });
	}

	// [dispute-subsystem-dormant] The DisputeService object is constructed below so tests and
	// getDisputeStatus() work, but it is unreachable from the live network path:
	//   - No inbound handler: disputeProtocolService is NOT in the services map above.
	//   - onInvalidation is deliberately unset: maybeInvalidate() is a no-op on live nodes.
	//   - revalidate is deliberately unset: handleChallenge always votes inconclusive on live nodes.
	// Full activation requires arbitrator-set anchoring before a forged synthetic cohort can pass resolution.
	// Gate: tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring
	// Wiring plan: tickets/backlog/feat-dispute-subsystem-live-activation
	// Initialize dispute service if enabled
	let disputeServiceInstance: DisputeService | undefined;
	if (options.dispute?.disputeEnabled) {
		const createDisputeClient = (peerId: any) => DisputeClient.create(peerId, keyNetwork, protocolPrefix, linkDeadlines);
		disputeServiceInstance = new DisputeService({
			peerId: node.peerId,
			privateKey: nodePrivateKey,
			peerNetwork: keyNetwork,
			createDisputeClient,
			reputation,
			validator: options.validator,
			config: options.dispute,
			selectArbitrators: async (blockId: string, excludePeers: string[], count: number, round: number, epoch: Uint8Array) => {
				const { hashKey: fretHashKey } = await import('p2p-fret');
				const fret = (node as any).services?.fret as FretService | undefined;
				if (!fret) return [];
				// Dispersed sampling: draw `count` peers from coordinates spread across the whole keyspace
				// (hash(blockId ‖ round ‖ epoch ‖ i)) rather than the block's XOR neighborhood, so an attacker
				// who owns the block's locale does not thereby own the arbitrators. `assembleCohort` already
				// filters to known members; excluding the original cluster + self keeps arbitrators independent.
				// NOTE: not filtered by `membership` — a node-local predicate would make the draw differ between
				// nodes — so a refused peer can be drawn and sent the disputed record. Settled before the dispute
				// subsystem goes live (`feat-dispute-subsystem-live-activation`, "Who may arbitrate?").
				const excludeSet = new Set(excludePeers);
				// NOTE: adding the local node's own id to `exclude` makes the draw node-relative. Cross-node
				// determinism (the verifiable-recompute property) holds today only because the dissent
				// coordinator running this is itself a member of the original cluster, so `self` is already in
				// `excludePeers` — the add is a no-op and every honest node excludes the identical set. When a
				// verify-path recompute lands, it MUST reconstruct `exclude` from the challenger's identity
				// (`proof.challengerPeerId`) + original cluster, never the verifier's own id, or re-derivation diverges.
				excludeSet.add(node.peerId.toString());
				const picks = await sampleArbitrators(
					{ blockId: new TextEncoder().encode(blockId), round, epoch, count, exclude: excludeSet },
					(coord, wants) => fret.assembleCohort(coord, wants) as string[],
					fretHashKey,
				);
				return picks.map(pid => peerIdFromString(pid));
			},
		});
	}

	return {
		storageRepo,
		coordinatedRepo: coordinator,
		reportBlockHeld,
		clusterLatestCallback,
		disputeService: disputeServiceInstance,
		arachnode: arachnodeHandles
	};
}
