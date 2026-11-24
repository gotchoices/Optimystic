/**
 * The decision half of docs/blobs.md §Placement, copying and durability, *When the cohort changes*:
 * "A member that joins a held blob's cohort is announced to. A node that leaves a blob's cohort drops
 * its `responsible` hold only after confirming that enough current members hold the blob."
 *
 * This is the blob counterpart of `BlockTransferCoordinator.handleRebalanceEvent`
 * (`packages/db-p2p/src/cluster/block-transfer.ts`): the same event in, the same shape of feedback
 * out, a different primitive — an announcement instead of a push, and a `stat` instead of a push
 * response. It touches no wiring: running a `RebalanceMonitor` over the blobs this node holds and
 * acting on what `handleRebalanceEvent` returns is the factory's.
 *
 * Imports here are type-only or pure: this module is reachable from the react-native entry
 * (`src/rn.ts`).
 */

import type { BlobRef, BlobScope } from '@optimystic/db-core';
import type { PartitionDetector } from '../cluster/partition-detector.js';
import type { GrowthOutcome, RebalanceEvent } from '../cluster/rebalance-monitor.js';
import { createLogger } from '../logger.js';
import { admittedBy, type NetworkMembershipGate } from '../network-membership-gate.js';
import { MAX_BLOB_STAT_REFS } from '../protocol-limits.js';
import type { BlobAcceptance } from './accepts-blobs.js';
import type { BlobCopyDrain, BoundBlobAnnouncer } from './blob-copy-drain.js';
import type { BlobAnnounceAnswer, BlobLocalHolding } from './blob-protocol.js';
import type { BlobResponsibleRecords } from './local-blob-service.js';
import type { OwedBlobLedger } from './owed-blob-ledger.js';

/**
 * The blob monitor runs under this namespace too (`RebalanceMonitorDeps.logName` documents
 * `'blob:copy'` for the blob instance), so one filter shows a blob's whole copy story.
 */
const log = createLogger('blob:copy');

/** How many references each arm works on at once, and how many peers the release arm stats at once. */
const REACTION_CONCURRENCY = 4;

/**
 * The announce answers that leave a newly co-responsible peer owed nothing more. `fetching` counts
 * because the receiver has already taken a durable `responsible` hold and resumes its pull after a
 * restart (`BlobAnnounceReceiver.resume`); its `held`, when it comes, reaches the monitor as holder
 * evidence through the drain's `onHolderConfirmed`. `declined` counts because a node that declines
 * will never hold the blob, so counting it owed would keep this node's hold for ever.
 *
 * `out-of-space` is deliberately NOT here, and the asymmetry with `declined` is the whole reason:
 * `declined` is a permanent fact about a CONFIGURATION, while being full is a CONDITION that clears.
 * A satisfied peer enters `RebalanceMonitor`'s seen set, which only a departure from the cohort
 * clears — so counting a full peer satisfied would mean never offering it that blob again. It is
 * treated as an unreachable peer instead: unsatisfied, so the growth outcome is incomplete and the
 * monitor retries it (bounded by `growthMaxAttempts`), and remembered nowhere per peer, since a
 * memory of "full" would need a clock to expire it and the passes are already the retry.
 *
 * The RELEASE arm reads none of this and must not: an out-of-space candidate stays in both the
 * numerator and the denominator of the release count, its `stat` does not answer `whole`, and so the
 * reference is retained. Dropping it from the count (the `satisfiedWithoutRequest` treatment) would
 * LOWER the number of holders a release needs and let this node drop a hold because its neighbours
 * are full.
 */
const SATISFYING_ANSWERS: readonly BlobAnnounceAnswer[] = ['whole', 'fetching', 'declined'];

export interface BlobCohortReactionDeps {
	selfId: string;
	membership?: NetworkMembershipGate;
	partitionDetector: Pick<PartitionDetector, 'detectPartition'>;
	/** The record door. `responsibleScope` is both the "does this node still hold it responsible" test and the scope to announce under. */
	records: Pick<BlobResponsibleRecords, 'responsibleScope'>;
	/** The writer's owed entry, for the scope of a grown reference this node owes rather than holds responsible. */
	owed: Pick<OwedBlobLedger, 'get'>;
	/** `blobAcceptanceOf(keyNetwork, blobProtocol, peerIds)`, bound by the node — the same closure `BlobCopyDrain` takes. */
	acceptance: (peerIds: readonly string[]) => Promise<Record<string, BlobAcceptance>>;
	/** The drain's per-peer `declined` memory. Absent when the copy drain is switched off, and then nothing declines. */
	declining?: Pick<BlobCopyDrain, 'isDeclining' | 'noteDeclined'>;
	/** `BlobProtocolClient.announce` bound to this node, as the drain takes it. */
	announce: BoundBlobAnnouncer;
	/** `BlobProtocolClient.stat` bound to this node: one request per peer, answers positional on `refs`. */
	stat: (peerId: string, refs: readonly BlobRef[]) => Promise<readonly BlobLocalHolding[]>;
}

