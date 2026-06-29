import type {
	ActionId, BlockId, CollectionId, Log,
	DisputeResolutionProof, RevertedBlock, ReadDependency,
} from '@optimystic/db-core';
import type { IBlockStorage } from '../storage/i-block-storage.js';
import { applyInvalidation, hashBlockContent, DELETED_BLOCK_RESTORE, type CertificateTarget } from './invalidation.js';
import { createLogger } from '../logger.js';

const log = createLogger('cascade');

// ─── Configuration ───

export type CascadeConfig = {
	/**
	 * Maximum number of re-evaluation rounds. Each round rescans the in-scope collections for fresh
	 * read-dependents of everything invalidated so far; a linear chain processed in revision order
	 * collapses into a single round, so this caps pathological out-of-order dependency graphs.
	 */
	readonly maxCascadeDepth: number;
	/** Maximum transactions the cascade may invalidate, counting the root. */
	readonly maxCascadeTransactions: number;
};

export const DEFAULT_CASCADE_CONFIG: CascadeConfig = {
	maxCascadeDepth: 32,
	maxCascadeTransactions: 1000,
};

// ─── Collection environment ───

/**
 * Everything the cascade needs from one collection: its append-only log (where child invalidation
 * entries land and where read-dependents are discovered) and a resolver for the per-block storage
 * its actions wrote. The caller supplies one per collection in the cascade's universe — the root's
 * collections plus every collection reachable via a cross-collection read edge. (Discovering that
 * universe requires a block→collection read index; the engine consumes the universe rather than
 * computing it — see the handoff's cross-collection note.)
 */
export type CollectionEnv = {
	readonly collectionId: CollectionId;
	readonly log: Log<unknown>;
	readonly createBlockStorage: (blockId: BlockId) => IBlockStorage;
	/**
	 * Optional per-block commit-latch runner threaded into each cascade child's {@link applyInvalidation}
	 * so the child's compensating write serializes against a concurrent commit on the same block — the
	 * same mutual-exclusion the root apply gets (see `InvalidationContext.withBlockCommitLatch`). Omitted
	 * → child writes run unlatched (today's behavior).
	 */
	readonly withBlockCommitLatch?: <T>(blockId: BlockId, fn: () => Promise<T>) => Promise<T>;
};

// ─── Invalidated (blockId, revision) pairs ───

/**
 * A block revision proven invalid: a committed action wrote `blockId` at `rev`, and that action has
 * been invalidated (the root, or a cascade child). Any committed transaction whose read set contains
 * `(blockId, rev)` observed this now-invalid revision and is a read-dependent.
 *
 * `restoredContentHash` is the content hash of the as-if-absent (reverted) value — the hash the
 * invalidation recorded. The default re-evaluator compares it against the content the dependent
 * actually observed: equal ⇒ the revert did not change what was read ⇒ retain.
 */
export type InvalidatedPair = {
	readonly blockId: BlockId;
	readonly rev: number;
	readonly restoredContentHash: string;
	/** The collection whose invalidation produced this pair (so same-collection rev ordering is checkable). */
	readonly collectionId: CollectionId;
	/** Resolves storage for this block, from its owning collection — the dependent may live elsewhere. */
	readonly createBlockStorage: (blockId: BlockId) => IBlockStorage;
};

function pairKey(blockId: BlockId, rev: number): string {
	return `${blockId}\0${rev}`;
}

/**
 * Dedup identity for a reverted log entry: the (collectionId, actionId) pair, not the actionId
 * alone. A transaction spanning N collections has one entry per collection (same actionId,
 * different collection/blockIds/rev) — each must be reverted independently, tracked separately.
 * Uses a NUL separator, mirroring {@link pairKey}, so ids containing spaces cannot collide.
 */
function entryKey(collectionId: CollectionId, actionId: ActionId): string {
	return `${collectionId}\0${actionId}`;
}

// ─── Re-evaluation ───

