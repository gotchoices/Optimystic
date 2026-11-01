import { LruMap } from '../utility/lru-map.js';

/** How many node ids a {@link SkewLedger} remembers; the least recently heard from is forgotten first. */
export const DEFAULT_SKEW_LEDGER_MAX_NODES = 256;

/**
 * How far one node's HLCs have been from this node's wall clock, over the samples a
 * {@link SkewLedger} kept for it. Both maxima are magnitudes, 0 when no sample fell on that side.
 *
 * A gap does not say which clock is wrong: a node whose own HLC jumped forward after it observed a
 * far-ahead peer shows as ahead to everyone, and so does a node whose wall clock simply runs fast.
 */
export type NodeSkew = {
	readonly nodeId: string;
	readonly samples: number;
	/** The largest amount one of the node's HLCs sat ahead of local time, in milliseconds. */
	readonly maxAheadMs: number;
	/** The largest amount one of the node's HLCs sat behind local time, in milliseconds. */
	readonly maxBehindMs: number;
};

/**
 * The measurement docs/crdt-sync.md §Open Questions asks for before deciding whether members should
 * refuse an HLC far from their own clock: per node id, how far the HLCs this node received from it
 * sat from local time. Pure and in memory; it refuses nothing and nothing acts on it. A db-p2p
 * storage repo records one sample per pend that carries an HLC (`StorageRepo.hlcSkew`).
 */
export class SkewLedger {
	private readonly nodes: LruMap<string, NodeSkew>;

	constructor(maxNodes = DEFAULT_SKEW_LEDGER_MAX_NODES) {
		this.nodes = new LruMap(maxNodes);
	}

	/**
	 * Add one sample: `gapMs` is the HLC's `wallMs` less local time, positive when the node's HLC was
	 * ahead. Returns the node's summary with the sample included.
	 */
	record(nodeId: string, gapMs: number): NodeSkew {
		const prior = this.nodes.get(nodeId);
		const next: NodeSkew = {
			nodeId,
			samples: (prior?.samples ?? 0) + 1,
			maxAheadMs: Math.max(prior?.maxAheadMs ?? 0, gapMs),
			maxBehindMs: Math.max(prior?.maxBehindMs ?? 0, -gapMs),
		};
		this.nodes.set(nodeId, next);
		return next;
	}

	/** Every node remembered, least recently heard from first. */
	snapshot(): NodeSkew[] {
		return [...this.nodes].map(([, skew]) => skew);
	}
}
