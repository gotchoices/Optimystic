/**
 * The sending half of `announce` (docs/blobs.md §Placement, copying and durability, *Copying*):
 * `NodeBlobService.announce` makes this node owe the blob to its cohort, and this drain announces it
 * to each owed member until every member that accepts blobs holds it.
 *
 * Imports here are pure or type-only apart from the scheduler, the ledger's sibling classifier and
 * the serial queue: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import type { Startable } from '@libp2p/interface';
import {
	routingKeyForBlob,
	type BlobDurability,
	type BlobRef,
	type BlobScope,
	type IKeyNetwork,
	type RoutingKey,
} from '@optimystic/db-core';
import type { PartitionDetector } from '../cluster/partition-detector.js';
import { KeyedSerialQueue } from '../keyed-serial-queue.js';
import { createLogger } from '../logger.js';
import type { NetworkMembershipGate } from '../network-membership-gate.js';
import {
	DrainScheduler,
	type DrainEntryContext,
	type DrainLibp2p,
	type DrainPassReport,
	type DrainSchedulerConfig,
} from '../repo/drain-scheduler.js';
import type { BlobAcceptance } from './accepts-blobs.js';
import type { BlobHoldPolicy } from './announce-receiver.js';
import { classifyBlobDurability, type BlobCohortView } from './blob-durability.js';
import type { BlobAnnounceAnswer } from './blob-protocol.js';
import type { BlobOwedRecords } from './local-blob-service.js';
import type { OwedBlobEntry, OwedBlobLedger } from './owed-blob-ledger.js';

const log = createLogger('blob:copy');

/** The per-entry outcomes one pass counts, in the order `pass:done` prints them. */
export type BlobCopyTally = 'unrouted' | 'solo' | 'waiting' | 'announced' | 'full' | 'gone';

/** Exactly {@link DrainSchedulerConfig}: the copy drain adds no knob of its own. */
export type BlobCopyDrainConfig = DrainSchedulerConfig;

/** The block drain's defaults, unchanged — the two drains wake and give up on the same schedule. */
export const DEFAULT_BLOB_COPY_DRAIN_CONFIG: BlobCopyDrainConfig = {
	debounceMs: 5000,
	minIntervalMs: 15_000,
	recheckIntervalMs: 30_000,
	entryBudget: 64,
	maxAttempts: 5,
};

/**
 * The announce primitive, already bound to this node's blob protocol client and its peer-id parsing
 * — the node binds `BlobProtocolClient.announce`; a unit test binds a double. A peer id that does
 * not parse, a peer known not to run the blob protocol (`BlobPeerRefusesError`) and a stalled or
 * reset stream all reach the drain as a rejection, which it counts as one unconfirmed round.
 */
export type BoundBlobAnnouncer = (peerId: string, ref: BlobRef, scope: BlobScope) => Promise<BlobAnnounceAnswer>;

export interface BlobCopyDrainDeps {
	libp2p: DrainLibp2p;
	selfId: string;
	/** This node's own `NodeOptions.blobs.hold`: an `on-demand` node never counts itself as accepting. */
	hold: BlobHoldPolicy;
	keyNetwork: Pick<IKeyNetwork, 'findCluster' | 'absentCohortMembers'>;
	partitionDetector: Pick<PartitionDetector, 'detectPartition'>;
	membership?: NetworkMembershipGate;
	/** `buildBlobProtocol(prefix)`: a peer is eligible for a pass only once its peer record lists it. */
	blobProtocol: string;
	ledger: OwedBlobLedger;
	records: BlobOwedRecords;
	announce: BoundBlobAnnouncer;
	/** `blobAcceptanceOf(keyNetwork, blobProtocol, peerIds)`, bound by the node. */
	acceptance: (peerIds: readonly string[]) => Promise<Record<string, BlobAcceptance>>;
	/** A peer was confirmed to hold `ref` (answered `whole`, or sent `held`). The cohort reaction feeds this to its monitor. */
	onHolderConfirmed?: (ref: BlobRef, peerId: string) => void;
}

const UNRESOLVED_COHORT: BlobCohortView = { resolved: false, accepting: [] };

