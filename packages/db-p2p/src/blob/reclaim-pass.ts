/**
 * The reference pass of docs/blobs.md §Lifetime: periodically, and on demand, this node reads every
 * registered reference tree for the blobs it holds under `responsible` or owes, and releases a hold
 * only for a blob that two counting passes at least a grace period apart (7 days by default) found
 * listed nowhere. Releasing the last hold leaves the blob's pieces to the piece sweep.
 *
 * **This is the only code in the repository that deletes replicated data on a schedule.** Every rule
 * here errs toward keeping: a wrong release deletes a file a committed row still names, on each
 * holder independently, with nothing left to repair from. So the conditions under which a pass does
 * NOT count are a named, pure function ({@link whyPassDoesNotCount}) rather than scattered `if`s, and
 * every write a pass makes is conditional on the record or entry as it is at that moment.
 *
 * Cache eviction is `BlobCacheBudget` in `packages/db-p2p/src/blob/cache-budget.ts` and is a separate
 * mechanism; the two share the `blob:reclaim` log namespace.
 */

import { BlobReferenceTree, BlobScopeRegistry, type BlobRef, type BlobScope, type ITransactor } from '@optimystic/db-core';
import type { PartitionDetector } from '../cluster/partition-detector.js';
import type { Logger } from '../logger.js';
import type { CohortAloneness } from '../network/cohort-reachability.js';
import { armUnrefTimer } from '../unref-timer.js';
import { ConfirmationRecordingTransactor } from './confirmation-recording-transactor.js';
import type { BlobOwedRecords, BlobReclaimRecords } from './local-blob-service.js';
import type { OwedBlobLedger } from './owed-blob-ledger.js';
import { judgeMark, resolveReclaimGraceMs } from './reclaim-marks.js';

/**
 * Four passes a day. Bounds a release to between the grace period and the grace period plus six
 * hours after the first counting pass, at four full reads of every registered reference tree a day
 * on a node holding blobs; one hour would be 24.
 */
export const DEFAULT_RECLAIM_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Long enough for a starting node to have dialed its bootstrap peers and identified its cohort,
 * although the confirmation rule already keeps a cold node's passes from counting.
 */
export const DEFAULT_RECLAIM_FIRST_PASS_DELAY_MS = 5 * 60 * 1000;

/** Why a pass does not count toward reclaiming. Declaration order is the order they are reported in. */
export type ReclaimNotCountedReason =
	/** `detectPartition()` was true at the start or the end of the pass. */
	| 'partition'
	/** `BlobScopeRegistry.enumerate` threw. */
	| 'registry-threw'
	/** `BlobScopeRegistry.enumerate` answered `certain: false`. */
	| 'registry-uncertain'
	/** The registry read as authoritatively absent while this node holds a `responsible` blob or owes one. */
	| 'registry-absent'
	/** Some `BlobReferenceTree.listed` threw. */
	| 'tree-threw'
	/** Some `BlobReferenceTree.listed` answered `certain: false`. */
	| 'tree-uncertain'
	/** Some block answer was not `cohortConfirmed` and `aloneFor` over those blocks was false. */
	| 'unconfirmed-not-alone'
	/** The pass was stopped before it applied anything. */
	| 'stopped';

/** What one pass established about its own trustworthiness, as {@link whyPassDoesNotCount} reads it. */
export interface ReclaimEvidence {
	readonly partitionAtStart: boolean;
	readonly partitionAtEnd: boolean;
	readonly registry: 'threw' | { readonly certain: boolean; readonly exists: boolean };
	/** Whether this node holds any `responsible` blob or owes one; an absent registry only disqualifies such a node. */
	readonly holdsAny: boolean;
	readonly trees: readonly { readonly scope: BlobScope; readonly outcome: 'threw' | 'certain' | 'uncertain' }[];
	readonly unconfirmedBlocks: number;
	/** `aloneFor` over the unconfirmed blocks; `undefined` when there were none. */
	readonly aloneForUnconfirmed: boolean | undefined;
	readonly stopped: boolean;
}