/** A candidate read-dependent under re-evaluation against post-invalidation state. */
export type CascadeCandidate = {
	readonly env: CollectionEnv;
	readonly collectionId: CollectionId;
	readonly actionId: ActionId;
	readonly rev: number;
	/** Blocks this action wrote (its entry's blockIds) — what gets reverted if it is invalidated. */
	readonly blockIds: ReadonlyArray<BlockId>;
	/** This action's persisted read set, or `undefined` for a legacy (pre-cascade) entry. */
	readonly reads: ReadonlyArray<ReadDependency> | undefined;
	/** The subset of `reads` intersecting an invalidated `(blockId, rev)`. Empty for a legacy candidate. */
	readonly matched: ReadonlyArray<InvalidatedPair>;
};

/**
 * Verdict for a candidate re-evaluated against the reverted state:
 *  - `retain`      — the read still holds; the transaction stands untouched (the re-evaluation prune).
 *  - `invalidate`  — the read no longer holds; revert this transaction and recurse into its dependents.
 *  - `unevaluable` — cannot decide from available data (e.g. a legacy entry with no persisted reads,
 *                    and no engine to re-execute). Escalated rather than guessed.
 */
export type CascadeVerdict = 'retain' | 'invalidate' | 'unevaluable';

/** Decides whether a candidate still holds against the reverted state. */
export type Reevaluate = (candidate: CascadeCandidate) => Promise<CascadeVerdict>;

/**
 * The default, engine-free re-evaluator: deterministic from stored revisions alone (no engine replay),
 * matching the compensating-state philosophy of the single-collection core.
 *
 * For each of the candidate's intersecting reads `(blockId, rev)`, it compares the content the
 * candidate *observed* (the immutable historical revision `blockId@rev`) against the `restoredContentHash`
 * the invalidation recorded (the as-if-absent value):
 *  - any read whose observed content differs from the restored content ⇒ the read no longer holds ⇒ **invalidate**;
 *  - a writer that *created* the block (deleted-block sentinel) ⇒ the observed content no longer exists ⇒ **invalidate**;
 *  - all intersecting reads unchanged ⇒ **retain** (e.g. a structural-block false dependent whose content the
 *    revert did not actually alter, or a redundant write that reverted to the same bytes).
 *  - a legacy entry (no persisted reads) ⇒ **unevaluable** (escalate, never guess independent).
 *
 * This is *sound but conservative* at block granularity: it never wrongly retains, but because reads are
 * block-granular it may invalidate a dependent that read an unchanged *field* of a changed block. That is
 * safe (over-invalidation just resubmits the transaction). Field/operation-granular pruning — re-executing
 * the transaction and checking its operations still reproduce — requires an engine and is provided by
 * injecting a custom {@link Reevaluate} instead (see the handoff).
 */
export function contentEqualityReevaluator(): Reevaluate {
	return async (candidate: CascadeCandidate): Promise<CascadeVerdict> => {
		if (candidate.reads === undefined) {
			return 'unevaluable';
		}
		// Defensive: a candidate with no intersecting reads is not actually a dependent.
		if (candidate.matched.length === 0) {
			return 'retain';
		}
		for (const pair of candidate.matched) {
			if (pair.restoredContentHash === DELETED_BLOCK_RESTORE) {
				return 'invalidate';
			}
			const observed = await pair.createBlockStorage(pair.blockId).getBlock(pair.rev);
			if (!observed) {
				// Cannot confirm the observed revision still materializes → conservative invalidate.
				return 'invalidate';
			}
			if (await hashBlockContent(observed.block) !== pair.restoredContentHash) {
				return 'invalidate';
			}
		}
		return 'retain';
	};
}

// ─── Cascade input / output ───

/** A `(blockId, rev)` the root invalidation proved invalid in a given collection, with its restored hash. */
export type CascadeSeed = {
	readonly collectionId: CollectionId;
	readonly blockId: BlockId;
	readonly rev: number;
	readonly restoredContentHash: string;
};

