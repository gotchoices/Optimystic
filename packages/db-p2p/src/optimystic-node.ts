import type { Libp2p, PrivateKey } from '@libp2p/interface';
import type { BlockId, HlcClock, IBlockChangeNotifier, IRepo } from '@optimystic/db-core';
import type { NodeBlobService } from './blob/node-blob-service.js';
import type { BlobReclaimOnDemand } from './blob/reclaim-pass.js';
import type { DisputeService } from './dispute/dispute-service.js';
import type { Libp2pKeyPeerNetwork } from './libp2p-key-network.js';
import type { NodeCohortReachability } from './network/cohort-reachability.js';
import type { ReactivityCollectionWatch } from './reactivity/collection-watch.js';
import type { PeerReputationService } from './reputation/peer-reputation.js';
import type { ArrivalPushReceiver } from './matchmaking/arrival-push-receiver.js';
import type { LinkDeadlines } from './rpc-deadline.js';
import type { StorageRepo } from './storage/storage-repo.js';

/**
 * The handles `createLibp2pNodeBase` attaches to every libp2p node it returns, a client's included
 * (`NodeOptions.servesBlocks`). This is the sanctioned in-process surface a host reads — declared
 * once here so reaching it does not require a cast, and so a host cannot silently rebuild a
 * component the node already owns. A node carries one of the two shapes that extend it,
 * {@link OptimysticNodeAttachments} or {@link OptimysticClientNodeAttachments}, told apart by
 * `servesBlocks`.
 *
 * Deliberately NOT the full set of `(node as any).*` attachments made in `libp2p-node-base.ts`:
 * the churn/rebalance/ring-shift monitors, the cohort-topic host and the reactivity registries
 * are node-internal wiring, not a host-facing surface, and typing them is a separate job.
 * `reactivityWatch` is the exception among the reactivity pieces because it IS the surface a
 * host uses; the registry, recover transport and rotation scheduler behind it stay internal.
 * `matchmakingArrivalPush` is the matchmaking counterpart: the one piece a host passes on.
 */
export interface OptimysticNodeAttachmentsBase {
	/**
	 * The node's ONE key network — built from its resolved cluster policy, network-namespaced
	 * protocol prefix, reputation tracker and persistence. A host that needs key/coordinator
	 * lookup uses THIS; constructing a second one gives peer selection a different cohort
	 * width and coordinator than the node's own consensus path uses for the same key.
	 */
	keyNetwork: Libp2pKeyPeerNetwork;
	reputation: PeerReputationService;
	/** The node's libp2p Ed25519 identity key, for hosts binding a client-transaction signer. */
	peerPrivateKey: PrivateKey;
	/**
	 * Every network deadline the node derived from `NodeOptions.linkRoundTripMs` (the undeclared
	 * constants when it was not set). A host that dials through the node — a `NetworkTransactor`'s
	 * `dialTimeoutMs`, its `timeoutMs` from `transactionTimeoutMs`, and its `retryBackoffBaseMs` — reads
	 * its deadlines here rather than restating ones that ignore the declaration.
	 */
	linkDeadlines: LinkDeadlines;
	/**
	 * Wake-on-network-change for a collection: one `watch` call per collection a host wants to be
	 * told about, whichever machine commits to it. Present exactly when the node was built with
	 * `cohortTopic.enabled`. Without it, a host on a serving node has only `blockChangeNotifier`,
	 * which reports commits this node itself stores, and a host on a client is told of nothing and
	 * reads to see another machine's commit.
	 */
	reactivityWatch?: ReactivityCollectionWatch;
	/**
	 * The node's matchmaking arrival-push receiver: pass it to `createLibp2pMatchmakingSeekerSession` as
	 * `arrivalPush` and that session's walks wait on pushes rather than polling. Present exactly when the node
	 * was built with `cohortTopic.enabled`; without it a seeker session takes the poll path.
	 */
	matchmakingArrivalPush?: ArrivalPushReceiver;
	/**
	 * Whether the cohorts responsible for some blocks can be reached now, or this node is genuinely
	 * alone in them — the offline queue's reachability gate (docs/offline-sync.md §When to submit: the
	 * reachability gate), built over this node's own key network. Its `onChange` wakes a listener,
	 * debounced (`NodeOptions.cohortReachability`), when a connection opens or a peer is identified.
	 * On a client no cohort ever names this node, so the gate is open exactly when a cohort names a
	 * serving machine.
	 */
	cohortReachability: NodeCohortReachability;
	/**
	 * The node's hybrid logical clock (docs/crdt-sync.md §Migration Path, Stage 1), started before the
	 * node could store anything, its high-water mark kept in `NodeOptions.kvStore`. A serving node's
	 * storage raises it to the HLC of every write it stores for others. A host that builds a transactor
	 * over the node passes it as `NetworkTransactorInit.clock`, so the writes it mints and the writes
	 * the node stores move one clock; a transactor without it mints from a process-wide clock that
	 * observes nothing the node stores. On a client, the clock mints the HLC of every write it sends.
	 */
	hlcClock: HlcClock;
	/**
	 * The node's blob service (docs/blobs.md §The node's blob service), over `NodeOptions.pieceStorage`
	 * and the blob records in `NodeOptions.kvStore`. On a client too: the machine a blob is put on holds
	 * its only copy until a row referencing it commits. A read fetches the pieces this node lacks from
	 * the machines that hold them, `fetch` brings a whole blob here, `stat` with `probe` asks the blob's
	 * cohort, and `announce` hands the blob to the node's copy drain, which copies it to the cohort and
	 * reports its durability.
	 */
	blobs: NodeBlobService;
	/**
	 * The node's blob reference pass (docs/blobs.md §Lifetime), which releases the `responsible` and
	 * `owed` holds of blobs no registered reference tree lists any longer. It runs on its own schedule
	 * — five minutes after the node starts, then every six hours — and this handle only asks for a
	 * pass now, which a host or a test uses to see one through without waiting. On a client too: it
	 * takes no `responsible` hold, but it owns the owed entries of the blobs its host put.
	 */
	blobReclaim: BlobReclaimOnDemand;
}