export interface BlobReactionResult {
	/** Lost references whose release was confirmed; the caller drops the `responsible` hold. */
	released: BlobRef[];
	/** Lost references not yet confirmed; the caller calls `RebalanceMonitor.retainLost`. */
	retained: BlobRef[];
	/** Per grown reference, keyed by the reference. No entry for one the reaction learned nothing about. */
	growth: Map<string, GrowthOutcome>;
}

/** One lost reference this node still holds `responsible`, with the owners its release is counted over. */
interface ReleasePlan {
	readonly ref: BlobRef;
	readonly scope: BlobScope;
	/** New owners that could hold the blob — the satisfiable-without-a-request peers already dropped. */
	readonly candidates: readonly string[];
	/** How many of `candidates` must answer `whole` before the hold may go. */
	readonly required: number;
}

/**
 * Turns one {@link RebalanceEvent} over this node's held blobs into "announce to these peers", "this
 * hold can go", "this hold must stay".
 *
 * `event.gained` is not acted on, as for blocks: a tracked reference is one this node already holds.
 *
 * {@link releaseLost} is a second, narrower entry point: the release arm on its own, over references
 * named by something other than a cohort change — today, a ring narrowing (see its own comment).
 *
 * The two arms run concurrently, each handling at most {@link REACTION_CONCURRENCY} references at a
 * time, and within one reference the announcements go in turn. Cohorts overlap, so that still leaves
 * up to {@link REACTION_CONCURRENCY} announcements in flight to one peer rather than one — the point
 * of taking them in turn per reference is the reason `BlobCopyDrain.announceTo` documents, that the
 * receiver's reference read holds one of four read slots (`BLOB_REFERENCE_READS_IN_FLIGHT`), so a full
 * fan-out would mostly queue behind that. A small constant beats both one at a time, which would make
 * a wide event take a round trip per (reference, peer) pair, and unbounded, which would open a stream
 * per pair at once.
 */
export class BlobCohortReaction {
	constructor(private readonly deps: BlobCohortReactionDeps) { }

	async handleRebalanceEvent(event: RebalanceEvent): Promise<BlobReactionResult> {
		// Re-checked here even though the monitor suppresses its own checks during a partition: the
		// event may have been emitted just before the flag went up.
		if (this.deps.partitionDetector.detectPartition()) {
			log('reaction:partition lost=%d grown=%d', event.lost.length, event.grown.size);
			const growth = new Map<string, GrowthOutcome>();
			for (const [ref, peers] of event.grown) {
				// An incomplete outcome with nothing satisfied counts an attempt in the monitor AND keeps
				// every reported peer un-seen, so the next check retries it, as `replicateGrown` does.
				if (peers.length > 0) growth.set(ref, { satisfiedPeers: [], complete: false });
			}
			// Retaining a lost reference this node does not hold `responsible` costs nothing: the monitor
			// re-reports it and the release arm then skips it.
			return { released: [], retained: [...event.lost] as BlobRef[], growth };
		}

		const acceptance = await this.acceptanceOfPeers(this.namedPeers(event.grown, event.newOwners));
		const [release, growth] = await Promise.all([
			// Every id the blob monitor tracks came from a blob record, so it is a canonical reference.
			this.releaseLost(event.lost as BlobRef[], event.newOwners, event.floor, acceptance),
			this.announceGrown(event.grown, peerId => this.satisfiedWithoutRequest(peerId, acceptance)),
		]);
		return { released: release.released, retained: release.retained, growth };
	}

	/** Every peer the given reference→peers maps name, self excluded: the set one classification covers. */
	private namedPeers(...named: ReadonlyArray<ReadonlyMap<string, readonly string[]>>): Set<string> {
		const peers = new Set<string>();
		for (const map of named) {
			for (const listed of map.values()) {
				for (const peerId of listed) {
					if (peerId !== this.deps.selfId) peers.add(peerId);
				}
			}
		}
		return peers;
	}