export type CascadeInput = {
	/** actionId of the root invalidation — recorded as `cascadeRoot` on every child entry. */
	readonly rootActionId: ActionId;
	/** The root's invalidation certificate; reused to authorize each child invalidation. */
	readonly proof: DisputeResolutionProof;
	/** The `(blockId, rev)` pairs the root reversal produced — seeds the dependency frontier. */
	readonly seed: ReadonlyArray<CascadeSeed>;
	/**
	 * The target the root proof's votes are bound to — `(rootActionId, root blockIds)`. Every child
	 * reuses the root proof, whose votes were signed over the *root's* targetHash, so each child's
	 * certificate verification must be against this target, not the child's own. Defaults to the root
	 * action id plus the distinct block ids across {@link seed} (the root's reverted blocks). Pass it
	 * explicitly when the seed is not a faithful 1:1 image of the root's commit blockIds.
	 */
	readonly certificateTarget?: CertificateTarget;
	/** Every collection the cascade may walk: the root's, plus any reachable via cross-collection reads. */
	readonly envs: ReadonlyArray<CollectionEnv>;
	readonly config?: CascadeConfig;
	/** Re-evaluation strategy; defaults to {@link contentEqualityReevaluator}. */
	readonly reevaluate?: Reevaluate;
	/**
	 * Operator-escalation health signal: invoked once when the cascade stops at a hard horizon (or hits
	 * an unevaluable candidate) and the affected collection(s) need a full re-sync. Never throws past here.
	 */
	readonly onEscalation?: (escalation: CascadeEscalation) => void;
};

export type CascadeChild = {
	readonly collectionId: CollectionId;
	readonly actionId: ActionId;
	readonly rev: number;
	readonly reverted: ReadonlyArray<RevertedBlock>;
};

export type CascadeStanding = {
	readonly collectionId: CollectionId;
	readonly actionId: ActionId;
	readonly rev: number;
};

export type CascadeEscalation = {
	readonly reason: 'max-depth' | 'max-transactions' | 'unevaluable';
	/** Collections to flag for operator-escalated full re-sync. */
	readonly collections: ReadonlyArray<CollectionId>;
	/** Read-dependents left un-cascaded at the horizon — surfaced, never silently dropped. */
	readonly remainder: ReadonlyArray<CascadeStanding>;
	/** Candidates that could not be re-evaluated (e.g. legacy entries with no engine to re-execute them). */
	readonly unevaluable: ReadonlyArray<CascadeStanding>;
};

export type CascadeResult = {
	readonly rootActionId: ActionId;
	/** Read-dependents invalidated by the cascade (children only — the root is the caller's to apply). */
	readonly invalidated: ReadonlyArray<CascadeChild>;
	/** Read-dependents re-evaluated and retained (appeared in the chain but did not actually depend). */
	readonly retained: ReadonlyArray<CascadeStanding>;
	/** Re-evaluation rounds run (dependency-graph depth proxy). */
	readonly rounds: number;
	/** Present iff the cascade stopped at a hard horizon or hit an unevaluable candidate. */
	readonly escalation?: CascadeEscalation;
};

// ─── Engine ───

/**
 * Detects and re-evaluates the transitive read-dependents of an already-applied root invalidation,
 * invalidating only those that no longer hold against the reverted state and leaving the rest in place.
 *
 * Preconditions: the caller has already applied the *root* reversal (driven through cluster consensus)
 * and supplies its proven-invalid `(blockId, rev)` pairs as `seed`. This engine owns only the *cascade*:
 * each child invalidation is appended via {@link applyInvalidation} carrying `cascadeRoot`, exactly the
 * deterministic primitive every member runs — so a member replaying the same seed + logs converges on
 * the same children (no per-child consensus round is required while the re-evaluator is deterministic;
 * a non-deterministic/engine-based re-evaluator would need each child driven through consensus instead).
 *
 * Algorithm (fixpoint):
 *  1. Seed the invalidated `(blockId, rev)` frontier from the root.
 *  2. Each round, walk every in-scope collection log forward, collecting unprocessed actions whose read
 *     set intersects the frontier (legacy reads-less entries are always candidates — unknown dependency).
 *  3. Process candidates in `(rev, collectionId, actionId)` order, deduped by actionId. Re-evaluate each
 *     against the reverted state; **retain** leaves it (revisited next round in case a later ancestor
 *     reverts), **invalidate** appends its child entry and feeds its reverted blocks back into the frontier.
 *  4. Repeat until a round makes no progress (fixpoint) or a horizon trips (escalate, applying what it did).
 *
 * Diamonds: a dependent of two invalidated ancestors is evaluated once (dedup), after both are reverted
 * (revision order within a collection; cross-collection retains are re-examined every round until fixpoint).
 * Cycle-freedom: a read observes a strictly earlier write, so within a collection a child's rev exceeds the
 * pair it depends on — a back-edge is corruption and throws.
 */