/**
 * A node that stores blocks for its network and takes part in agreeing on writes — the default
 * (`NodeOptions.servesBlocks` unset or `true`).
 */
export interface OptimysticNodeAttachments extends OptimysticNodeAttachmentsBase {
	servesBlocks: true;
	coordinatedRepo: IRepo;
	storageRepo: StorageRepo;
	/** Per-collection change origin. Replaced by the cohort-topic bridge notifier when enabled. */
	blockChangeNotifier: IBlockChangeNotifier;
	/** Present only when the dispute subsystem is configured. */
	disputeService?: DisputeService;
	/**
	 * Record that `peerId` holds `blockId` at revision `rev` or later, as learned by the embedder — for
	 * example from a block push the embedder made itself and the peer accepted. Two effects:
	 *
	 *  - the rebalance monitor counts `peerId` as holding the block, so its growth arm does not push it
	 *    there (when the monitor runs on this node; otherwise nothing);
	 *  - the under-replication ledger's entry for the block, when it owes `peerId` a copy of a revision
	 *    at or below `rev`, no longer owes it; an entry left with nobody owed is removed and the
	 *    full-replication event fires for it, exactly as when this node's own push is confirmed. That
	 *    event carries no `collectionId`.
	 *
	 * The report is taken on the embedder's word: nothing is checked against the peer or local storage.
	 * A wrong report costs the peer a copy it should have received, until a later commit to the block
	 * records a new shortfall or the peer leaves the cohort and rejoins.
	 *
	 * `peerId` is `PeerId.toString()`, the `12D3KooW…` form. Works with the under-replication drain
	 * disabled: that option stops pushing, not recording.
	 *
	 * Resolves once the ledger has been updated. Rejects with a `RangeError`, having recorded nothing,
	 * when `rev` is not a non-negative integer; otherwise only on a fault reading or writing the ledger
	 * (a node that has stopped may have closed its store). Reporting this node's own peer id does nothing.
	 */
	reportBlockHeld(blockId: BlockId, rev: number, peerId: string): Promise<void>;
}

/**
 * A client (`NodeOptions.servesBlocks: false`): it stores no blocks and coordinates nothing, so it
 * carries no repo, no block store and no change notifier — nothing ever lands in storage it does not
 * have. Its reads and writes go to the network's serving machines through a `NetworkTransactor` over
 * `keyNetwork`; it hears another machine's commit only through `reactivityWatch`, or by reading.
 * See docs/internals.md §Client nodes.
 */
export interface OptimysticClientNodeAttachments extends OptimysticNodeAttachmentsBase {
	servesBlocks: false;
}

export type OptimysticNode = Libp2p & OptimysticNodeAttachments;
export type OptimysticClientNode = Libp2p & OptimysticClientNodeAttachments;