/**
 * Every reason this pass does not count toward reclaiming; empty when it counts. In the declaration
 * order of {@link ReclaimNotCountedReason}, so the log line and the report are stable.
 *
 * Pure, and separate from the pass, which is what makes docs/blobs.md §Lifetime's disqualifying
 * conditions enumerable and testable without a network.
 */
export function whyPassDoesNotCount(evidence: ReclaimEvidence): ReclaimNotCountedReason[] {
	const reasons: ReclaimNotCountedReason[] = [];
	if (evidence.partitionAtStart || evidence.partitionAtEnd) {
		reasons.push('partition');
	}
	if (evidence.registry === 'threw') {
		reasons.push('registry-threw');
	} else {
		if (!evidence.registry.certain) {
			reasons.push('registry-uncertain');
		}
		// An existing registry with no scopes COUNTS: every reference tree was unregistered, so every
		// blob really is unreferenced there. An absent one does not, on a node holding blobs — the
		// registry existed when those holds were taken, so its absence is a read this node cannot trust.
		if (!evidence.registry.exists && evidence.holdsAny) {
			reasons.push('registry-absent');
		}
	}
	if (evidence.trees.some(tree => tree.outcome === 'threw')) {
		reasons.push('tree-threw');
	}
	if (evidence.trees.some(tree => tree.outcome === 'uncertain')) {
		reasons.push('tree-uncertain');
	}
	// `undefined` is "no block answer needed vouching", which disqualifies nothing.
	if (evidence.aloneForUnconfirmed === false) {
		reasons.push('unconfirmed-not-alone');
	}
	if (evidence.stopped) {
		reasons.push('stopped');
	}
	return reasons;
}

export interface BlobReclaimDeps {
	/** This node's blob records; `LocalBlobService`. `releaseOwed` comes from `BlobOwedRecords`. */
	readonly records: BlobReclaimRecords & Pick<BlobOwedRecords, 'releaseOwed'>;
	readonly owed: Pick<OwedBlobLedger, 'list' | 'clearUnlisted' | 'markUnlisted' | 'deleteIfUnlisted'>;
	/** The node's committed-state reader (`createNodeNetworkTransactor`); wrapped per pass, never written through. */
	readonly transactor: ITransactor;
	readonly cohort: CohortAloneness;
	readonly partitionDetector: Pick<PartitionDetector, 'detectPartition'>;
	readonly log: Logger;
}

export interface BlobReclaimOptions {
	/** Default `DEFAULT_RECLAIM_GRACE_MS` (7 days); `resolveReclaimGraceMs` refuses a value below `MIN_RECLAIM_GRACE_MS` or not finite. */
	graceMs?: number;
	/** Default {@link DEFAULT_RECLAIM_INTERVAL_MS}. */
	intervalMs?: number;
	/** Default {@link DEFAULT_RECLAIM_FIRST_PASS_DELAY_MS}. */
	firstPassDelayMs?: number;
	/** Default `Date.now`; tests inject a clock. */
	now?: () => number;
}

/** What one pass read and did. */
export interface ReclaimPassReport {
	readonly startedAt: number;
	/** Set when the pass read nothing: nothing held, or it was stopped before it began. */
	readonly skipped?: 'nothing-held' | 'stopped';
	/**
	 * Whether this pass counts toward reclaiming. Meaningful only for a pass that read: a skipped
	 * pass reports `false` with nothing in {@link notCounted} for `'nothing-held'` (there was nothing
	 * to decide) and `['stopped']` for `'stopped'`.
	 */
	readonly counted: boolean;
	readonly notCounted: readonly ReclaimNotCountedReason[];
	/** Registered scopes the registry listed. */
	readonly scopes: number;
	/** Trees actually read — a scope with no reference left to ask about is skipped. */
	readonly treesRead: number;
	readonly responsibleChecked: number;
	readonly owedChecked: number;
	/** Responsible references some tree listed. */
	readonly listed: number;
	readonly newlyMarked: number;
	readonly cleared: number;
	/** `responsible` holds released. */
	readonly released: number;
	readonly owedReleased: number;
	readonly unconfirmedBlocks: number;
}