/**
 * Announces each blob this node owes to the cohort members that still owe a copy, and reports how
 * widely the blob is held as that changes.
 *
 * `NodeBlobService.announce` takes the `owed` hold and records the entry (`OwedBlobLedger`); this
 * service is the other half. On start, whenever a peer connects or is identified, and on a re-check
 * timer while anything is owed, it walks the ledger and announces each blob to the owed members that
 * are reachable right now. A member that answers `whole`, or that later sends `held`, goes onto the
 * entry as a holder; each change of the blob's durability class or holder count is one
 * `onDurability` event, and reaching `full` deletes the entry and releases the `owed` hold, so the
 * writer stops holding the blob on the others' behalf.
 *
 * When a pass runs, which peers it may send to, the per-pass budget and the give-up rule are
 * {@link DrainScheduler}'s, shared with the block drain (`UnderReplicationDrain` in
 * `packages/db-p2p/src/repo/under-replication-drain.ts`); this class supplies the ledger as the
 * entry source and the announcement for one entry.
 *
 * What it deliberately does not do:
 * - **Dial the world.** An announcement goes only to a peer connected now and identified as running
 *   the blob protocol. An entry whose owed members are all away waits; the next arrival wakes it.
 * - **Keep a list of missing members.** The entry stores the confirmed holders, so the owed set is
 *   derived from the cohort on every pass and the entry follows the cohort by construction.
 * - **Count this node against a member that refuses blobs.** A member whose peer record says it does
 *   not run the blob protocol, and one that answered `declined`, are neither announced to nor
 *   counted, so a group where nobody else takes blobs stays `local` rather than never reaching it.
 * - **Fan out.** One pass is at most one round trip per owed member, in turn — see `announceTo`.
 */
export class BlobCopyDrain implements Startable {
	private readonly scheduler: DrainScheduler<OwedBlobEntry, BlobCopyTally>;
	/**
	 * Peers that answered `declined` since they last connected. Per peer, not per blob: a node
	 * declines because of its own `blobs.hold`, so one answer settles every blob. Cleared when the
	 * peer's only connection opens, which is also when the scheduler retries an abandoned peer.
	 *
	 * NOTE: one string per peer that ever declined, and a peer that never reconnects is never
	 * forgotten — unlike the scheduler's abandonment, which `forgetDisconnected` prunes each pass.
	 * Bounded by the distinct peers this node has met, which is the order of its other per-peer state;
	 * if a long-lived node in a large network ever shows this set growing, cap it with eviction as
	 * `AnnounceLimiter` caps its windows (`BLOB_ANNOUNCE_PEERS_TRACKED`).
	 */
	private readonly declining = new Set<string>();
	/** One durability transition at a time per ref — see {@link settleRef}. */
	private readonly transitions = new KeyedSerialQueue();

	constructor(
		private readonly deps: BlobCopyDrainDeps,
		config: Partial<BlobCopyDrainConfig> = {}
	) {
		this.scheduler = new DrainScheduler<OwedBlobEntry, BlobCopyTally>({
			libp2p: deps.libp2p,
			partitionDetector: { detectPartition: () => this.deps.partitionDetector.detectPartition() },
			membership: deps.membership,
			protocol: deps.blobProtocol,
			source: {
				list: () => this.deps.ledger.list(),
				size: () => this.deps.ledger.size(),
				keyOf: entry => entry.ref,
			},
			drainEntry: (entry, context) => this.drainEntry(entry, context),
			tallies: ['unrouted', 'solo', 'waiting', 'announced', 'full', 'gone'],
			entryLabel: 'blob',
			log,
			onPeerReturned: peerId => { this.declining.delete(peerId); },
		}, { ...DEFAULT_BLOB_COPY_DRAIN_CONFIG, ...config });
	}

	// ── Startable ────────────────────────────────────────────────────

	/** Starts listening, and runs one pass off the start path: the entries the ledger carried across a restart. */
	async start(): Promise<void> {
		await this.scheduler.start();
	}

	async stop(): Promise<void> {
		await this.scheduler.stop();
	}

