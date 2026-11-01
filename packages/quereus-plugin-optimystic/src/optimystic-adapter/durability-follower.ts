import type {
	BlockDurabilityReachedEvent, BlockId, IBlockDurabilityNotifier, TransactionDurability, WriteDurability,
} from '@optimystic/db-core';
import { LruMap, isFullyDurable } from '@optimystic/db-core';
import { createLogger } from '../logger.js';

const log = createLogger('durability-follower');

/** Pending commits followed at once, before the oldest is dropped. */
export const DEFAULT_MAX_PENDING_COMMITS = 10_000;
/** Blocks whose full-replication event is remembered per notifier, for a commit whose answer arrives
 *  after the event did. */
export const DEFAULT_MAX_REACHED_BLOCKS = 4_096;

/**
 * What {@link DurabilityFollower.follow} decided about one commit.
 *
 * - `unfollowed` — no full-replication event for it will reach this node, so it is never reported
 *   fully held.
 * - `held` — already fully held when it was reported; nothing is owed, so it is not registered and
 *   is not reported again.
 * - `pending` — registered; `onFullyHeld` fires once when every block it owes is covered.
 * - `covered` — every block it owes was covered by an event seen before its answer arrived. It is
 *   not registered: the caller reports it fully held itself, after reporting the commit.
 */
export type FollowVerdict = 'unfollowed' | 'held' | 'pending' | 'covered';

/** Where a commit's full-replication events come from. */
export interface FollowSource {
	/** The peer id of the node the commit was written through. */
	readonly selfPeerId: string | undefined;
	/** That node's full-replication event source; absent when it keeps no under-replication ledger. */
	readonly notifier: IBlockDurabilityNotifier | undefined;
}

export interface DurabilityFollowerOptions {
	/** Called once per followed commit, synchronously, when every block it owes is covered. */
	readonly onFullyHeld: (transactionId: string) => void;
	readonly maxPendingCommits?: number;
	readonly maxReachedBlocks?: number;
}

/** One followed commit: the blocks still owed, each at the revision the commit wrote it at. */
interface PendingCommit {
	readonly transactionId: string;
	readonly source: NotifierState;
	readonly owed: Map<BlockId, number>;
}

/** Per notifier: its subscription, the commits waiting on each of its blocks, and the events seen. */
interface NotifierState {
	readonly unsubscribe: () => void;
	readonly waiting: Map<BlockId, Set<PendingCommit>>;
	/** Block → the highest revision an event (or a fully held commit) has reported every member holds. */
	readonly reached: LruMap<BlockId, number>;
}

/**
 * Tells when a SQL commit that was saved below full replication becomes held by its whole cohort.
 *
 * Takes each commit's {@link TransactionDurability} and the node's full-replication events
 * (`BlockDurabilityReachedEvent`, keyed by block and revision) and emits transaction ids. A commit
 * is followed by the blocks it wrote (`WriteDurability.blockRevs`): an event naming a block at the
 * revision the commit wrote or a later one covers it, because a later revision every member holds
 * was built on the earlier one. When nothing the commit owes is left, it is reported once.
 *
 * Knows nothing of SQL or libp2p; the bridge hands it reports and the notifier to listen to.
 */
export class DurabilityFollower {
	private readonly onFullyHeld: (transactionId: string) => void;
	private readonly maxPendingCommits: number;
	private readonly maxReachedBlocks: number;
	/** Every followed commit, oldest first — the order the cap evicts in. */
	private readonly pending = new Map<string, PendingCommit>();
	private readonly notifiers = new Map<IBlockDurabilityNotifier, NotifierState>();

	constructor(options: DurabilityFollowerOptions) {
		this.onFullyHeld = options.onFullyHeld;
		this.maxPendingCommits = options.maxPendingCommits ?? DEFAULT_MAX_PENDING_COMMITS;
		this.maxReachedBlocks = options.maxReachedBlocks ?? DEFAULT_MAX_REACHED_BLOCKS;
	}

	/**
	 * Start listening to `notifier`, if not already. Call before a commit that may be followed is
	 * sent: an event that fires before the subscription exists is not seen, and a commit whose
	 * answer arrives after its blocks' events would then wait forever. Idempotent.
	 */
	watch(notifier: IBlockDurabilityNotifier): void {
		this.stateFor(notifier);
	}

	/** Decide whether `durability`'s commit can be followed, and register it if so. */
	follow(transactionId: string, durability: TransactionDurability, source: FollowSource): FollowVerdict {
		const { overall } = durability;
		if (overall !== undefined && isFullyDurable(overall)) {
			return 'held';
		}
		const reason = unfollowableReason(durability, source);
		if (reason !== undefined) {
			log('follow:unfollowed transaction=%s reason=%s', transactionId, reason);
			return 'unfollowed';
		}
		const state = this.stateFor(source.notifier!);
		const owed = owedBlocks(durability);
		for (const [blockId, rev] of owed) {
			if ((state.reached.peek(blockId) ?? -1) >= rev) {
				owed.delete(blockId);
			}
		}
		if (owed.size === 0) {
			log('follow:covered transaction=%s', transactionId);
			return 'covered';
		}
		this.register({ transactionId, source: state, owed });
		log('follow:pending transaction=%s blocks=%d', transactionId, owed.size);
		return 'pending';
	}

	/**
	 * Treat every collection `durability` reports fully held as an event for its blocks: every member
	 * holds them at those revisions, so an earlier commit waiting on one of them is covered now rather
	 * than when the settling event arrives.
	 */
	coverHeld(durability: TransactionDurability, notifier: IBlockDurabilityNotifier | undefined): void {
		const state = notifier === undefined ? undefined : this.notifiers.get(notifier);
		if (state === undefined) return;
		const reached: [BlockId, number][] = [];
		for (const d of durability.collections.values()) {
			if (d !== undefined && isFullyDurable(d)) {
				reached.push(...Object.entries(d.blockRevs ?? {}));
			}
		}
		this.noteReached(state, reached);
	}