/** The on-demand entry, which is all the node attaches. */
export interface BlobReclaimOnDemand {
	runNow(): Promise<ReclaimPassReport>;
}

/** The counters of a pass that read nothing. */
const NOTHING_READ = {
	scopes: 0,
	treesRead: 0,
	responsibleChecked: 0,
	owedChecked: 0,
	listed: 0,
	newlyMarked: 0,
	cleared: 0,
	released: 0,
	owedReleased: 0,
	unconfirmedBlocks: 0,
} as const;

/** One tree read's outcome, as the evidence records it. */
type TreeOutcome = { readonly scope: BlobScope; readonly outcome: 'threw' | 'certain' | 'uncertain' };

/** What the registry read established: the evidence shape, plus the scopes when they may be acted on. */
type RegistryRead = { readonly evidence: ReclaimEvidence['registry']; readonly scopes: readonly BlobScope[] };

/** How much was marked, cleared and released, which the report carries and the sweep decision reads. */
type AppliedCounts = { readonly newlyMarked: number; readonly cleared: number; readonly released: number; readonly owedReleased: number };

const APPLIED_NOTHING: AppliedCounts = { newlyMarked: 0, cleared: 0, released: 0, owedReleased: 0 };

// NOTE: `awaitConsult` makes each expired-window block a blocking consult, and the trees are read
// one after another. If pass time shows up, read trees concurrently with a small bound.
// NOTE: `aloneFor` makes one `findCluster` per distinct unconfirmed block, which on a node that IS
// alone is every block of every tree it read — nothing confirms there, by construction. Local
// lookups, once per pass; if they show up, have the gate answer for a set of routing keys with the
// cluster lookups memoized.
/**
 * Releases the `responsible` and `owed` holds of blobs committed state no longer lists
 * (docs/blobs.md §Lifetime). One pass runs at a time; `runNow` joins the pass in flight.
 */
export class BlobReclaimPass implements BlobReclaimOnDemand {
	private readonly graceMs: number;
	private readonly intervalMs: number;
	private readonly firstPassDelayMs: number;
	private readonly now: () => number;
	/** The pass in flight, absent while none runs. */
	private running: Promise<ReclaimPassReport> | undefined;
	/** Whether {@link start} armed the schedule; a `runNow` on an unstarted pass arms no timer. */
	private scheduled = false;
	private cancelTimer: (() => void) | undefined;
	private stopped = false;

	constructor(private readonly deps: BlobReclaimDeps, options?: BlobReclaimOptions) {
		this.graceMs = resolveReclaimGraceMs(options?.graceMs);
		this.intervalMs = options?.intervalMs ?? DEFAULT_RECLAIM_INTERVAL_MS;
		this.firstPassDelayMs = options?.firstPassDelayMs ?? DEFAULT_RECLAIM_FIRST_PASS_DELAY_MS;
		this.now = options?.now ?? Date.now;
	}

	/** Arm the first pass after `firstPassDelayMs`; each later pass `intervalMs` after the previous one ENDS. */
	start(): void {
		if (this.stopped || this.scheduled) {
			return;
		}
		this.scheduled = true;
		this.arm(this.firstPassDelayMs);
	}

	/**
	 * Run a pass now, or join the one running. Rejects after {@link stop}.
	 *
	 * Joining is right here, unlike `BlobCacheBudget`'s single-flight-with-a-follow-on: a pass's
	 * verdict is about committed state, which the joiner has not changed.
	 */
	runNow(): Promise<ReclaimPassReport> {
		if (this.stopped) {
			return Promise.reject(new Error('the blob reclaim pass has stopped'));
		}
		return this.run();
	}

