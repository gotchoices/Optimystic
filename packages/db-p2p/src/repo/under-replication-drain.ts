import type { Startable } from '@libp2p/interface';
import type { BlockId, CollectionId, IKeyNetwork } from '@optimystic/db-core';
import type { PartitionDetector } from '../cluster/partition-detector.js';
import type { PushBlockOutcome } from '../cluster/block-transfer-service.js';
import { buildBlockTransferProtocol } from '../cluster/block-transfer-service.js';
import type { IUnderReplicationLedger, SatisfyOutcome, UnderReplicatedEntry } from './i-under-replication-ledger.js';
import { resolveOwedPeers, takeConfirmedCopies, type BlockDurabilitySink, type Owed } from './owed-copies.js';
import type { NetworkMembershipGate } from '../network-membership-gate.js';
import { DrainScheduler, type DrainEntryContext, type DrainLibp2p, type DrainPassReport, type DrainTrigger } from './drain-scheduler.js';
import { createLogger } from '../logger.js';

const log = createLogger('under-replication-drain');

export interface UnderReplicationDrainConfig {
	/** Debounce after a connection opens or a peer is identified, before a pass runs. Default: 5000 */
	debounceMs: number;
	/**
	 * Minimum interval between passes (ms). A trigger inside the window is DEFERRED to the window's
	 * end, never dropped, so a flapping peer costs at most one pass per interval and a peer that
	 * arrives mid-window is still drained to. Default: 15000
	 */
	minIntervalMs: number;
	/**
	 * Self-arming re-check timer while any ledger entry is outstanding (ms). Passes otherwise fire
	 * only on connection events, so a failed push on a then-quiet network — or a shortfall recorded
	 * while its missing member was already connected — would wait for the next arrival. Cheap while
	 * nothing can be pushed: a tick with no pushable peer connected costs one connection scan and
	 * one in-memory count. `0` disables. Default: 30000
	 */
	recheckIntervalMs: number;
	/**
	 * Entries examined per pass. Passes rotate through the ledger, oldest-recorded first, so a large
	 * backlog drains one budget per pass and no entry starves behind a stuck one. A deferred entry is
	 * not touched at all; it is re-examined on a later pass. Default: 64
	 */
	blockBudget: number;
	/**
	 * Consecutive rounds a reachable peer may fail to confirm one block before it is ABANDONED for
	 * that block — no longer pushed to — until it reconnects, which retries it from scratch. The
	 * entry itself stays in the ledger, visible, whatever happens here. Default: 5
	 */
	maxAttempts: number;
}

export const DEFAULT_UNDER_REPLICATION_DRAIN_CONFIG: UnderReplicationDrainConfig = {
	debounceMs: 5000,
	minIntervalMs: 15_000,
	recheckIntervalMs: 30_000,
	blockBudget: 64,
	maxAttempts: 5
};

// Defined beside the shared confirmed-copy rule; re-exported so the package barrel still publishes it.
export type { BlockDurabilitySink } from './owed-copies.js';
// Defined beside the shared scheduling; re-exported so this module's surface is unchanged.
export type { DrainLibp2p, DrainTrigger } from './drain-scheduler.js';

/**
 * The push primitive, already bound to this node's own store, dialer and protocol prefix — the
 * node binds `pushBlockToPeers` (`cluster/block-transfer-service.ts`); a unit test binds a double.
 */
export type BoundBlockPusher = (blockId: BlockId, peerIds: readonly string[]) => Promise<PushBlockOutcome>;

export interface UnderReplicationDrainDeps {
	libp2p: DrainLibp2p;
	ledger: IUnderReplicationLedger;
	/** Re-resolves a block's cohort for an entry that could not name its missing members. */
	keyNetwork: Pick<IKeyNetwork, 'findCluster'>;
	partitionDetector: Pick<PartitionDetector, 'detectPartition'>;
	pushBlock: BoundBlockPusher;
	emit: BlockDurabilitySink;
	/** The `/optimystic/<networkName>` prefix; a connected peer counts as pushable only once identify
	 *  reports it serving this network's block-transfer protocol. Default: none (any connected peer). */
	protocolPrefix?: string;
	/** The node's network-membership gate (`createNetworkMembershipGate`): a connected peer it refuses
	 *  is never pushable, whatever its protocol list says. Absent → no check. */
	membership?: NetworkMembershipGate;
}

