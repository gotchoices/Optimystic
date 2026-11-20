import type { BlobDurability } from '@optimystic/db-core';

/** What {@link classifyBlobDurability} needs to know of a blob's cohort. */
export interface BlobCohortView {
	/** False when `findCluster` threw or named nobody. */
	readonly resolved: boolean;
	/**
	 * The cohort members that accept blobs, this node included when it is one and takes blobs.
	 *
	 * A member whose acceptance is `unknown` (not yet identified) is the **caller's** decision to
	 * include. The copy drain includes it, because an unidentified member is owed a copy until it is
	 * known not to take blobs, which errs toward keeping the writer's copy.
	 */
	readonly accepting: readonly string[];
}

/**
 * How widely a blob is held, in the classes a commit uses (docs/blobs.md §Placement, copying and
 * durability, *Durability*), counted over the cohort members that accept blobs. Pure: the caller
 * builds the view and the holder set.
 *
 * With `n` the accepting members that hold it and `k` the accepting members, the rules are checked in
 * this order:
 *
 * 1. `unrouted` — the cohort could not be named, so there is nobody to name as unconfirmed either.
 * 2. `local` — no accepting member other than this node, whatever `n`. A group where nobody else
 *    accepts blobs stays `local` and the writer keeps the blob.
 * 3. `local` — `2n <= k`: this node alone, or fewer than a strict majority.
 * 4. `full` — `n === k`.
 * 5. `majority` — otherwise.
 *
 * The order matters. Rule 2 is what keeps a one-member cohort out of `full`, which the specification
 * requires ("every accepting member holds it, **and at least one of them is not this node**"), and it
 * runs before the arithmetic so a cohort of just this node never reads as a strict majority of itself.
 * It also guards the empty-`accepting` case, which divides by nothing.
 *
 * @param holders peers known to hold the whole blob, this node included when it does.
 * @param selfId this node's peer id, as it is spelt in `view.accepting` and `holders`.
 */
export function classifyBlobDurability(view: BlobCohortView, holders: ReadonlySet<string>, selfId: string): BlobDurability {
	// Before the counts: an unresolved view names nobody, so neither count can be anything but zero,
	// and `confirmed` never reads as larger than `accepting`.
	if (!view.resolved) {
		return { quorum: 'unrouted', confirmed: 0, accepting: 0 };
	}
	const confirmed = view.accepting.filter(peerId => holders.has(peerId));
	const unconfirmed = view.accepting.filter(peerId => !holders.has(peerId));
	const n = confirmed.length;
	const k = view.accepting.length;
	const counts = { confirmed: n, accepting: k, unconfirmed };
	if (!view.accepting.some(peerId => peerId !== selfId)) {
		return { quorum: 'local', ...counts };
	}
	if (2 * n <= k) {
		return { quorum: 'local', ...counts };
	}
	return { quorum: n === k ? 'full' : 'majority', ...counts };
}