	/** Clear the timer, mark stopped — a running pass then applies nothing further — and wait for it. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		await this.running?.then(noop, noop);
	}

	private arm(delayMs: number): void {
		if (this.stopped) {
			return;
		}
		this.cancelTimer = armUnrefTimer(() => {
			this.cancelTimer = undefined;
			// A pass that threw already logged `reclaim:pass-failed`; the timer is re-armed either way.
			void this.run().catch(noop);
		}, delayMs);
	}

	/**
	 * The pass in flight, or a new one. Each pass re-arms the timer `intervalMs` after it ENDS, so
	 * passes never overlap and a long pass delays the next rather than stacking.
	 */
	private run(): Promise<ReclaimPassReport> {
		if (this.running !== undefined) {
			return this.running;
		}
		const pass = this.runPass()
			.catch((error: unknown) => {
				this.deps.log('reclaim:pass-failed - %e', error);
				throw error;
			})
			.finally(() => {
				if (this.running === pass) {
					this.running = undefined;
				}
				if (this.scheduled) {
					this.arm(this.intervalMs);
				}
			});
		this.running = pass;
		return pass;
	}

	private async runPass(): Promise<ReclaimPassReport> {
		const startedAt = this.now();
		if (this.stopped) {
			return { startedAt, skipped: 'stopped', counted: false, notCounted: ['stopped'], ...NOTHING_READ };
		}

		// The work this pass decides about, snapshotted before any read. Every write below is
		// conditional on what the snapshot saw, so a hold taken or released mid-pass changes nothing.
		const responsible = await this.deps.records.responsibleMarks();
		const owedEntries = await this.deps.owed.list();
		if (responsible.length === 0 && owedEntries.length === 0) {
			return { startedAt, skipped: 'nothing-held', counted: false, notCounted: [], ...NOTHING_READ };
		}
		// One of the two snapshots is non-empty, or the line above returned.
		const holdsAny = true;

		const partitionAtStart = this.deps.partitionDetector.detectPartition();
		const recorder = new ConfirmationRecordingTransactor(this.deps.transactor);
		const responsibleRefs = new Set(responsible.map(mark => mark.ref));
		const owedByScope = owedRefsByScope(owedEntries);

		/** Responsible references some tree listed, so their marks are cleared whatever else happened. */
		const listedResponsible = new Set<BlobRef>();
		/** Owed references their OWN scope listed; a listing elsewhere does not keep an owed entry. */
		const listedOwed = new Set<BlobRef>();
		const trees: TreeOutcome[] = [];

		// A partition reads nothing: the pass cannot count, so reading would only cost round trips.
		// Trees are likewise read only behind a registry this pass can act on. Nothing is then marked or
		// cleared, which is safe BECAUSE a pass that skipped its tree reads can never count: a mark left
		// standing through such a pass is cleared by the next pass that does read the trees, and only a
		// counting pass releases.
		const registry: RegistryRead = partitionAtStart
			? { evidence: { certain: true, exists: true }, scopes: [] }
			: await this.readRegistry(recorder);

		let treesRead = 0;
		for (const scope of registry.scopes) {
			if (this.stopped) {
				break;
			}
			// The references still worth asking about: every responsible one no earlier tree listed,
			// together with the owed ones whose entry names THIS scope.
			const refs = new Set<BlobRef>();
			for (const ref of responsibleRefs) {
				if (!listedResponsible.has(ref)) refs.add(ref);
			}
			for (const ref of owedByScope.get(scope) ?? []) {
				refs.add(ref);
			}
			if (refs.size === 0) {
				continue;
			}
			treesRead++;
			try {
				const listing = await BlobReferenceTree.listed(recorder, scope, refs);
				trees.push({ scope, outcome: listing.certain ? 'certain' : 'uncertain' });
				if (!listing.certain) {
					this.deps.log('reclaim:tree-uncertain scope=%s', scope);
				}
				for (const ref of listing.listed) {
					if (responsibleRefs.has(ref)) listedResponsible.add(ref);
					if (owedByScope.get(scope)?.has(ref) === true) listedOwed.add(ref);
				}
			} catch (error) {
				// Recorded and logged, and the next tree is still read: references other trees list must
				// still have their marks cleared.
				trees.push({ scope, outcome: 'threw' });
				this.deps.log('reclaim:tree-threw scope=%s - %e', scope, error);
			}
		}

		// Asked over exactly the blocks nobody vouched for, after the last read. An answer from another
		// machine that lacked the marker — an older build, or a coordinator that itself asked nobody —
		// makes this false anyway, since that machine is in the cohort.
		const unconfirmedBlocks = recorder.unconfirmed.size;
		let aloneForUnconfirmed: boolean | undefined;
		if (unconfirmedBlocks > 0) {
			aloneForUnconfirmed = await this.deps.cohort.aloneFor([...recorder.unconfirmed]);
			if (!aloneForUnconfirmed) {
				this.deps.log('reclaim:not-alone unconfirmedBlocks=%d', unconfirmedBlocks);
			}
		}

		const partitionAtEnd = this.deps.partitionDetector.detectPartition();
		const notCounted = whyPassDoesNotCount({
			partitionAtStart,
			partitionAtEnd,
			registry: registry.evidence,
			holdsAny,
			trees,
			unconfirmedBlocks,
			aloneForUnconfirmed,
			stopped: this.stopped,
		});
		const counted = notCounted.length === 0;

		const applied = this.stopped
			? APPLIED_NOTHING
			: await this.apply({ startedAt, counted, responsible, owedEntries, listedResponsible, listedOwed });

		if (applied.released + applied.owedReleased > 0) {
			await this.deps.records.sweep();
		}

		const report: ReclaimPassReport = {
			startedAt,
			counted,
			notCounted,
			scopes: registry.scopes.length,
			treesRead,
			responsibleChecked: responsible.length,
			owedChecked: owedEntries.length,
			listed: listedResponsible.size,
			unconfirmedBlocks,
			...applied,
		};
		this.logPass(report);
		return report;
	}