/** What one pass did. Counts are per ledger ENTRY (one per block). */
export interface DrainPassResult {
	trigger: DrainTrigger;
	/** Set when the pass did no work at all, and why. */
	skipped?: 'partition' | 'no-pushable-peer';
	/** Entries in the ledger when the pass began. */
	entries: number;
	/** Entries examined this pass, up to the block budget. */
	examined: number;
	/** Entries the budget left for a later pass. */
	deferred: number;
	/** Entries whose cohort resolves to this node alone: nothing owed, nothing counted. */
	solo: number;
	/** Entries owing a copy to nobody currently pushable (not connected, not yet identified, or
	 *  abandoned) — or whose cohort could not be resolved this pass. */
	waiting: number;
	/** Entries pushed to at least one peer. */
	pushed: number;
	/** Entries whose last shortfall cleared — one full-replication event fired for each. */
	cleared: number;
	/** Entries deleted because the block is gone from local storage. */
	dropped: number;
	/** Peers newly abandoned for a block this pass. */
	abandoned: number;
}

/** The per-entry outcomes the block drain counts, in the order `pass:done` prints them. */
const BLOCK_DRAIN_TALLIES = ['solo', 'waiting', 'pushed', 'cleared', 'dropped'] as const;
type BlockDrainTally = typeof BLOCK_DRAIN_TALLIES[number];
type BlockDrainContext = DrainEntryContext<BlockDrainTally>;

function toPassResult(report: DrainPassReport<BlockDrainTally>): DrainPassResult {
	const { trigger, skipped, entries, examined, deferred, abandoned, tallies } = report;
	const result: DrainPassResult = { trigger, entries, examined, deferred, ...tallies, abandoned };
	if (skipped !== undefined) result.skipped = skipped === 'no-eligible-peer' ? 'no-pushable-peer' : skipped;
	return result;
}

/**
 * Sends the copies the under-replication ledger says this node still owes, and says when a block
 * finally has all of them.
 *
 * `CoordinatorRepo.commit` writes an entry per block it acknowledged below full replication, naming
 * the cohort members that had not confirmed it (or an EMPTY set when no cohort could be named — an
 * `unrouted` write, or a `local` one that knew of no other member). This service is the other half:
 * on start, whenever a peer connects or is identified, and on a re-check timer while anything is
 * outstanding, it walks the ledger and pushes each block to the owed peers that are reachable right
 * now. A peer that confirms is removed from the entry; when the entry empties it is deleted and ONE
 * {@link BlockDurabilityReachedEvent} fires through the sink — after the deletion, never before.
 *
 * When a pass runs, which peers are reachable, the per-pass budget and the give-up rule are
 * {@link DrainScheduler}'s, shared with the blob copy drain; this class supplies the ledger as the
 * entry source and the push for one entry.
 *
 * What it deliberately does not do:
 * - **Dial the world.** A copy goes only to a peer that is connected and identified as serving this
 *   network. An entry whose owed peers are all away simply waits; the next arrival wakes the drain.
 * - **Re-resolve a NAMED peer.** A `majority` entry names members that were in the cohort when the
 *   write was acknowledged, and a `local` entry the members the node knew belonged in it; a copy there
 *   is never harmful even if the cohort has since moved on.
 * - **Count an attempt against a node that is alone.** An entry with no named members whose cohort
 *   still resolves to this node alone is left exactly as it is: nobody is owed anything yet.
 * - **Delete an entry to tidy up.** Only a confirmed copy (or the block leaving local storage) removes
 *   one. A peer that never returns leaves its entry in place; the ledger's size cap is the backstop.
 * - **Coordinate with the rebalance growth arm or spread-on-churn.** All three may push the same
 *   block to the same peer; the receiver is idempotent, so the overlap costs duplicate work only.
 *
 * NOTE: a pass that finds work SCANS the ledger (`IUnderReplicationLedger.list`, one store read per
 * entry) and examines up to `blockBudget` entries, oldest first. Bounded by the node's owned-block
 * count today. If a node ever holds so many under-replicated blocks that the scan shows up — a long
 * solo run with a persistent store — index the ledger by missing peer instead of scanning, and
 * consider draining newest-first so a host's most recent pending writes settle before old ones.
 */