	/** Release every subscription and forget every followed commit: none is reported after this. */
	dispose(): void {
		for (const state of this.notifiers.values()) {
			state.unsubscribe();
		}
		this.notifiers.clear();
		this.pending.clear();
	}

	private stateFor(notifier: IBlockDurabilityNotifier): NotifierState {
		const known = this.notifiers.get(notifier);
		if (known !== undefined) return known;
		const waiting = new Map<BlockId, Set<PendingCommit>>();
		const reached = new LruMap<BlockId, number>(this.maxReachedBlocks);
		// NOTE: an event evicted from `reached` before the commit it covers is registered strands that
		// commit (it waits for an event that already fired). Only an answer delayed past this many
		// other blocks' events can lose that way; raise the cap if pending commits are ever seen stranded.
		const state: NotifierState = {
			waiting,
			reached,
			unsubscribe: notifier.onBlockDurabilityReached(event => this.onEvent(state, event)),
		};
		this.notifiers.set(notifier, state);
		return state;
	}

	private onEvent(state: NotifierState, event: BlockDurabilityReachedEvent): void {
		this.noteReached(state, event.blockIds.map(blockId => [blockId, event.rev]));
	}

	/** Remember that every member holds each block at its revision, and cover what was waiting on it. */
	private noteReached(state: NotifierState, reached: Iterable<readonly [BlockId, number]>): void {
		const held: string[] = [];
		for (const [blockId, rev] of reached) {
			state.reached.set(blockId, Math.max(state.reached.peek(blockId) ?? rev, rev));
			this.coverBlock(state, blockId, rev, held);
		}
		// After the bookkeeping, so a listener that commits again sees a consistent follower.
		for (const transactionId of held) {
			this.onFullyHeld(transactionId);
		}
	}

	/** Take `blockId` off every commit it covers at `rev`; a commit left owing nothing goes on `held`. */
	private coverBlock(state: NotifierState, blockId: BlockId, rev: number, held: string[]): void {
		const waiting = state.waiting.get(blockId);
		if (waiting === undefined) return;
		for (const commit of [...waiting]) {
			if (commit.owed.get(blockId)! > rev) continue;
			commit.owed.delete(blockId);
			waiting.delete(commit);
			if (commit.owed.size === 0) {
				this.pending.delete(commit.transactionId);
				held.push(commit.transactionId);
			}
		}
		if (waiting.size === 0) state.waiting.delete(blockId);
	}

	private register(commit: PendingCommit): void {
		// NOTE: a node that stays alone registers every write it makes and none ever clears, so the
		// count is capped and the oldest dropped. A dropped commit was reported `followed` and is never
		// reported fully held; raise the cap if hosts are seen waiting on commits this log line names.
		if (this.pending.size >= this.maxPendingCommits) {
			const oldest = this.pending.values().next().value!;
			this.forget(oldest);
			log('follow:evicted transaction=%s blocks=%d cap=%d', oldest.transactionId, oldest.owed.size, this.maxPendingCommits);
		}
		this.pending.set(commit.transactionId, commit);
		for (const blockId of commit.owed.keys()) {
			let waiting = commit.source.waiting.get(blockId);
			if (waiting === undefined) {
				waiting = new Set();
				commit.source.waiting.set(blockId, waiting);
			}
			waiting.add(commit);
		}
	}

	private forget(commit: PendingCommit): void {
		this.pending.delete(commit.transactionId);
		for (const blockId of commit.owed.keys()) {
			const waiting = commit.source.waiting.get(blockId);
			waiting?.delete(commit);
			if (waiting?.size === 0) commit.source.waiting.delete(blockId);
		}
	}
}

/**
 * Why no full-replication event for this commit's missing copies will reach `source`'s node, or
 * `undefined` when every one will. Assumes the commit is not already fully held.
 */
function unfollowableReason(durability: TransactionDurability, source: FollowSource): string | undefined {
	if (durability.overall === undefined) return 'holders-unknown';
	const collections = [...durability.collections.values()].filter((d): d is WriteDurability => d !== undefined);
	// An abandoned block never heals by replication, so the commit never becomes fully held.
	if (collections.some(d => (d.torn?.length ?? 0) > 0)) return 'torn';
	if (source.notifier === undefined || source.selfPeerId === undefined) return 'no-ledger-here';
	for (const d of collections.filter(d => !isFullyDurable(d))) {
		if (d.blockRevs === undefined) return 'blocks-unnamed';
		const answers = [d, ...(d.otherCohorts ?? [])];
		// `blockRevs` does not say which cohort answered for which block, and a block whose cohort
		// answered `full` has no ledger entry, so no event would ever cover it.
		if (answers.some(a => a.quorum === 'full')) return 'mixed-cohort-answers';
		if (answers.some(a => a.recordedBy !== source.selfPeerId)) return 'owed-by-another-ledger';
	}
	return undefined;
}

/** Every block the commit's collections below full replication wrote, at the highest revision. */
function owedBlocks(durability: TransactionDurability): Map<BlockId, number> {
	const owed = new Map<BlockId, number>();
	for (const d of durability.collections.values()) {
		if (d === undefined || isFullyDurable(d)) continue;
		for (const [blockId, rev] of Object.entries(d.blockRevs ?? {})) {
			owed.set(blockId, Math.max(owed.get(blockId) ?? rev, rev));
		}
	}
	return owed;
}
