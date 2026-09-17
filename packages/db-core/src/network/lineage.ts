import type { ActionRev } from "../collection/action.js";
import type { BlockLineage, WriteDurability } from "./struct.js";

/** One cohort member's answer to {@link BlockGets.lineageOf} for one block. A member that could not
 *  be asked, or predates the question, is listed with `unknown` — it still counts as a member. */
export type MemberLineage = {
	peerId: string;
	lineage: BlockLineage;
	/** The newest revision the member holds for the block, as it reported it. */
	latest?: ActionRev;
};

/** A block's cohort-level lineage answer, with who holds the write when the answer is `contains`. */
export type CohortLineage = {
	lineage: BlockLineage;
	durability?: WriteDurability;
};

/**
 * The single rule for turning a cohort's per-member lineage answers into one answer for the block.
 *
 * A member can only vouch for history it derived itself, so a member that took a later revision as
 * a replica answers `unknown` even when that replica was built from the write. Such a member is
 * counted WITH a member that did answer when the two hold the same latest revision under the same
 * action: a revision's content is what the cohort agreed on at commit, so two members holding the
 * same one hold the same lineage.
 *
 * - `contains` — a strict majority of the cohort holds content built from the write, the same bar
 *   a commit must meet to be acknowledged. Fewer than that is `unknown`, not a smaller `contains`:
 *   the write may yet spread from the members that hold it, or be overwritten by the ones that do
 *   not, and the writer must not be told either.
 * - `excludes` — at least one member proves it, and EVERY member is accounted for as excluding it
 *   or not having reached it. One unaccounted member could be where the write survives.
 * - `behind` — every member answered that it has not reached the revision.
 * - `unknown` — anything else, including members that contradict each other (one proves the write
 *   is in its content, another that it is not): the block's content has forked, which is a fault
 *   this answer must not paper over in either direction.
 *
 * An empty cohort is `unknown`.
 */
export function judgeCohortLineage(members: readonly MemberLineage[]): CohortLineage {
	const provers = members.filter(m => m.lineage === 'contains');
	const refuters = members.filter(m => m.lineage === 'excludes');
	if (members.length === 0 || (provers.length > 0 && refuters.length > 0)) {
		return { lineage: 'unknown' };
	}
	if (provers.length > 0) {
		const holders = withSameLatest(members, provers);
		if (holders.length * 2 <= members.length) {
			return { lineage: 'unknown' };
		}
		const held = new Set(holders.map(m => m.peerId));
		const unconfirmed = members.filter(m => !held.has(m.peerId)).map(m => m.peerId);
		return {
			lineage: 'contains',
			durability: {
				quorum: unconfirmed.length === 0 ? 'full' : 'majority',
				confirmed: holders.length,
				cohort: members.length,
				unconfirmed,
				cohortPeerIds: members.map(m => m.peerId)
			}
		};
	}
	if (refuters.length > 0) {
		const excluding = new Set(withSameLatest(members, refuters).map(m => m.peerId));
		return members.every(m => excluding.has(m.peerId) || m.lineage === 'behind')
			? { lineage: 'excludes' }
			: { lineage: 'unknown' };
	}
	return { lineage: members.every(m => m.lineage === 'behind') ? 'behind' : 'unknown' };
}

/** `decided`, plus every `unknown` member holding the same latest revision as one of them. */
function withSameLatest(members: readonly MemberLineage[], decided: readonly MemberLineage[]): MemberLineage[] {
	const sameRevision = (a: ActionRev | undefined, b: ActionRev | undefined): boolean =>
		a !== undefined && b !== undefined && a.rev === b.rev && a.actionId === b.actionId;
	return members.filter(m => decided.includes(m)
		|| (m.lineage === 'unknown' && decided.some(d => sameRevision(d.latest, m.latest))));
}