export class UnderReplicationDrain implements Startable {
	private readonly scheduler: DrainScheduler<UnderReplicatedEntry, BlockDrainTally>;

	constructor(
		private readonly deps: UnderReplicationDrainDeps,
		config: Partial<UnderReplicationDrainConfig> = {}
	) {
		const { blockBudget, ...schedule } = { ...DEFAULT_UNDER_REPLICATION_DRAIN_CONFIG, ...config };
		// The ledger and the partition detector are read through `deps` on every pass, so a member the
		// owner replaces after construction is the one the next pass uses.
		this.scheduler = new DrainScheduler<UnderReplicatedEntry, BlockDrainTally>({
			libp2p: deps.libp2p,
			partitionDetector: { detectPartition: () => this.deps.partitionDetector.detectPartition() },
			membership: deps.membership,
			...(deps.protocolPrefix === undefined ? {} : { protocol: buildBlockTransferProtocol(deps.protocolPrefix) }),
			source: {
				list: () => this.deps.ledger.list(),
				size: () => this.deps.ledger.size(),
				keyOf: entry => entry.blockId
			},
			drainEntry: (entry, context) => this.drainEntry(entry, context),
			tallies: BLOCK_DRAIN_TALLIES,
			entryLabel: 'block',
			log
		}, { ...schedule, entryBudget: blockBudget });
	}

	// ── Startable ────────────────────────────────────────────────────

	/** Starts listening, and runs one pass off the start path: the entries the ledger carried across
	 *  a restart, the one case no in-memory mechanism ever covered. */
	async start(): Promise<void> {
		await this.scheduler.start();
	}

	async stop(): Promise<void> {
		await this.scheduler.stop();
	}

	// ── Public API ───────────────────────────────────────────────────

	/** Run one pass now, bypassing the debounce and the interval throttle. Waits for an in-flight pass first. */
	async checkNow(): Promise<DrainPassResult> {
		return toPassResult(await this.scheduler.checkNow());
	}

	/** Observability: given-up (block, peer) pairs, whether a timer is armed, and the last pass. */
	getDiagnostics(): { abandonedPairs: number; timerArmed: boolean; lastPassAt: number } {
		return this.scheduler.getDiagnostics();
	}

	// ── One entry ────────────────────────────────────────────────────

	private async drainEntry(entry: UnderReplicatedEntry, context: BlockDrainContext): Promise<void> {
		const owed = await resolveOwedPeers(entry, this.deps.libp2p.peerId.toString(), this.deps.keyNetwork);
		if (owed.kind === 'solo') {
			context.tally('solo');
			return;
		}
		if (owed.kind === 'unresolved') {
			context.tally('waiting');
			return;
		}
		const reachable = this.pushablePeers(owed, context);
		if (reachable.length === 0) {
			context.tally('waiting');
			return;
		}

		const outcome = await this.deps.pushBlock(entry.blockId, reachable);
		if (outcome.status === 'no-local-data') {
			// A block this node no longer holds is not one it can owe — the same call spread-on-churn
			// makes when a tracked block has left local storage.
			log('entry:dropped block=%s rev=%d (no local data)', entry.blockId, entry.rev);
			await this.deps.ledger.delete(entry.blockId);
			context.forgetEntry();
			context.tally('dropped');
			return;
		}
		if (outcome.status === 'unavailable') {
			// Could not find out what this node holds — not "holds nothing". Keep the entry, count nothing.
			log('entry:unavailable block=%s rev=%d reason=%s (keeping)', entry.blockId, entry.rev, outcome.reason);
			context.tally('waiting');
			return;
		}
		context.tally('pushed');
		const heldRev = outcome.latest?.rev ?? entry.rev;
		for (const peerId of outcome.confirmed) {
			log('push:ok block=%s peer=%s rev=%d', entry.blockId, peerId, heldRev);
			context.noteSuccess(peerId);
		}

		if (outcome.confirmed.length > 0) {
			const status = await this.recordConfirmed(entry, owed, outcome.confirmed, heldRev, outcome.collectionId);
			if (status === 'cleared') {
				context.tally('cleared');
				context.forgetEntry();
				return;
			}
			if (status === 'absent') {
				// Removed while the copy was in flight — by a `full` commit, whose coordinator fired the
				// event when it removed the entry (firing here too would announce the block twice), or by
				// the ledger's size cap, which owes no event: the block was never confirmed held.
				context.forgetEntry();
				return;
			}
		}
		if (outcome.refusals.length > 0) {
			await this.deps.ledger.noteAttempt(entry.blockId);
			this.noteRefusals(entry, outcome, context);
		}
	}