	// ── Public API ───────────────────────────────────────────────────

	/** Run one pass now, bypassing the debounce and the interval throttle. Waits for an in-flight pass first. */
	async checkNow(): Promise<DrainPassReport<BlobCopyTally>> {
		return this.scheduler.checkNow();
	}

	/**
	 * Record the owed entry for a just-announced blob, report its first durability, and wake the drain.
	 * Resolves once the entry is durable and that first event has fired; it never waits for a copy.
	 */
	async owe(ref: BlobRef, scope: BlobScope): Promise<void> {
		await this.deps.ledger.record(ref, scope);
		// Before the wake, so a caller that awaits `announce` and then listens has not missed the event.
		await this.settle(ref);
		this.scheduler.wake();
	}

	/** A `held` from `peerId` (the caller has already checked membership): add the holder and settle. */
	async noteHeld(peerId: string, ref: BlobRef): Promise<void> {
		const entry = await this.deps.ledger.addHolders(ref, [peerId]);
		if (entry === undefined) {
			// A blob whose entry is gone is not owed: it reached `full`, or its reference was reclaimed.
			log('held:not-owed peer=%s ref=%s', peerId, ref);
			return;
		}
		this.deps.onHolderConfirmed?.(ref, peerId);
		await this.settle(ref);
	}

	/** Recompute `ref`'s durability from the cohort now; persist and emit when it changed, and finish it at `full`. */
	async settle(ref: BlobRef): Promise<BlobDurability | undefined> {
		return this.settleRef(ref, await this.cohortView(ref));
	}

	/** Whether `peerId` answered `declined` since it last connected. */
	isDeclining(peerId: string): boolean {
		return this.declining.has(peerId);
	}

	/** Remember `peerId` as declining until its next connection. */
	noteDeclined(peerId: string): void {
		this.declining.add(peerId);
	}

	/** Observability: given-up (blob, peer) pairs, peers remembered as declining, whether a timer is armed, and the last pass. */
	getDiagnostics(): { abandonedPairs: number; declining: number; timerArmed: boolean; lastPassAt: number } {
		return { ...this.scheduler.getDiagnostics(), declining: this.declining.size };
	}

	// ── The cohort view ──────────────────────────────────────────────

	/**
	 * Who is responsible for `ref` and which of them accept blobs.
	 *
	 * Absent members count as owed, exactly as a block write counts them (`absentCohortMembers`): a
	 * member that is offline still owes a copy. They are classified like any other member — they are
	 * serving peers outside FRET's band, which the peer-record cache knows — so a `refuses` among them
	 * is still dropped.
	 *
	 * Any of the three lookups failing leaves the view UNRESOLVED rather than short of members. A view
	 * short of members could read `full` while a member that has not got the blob is simply unnamed,
	 * which would release the writer's hold; an unresolved view reaches `unrouted`, which releases
	 * nothing and is retried on the next pass.
	 */
	private async cohortView(ref: BlobRef): Promise<BlobCohortView> {
		const key = routingKeyForBlob(ref);
		let members: readonly string[];
		try {
			members = await this.cohortMembers(key);
		} catch (error) {
			log('cohort:unresolved ref=%s err=%s', ref, describe(error));
			return UNRESOLVED_COHORT;
		}
		if (members.length === 0) {
			log('cohort:unresolved ref=%s err=%s', ref, 'the cohort named nobody');
			return UNRESOLVED_COHORT;
		}
		const others = members.filter(peerId => peerId !== this.deps.selfId);
		let acceptance: Record<string, BlobAcceptance>;
		try {
			acceptance = others.length === 0 ? {} : await this.deps.acceptance(others);
		} catch (error) {
			log('cohort:unresolved ref=%s err=%s', ref, describe(error));
			return UNRESOLVED_COHORT;
		}
		return { resolved: true, accepting: members.filter(peerId => this.accepts(peerId, acceptance)) };
	}

	private async cohortMembers(key: RoutingKey): Promise<readonly string[]> {
		const cohort = Object.keys(await this.deps.keyNetwork.findCluster(key));
		const absent = (await this.deps.keyNetwork.absentCohortMembers?.(key)) ?? [];
		return [...new Set([...cohort, ...absent])];
	}

