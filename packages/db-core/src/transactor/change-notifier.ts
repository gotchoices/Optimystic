import type { BlockId, CollectionId } from '../index.js';
import type { ActionId } from '../collection/action.js';

/** A commit landed on this node mutating one collection's blocks. */
export type CollectionChangeEvent = {
	/** Header/collection id of the affected collection (block.header.collectionId). */
	readonly collectionId: CollectionId;
	/** Blocks within that collection mutated by this commit. */
	readonly blockIds: readonly BlockId[];
	readonly actionId: ActionId;
	readonly rev: number;
	/**
	 * The collection's chain tail block id at the time of this commit (the `CommitRequest.tailId`).
	 * Names the reactivity root (the tail block's storage group, at `H(tailId)`). Present on commit-driven
	 * events; `undefined` on read-driven promotions (the `StorageRepo.get` path has no commit tail —
	 * those never originate anyway, and are cert-gated out downstream).
	 */
	readonly tailId?: BlockId;
	/**
	 * `true` iff this change event is a durable **invalidation** — a compensating revision + appended
	 * `InvalidationEntry` reversing a previously-committed action proven invalid by dispute
	 * (`docs/right-is-right.md` §Durable Invalidation), rather than an ordinary commit. An invalidation
	 * is a committed collection change like any other, so it flows through the same notification path;
	 * this flag lets a subscriber distinguish it (drop derived results + resubmit) from a plain commit
	 * (refresh). A hint only — correctness never depends on it: the subscriber always re-reads the
	 * authoritative reverted state. Absent (falsy) on ordinary commits.
	 */
	readonly invalidation?: boolean;
	/**
	 * When {@link invalidation} is set, the `actionId` of the original committed action that was
	 * reversed (the `InvalidationEntry.invalidatedActionId`). Lets an invalidation-aware client
	 * dedup/coalesce multiple cascade notifications by the action they reverse, and resubmit exactly
	 * the affected work. Absent on ordinary commits.
	 */
	readonly invalidatedActionId?: ActionId;
};

export type CollectionChangeListener = (event: CollectionChangeEvent) => void;

/**
 * The cluster-consensus commit certificate for a committed action — the **authoritative** proof
 * that the cohort agreed the commit. It is the cross-package currency the local change-notifier
 * bridge forwards into the cohort-topic substrate (`CohortTopicService.onLocalCommit`) so reactivity
 * can originate notifications **without re-signing**: a notification's signature is bit-for-bit this
 * `thresholdSig`. The bridge and every downstream consumer treat the bytes as opaque and pass them
 * through unchanged — only the cluster layer that produced consensus ever mints one.
 *
 * Peer ids are carried as their string form (the cluster keys signatures by peer-id string); db-core
 * stays cross-platform and never references a libp2p `PeerId` type here.
 */
export type CommitCert = {
	/** Threshold signature bytes proving `signers` agreed the commit. Forwarded UNCHANGED; never re-signed. */
	readonly thresholdSig: Uint8Array;
	/** Peer-id strings whose signatures compose {@link thresholdSig} (a distinct set of size ≥ {@link minSigs}). */
	readonly signers: readonly string[];
	/** Threshold the signer set satisfies (the cluster super-majority / cohort `k − x`). */
	readonly minSigs: number;
	/**
	 * The exact byte preimage each `signers[i]` signed to produce its 64-byte chunk of
	 * {@link thresholdSig} — the cluster's per-member commit-vote payload `utf8(commitHash + ":approve")`,
	 * identical across all approving signers. Reactivity sets a notification's `digest` to
	 * base64url(signedPayload) so a subscriber's threshold-verify over `digest` reproduces the exact
	 * signed image. Opaque to db-core; minted only by the cluster layer.
	 */
	readonly signedPayload: Uint8Array;
};

export interface IBlockChangeNotifier {
	/**
	 * Subscribe to commits that mutate the given collection. Returns an idempotent unsubscribe.
	 * Listeners are invoked AFTER the commit's critical section (locks released), in commit order,
	 * never from inside it; a throwing listener must not break the commit or other listeners (log +
	 * continue).
	 *
	 * A listener may be invoked later than the call that landed the change: a transaction that
	 * writes several collections (a table and its indexes) commits each as its own request under one
	 * action id, and a node's storage holds one collection's event while another collection of the
	 * same action is still pending there, releasing it when that collection lands, is cancelled, or
	 * a bound elapses (`StorageRepo.emitCollectionChanges` in
	 * `packages/db-p2p/src/storage/storage-repo.ts`). So an event may arrive from a later call of
	 * the storage, or from a timer. Every change still produces exactly one event.
	 */
	onCollectionChange(collectionId: CollectionId, listener: CollectionChangeListener): () => void;
}