	/**
	 * Which of these peers accept blobs, classified in ONE call — not one call per reference, which
	 * would be one peer-store sweep per reference per check. A rejection is read as `unknown` for every
	 * peer, which counts as accepting: a member not known to refuse blobs is owed one until it is, which
	 * errs toward keeping this node's copy.
	 */
	private async acceptanceOfPeers(peers: ReadonlySet<string>): Promise<Record<string, BlobAcceptance>> {
		if (peers.size === 0) return {};
		try {
			return await this.deps.acceptance([...peers]);
		} catch (error) {
			log('acceptance:failed err=%s', describe(error));
			return {};
		}
	}

	/**
	 * Whether `peerId` is owed nothing without a request being made: it will never hold the blob, so
	 * announcing to it would be wasted and counting it owed would keep this node's hold for ever.
	 *
	 * NOTE: all three tests can be transient — `declining` is forgotten at the peer's next connection,
	 * and a `refuses` may only be an unfinished identify (backlog
	 * `debt-a-peer-read-as-refusing-may-only-be-unidentified`) — while the GROWTH arm's report of such
	 * a peer is not: a satisfied peer enters `RebalanceMonitor`'s seen set, which only a departure from
	 * the cohort clears. So a peer that declined some OTHER blob is recorded as holding this one and is
	 * never announced to again for it. Left as it is because the alternative converges on the same end
	 * state: reporting it unsatisfied makes the outcome incomplete, and `growthMaxAttempts` incomplete
	 * outcomes later the monitor abandons the peer for that reference, cleared by the same departure
	 * and nothing else. If transient refusals ever turn out to be common, the fix is in the monitor,
	 * not here — a third `GrowthOutcome` state for "unsatisfiable now, ask again" that does not enter
	 * the seen set. The RELEASE arm is unaffected: it drops such a peer from the numerator and the
	 * denominator alike, which can only make a release harder to reach, never wrongly reached.
	 */
	private satisfiedWithoutRequest(peerId: string, acceptance: Record<string, BlobAcceptance>): boolean {
		return !admittedBy(this.deps.membership, peerId)
			|| acceptance[peerId] === 'refuses'
			|| (this.deps.declining?.isDeclining(peerId) ?? false);
	}

	// ── `grown` — a member joined a held blob's cohort ────────────────

	private async announceGrown(
		grown: ReadonlyMap<string, string[]>,
		satisfiable: (peerId: string) => boolean
	): Promise<Map<string, GrowthOutcome>> {
		const growth = new Map<string, GrowthOutcome>();
		// The monitor never reports an empty list; one that appears is skipped rather than reported
		// complete, so it cannot be mistaken for growth that was satisfied.
		const entries = [...grown.entries()].filter(([, peers]) => peers.length > 0);
		await inParallel(entries, REACTION_CONCURRENCY, async ([ref, peers]) => {
			const outcome = await this.growOne(ref as BlobRef, peers, satisfiable);
			if (outcome !== undefined) growth.set(ref, outcome);
		});
		return growth;
	}

	/** `undefined` when the reaction learned nothing about `ref` — see {@link BlobReactionResult.growth}. */
	private async growOne(
		ref: BlobRef,
		peers: readonly string[],
		satisfiable: (peerId: string) => boolean
	): Promise<GrowthOutcome | undefined> {
		const reported = new Set(peers);
		const scope = await this.scopeOf(ref);
		if (scope === undefined) {
			// The holds changed since the check read them: this node no longer keeps the blob for the
			// network, so there is nothing to announce under and nothing was learned about these peers. No
			// outcome at all is the honest report, and the one `RebalanceMonitor.recordGrowthOutcome`
			// documents for a reference the reaction had no information about. Reporting them satisfied
			// instead would enter them in the monitor's seen set — peers CONFIRMED to hold a replica, which
			// only a departure from the cohort clears — and so silence the growth arm for a reference that
			// may be held again (a reader repair's `keepAfterRead`, say) while they hold nothing. Nothing
			// re-checks for ever either way: a reference with neither hold leaves the tracked set with it.
			log('grow:no-scope ref=%s', ref);
			return undefined;
		}
		const satisfiedPeers: string[] = [];
		for (const peerId of reported) {
			if (satisfiable(peerId)) {
				satisfiedPeers.push(peerId);
				continue;
			}
			let answer: BlobAnnounceAnswer;
			try {
				answer = await this.deps.announce(peerId, ref, scope);
			} catch (error) {
				log('grow:unreachable ref=%s peer=%s err=%s', ref, peerId, describe(error));
				continue;
			}
			log('grow:answer ref=%s peer=%s answer=%s', ref, peerId, answer);
			if (answer === 'declined') this.deps.declining?.noteDeclined(peerId);
			if (SATISFYING_ANSWERS.includes(answer)) satisfiedPeers.push(peerId);
		}
		// An incomplete outcome counts an attempt in the monitor, so a failing announcement is
		// re-detected on the next check and abandoned after `growthMaxAttempts` until the peer leaves the
		// cohort and rejoins. That is why a reported peer is never reported satisfied on a guess.
		return { satisfiedPeers, complete: satisfiedPeers.length === reported.size };
	}

