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
 * whichever cohort it ran on — and `blockRevs` the union at the higher revision per block, less
 * every torn block. Reports that already carry `otherCohorts` are flattened first, so
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
	// Over the ORIGINAL reports: flattening strips `torn` and `blockRevs` (they are action-level),
	// so both are taken before that or a torn input merges to an untorn answer.
	const torn = unionTorn(reports);
	const blockRevs = withoutBlocks(highestBlockRevs(reports), torn);
	return {
		...stripMergedFields(weakest),
		...(others.length === 0 ? {} : { otherCohorts: others.map(stripMergedFields) }),
		...(torn.length === 0 ? {} : { torn }),
		...blockRevsField(blockRevs)
	};
}

/**
 * Name the blocks a write committed, at the revision it committed them at — set where the commit is
 * confirmed, by the db-core layer that issued it. A block already named keeps the higher revision,
 * and a block in `d.torn` is left out: it holds nothing.
 */
export function withBlockRevs(d: WriteDurability, blockIds: readonly BlockId[], rev: number): WriteDurability {
	const committed = Object.fromEntries(blockIds.map(blockId => [blockId, rev]));
	const blockRevs = withoutBlocks(highestBlockRevs([d, { blockRevs: committed }]), d.torn ?? []);
	return { ...d, ...blockRevsField(blockRevs) };
}

/**
 * Clamp an action-level report below `full` when the action abandoned blocks. A cohort can hold
 * every block it was asked to commit and the action still be incomplete — the blocks the sweep
 * never reached are on nobody. Never raises the class; a report already below `full` keeps it.
 * A torn block leaves `blockRevs`, since it was not committed. Idempotent, and a no-op for an
 * empty `torn`.
 */
export function withTornBlocks(d: WriteDurability, torn: readonly BlockId[]): WriteDurability {
	if (torn.length === 0) return d;
	const allTorn = Array.from(new Set([...(d.torn ?? []), ...torn]));
	const { blockRevs: _blockRevs, ...rest } = d;
	return {
		...rest,
		quorum: d.quorum === 'full' ? 'majority' : d.quorum,
		torn: allTorn,
		...blockRevsField(withoutBlocks(d.blockRevs ?? {}, allTorn))
	};
}

/**
 * The single-node answer: this node holds it and nobody else does yet. `absent` names the cohort
 * members this node knows of that the write ran without — they are part of the cohort the write is
 * owed to, so they count in `cohort` and are listed in `unconfirmed`. With none, it is a one-machine
 * write that is complete. `absent` needs `selfPeerId`: without it the answer cannot name the cohort.
 */
export function localDurability(selfPeerId?: string, absent: readonly string[] = []): WriteDurability {
	if (selfPeerId === undefined) return { quorum: 'local', confirmed: 1, cohort: 1 };
	return {
		quorum: 'local',
		confirmed: 1,
		cohort: 1 + absent.length,
		unconfirmed: [...absent],
		cohortPeerIds: [selfPeerId, ...absent]
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

/** The per-cohort fields only — `otherCohorts`, `torn` and `blockRevs` are action-level and
 *  re-derived by the merge. */
function stripMergedFields(d: WriteDurability): WriteDurability {
	const { otherCohorts: _otherCohorts, torn: _torn, blockRevs: _blockRevs, ...cohortReport } = d;
	return cohortReport;
}

/**
 * First occurrence of each structurally identical per-cohort report, input order kept. Peer lists
 * compare as SETS: `findCluster` orders a cohort by routing distance to the block's key, so one
 * cohort answering for two blocks lists the same members in two orders. `recordedBy` is part of the
 * identity: two otherwise identical answers whose shortfalls two different ledgers recorded are two
 * facts, and a consumer waiting on full-replication events needs to see both.
 */
function distinctReports(reports: readonly WriteDurability[]): WriteDurability[] {
	const seen = new Set<string>();
	const sorted = (ids: readonly string[] | undefined): string[] | null => ids === undefined ? null : [...ids].sort();
	return reports.filter(r => {
		const key = JSON.stringify([r.quorum, r.confirmed, r.cohort, sorted(r.unconfirmed), sorted(r.cohortPeerIds), r.recordedBy ?? null]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function unionTorn(reports: readonly WriteDurability[]): BlockId[] {
	return Array.from(new Set(reports.flatMap(r => r.torn ?? [])));
}

/** Every block any report names, at the highest revision any of them names it at. */
function highestBlockRevs(reports: readonly Pick<WriteDurability, 'blockRevs'>[]): Record<BlockId, number> {
	// A Map, not assignment into `{}`: a header block's id is its collection id, which a caller
	// names, and `__proto__` assigned into a plain object sets its prototype instead of a key.
	const highest = new Map<BlockId, number>();
	for (const [blockId, rev] of reports.flatMap(r => Object.entries(r.blockRevs ?? {}))) {
		highest.set(blockId, Math.max(highest.get(blockId) ?? rev, rev));
	}
	return Object.fromEntries(highest);
}

function withoutBlocks(blockRevs: Readonly<Record<BlockId, number>>, excluded: readonly BlockId[]): Record<BlockId, number> {
	const drop = new Set(excluded);
	return Object.fromEntries(Object.entries(blockRevs).filter(([blockId]) => !drop.has(blockId)));
}

/** The field, or nothing: an empty map is left off, as an empty `torn` is. */
function blockRevsField(blockRevs: Readonly<Record<BlockId, number>>): Pick<WriteDurability, 'blockRevs'> {
	return Object.keys(blockRevs).length === 0 ? {} : { blockRevs };
}
