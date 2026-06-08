import type { RingModel, RingCoord } from './ring-model.js';

/**
 * Cohort-topic tier addressing, modeled against `docs/cohort-topic.md` §Tier addressing.
 *
 * This is the only async file in the topic layer: like `ring-model.ts`/`fret-model.ts` it
 * wraps FRET's async sha256 (`RingModel.coordOf` → `hashKey`) at *seed time*, never inside a
 * scheduler event, so byte-reproducibility holds (see the no-real-time guard). Everything
 * downstream — lifecycle, barometer, willingness, traffic — consumes the pre-derived
 * `RingCoord`s synchronously.
 *
 *   coord_0(_, topicId)  = H(0x00 ‖ topicId)                          // root, special case
 *   coord_d(P, topicId)  = H(d ‖ prefix(P, d·log₂F) ‖ topicId)        for d ≥ 1
 *
 * `prefix(P, n)` is the n most-significant bits of the peer ring position P (F-ary prefix
 * sharding): peers that share the first `d·log₂F` bits deterministically converge on one
 * tier-`d` coordinate, while the tier byte + topicId keep coordinates uncorrelated across
 * tiers and topics (the collision test exercises both properties). Note coord_0 falls out of
 * the general form at d = 0 (empty prefix, tier byte 0x00) — no separate code path needed.
 */

/** Opaque 32-byte topic label; what it means is application-defined (cohort-topic.md §Concepts). */
export type TopicId = Uint8Array;

export interface TierAddressConfig {
	/** Fan-out per tier; must be a power of two (default 16, log₂F = 4). */
	readonly F: number;
}

export const DEFAULT_TIER_ADDRESS_CONFIG: TierAddressConfig = { F: 16 };

/** `log₂F`, asserting F is a power of two (the F-ary prefix must align to whole bits). */
export function log2F(F: number): number {
	const l = Math.log2(F);
	if (!Number.isInteger(l) || F < 2) {
		throw new RangeError(`F must be a power of two ≥ 2, got ${F}`);
	}
	return l;
}

/**
 * The `nBits` most-significant bits of `P`, packed big-endian into `⌈nBits/8⌉` bytes with the
 * trailing partial byte's unused low bits zeroed. Deterministic and prefix-grouping: two coords
 * sharing the first `nBits` bits yield byte-identical output. `nBits = 0` → empty array.
 */
export function prefixBits(P: RingCoord, nBits: number): Uint8Array {
	if (!Number.isInteger(nBits) || nBits < 0) {
		throw new RangeError(`nBits must be a non-negative integer, got ${nBits}`);
	}
	if (nBits > P.length * 8) {
		throw new RangeError(`nBits ${nBits} exceeds coord width ${P.length * 8}`);
	}
	const nBytes = Math.ceil(nBits / 8);
	const out = new Uint8Array(nBytes);
	const fullBytes = Math.floor(nBits / 8);
	for (let i = 0; i < fullBytes; i++) {
		out[i] = P[i]!;
	}
	const remBits = nBits - fullBytes * 8;
	if (remBits > 0) {
		out[fullBytes] = P[fullBytes]! & (0xff << (8 - remBits));
	}
	return out;
}

/**
 * `coord_d(P, topicId)` for any `d ≥ 0`, via FRET sha256. At `d = 0` the prefix is empty and
 * the tier byte is 0x00, so this reduces to the documented `coord_0 = H(0x00 ‖ topicId)`.
 */
export async function coordForTier(
	ring: RingModel,
	P: RingCoord,
	topicId: TopicId,
	d: number,
	cfg: TierAddressConfig = DEFAULT_TIER_ADDRESS_CONFIG
): Promise<RingCoord> {
	if (!Number.isInteger(d) || d < 0 || d > 0xff) {
		throw new RangeError(`tier d must be an integer in [0, 255], got ${d}`);
	}
	const pre = prefixBits(P, d * log2F(cfg.F));
	const input = new Uint8Array(1 + pre.length + topicId.length);
	input[0] = d;
	input.set(pre, 1);
	input.set(topicId, 1 + pre.length);
	return ring.coordOf(input);
}

/** `coord_0(_, topicId) = H(0x00 ‖ topicId)`. P is irrelevant at the root. */
export async function coord0(ring: RingModel, topicId: TopicId): Promise<RingCoord> {
	return coordForTier(ring, EMPTY_COORD, topicId, 0);
}

/**
 * A participant's full tier coordinate ladder, `ladder[d] = coord_d(P, topicId)` for
 * `d ∈ [0, dMax]`. Pre-deriving the ladder keeps the (async, sha256) addressing entirely out of
 * the synchronous lifecycle walk that consumes it.
 */
export async function buildCoordLadder(
	ring: RingModel,
	P: RingCoord,
	topicId: TopicId,
	dMax: number,
	cfg: TierAddressConfig = DEFAULT_TIER_ADDRESS_CONFIG
): Promise<RingCoord[]> {
	if (!Number.isInteger(dMax) || dMax < 0) {
		throw new RangeError(`dMax must be a non-negative integer, got ${dMax}`);
	}
	const ladder: RingCoord[] = [];
	for (let d = 0; d <= dMax; d++) {
		ladder.push(await coordForTier(ring, P, topicId, d, cfg));
	}
	return ladder;
}

/**
 * A deterministic 32-byte topic id from a label — a simulator convenience for naming topics
 * without a real anchor hash. FNV-1a expanded to 32 bytes; opaque to the layer, like any topicId.
 */
export function deriveTopicId(label: string): TopicId {
	const out = new Uint8Array(32);
	let h = 0x811c9dc5 >>> 0;
	for (let i = 0; i < label.length; i++) {
		h ^= label.charCodeAt(i) & 0xff;
		h = Math.imul(h, 0x0100_0193);
	}
	for (let i = 0; i < out.length; i++) {
		h ^= i;
		h = Math.imul(h, 0x0100_0193);
		out[i] = (h >>> 24) & 0xff;
	}
	return out;
}

/** Placeholder ring position for the root, whose coord ignores P. */
const EMPTY_COORD: RingCoord = new Uint8Array(32);