	/**
	 * What to announce `ref` under: its `responsible` hold's scope, else the owed entry's — the
	 * reference this node wrote and owes rather than holds responsible. `undefined` when it has
	 * neither.
	 *
	 * NOTE: `responsibleScope` throws `BlobRecordFormatError` on a record that does not decode, which
	 * fails this whole reaction rather than skipping the one reference — unlike `durabilityOf` and
	 * `holdsWhole`, which read through `readableRecord` and tolerate it. The monitor re-reports, so one
	 * such record would fail every check for as long as it is there; if a malformed record is ever
	 * observed in the field, give the reaction a tolerant read rather than catching per call site.
	 */
	private async scopeOf(ref: BlobRef): Promise<BlobScope | undefined> {
		return (await this.deps.records.responsibleScope(ref)) ?? (await this.deps.owed.get(ref))?.scope;
	}

	// ── `lost` — this node should stop keeping a blob for the network ─

	/**
	 * The release arm, over any set of references this node should stop keeping: each one's
	 * `responsible` hold may go only once at least `floor` of the blob's current `owners` answer a
	 * `stat` with `whole`. Answers which holds may go and which must stay; the caller applies them
	 * (`LocalBlobService.releaseResponsible` for the first, `RebalanceMonitor.retainLost` for the
	 * second).
	 *
	 * Two paths reach this decision — the cohort change {@link handleRebalanceEvent} reacts to, and a
	 * ring narrowing that leaves a blob outside the slice this node serves (`shedNarrowedBlobs` in
	 * `packages/db-p2p/src/blob/ring-shed-pass.ts`) — so it is public rather than written twice. A
	 * second implementation of the rule that decides whether a copy may go is the last thing this
	 * should grow.
	 *
	 * `acceptance` lets a caller that has already classified `owners`' peers hand its map in rather
	 * than have them classified a second time; omitted, they are classified here.
	 */
	async releaseLost(
		refs: readonly BlobRef[],
		owners: ReadonlyMap<string, readonly string[]>,
		floor: number,
		acceptance?: Record<string, BlobAcceptance>
	): Promise<{ released: BlobRef[]; retained: BlobRef[] }> {
		if (this.deps.partitionDetector.detectPartition()) {
			// A count over the members this node can still see would drop a hold on the strength of a split
			// view. `handleRebalanceEvent` checks this too, since it has growth outcomes to report as well;
			// this is the check every OTHER caller of the release arm gets without making it.
			log('release:partition refs=%d', refs.length);
			return { released: [], retained: [...refs] };
		}
		const classified = acceptance ?? await this.acceptanceOfPeers(this.namedPeers(owners));
		const satisfiable = (peerId: string): boolean => this.satisfiedWithoutRequest(peerId, classified);
		const released: BlobRef[] = [];
		const retained: BlobRef[] = [];
		const plans: ReleasePlan[] = [];
		await inParallel(refs, REACTION_CONCURRENCY, async (ref) => {
			const scope = await this.deps.records.responsibleScope(ref);
			if (scope === undefined) {
				// Neither released nor retained and no outcome, so the monitor's state for this reference is
				// untouched: it is held only as `owed` (the owed drain follows the cohort on its own passes,
				// and the reference stays tracked through that hold), or its holds changed while the check ran.
				log('release:not-responsible ref=%s', ref);
				return;
			}
			const candidates = [...new Set(owners.get(ref) ?? [])].filter(peerId => !satisfiable(peerId));
			// The floor the block release uses, capped by the candidates that can actually hold the blob:
			// an on-demand or older member never will, and requiring it would keep the hold for ever even
			// when every member that can hold the blob does.
			const required = Math.min(Math.max(1, floor), candidates.length);
			if (required === 0) {
				// No new owner accepts blobs: nobody else would keep it.
				log('release:no-accepting-owner ref=%s', ref);
				retained.push(ref);
				return;
			}
			plans.push({ ref, scope, candidates, required });
		});

		const whole = await this.statCandidates(plans);

		await inParallel(plans, REACTION_CONCURRENCY, async (plan) => {
			const held = whole.get(plan.ref) ?? new Set<string>();
			// Announced to after the stat so a member that has not heard of the blob starts pulling now
			// rather than at its writer's next pass.
			for (const peerId of plan.candidates) {
				if (!held.has(peerId)) await this.announceForRelease(plan, peerId);
			}
			// Only the `stat` answers count: a peer that answers `whole` to the announcement just sent is
			// deliberately not counted this pass, so the decision is made over one snapshot of the cohort
			// rather than over a tally that shifts as the announcements go out. Nothing is lost by it — the
			// caller retains the reference, the monitor re-reports it, and the next check's `stat` sees it.
			if (held.size >= plan.required) {
				log('release:confirmed ref=%s whole=%d/%d', plan.ref, held.size, plan.required);
				released.push(plan.ref);
			} else {
				log('release:retained ref=%s whole=%d/%d', plan.ref, held.size, plan.required);
				retained.push(plan.ref);
			}
		});

		return { released, retained };
	}

