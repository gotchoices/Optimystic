import { DigitreeStore, type SizeEstimate } from 'p2p-fret';
import type { PeerRef, EventScheduler, VTime } from './types.js';
import { RingModel } from './ring-model.js';
import { CohortModel } from './cohort-model.js';
import { SizeModel } from './size-model.js';

export interface FretModelOptions {
	/** Sample-size parameter for FRET's estimator; production uses `m = ⌈k/2⌉` (k default 15 → 8). */
	readonly m: number;
}

/**
 * Thin model over real FRET. It derives ring coordinates, cohort membership, `n_est`, and
 * `d_max` from an injected synthetic population using the *same* FRET functions production
 * calls (`hashKey`, `xorDistance`, `assembleCohort`, `estimateSizeAndConfidence`) — the
 * simulator is FRET's first non-libp2p consumer and wraps, never reimplements, that math.
 *
 * It owns a single `DigitreeStore` seeded by `hashKey` over each peer's synthetic key. Churn
 * (`addPeer`/`removePeer`) mutates that store directly; the cached `lastEstimate` only reflects
 * the change after the next `scheduleRecompute` event fires — modeling FRET stabilization as
 * one gossip-round latency (event-clock ticket, Decision 6), not a full stabilization loop.
 */
export class FretModel {
	readonly ring: RingModel;
	readonly cohort: CohortModel;
	readonly size: SizeModel;
	/** Snapshot from the most recent scheduled recompute; `undefined` until the first one fires. */
	lastEstimate: SizeEstimate | undefined;

	private constructor(
		private readonly store: DigitreeStore,
		private readonly peersById: Map<string, PeerRef>,
		m: number
	) {
		this.ring = new RingModel();
		this.cohort = new CohortModel(store, peersById);
		this.size = new SizeModel(store, m);
	}

	/** Seed a model from an injected population (awaits FRET sha256 per peer at build time). */
	static async create(peers: readonly PeerRef[], opts: FretModelOptions): Promise<FretModel> {
		const ring = new RingModel();
		const store = new DigitreeStore();
		const peersById = new Map<string, PeerRef>();
		for (const peer of peers) {
			const coord = await ring.coordOf(peer.key);
			store.upsert(peer.id, coord);
			peersById.set(peer.id, peer);
		}
		return new FretModel(store, peersById, opts.m);
	}

	/** Add a peer to the underlying FRET store (churn-in). */
	async addPeer(peer: PeerRef): Promise<void> {
		const coord = await this.ring.coordOf(peer.key);
		this.store.upsert(peer.id, coord);
		this.peersById.set(peer.id, peer);
	}

	/** Remove a peer from the underlying FRET store (churn-out). */
	removePeer(id: string): void {
		this.store.remove(id);
		this.peersById.delete(id);
	}

	/** Recompute and cache the size estimate now (synchronous; reads the live store). */
	recomputeEstimate(): SizeEstimate {
		this.lastEstimate = this.size.estimate();
		return this.lastEstimate;
	}

	/**
	 * Schedule an `n_est` recompute one gossip round out on the virtual clock — the coarse
	 * stabilization model. `lastEstimate` reflects intervening store mutations only after the
	 * scheduled event fires.
	 */
	scheduleRecompute(scheduler: EventScheduler, gossipRoundMs: VTime): void {
		scheduler.scheduleAfter(gossipRoundMs, () => {
			this.recomputeEstimate();
		});
	}
}