export async function cascadeInvalidate(input: CascadeInput): Promise<CascadeResult> {
	const config = input.config ?? DEFAULT_CASCADE_CONFIG;
	const reevaluate = input.reevaluate ?? contentEqualityReevaluator();
	const envByCollection = new Map(input.envs.map(e => [e.collectionId, e] as const));

	// Invalidated frontier, seeded from the root's reverted blocks.
	const pairs = new Map<string, InvalidatedPair>();
	for (const s of input.seed) {
		const env = envByCollection.get(s.collectionId);
		if (!env) {
			throw new Error(`cascade: seed references collection ${s.collectionId} not present in envs`);
		}
		pairs.set(pairKey(s.blockId, s.rev), {
			blockId: s.blockId, rev: s.rev, restoredContentHash: s.restoredContentHash,
			collectionId: s.collectionId, createBlockStorage: env.createBlockStorage,
		});
	}

	const rootActionId = input.rootActionId;
	// The root proof's votes are bound to the ROOT's target; every child reuses that proof, so each
	// child's applyInvalidation must verify against the root's target rather than the child's own. The
	// child-specific justification is THIS deterministic read-dependency derivation, replayed identically
	// by every member — not the certificate (which only attests the root is invalid).
	const rootCertificateTarget: CertificateTarget = input.certificateTarget
		?? { invalidatedActionId: rootActionId, blockIds: [...new Set(input.seed.map(s => s.blockId))] };
	// Dedup identity is per collection-entry (collectionId, actionId), not actionId alone: a
	// multi-collection transaction has one entry per collection and each must be reverted separately.
	const processedEntries = new Set<string>(); // entryKey() of collection-entries reverted this cascade
	// The horizon counts distinct transactions (the root counts once, a multi-collection dependent once),
	// so a transaction is never split across the budget — reverted in some collections, escalated in others.
	const invalidatedTxns = new Set<ActionId>([rootActionId]);
	const children: CascadeChild[] = [];
	const affectedCollections = new Set<CollectionId>(input.seed.map(s => s.collectionId));
	const unevaluable: CascadeStanding[] = [];
	let retained: CascadeStanding[] = [];
	let rounds = 0;
	let escalation: CascadeEscalation | undefined;
	// Set once a new transaction is refused at the transaction horizon. We do NOT break the cascade
	// on that refusal: already-counted transactions must still finish every remaining collection-entry
	// (all-or-nothing), so we skip only the over-budget newcomer and let the round complete. The
	// max-transactions escalation is built once at the end, after the protected transactions drain.
	let horizonReached = false;

	while (true) {
		// Depth horizon: stop before another rescan, surfacing the un-cascaded frontier.
		if (rounds >= config.maxCascadeDepth) {
			const remainder = await collectCandidates(input.envs, pairs, rootActionId, processedEntries);
			escalation = makeEscalation('max-depth', affectedCollections, remainder, unevaluable);
			break;
		}
		rounds++;

		const candidates = await collectCandidates(input.envs, pairs, rootActionId, processedEntries);
		if (candidates.length === 0) {
			break; // fixpoint: no remaining read-dependents
		}

		retained = [];
		let progressed = false;

		for (const cand of candidates) {
			if (processedEntries.has(entryKey(cand.collectionId, cand.actionId))) {
				continue; // diamond: an ancestor pass already reverted this collection-entry
			}
			// Recompute matches against the live frontier (picks up same-round ancestors, ordered by rev).
			const matched = matchReads(cand.reads, pairs);
			const isLegacy = cand.reads === undefined;
			if (matched.length === 0 && !isLegacy) {
				continue; // no longer a dependent this round — revisit next round
			}

			assertForwardOnly(cand, matched);

			const verdict = await reevaluate({ ...cand, matched });
			if (verdict === 'retain') {
				retained.push(standing(cand));
				continue;
			}
			if (verdict === 'unevaluable') {
				if (!unevaluable.some(u => u.collectionId === cand.collectionId && u.actionId === cand.actionId)) {
					unevaluable.push(standing(cand));
				}
				affectedCollections.add(cand.collectionId);
				continue;
			}

			// invalidate — but never START a new transaction past the horizon. An already-counted
			// transaction's remaining collection-entries pass freely (the `has` short-circuit), so a
			// multi-collection dependent is reverted all-or-nothing and is never split across the budget.
			// Crucially we only SKIP the over-budget newcomer here — we must not break the round, or a
			// counted transaction's later-sorted sibling entry would be abandoned (silent partial revert).
			if (!invalidatedTxns.has(cand.actionId) && invalidatedTxns.size + 1 > config.maxCascadeTransactions) {
				horizonReached = true;
				continue;
			}

			const env = cand.env;
			const result = await applyInvalidation(
				{ log: env.log, createBlockStorage: env.createBlockStorage, withBlockCommitLatch: env.withBlockCommitLatch },
				{
					invalidatedActionId: cand.actionId,
					invalidatedRev: cand.rev,
					blockIds: cand.blockIds,
					proof: input.proof,
					cascadeRoot: input.rootActionId,
					// Verify the reused root proof against the root's target, not this child's own.
					certificateTarget: rootCertificateTarget,
				}
			);

			// `applied:false, already-applied` is the idempotent re-run path: the child entry already
			// exists (prior cascade run / restart). Treat it as invalidated and reuse its reverted blocks
			// so the frontier still grows and the cascade reconverges without a second entry.
			if (!result.applied && result.reason !== 'already-applied') {
				// invalid-certificate should be impossible: the child verifies the root proof against the
				// root's target (rootCertificateTarget), and the root proof is a valid challenger-wins cert.
				log('child-apply-rejected actionId=%s reason=%s', cand.actionId, result.reason);
				continue;
			}

			processedEntries.add(entryKey(cand.collectionId, cand.actionId));
			invalidatedTxns.add(cand.actionId);
			progressed = true;
			affectedCollections.add(cand.collectionId);
			children.push({ collectionId: cand.collectionId, actionId: cand.actionId, rev: cand.rev, reverted: result.reverted });

			for (const rb of result.reverted) {
				pairs.set(pairKey(rb.blockId, cand.rev), {
					blockId: rb.blockId, rev: cand.rev, restoredContentHash: rb.restoredContentHash,
					collectionId: cand.collectionId, createBlockStorage: env.createBlockStorage,
				});
			}
		}

		if (!progressed) {
			break; // only retains / unevaluable / over-budget newcomers remain — fixpoint
		}
	}

	// Transaction-horizon escalation, built after the protected transactions have fully drained so the
	// remainder reflects only what was genuinely left un-cascaded (never a half-reverted transaction).
	if (horizonReached && !escalation) {
		const remainder = await collectCandidates(input.envs, pairs, rootActionId, processedEntries);
		escalation = makeEscalation('max-transactions', affectedCollections, remainder, unevaluable);
	}

	if (!escalation && unevaluable.length > 0) {
		escalation = makeEscalation('unevaluable', affectedCollections, [], unevaluable);
	}

	if (escalation) {
		log('escalate reason=%s collections=%d remainder=%d unevaluable=%d',
			escalation.reason, escalation.collections.length, escalation.remainder.length, escalation.unevaluable.length);
		try {
			input.onEscalation?.(escalation);
		} catch (err) {
			log('escalation-sink-error error=%s', (err as Error).message);
		}
	}

	return {
		rootActionId: input.rootActionId,
		invalidated: children,
		retained,
		rounds,
		...(escalation ? { escalation } : {}),
	};
}

