/**
 * The blob arm of a ring narrowing: when a move-out leaves part of this node's slice behind
 * (`docs/arachnode-ring-handoff.md` § Phase C), the blobs that route into the part it gave up are
 * handed over too, so a narrowed slice means the same thing for blobs as it does for blocks.
 *
 * Three things this pass is NOT, each deliberate (docs/blobs.md §Placement, copying and durability):
 *
 * - **It never acquires.** A move-in fetches no blobs, exactly as it fetches no blocks; what delivers
 *   a gained range is the cohort's own announcements and read repair.
 * - **It does not decide what this node takes.** A blob reaches a node because its cohort assigned it;
 *   the ring only bounds what it keeps.
 * - **It invents no release rule.** Every hold goes through `BlobCohortReaction.releaseLost`, which
 *   drops one only once the floor of the blob's current owners answers `whole`.
 *
 * And it does not gate the shift: it runs after Phase C has already released the shed blocks, per
 * reference. Coupling the two would let one unconfirmable blob roll back a block handoff that had
 * already confirmed.
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry
 * (`src/rn.ts`) through the node factory.
 */

import { hashKey } from 'p2p-fret';
import { routingKeyForBlob, type BlobRef, type IKeyNetwork } from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import { narrowingSheds, type RingNarrowing } from '../storage/arachnode-partition.js';
import type { BlobCohortReaction } from './cohort-reaction.js';

/** The namespace the blob monitor and its reaction log under, so one filter shows a blob's whole copy story. */
const log = createLogger('blob:copy');

export interface RingShedBlobsDeps {
	/** This node's own peer id, excluded from a shed reference's owners as the monitor excludes it. */
	selfId: string;
	/**
	 * The references this node keeps for the network, read at call time — the blob monitor's tracked
	 * set. Best-effort iteration safety, as every other reader of that set already accepts: a hold
	 * taken or released mid-pass can add to or delete from it while this walks it, which does not throw
	 * in JavaScript, and a reference missed this way is simply not shed by this narrowing.
	 */
	heldRefs: Iterable<string>;
	/** The reaction whose release arm decides every shed reference. */
	reaction: Pick<BlobCohortReaction, 'releaseLost'>;
	/** The node's key network: a shed reference's owners are its current `findCluster` cohort. */
	keyNetwork: Pick<IKeyNetwork, 'findCluster'>;
	/** The replication floor `N`, read fresh per pass (`RebalanceMonitor.getCohortSize`). */
	floor: () => number;
	/** Drop a confirmed reference's `responsible` hold (`LocalBlobService.releaseResponsible`). */
	releaseResponsible: (ref: BlobRef) => Promise<void>;
	/** Report an unconfirmed reference to the monitor (`RebalanceMonitor.retainLost`). */
	retainLost: (ref: BlobRef) => void;
}

/** What one pass did, for the caller's log and for tests. */
export interface RingShedOutcome {
	/** Shed references whose release confirmed; their `responsible` hold has been dropped. */
	released: BlobRef[];
	/** Shed references whose release did not confirm; this node still holds them. */
	retained: BlobRef[];
	/** Shed references whose cohort could not be resolved, so no release was attempted. */
	unresolved: number;
}

/**
 * Hand over the blobs a narrowing leaves outside the slice this node serves.
 *
 * Takes its partitions from `narrowing` and never re-reads them from the adapter: by the time this
 * runs, a later shift may have moved them, and a pass that read the current pair would shed against
 * the wrong boundary.
 */