	/**
	 * Which candidates hold each planned reference whole, asking each peer once about every reference it
	 * is a candidate for — inverted rather than one request per reference, and chunked because
	 * `event.lost` is not budget-capped the way `event.grown` is, so a node that sheds a wide range can
	 * report hundreds.
	 *
	 * A rejection, or an answer array of the wrong length (a protocol break), counts every reference in
	 * that chunk as not `whole`: those references are then retained and re-asked on the next check.
	 */
	private async statCandidates(plans: readonly ReleasePlan[]): Promise<Map<BlobRef, Set<string>>> {
		const whole = new Map<BlobRef, Set<string>>();
		const byPeer = new Map<string, BlobRef[]>();
		for (const plan of plans) {
			whole.set(plan.ref, new Set());
			for (const peerId of plan.candidates) {
				const asked = byPeer.get(peerId);
				if (asked === undefined) byPeer.set(peerId, [plan.ref]);
				else asked.push(plan.ref);
			}
		}
		await inParallel([...byPeer.entries()], REACTION_CONCURRENCY, async ([peerId, refs]) => {
			for (const chunk of chunksOf(refs, MAX_BLOB_STAT_REFS)) {
				let holdings: readonly BlobLocalHolding[];
				try {
					holdings = await this.deps.stat(peerId, chunk);
				} catch (error) {
					log('release:stat-failed peer=%s refs=%d err=%s', peerId, chunk.length, describe(error));
					continue;
				}
				if (holdings.length !== chunk.length) {
					log('release:stat-failed peer=%s refs=%d err=%s', peerId, chunk.length,
						`answered ${holdings.length} holdings for ${chunk.length} references`);
					continue;
				}
				chunk.forEach((ref, index) => {
					if (holdings[index] === 'whole') whole.get(ref)?.add(peerId);
				});
			}
		});
		return whole;
	}

	/** Announce one planned reference to one candidate; its answer does not count toward the release. */
	private async announceForRelease(plan: ReleasePlan, peerId: string): Promise<void> {
		let answer: BlobAnnounceAnswer;
		try {
			answer = await this.deps.announce(peerId, plan.ref, plan.scope);
		} catch (error) {
			log('release:unreachable ref=%s peer=%s err=%s', plan.ref, peerId, describe(error));
			return;
		}
		log('release:announced ref=%s peer=%s answer=%s', plan.ref, peerId, answer);
		if (answer === 'declined') this.deps.declining?.noteDeclined(peerId);
	}
}

/**
 * Run `task` over `items`, at most `limit` at a time, taking them in order. A rejection rejects the
 * whole run — every `task` above handles the failures a peer can cause, so a rejection here is a
 * local fault (an unreadable record, say), which the caller logs.
 */
async function inParallel<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers: Promise<void>[] = [];
	for (let worker = 0; worker < Math.min(limit, items.length); worker++) {
		workers.push((async () => {
			while (next < items.length) {
				await task(items[next++]!);
			}
		})());
	}
	await Promise.all(workers);
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let start = 0; start < items.length; start += size) {
		chunks.push(items.slice(start, start + size));
	}
	return chunks;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