// ─── Walk / match helpers ───

/** Walk every in-scope collection log forward, collecting unprocessed actions that are read-dependents. */
async function collectCandidates(
	envs: ReadonlyArray<CollectionEnv>,
	pairs: Map<string, InvalidatedPair>,
	rootActionId: ActionId,
	processedEntries: Set<string>
): Promise<CascadeCandidate[]> {
	const candidates: CascadeCandidate[] = [];
	for (const env of envs) {
		for await (const entry of env.log.select()) {
			const action = entry.action;
			// Exclude the root (invalidated by the caller across all its collections) and any
			// collection-entry already reverted this cascade — but a not-yet-reverted entry of the
			// same transaction in a different collection is still a live candidate.
			if (!action || action.actionId === rootActionId || processedEntries.has(entryKey(env.collectionId, action.actionId))) {
				continue;
			}
			const reads = action.reads;
			const isLegacy = reads === undefined;
			const matched = matchReads(reads, pairs);
			if (matched.length === 0 && !isLegacy) {
				continue;
			}
			candidates.push({
				env,
				collectionId: env.collectionId,
				actionId: action.actionId,
				rev: entry.rev,
				blockIds: action.blockIds,
				reads,
				matched,
			});
		}
	}
	// Deterministic processing order: revision, then collection, then actionId.
	candidates.sort((a, b) =>
		a.rev - b.rev
		|| (a.collectionId < b.collectionId ? -1 : a.collectionId > b.collectionId ? 1 : 0)
		|| (a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0)
	);
	return candidates;
}