	/**
	 * Whether a cohort member is owed a copy and counted toward durability. An `unknown` acceptance
	 * counts: an unidentified member is owed until it is known not to take blobs, which errs toward
	 * keeping the writer's copy. An `on-demand` node takes nothing it is merely responsible for, so it
	 * does not count itself.
	 */
	private accepts(peerId: string, acceptance: Record<string, BlobAcceptance>): boolean {
		if (peerId === this.deps.selfId) {
			return this.deps.hold === 'eager';
		}
		return acceptance[peerId] !== 'refuses' && !this.declining.has(peerId);
	}

	// ── One entry ────────────────────────────────────────────────────

	private async drainEntry(entry: OwedBlobEntry, context: DrainEntryContext<BlobCopyTally>): Promise<void> {
		const view = await this.cohortView(entry.ref);
		const durability = await this.settleRef(entry.ref, view);
		if (!view.resolved) {
			context.tally('unrouted');
			return;
		}
		if (durability === undefined) {
			// The entry left the ledger while this pass ran — a concurrent `full`, or a reclaim.
			log('entry:vanished ref=%s', entry.ref);
			context.forgetEntry();
			context.tally('gone');
			return;
		}
		if (durability.quorum === 'full') {
			// `settleRef` has already deleted the entry and released the hold.
			context.forgetEntry();
			context.tally('full');
			return;
		}
		const others = view.accepting.filter(peerId => peerId !== this.deps.selfId);
		if (others.length === 0) {
			// Nobody else accepts blobs: nothing is owed, and nothing is counted against anyone.
			context.tally('solo');
			return;
		}
		const held = new Set(entry.holders);
		const reachable = context.reachable(others.filter(peerId => !held.has(peerId)));
		if (reachable.length === 0) {
			context.tally('waiting');
			return;
		}
		const confirmed = await this.announceTo(reachable, entry, context);
		context.tally('announced');
		if (confirmed.length === 0) {
			return;
		}
		await this.deps.ledger.addHolders(entry.ref, confirmed);
		// Against the same view, so the pass's own announcements are counted over the cohort it read.
		if ((await this.settleRef(entry.ref, view))?.quorum === 'full') {
			context.forgetEntry();
			context.tally('full');
		}
	}

	/**
	 * Announce `entry` to each peer in turn, and return those that answered `whole`.
	 *
	 * Sequential, not parallel: the receiver's `AnnounceLimiter` bounds announcements per peer per
	 * minute and its reference read holds one of four read slots, so a pass that fanned out would
	 * mostly queue behind that. A pass therefore costs at most one round trip per owed member, bounded
	 * by the cluster size. No per-announce timer is added: both ends already abort a blob stream that
	 * moves no bytes for one response timeout (`client:stalled`), which is the budget
	 * `BlobProtocolClient.announce` runs under.
	 */
	private async announceTo(
		peerIds: readonly string[], entry: OwedBlobEntry, context: DrainEntryContext<BlobCopyTally>
	): Promise<string[]> {
		const confirmed: string[] = [];
		for (const peerId of peerIds) {
			let answer: BlobAnnounceAnswer;
			try {
				answer = await this.deps.announce(peerId, entry.ref, entry.scope);
			} catch (error) {
				log('announce:unreachable ref=%s peer=%s err=%s', entry.ref, peerId, describe(error));
				context.noteFailure(peerId);
				continue;
			}
			log('announce:answer ref=%s peer=%s answer=%s', entry.ref, peerId, answer);
			if (this.noteAnswer(peerId, entry.ref, answer)) {
				confirmed.push(peerId);
			}
			// `not-responsible` and `unreferenced` are both "ask again": the first means the two
			// machines' views of the cohort differ for now, the second that the peer has not seen the
			// commit or could not read it. Counted under the give-up rule so a peer that always says so
			// is dropped for this blob until it reconnects.
			if (answer === 'not-responsible' || answer === 'unreferenced') {
				context.noteFailure(peerId);
			} else {
				context.noteSuccess(peerId);
			}
		}
		return confirmed;
	}