	/**
	 * The owed peers a push can land on now: those the scheduler finds connected, admitted by the
	 * membership gate and identified as serving this network's block-transfer protocol, less those
	 * abandoned for this block.
	 *
	 * NOTE: an entry NAMING a peer the gate has since refused waits for it, so that block's
	 * full-replication event does not fire while the peer stays refused — the drain has no notion of a
	 * named member leaving the cohort, refused or otherwise. The same holds for a named member that has
	 * since been rebuilt as a client (`NodeOptions.servesBlocks: false`) under the same peer id: once its
	 * identify replaces the old protocol list it names no `block-transfer`, so it is never pushable and
	 * the entry waits for it, never settling. If a removed
	 * member's entries are seen never clearing, drop refused and non-serving peers from the named set
	 * (and settle an entry left empty by that).
	 */
	private pushablePeers(owed: Owed & { kind: 'peers' }, context: BlockDrainContext): string[] {
		return context.reachable(owed.peerIds);
	}

	/**
	 * Take the confirmed peers off the entry, and fire the event when that cleared it — the rule an
	 * embedder's report follows too (`takeConfirmedCopies`). An entry settled mid-push by a `full`
	 * commit comes back `absent`, not `cleared`: the commit that settled it announced it.
	 */
	private async recordConfirmed(
		entry: UnderReplicatedEntry, owed: Owed & { kind: 'peers' }, confirmed: string[], heldRev: number,
		collectionId: CollectionId | undefined
	): Promise<SatisfyOutcome['status']> {
		const status = await takeConfirmedCopies(this.deps, entry, owed, confirmed, heldRev, collectionId);
		if (status === 'cleared') {
			log('entry:cleared block=%s rev=%d action=%s', entry.blockId, entry.rev, entry.actionId);
		} else if (status === 'absent') {
			log('entry:settled-elsewhere block=%s rev=%d action=%s', entry.blockId, entry.rev, entry.actionId);
		}
		return status;
	}

	/** Log each refusal so "cannot place" reads differently from "cannot reach", and count the round. */
	private noteRefusals(entry: UnderReplicatedEntry, outcome: PushBlockOutcome & { status: 'pushed' }, context: BlockDrainContext): void {
		for (const refusal of outcome.refusals) {
			if (refusal.reason === 'rejected') {
				// Uncertified means this node retained no proof for the revision: the receiver's
				// default policy refuses it, and no retry changes that until the block is rewritten.
				log('push:rejected block=%s peer=%s rev=%d certified=%s%s', entry.blockId, refusal.peerId, entry.rev,
					outcome.certified, outcome.certified ? '' : ' (no retained proof — cannot place)');
			} else {
				log('push:unreachable block=%s peer=%s err=%s', entry.blockId, refusal.peerId, refusal.error);
			}
			context.noteFailure(refusal.peerId);
		}
	}
}