/** The subset of `reads` that intersect the invalidated frontier; `[]` for a legacy (reads-less) entry. */
function matchReads(reads: ReadonlyArray<ReadDependency> | undefined, pairs: Map<string, InvalidatedPair>): InvalidatedPair[] {
	if (!reads) {
		return [];
	}
	const matched: InvalidatedPair[] = [];
	for (const r of reads) {
		const pair = pairs.get(pairKey(r.blockId, r.revision));
		if (pair) {
			matched.push(pair);
		}
	}
	return matched;
}

/**
 * Cycle-freedom guard. A read observes a strictly earlier write, so within a single collection a
 * dependent's revision must exceed the pair it depends on. A same-collection back-edge means the log
 * is corrupt — throw rather than risk a non-terminating walk. Cross-collection pairs live in
 * independent revision sequences and are not comparable, so they are skipped.
 */
function assertForwardOnly(cand: CascadeCandidate, matched: ReadonlyArray<InvalidatedPair>): void {
	for (const pair of matched) {
		if (pair.collectionId === cand.collectionId && cand.rev <= pair.rev) {
			throw new Error(
				`cascade: back-edge detected — action ${cand.actionId} at rev ${cand.rev} reads ${pair.blockId}@${pair.rev} in the same collection (dependency graph must be a forward DAG)`
			);
		}
	}
}

function standing(cand: CascadeCandidate): CascadeStanding {
	return { collectionId: cand.collectionId, actionId: cand.actionId, rev: cand.rev };
}

function makeEscalation(
	reason: CascadeEscalation['reason'],
	collections: Set<CollectionId>,
	remainder: ReadonlyArray<CascadeCandidate>,
	unevaluable: ReadonlyArray<CascadeStanding>
): CascadeEscalation {
	const affected = new Set(collections);
	for (const r of remainder) {
		affected.add(r.collectionId);
	}
	return {
		reason,
		collections: [...affected],
		remainder: remainder.map(standing),
		unevaluable: [...unevaluable],
	};
}
