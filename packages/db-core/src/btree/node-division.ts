import type { BlockId } from "../blocks/index.js";
import type { BranchNode, LeafNode } from "./nodes.js";
import { jsonEncodedBytes } from "../network/transaction-size.js";

// The arithmetic behind a node's size limit: how a node's items divide into nodes once they no
// longer fit one, by count or by bytes. Every function here is pure, so a replayed or retried action
// divides a node identically; the tree (`btree.ts`) applies the division it is handed. A node's JSON
// is its header and empty arrays (a fixed part per node) plus each item's JSON and the commas between
// them, so one serialization per item answers both whether a node fits and where to divide it.

/** The byte rule a node's items are divided under: the target, and the bytes a node holding items
 *  `[from, to)` encodes to. */
export type ItemBytes = { target: number; between(from: number, to: number): number };

/** The byte rule for a leaf that would hold `entries`: its fixed part plus the entries and the
 *  commas between them. */
export function leafItemBytes(leaf: LeafNode<unknown>, entries: readonly unknown[], target: number): ItemBytes {
	const before = prefixSums(itemBytes(entries));
	const base = emptyLeafBytes(leaf);
	return {
		target,
		between: (from, to) => base + before[to]! - before[from]! + Math.max(0, to - from - 1),
	};
}

/** The byte rule for a branch that would hold children `nodes` under the keys `partitions`. A run of
 *  children `[from, to)` carries the keys between them; the key before `from` is promoted to the
 *  parent and counts on neither side. */
export function branchItemBytes(branch: BranchNode<unknown>, partitions: readonly unknown[], nodes: readonly BlockId[], target: number): ItemBytes {
	const ids = prefixSums(itemBytes(nodes));
	const keys = prefixSums(itemBytes(partitions));
	const base = emptyBranchBytes(branch);
	return {
		target,
		between: (from, to) => base + ids[to]! - ids[from]! + keys[to - 1]! - keys[from]!
			+ Math.max(0, to - from - 1) + Math.max(0, to - from - 2),
	};
}

/** What a leaf encodes to with no entries: the part of its size the entries do not account for. */
export function emptyLeafBytes(leaf: LeafNode<unknown>): number {
	return jsonEncodedBytes({ header: leaf.header, entries: [] });
}

/** What a branch encodes to with no children: the part of its size the keys and ids do not account for. */
export function emptyBranchBytes(branch: BranchNode<unknown>): number {
	return jsonEncodedBytes({ header: branch.header, partitions: [], nodes: [] });
}

/** The JSON size of each item, by the measure block limits are judged with. */
function itemBytes(items: readonly unknown[]): number[] {
	return items.map(item => jsonEncodedBytes(item));
}

/** Running totals: `sums[i]` is the bytes of the first `i` items, so any run of items is one subtraction. */
function prefixSums(sizes: readonly number[]): number[] {
	const sums = [0];
	for (const size of sizes) {
		sums.push(sums[sums.length - 1]! + size);
	}
	return sums;
}

/**
 * How `count` items of one node divide into nodes when they no longer fit one, as run boundaries —
 * run `i` is the items `[runs[i], runs[i + 1])`, the first boundary 0 and the last `count` — or
 * `undefined` when they fit. A run fits when it holds at most `capacity` items and either no more
 * than `always` items (one entry, or two children: the least a node of its kind holds, so a node over
 * the byte target holds no more than that) or, under the byte rule, no more than the target's bytes.
 *
 * - Over the count alone: two runs at the midpoint ({@link countSplit}), the division the tree has
 *   always made, kept as it was so a tree of small entries writes the transforms it always did.
 * - Over the bytes: the fewest fitting runs ({@link fewestRuns}), so an entry larger than the target
 *   is left alone in a node of its own and a node that outgrew the target before this rule existed is
 *   brought within it in one write; where two runs suffice, the two whose larger is smallest
 *   ({@link balancedSplit}).
 */
export function divideItems(count: number, capacity: number, at: number, always: number, bytes?: ItemBytes): number[] | undefined {
	const fits = (from: number, to: number) => to - from <= capacity
		&& (bytes === undefined || to - from <= always || bytes.between(from, to) <= bytes.target);
	if (fits(0, count)) {
		return undefined;
	}
	if (bytes === undefined || count <= always || bytes.between(0, count) <= bytes.target) {
		return [0, countSplit(count, at), count];	// the count is the only reason
	}
	const runs = fewestRuns(count, always, fits);
	if (runs.length === 3) {
		runs[1] = balancedSplit(count, always, fits, bytes.between, runs[1]!);
	}
	return runs;
}

/** Which run of `runs` (see {@link divideItems}) item `index` falls in. */
export function runOf(runs: readonly number[], index: number): number {
	let run = 0;
	while (index >= runs[run + 1]!) {
		++run;
	}
	return run;
}

/** Where the count rule divides `count` items: at the midpoint, the odd item going to the half the
 *  edit at `at` lands in. */
function countSplit(count: number, at: number): number {
	const mid = count >>> 1;
	return mid + (at < mid ? 1 : 0);
}

/** The fewest runs that each fit, packing from the left: as many items into a run as fit, then the
 *  next run. A final run of a single item takes one more from the run before it when that run can
 *  spare one (it keeps more than `always`) and the pair fits — so a branch is not left routing to one
 *  child when its neighbour could have given it another.
 *
 *  NOTE: three children whose two keys each pass half the target still leave a one-child branch (the
 *  run before it holds only `always`); the tree routes through it, and a delete merges it away. Only
 *  a key over half the target gets there, which no key the SQL layer frames does; if one ever does,
 *  let a run take an item past the target before leaving one alone. */
function fewestRuns(count: number, always: number, fits: (from: number, to: number) => boolean): number[] {
	const runs = [0];
	for (let from = 0; from < count;) {
		let to = from + 1;
		while (to < count && fits(from, to + 1)) {
			++to;
		}
		runs.push(to);
		from = to;
	}
	const last = runs.length - 1;
	if (last >= 2 && runs[last]! - runs[last - 1]! === 1 && runs[last - 1]! - runs[last - 2]! > always && fits(runs[last - 1]! - 1, count)) {
		runs[last - 1] = runs[last - 1]! - 1;
	}
	return runs;
}

/** Where to divide `count` items into two runs that both fit so that the larger run's bytes are as
 *  small as possible. Each run keeps at least `always` items when the count allows, so a branch is
 *  not divided down to one child for the sake of balance. `fallback` is a division already known to
 *  fit, returned when no candidate does. */
function balancedSplit(count: number, always: number, fits: (from: number, to: number) => boolean, between: (from: number, to: number) => number, fallback: number): number {
	const least = count >= 2 * always ? always : 1;
	let best = fallback;
	let bestLarger = Infinity;
	for (let m = least; m <= count - least; ++m) {
		if (!fits(0, m) || !fits(m, count)) {
			continue;
		}
		const larger = Math.max(between(0, m), between(m, count));
		if (larger < bestLarger) {
			bestLarger = larger;
			best = m;
		}
	}
	return best;
}