	/**
	 * The registry's evidence, and its scopes when the pass may act on them. A read that threw, was
	 * uncertain, or found no registry at all yields no scopes, so nothing further is read; each of the
	 * three is logged, since the report alone does not say which answer the registry gave.
	 */
	private async readRegistry(recorder: ConfirmationRecordingTransactor): Promise<RegistryRead> {
		try {
			const listing = await BlobScopeRegistry.enumerate(recorder);
			if (!listing.certain) {
				this.deps.log('reclaim:registry-unusable reason=uncertain');
			} else if (!listing.exists) {
				this.deps.log('reclaim:registry-unusable reason=absent');
			} else {
				return { evidence: { certain: true, exists: true }, scopes: listing.scopes };
			}
			return { evidence: { certain: listing.certain, exists: listing.exists }, scopes: [] };
		} catch (error) {
			this.deps.log('reclaim:registry-unusable reason=threw - %e', error);
			return { evidence: 'threw', scopes: [] };
		}
	}

	/**
	 * One record or entry at a time, each write conditional on the record or entry as it is at that
	 * moment — which is the whole safety argument against holds that change while a pass reads. An
	 * announcement that took a `responsible` hold mid-pass cleared the mark, so the snapshot's mark no
	 * longer matches and nothing is released; a hold released and re-taken by the cohort reaction is
	 * the same. A pin is never read or changed: a pinned blob that loses `responsible` or `owed` keeps
	 * its record and its pieces.
	 */
	private async apply(pass: {
		readonly startedAt: number;
		readonly counted: boolean;
		readonly responsible: readonly { readonly ref: BlobRef; readonly unreferencedSince?: number }[];
		readonly owedEntries: readonly { readonly ref: BlobRef; readonly scope: BlobScope; readonly unlistedSince?: number }[];
		readonly listedResponsible: ReadonlySet<BlobRef>;
		readonly listedOwed: ReadonlySet<BlobRef>;
	}): Promise<AppliedCounts> {
		let newlyMarked = 0;
		let cleared = 0;
		let released = 0;
		let owedReleased = 0;

		for (const mark of pass.responsible) {
			// A listing is evidence of a reference whether or not the read was certain, and clearing only
			// delays reclaiming, so the mark is dropped on a pass that does not count too.
			if (pass.listedResponsible.has(mark.ref)) {
				if (mark.unreferencedSince !== undefined) {
					await this.deps.records.clearUnreferenced(mark.ref);
					cleared++;
				}
				continue;
			}
			if (!pass.counted) {
				continue;
			}
			const decision = judgeMark(mark.unreferencedSince, pass.startedAt, this.graceMs);
			if (decision === 'mark') {
				if (await this.deps.records.markUnreferenced(mark.ref, pass.startedAt)) newlyMarked++;
			} else if (decision === 'release') {
				// `judgeMark` answers `'release'` only for a mark at or before `startedAt`, so there is one.
				const since = mark.unreferencedSince!;
				if (await this.deps.records.releaseResponsibleIfMarked(mark.ref, since)) {
					released++;
					this.deps.log('reclaim:released ref=%s hold=responsible since=%d', mark.ref, since);
				}
			}
		}

		// NOTE: an owed entry is kept only by its OWN scope listing the blob, which is what docs/blobs.md
		// §Lifetime specifies, while a receiver accepts a pull on ANY listing scope (`OwedBlobEntry.scope`).
		// The two agree for every path that goes through `announce`, since that re-records the entry under
		// the new scope and clears its mark. They part company if a reference moves from one table to
		// another by the hand of a DIFFERENT writer: this node's entry still names the old scope, so after
		// the grace period it drops the entry and its `owed` hold even though a committed row still names
		// the blob. Harmless while the cohort got its copies — which is what the drain spent the grace
		// period doing — and that is the only thing standing between it and a lost blob. If a blob is ever
		// seen lost this way, keep an owed entry that ANY registered tree lists, and say so in §Lifetime.
		for (const entry of pass.owedEntries) {
			if (pass.listedOwed.has(entry.ref)) {
				if (entry.unlistedSince !== undefined) {
					await this.deps.owed.clearUnlisted(entry.ref);
					cleared++;
				}
				continue;
			}
			if (!pass.counted) {
				continue;
			}
			const decision = judgeMark(entry.unlistedSince, pass.startedAt, this.graceMs);
			if (decision === 'mark') {
				if (await this.deps.owed.markUnlisted(entry.ref, pass.startedAt)) newlyMarked++;
			} else if (decision === 'release') {
				const since = entry.unlistedSince!;
				// Entry first, hold second.
				// NOTE: a crash between the entry delete and the hold release leaves an `owed` hold with no
				// entry, which keeps the blob for ever — storage leaked, nothing lost, and the safe
				// direction. If orphaned `owed` holds are ever seen, release an `owed` hold with no entry on
				// the next pass.
				if (await this.deps.owed.deleteIfUnlisted(entry.ref, since)) {
					await this.deps.records.releaseOwed(entry.ref);
					owedReleased++;
					this.deps.log('reclaim:released ref=%s hold=owed scope=%s since=%d', entry.ref, entry.scope, since);
				}
			}
		}

		return { newlyMarked, cleared, released, owedReleased };
	}