export function isBlockChangeNotifier(x: unknown): x is IBlockChangeNotifier {
	return !!x && typeof (x as IBlockChangeNotifier).onCollectionChange === 'function';
}

/**
 * One or more blocks reached FULL replication: every member of their cohort is now confirmed to
 * hold the revision. The complement of the durability class on the write's own result — a write
 * acknowledged below `full` (`WriteDurability.quorum`) is pending until these events cover its
 * blocks, at which point a host can move it from "pending" to "saved".
 *
 * **Fired only on the node whose ledger recorded the shortfall** — the one a below-`full` answer
 * names as `WriteDurability.recordedBy`. An answer without `recordedBy` is a write no node is
 * tracking, and no event should be expected for it. That node fires the event when its record of a
 * block's shortfall is removed, which happens two ways, each firing exactly once per record: the
 * missing copies are confirmed — by the node's own push, or by the embedder reporting a copy it
 * delivered itself — and empty it (the event carries the record's own `rev` and `actionId`), or a
 * later commit of the block that every member confirmed settles it (the event carries that later
 * commit's `rev` and `actionId`).
 *
 * **Keyed by block, deliberately, never by action.** The node's record of what is still owed (the
 * under-replication ledger) keeps ONE entry per block, at the block's highest under-replicated
 * revision: a block written again by a LATER action replaces the earlier entry, so the earlier
 * action's shortfall is cleared by the later action's copies and reported under the later
 * action's `actionId` — the earlier action never fires an event of its own. A host that keys its
 * pending state by action alone therefore waits forever for a superseded write. Hold the blocks the
 * write's durability names (`WriteDurability.blockRevs`, each with the revision it committed at) and
 * clear a block when an event names it at that revision or a later one; `rev` and `actionId` say
 * which write's copies did the covering. An event can arrive before the write's answer has reached
 * the host, so a host that registers on the answer must also remember events it has already seen.
 */
export type BlockDurabilityReachedEvent = {
	/** Blocks that reached full replication in this round. Both of today's producers report one block
	 *  per event; the list shape lets a producer report several blocks of one action together. */
	readonly blockIds: readonly BlockId[];
	/** The revision every cohort member now holds — the block's highest under-replicated revision,
	 *  or the fully replicated commit that settled it, either of which supersedes every lower one. */
	readonly rev: number;
	/** The action whose copies covered the block: the one whose recorded shortfall cleared, or the
	 *  fully replicated commit that settled it. See the note above on superseded writes. */
	readonly actionId: ActionId;
	/** Best-effort; absent when the collection could not be resolved from the block's header, and
	 *  always when a settling commit fired the event (the coordinator does not read the block) or an
	 *  embedder's report cleared the entry (`reportBlockHeld` on a db-p2p node reads no block either). */
	readonly collectionId?: CollectionId;
};

export type BlockDurabilityListener = (event: BlockDurabilityReachedEvent) => void;

/**
 * The seam a host watches for "and now it is really saved": the SAME object that emits
 * {@link CollectionChangeEvent}s for commits (`StorageRepo` implements both), so a host has one
 * subscription point for change events, not two.
 */
export interface IBlockDurabilityNotifier {
	/**
	 * Subscribe to full-replication events. Returns an idempotent unsubscribe. Same listener
	 * discipline as {@link IBlockChangeNotifier.onCollectionChange}: a throwing listener is logged
	 * and the rest still run. An event fires only AFTER the node's own record of the shortfall is
	 * gone, so a listener that re-reads that record sees a consistent picture.
	 */
	onBlockDurabilityReached(listener: BlockDurabilityListener): () => void;
}

export function isBlockDurabilityNotifier(x: unknown): x is IBlockDurabilityNotifier {
	return !!x && typeof (x as IBlockDurabilityNotifier).onBlockDurabilityReached === 'function';
}