	/** Act on one answer; true when `peerId` is now a confirmed holder. */
	private noteAnswer(peerId: string, ref: BlobRef, answer: BlobAnnounceAnswer): boolean {
		if (answer === 'whole') {
			this.deps.onHolderConfirmed?.(ref, peerId);
			return true;
		}
		if (answer === 'declined') {
			this.noteDeclined(peerId);
		}
		// NOTE: a peer that answered `fetching` is re-announced every pass until its `held` arrives, one
		// small request per pass; if a stuck pull ever makes that show up, stop announcing to a peer that
		// answered `fetching` within the last n passes.
		return false;
	}

	// ── The one durability transition ────────────────────────────────

	/**
	 * Classify `ref` from `view`, persist and emit the class on a change, and finish the blob at `full`.
	 * `undefined` when there is no entry: a blob that is not owed is neither written nor emitted, which
	 * is also what makes a `held` for an already-finished blob a no-op.
	 *
	 * Every path that can change a blob's durability comes through here, serialized per ref: without a
	 * single point, a `settle` driven by an incoming `held` and a pass classifying at the same time can
	 * both decide the class changed and emit the same value twice.
	 *
	 * NOTE: the "changed" test reads the class back off the blob's record, and `setDurability` never
	 * creates a record — so a blob whose record went while its entry stayed would read as changed on
	 * every pass and emit the same class each time. The `owed` hold is what stops that pairing from
	 * arising (a held record is not swept), and the entry is deleted the moment the class is `full`, so
	 * there is no loop; if a store fault or a future reclaim pass ever does leave an entry without a
	 * record, remember the last emitted class in memory beside the record rather than only on it.
	 */
	private settleRef(ref: BlobRef, view: BlobCohortView): Promise<BlobDurability | undefined> {
		return this.transitions.run(ref, async () => {
			const entry = await this.deps.ledger.get(ref);
			if (entry === undefined) {
				return undefined;
			}
			const holders = new Set(entry.holders);
			if (await this.deps.records.holdsWhole(ref)) {
				holders.add(this.deps.selfId);
			}
			const next = classifyBlobDurability(view, holders, this.deps.selfId);
			const changed = !sameDurability(await this.deps.records.durabilityOf(ref), next);
			if (changed) {
				await this.deps.records.setDurability(ref, next);
				log('durability:changed ref=%s quorum=%s confirmed=%d/%d', ref, next.quorum, next.confirmed, next.accepting);
			}
			if (next.quorum === 'full') {
				await this.finish(ref);
			}
			if (changed) {
				this.deps.records.emitDurability({ ref, durability: next });
			}
			return next;
		});
	}

	/**
	 * The blob's cohort holds it: the record's `full` durability is written (above), the entry is
	 * deleted, and only then is the `owed` hold released. A crash between the two leaves at worst an
	 * `owed` hold with no entry, which keeps the bytes — the safe direction, and the reclaiming pass
	 * (`feat-unreferenced-blobs-are-reclaimed`) covers an orphaned hold as it covers an orphaned entry.
	 *
	 * Releasing the hold may delete the record outright when `owed` was its last hold, taking the
	 * just-written durability with it. That is the intended end state — the writer stops holding the
	 * blob on the others' behalf — and is why `stat` on such a blob afterwards reports `unknown` with
	 * no durability.
	 */
	private async finish(ref: BlobRef): Promise<void> {
		await this.deps.ledger.delete(ref);
		await this.deps.records.releaseOwed(ref);
		log('entry:full ref=%s', ref);
	}
}

/**
 * Whether two classifications say the same thing. `unconfirmed` is derived from the same inputs as
 * `confirmed` and `accepting`, so it never differs alone, and comparing it would make every change of
 * WHICH member is missing an event of its own.
 */
function sameDurability(stored: BlobDurability | undefined, next: BlobDurability): boolean {
	return stored !== undefined
		&& stored.quorum === next.quorum
		&& stored.confirmed === next.confirmed
		&& stored.accepting === next.accepting;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