export async function shedNarrowedBlobs(deps: RingShedBlobsDeps, narrowing: RingNarrowing): Promise<RingShedOutcome> {
	const shed = await selectShedBlobRefs(deps.heldRefs, narrowing);
	if (shed.length === 0) {
		return { released: [], retained: [], unresolved: 0 };
	}
	const { owners, unresolved } = await ownersOf(deps, shed);
	const releasable = [...owners.keys()];
	// `Math.max(1, …)` for the same reason the event arm applies it: a floor of zero would release a
	// hold on nobody's word.
	const { released, retained } = await deps.reaction.releaseLost(releasable, owners, Math.max(1, deps.floor()));
	// In turn, as the monitor's own handler applies them: each release is one serialized record write,
	// and the holds feed untracks the reference when no `owed` hold remains, so nothing untracks here.
	for (const ref of released) {
		await deps.releaseResponsible(ref);
	}
	// NOTE: `retainLost` only buys a re-report for a reference this node has ALSO left the cohort of —
	// `RebalanceMonitor.retainLost` ignores one it is still responsible for — and a ring narrowing does
	// not change a cohort. So a shed blob whose release does not confirm is re-offered by the next
	// narrowing or the next cohort departure, and not sooner: the node keeps the bytes meanwhile, which
	// is the safe direction but frees less than the narrowing asked for. If unconfirmed sheds ever show
	// up as the reason a narrowed node stays full, give this pass its own retry (re-run it against the
	// node's current partition on the ring tick) rather than teaching the monitor about ring depth.
	for (const ref of retained) {
		deps.retainLost(ref);
	}
	log('shed:done shed=%d released=%d retained=%d unresolved=%d', shed.length, released.length, retained.length, unresolved);
	return { released, retained, unresolved };
}

/**
 * The held references a narrowing sheds: those whose blob routing key the OLD slice covered and the
 * new one does not.
 *
 * Everything else is kept — including a reference outside the old slice, which a narrowing never
 * touches. Such a reference is here because the blob's cohort put it here, and the cohort, not the
 * ring, is what takes it away again.
 */
export async function selectShedBlobRefs(heldRefs: Iterable<string>, narrowing: RingNarrowing): Promise<BlobRef[]> {
	const shed: BlobRef[] = [];
	for (const held of heldRefs) {
		// Every id the blob monitor tracks came from a blob record, so it is a canonical reference.
		const ref = held as BlobRef;
		if (narrowingSheds(narrowing, await coordOf(ref))) {
			shed.push(ref);
		}
	}
	return shed;
}

/**
 * Each shed reference's current owners — its `findCluster` cohort minus self — the way the reaction's
 * own release arm gets them, rather than from the shift's block-owners map, whose peers were chosen
 * for block keys.
 *
 * A reference whose lookup fails is left out of the result entirely rather than given an empty owner
 * list: an empty list would read as "no member accepts blobs" and retain the reference under a reason
 * that is not what happened. Nothing is recorded for it, as the monitor's own failed lookup records
 * nothing.
 *
 * NOTE: one `findCluster` per shed reference, in turn, as the monitor's own check makes one per tracked
 * id. A node narrowing out of a deep ring sheds most of what it holds, so this is the pass's cost; if
 * a narrowing ever shows up as slow, the lookups are independent and can go in a bounded parallel run
 * like the reaction's own arms.
 */
async function ownersOf(
	deps: RingShedBlobsDeps,
	shed: readonly BlobRef[]
): Promise<{ owners: Map<BlobRef, string[]>; unresolved: number }> {
	const owners = new Map<BlobRef, string[]>();
	let unresolved = 0;
	for (const ref of shed) {
		try {
			const cohort = Object.keys(await deps.keyNetwork.findCluster(routingKeyForBlob(ref)));
			owners.set(ref, cohort.filter(peerId => peerId !== deps.selfId));
		} catch (error) {
			unresolved++;
			log('shed:cohort-unresolved ref=%s err=%s', ref, error instanceof Error ? error.message : String(error));
		}
	}
	return { owners, unresolved };
}

/**
 * A blob's ring coordinate: its routing key hashed once, the same transformation the key network
 * applies to place it and `RingSelector` applies to a peer id. Comparing a partition against anything
 * else would compare a prefix of one space against a prefix of another.
 */
async function coordOf(ref: BlobRef): Promise<Uint8Array> {
	return await hashKey(routingKeyForBlob(ref));
}
