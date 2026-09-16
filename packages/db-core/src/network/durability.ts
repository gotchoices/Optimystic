import type { BlockId } from "../index.js";
import type { DurabilityQuorum, WriteDurability } from "./struct.js";

/**
 * The ONLY "this write is completely saved" test. `quorum === 'full'` alone is not enough: a torn
 * action can have a fully-held tail and blocks that were abandoned and cancelled (`torn`), and a
 * consumer that compared the class by hand would show such a write as saved. Every place that wants
 * to present a change as saved calls this rather than reading the fields.
 */
export function isFullyDurable(d: WriteDurability): boolean {
	return d.quorum === 'full' && (d.torn === undefined || d.torn.length === 0);
}

/** Total order on quorum classes: unrouted < local < majority < full. */
export function durabilityRank(q: DurabilityQuorum): number {
	switch (q) {
		case 'unrouted': return 0;
		case 'local': return 1;
		case 'majority': return 2;
		case 'full': return 3;
	}
}

/**
 * Merge per-cohort reports into one action-level report: the weakest becomes the scalar answer and
 * the rest become `otherCohorts`, so a consumer that reads only the scalar fields is reading the
 * binding constraint. `torn` is the union across the inputs — an abandoned block is abandoned
 * whichever cohort it ran on. Reports that already carry `otherCohorts` are flattened first, so
 * merging a merge is the same as merging its inputs. Identical reports collapse to one: a commit
 * sends the tail and the sweep as separate batches, so ONE cohort routinely answers twice for one
 * action, and without this a healthy single-cohort commit would list its own cohort under
 * `otherCohorts`.
 * NOTE: only structurally identical reports collapse. One cohort answering differently for two
 * batches (a member confirmed one block and not the other) appears twice, once per answer, which
 * is the truthful shape. If a consumer ever needs exactly one entry per cohort, fold same-cohort
 * reports here by unioning `unconfirmed`; do not dedupe by `cohortPeerIds` alone.
 *
 * THROWS on an empty input: an action always ran on at least one cohort, and fabricating an answer
 * for one that ran on none is exactly the plain-success ambiguity the durability field removes.
 */
export function mergeDurability(reports: readonly WriteDurability[]): WriteDurability {
	const flat = distinctReports(reports.flatMap(flattenDurability));
	if (flat.length === 0) {
		throw new Error('mergeDurability: no durability reports to merge — an action always ran on at least one cohort');
	}
	const ranked = [...flat].sort((a, b) => durabilityRank(a.quorum) - durabilityRank(b.quorum));
	const weakest = ranked[0]!;
	const others = ranked.slice(1);
	// Over the ORIGINAL reports: flattening strips `torn` (it is action-level), so the union must
	// be taken before that or a torn input merges to an untorn answer.
	const torn = unionTorn(reports);
	return {
		...stripMergedFields(weakest),
		...(others.length === 0 ? {} : { otherCohorts: others.map(stripMergedFields) }),
		...(torn.length === 0 ? {} : { torn })
	};
}

/**
 * Clamp an action-level report below `full` when the action abandoned blocks. A cohort can hold
 * every block it was asked to commit and the action still be incomplete — the blocks the sweep
 * never reached are on nobody. Never raises the class; a report already below `full` keeps it.
 * Idempotent, and a no-op for an empty `torn`.
 */
export function withTornBlocks(d: WriteDurability, torn: readonly BlockId[]): WriteDurability {
	if (torn.length === 0) return d;
	const allTorn = Array.from(new Set([...(d.torn ?? []), ...torn]));
	return {
		...d,
		quorum: d.quorum === 'full' ? 'majority' : d.quorum,
		torn: allTorn
	};
}

/** The single-node answer: this node holds it and knows nothing about a cohort beyond itself. */
export function localDurability(selfPeerId?: string): WriteDurability {
	return {
		quorum: 'local',
		confirmed: 1,
		cohort: 1,
		...(selfPeerId === undefined ? {} : { unconfirmed: [], cohortPeerIds: [selfPeerId] })
	};
}

/**
 * The no-cohort answer: this node holds it and could not establish where it belongs. Takes no
 * reason on purpose: the producing site logs WHY the cohort did not resolve (`CohortResolution.reason`),
 * and the result says only `unrouted`, so no consumer is tempted to branch on prose.
 */
export function unroutedDurability(): WriteDurability {
	return { quorum: 'unrouted', confirmed: 1, cohort: 0 };
}

/** A merged report's own scalar view plus every `otherCohorts` entry, each as a standalone report. */
function flattenDurability(d: WriteDurability): WriteDurability[] {
	return [stripMergedFields(d), ...(d.otherCohorts ?? [])];
}

/** The per-cohort fields only — `otherCohorts` and `torn` are action-level and re-derived by the merge. */
function stripMergedFields(d: WriteDurability): WriteDurability {
	const { otherCohorts: _otherCohorts, torn: _torn, ...cohortReport } = d;
	return cohortReport;
}

/**
 * First occurrence of each structurally identical per-cohort report, input order kept. Peer lists
 * compare as SETS: `findCluster` orders a cohort by routing distance to the block's key, so one
 * cohort answering for two blocks lists the same members in two orders.
 */
function distinctReports(reports: readonly WriteDurability[]): WriteDurability[] {
	const seen = new Set<string>();
	const sorted = (ids: readonly string[] | undefined): string[] | null => ids === undefined ? null : [...ids].sort();
	return reports.filter(r => {
		const key = JSON.stringify([r.quorum, r.confirmed, r.cohort, sorted(r.unconfirmed), sorted(r.cohortPeerIds)]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function unionTorn(reports: readonly WriteDurability[]): BlockId[] {
	return Array.from(new Set(reports.flatMap(r => r.torn ?? [])));
}
