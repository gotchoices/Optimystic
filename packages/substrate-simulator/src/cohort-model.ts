import { assembleCohort, type DigitreeStore } from 'p2p-fret';
import type { PeerRef } from './types.js';
import type { RingCoord } from './ring-model.js';

/**
 * Two-sided cohort membership, delegated to real FRET `assembleCohort` over a shared
 * `DigitreeStore` (alternating successor/predecessor walk, auto-adapting when `n < k`). The
 * model adds no selection logic of its own: `assembleIds(coord, k)` is byte-identical to a
 * direct `assembleCohort(store, coord, k)` call — see the parity test.
 */
export class CohortModel {
	constructor(
		private readonly store: DigitreeStore,
		private readonly peersById: ReadonlyMap<string, PeerRef>
	) {}

	/** Cohort of up to `k` peers around `coord` (auto-adapts when `n < k`), via FRET. */
	assemble(coord: RingCoord, k: number, exclude?: Set<string>): PeerRef[] {
		const ids = this.assembleIds(coord, k, exclude);
		return ids
			.map((id) => this.peersById.get(id))
			.filter((p): p is PeerRef => p !== undefined);
	}

	/** Raw cohort ids, exactly as FRET names them — the parity surface for divergence checks. */
	assembleIds(coord: RingCoord, k: number, exclude?: Set<string>): string[] {
		return assembleCohort(this.store, coord, k, exclude);
	}

	/** Downstream signature threshold: `minSigs = k − x`. */
	minSigs(k: number, x: number): number {
		return k - x;
	}
}