	/** One line per pass, skipped ones included. */
	private logPass(report: ReclaimPassReport): void {
		this.deps.log(
			'reclaim:pass startedAt=%d%s counted=%s notCounted=%s scopes=%d treesRead=%d responsible=%d owed=%d listed=%d marked=%d cleared=%d released=%d owedReleased=%d unconfirmedBlocks=%d ms=%d',
			report.startedAt,
			report.skipped === undefined ? '' : ` skipped=${report.skipped}`,
			report.counted,
			report.notCounted.length === 0 ? 'none' : report.notCounted.join(','),
			report.scopes,
			report.treesRead,
			report.responsibleChecked,
			report.owedChecked,
			report.listed,
			report.newlyMarked,
			report.cleared,
			report.released,
			report.owedReleased,
			report.unconfirmedBlocks,
			this.now() - report.startedAt,
		);
	}
}

/** The owed references of each scope, so a tree read asks only about the entries that name it. */
function owedRefsByScope(entries: readonly { readonly ref: BlobRef; readonly scope: BlobScope }[]): Map<BlobScope, Set<BlobRef>> {
	const byScope = new Map<BlobScope, Set<BlobRef>>();
	for (const entry of entries) {
		let refs = byScope.get(entry.scope);
		if (refs === undefined) {
			refs = new Set<BlobRef>();
			byScope.set(entry.scope, refs);
		}
		refs.add(entry.ref);
	}
	return byScope;
}

function noop(): void {
	// Waiting for a pass to end, not for what it found.
}
