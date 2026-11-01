import type { ActionRev, BlockId, BlockLineage } from "@optimystic/db-core";
import { soloAheadOfCohort, type RevClaim } from "./quorum-restore.js";

/**
 * The second, narrow round both block-repair paths run when the claim set has the one shape the
 * selector cannot settle on its own (`soloAheadOfCohort` in `./quorum-restore.ts`): a lone machine's
 * single-signer certified claim strictly ahead of a pair the rest of the cohort backs. One peer ahead
 * of two is what a forked machine AND a lagging cohort both look like, so the claimants of the lone
 * pair are asked whether their own history contains the group's pair — `IBlockStorage.lineageOf`,
 * the question the torn-write path already asks a cohort — and the answers decide.
 *
 * Shared by the read path (`CoordinatorRepo.queryClusterForLatest`) and the commit path
 * (`createReconcileBlock`) so the two cannot drift on the rule. The transport is injected
 * ({@link BlockLineageAsk}) and OPTIONAL at both call sites: without it the helper answers
 * `not-asked` and marks nothing, so a caller without the wire selects byte-for-byte as before.
 */

/**
 * Ask one cohort peer whether ITS current content for `blockId` was built from `target`, answered
 * from that peer's own records (`contains` / `excludes` / `behind` / `unknown`). A throw or a
 * rejection reads as a silent claimant, which the fold weighs as `unknown`. The helper puts no
 * deadline on the promise; a caller that wants one wraps the ask (the coordinator does, with its
 * per-peer consult budget).
 */
export type BlockLineageAsk = (peerId: string, blockId: BlockId, target: ActionRev) => Promise<BlockLineage>;

/** One claimant's answer as recorded for the log: its lineage verdict, or `silent` when the ask threw. */
export type LineageAnswer = BlockLineage | 'silent';

/**
 * What the round concluded. `not-asked` is the common case — no ask was supplied, or the claim set
 * does not have the shape — and the three asked verdicts carry the two pairs, who was asked and what
 * each said, so a caller can log them whole.
 *
 *  - `fork` — a claimant said its history EXCLUDES the group's pair. Every claim at the lone pair has
 *    been marked `forkedFromCohort`, so the group's pair wins the selection that follows.
 *  - `same-lineage` — no claimant excluded it and at least one said it CONTAINS it: the ordinary
 *    lagging-cohort repair, confirmed. Nothing is marked; the lone pair wins as before.
 *  - `unknown` — every claimant was silent, `behind` (contradicting its own claim) or `unknown`
 *    (its content past the asked revision came from elsewhere, so it cannot vouch). Nothing is
 *    marked; the lone pair wins as before, which keeps the lagging-cohort repair working.
 */
export type SoloAheadVerdict =
	| { verdict: 'not-asked' }
	| {
		verdict: 'fork' | 'same-lineage' | 'unknown';
		solo: ActionRev;
		cohort: ActionRev;
		claimants: string[];
		answers: Record<string, LineageAnswer>;
	};

/** The corroboration settings the shape is judged under — the same two numbers the selector takes. */
export interface SoloAheadSettings {
	simpleMajorityThreshold: number;
	corroboratorCapacity?: number;
}

/**
 * Detect the shape, ask each claimant of the lone pair about the group's pair, fold the answers, and
 * on `fork` mark every claim at the lone pair IN PLACE — the caller's later logging and penalties
 * read the same claim objects, so no filtered copy is returned.
 *
 * The fold: any `excludes` → `fork`; otherwise any `contains` → `same-lineage`; otherwise `unknown`.
 * A claimant answering `excludes` is reporting its own revision index naming another action at that
 * revision. A `contains` beside an `excludes` is two machines holding the same bytes under the same
 * pair and disagreeing about where they came from, so one of them is wrong, and the conservative
 * direction is the group's. No answer carries a reputation penalty: only the lone pair's claimants
 * are asked, so a lying `excludes` can only make its own pair lose, and an honest fork claimant is a
 * partition casualty rather than a liar.
 *
 * NOTE: one request per claimant, and only in a shape that honestly arises after a machine committed
 * while cut off from a group that holds the block. The commit path's pass is already bounded whole
 * (`reconcilePassTimeoutMs`) and the read path deadlines each ask; a bound that expires reads as a
 * silent claimant and the verdict stays `unknown`, never a throw.
 */
export async function settleSoloAhead(
	claims: RevClaim[],
	blockId: BlockId,
	settings: SoloAheadSettings,
	askLineage: BlockLineageAsk | undefined
): Promise<SoloAheadVerdict> {
	if (!askLineage) return { verdict: 'not-asked' };
	const shape = soloAheadOfCohort(claims, settings.simpleMajorityThreshold, settings.corroboratorCapacity);
	if (!shape) return { verdict: 'not-asked' };
	const cohort: ActionRev = { actionId: shape.cohort.actionId, rev: shape.cohort.rev };
	const answers: Record<string, LineageAnswer> = {};
	await Promise.all(shape.solo.claimants.map(async peerId => {
		answers[peerId] = await lineageAnswer(askLineage, peerId, blockId, cohort);
	}));
	const verdict = foldLineageAnswers(Object.values(answers));
	if (verdict === 'fork') markForked(claims, shape.solo);
	return {
		verdict,
		solo: { actionId: shape.solo.actionId, rev: shape.solo.rev },
		cohort,
		claimants: shape.solo.claimants,
		answers
	};
}

/** One claimant's answer, isolated: a throw costs that claimant its answer, never the round. */
async function lineageAnswer(ask: BlockLineageAsk, peerId: string, blockId: BlockId, target: ActionRev): Promise<LineageAnswer> {
	try {
		return await ask(peerId, blockId, target);
	} catch {
		return 'silent';
	}
}

function foldLineageAnswers(answers: readonly LineageAnswer[]): 'fork' | 'same-lineage' | 'unknown' {
	if (answers.includes('excludes')) return 'fork';
	if (answers.includes('contains')) return 'same-lineage';
	return 'unknown';
}

/** Mark every claim at the lone pair, certified or not: a pushed replica of the fork is the same commit. */
function markForked(claims: RevClaim[], solo: { rev: number; actionId: string }): void {
	for (const claim of claims) {
		if (claim.rev === solo.rev && claim.actionId === solo.actionId) claim.forkedFromCohort = true;
	}
}
