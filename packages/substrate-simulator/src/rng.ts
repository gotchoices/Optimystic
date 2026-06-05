import type { SeededRng } from './types.js';

/**
 * Decision 4 — a single integer seed drives one deterministic PRNG stream. Every
 * stochastic choice in a simulation draws from this stream, so a run is byte-reproducible
 * from `(seed, config)`. Implementation is mulberry32: small, dependency-free, 32-bit state.
 */
export class Mulberry32Rng implements SeededRng {
	/** Mutable PRNG state, advanced on each draw. */
	private state: number;
	/** Construction seed, retained so `fork` is independent of how far the stream has been drawn. */
	private readonly seed: number;

	constructor(seed: number) {
		this.seed = seed >>> 0;
		this.state = seed >>> 0;
	}

	nextU32(): number {
		let a = (this.state + 0x6d2b79f5) | 0;
		this.state = a;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return (t ^ (t >>> 14)) >>> 0;
	}

	nextFloat(): number {
		return this.nextU32() / 0x1_0000_0000;
	}

	nextInt(maxExclusive: number): number {
		if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
			throw new RangeError(`maxExclusive must be a positive integer, got ${maxExclusive}`);
		}
		return Math.floor(this.nextFloat() * maxExclusive);
	}

	/**
	 * Derive an independent sub-stream seeded from hash(seed ‖ label). Deterministic in
	 * `(this.seed, label)` only — never the live `state` — so two runs agree regardless of
	 * how the parent stream has been interleaved. Tradeoff (Decision 4): the single shared
	 * stream is simplest but reordering insertions reorders draws; `fork` isolates a module's
	 * draws at the cost of N streams. Opt-in; the primary contract is the shared stream.
	 */
	fork(label: string): SeededRng {
		return new Mulberry32Rng(hashSeedLabel(this.seed, label));
	}
}

/** FNV-1a over the seed's 4 bytes followed by the label's UTF-16 code units. Deterministic. */
function hashSeedLabel(seed: number, label: string): number {
	let h = 0x811c9dc5;
	const s = seed >>> 0;
	for (let i = 0; i < 4; i++) {
		h ^= (s >>> (i * 8)) & 0xff;
		h = Math.imul(h, 0x0100_0193);
	}
	for (let i = 0; i < label.length; i++) {
		const c = label.charCodeAt(i);
		h ^= c & 0xff;
		h = Math.imul(h, 0x0100_0193);
		h ^= (c >>> 8) & 0xff;
		h = Math.imul(h, 0x0100_0193);
	}
	return h >>> 0;
}

export function createRng(seed: number): SeededRng {
	if (!Number.isInteger(seed)) {
		throw new TypeError(`seed must be an integer, got ${seed}`);
	}
	return new Mulberry32Rng(seed);
}
