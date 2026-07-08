/**
 * Cohort-topic substrate — tier addressing (`coord_d`).
 *
 * Transcribed from `docs/cohort-topic.md` §Tier addressing:
 *
 * ```
 * coord_0(_, topicId) = H(0x00 ‖ topicId)
 * coord_d(P, topicId) = H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)   for d ≥ 1
 * ```
 *
 * `P` is ring-hashed before the prefix so the shard input is uniformly distributed across
 * participants (the raw peer-id string bytes share a near-constant `12D3Koo…` prefix that would
 * collapse all tier-`d` shards to one coordinate). The wire field `participantCoord` keeps the
 * unmodified peer id so the Ed25519 key remains recoverable; the ring-hash is applied only inside
 * the addressing math.
 *
 * `H` is the injected {@link IRingHash} (db-core's own SHA-256 truncated to the ring width — **not**
 * a FRET import). `prefix(P, n)` is the `n` most-significant bits of peer id `P`, left-padded if
 * shorter. `F` is the fan-out (default 16, `log₂F = 4`); tier `d` has exactly `F^d` coordinates.
 *
 * The db-p2p binding is responsible for ensuring the coord byte layout (ring width) matches FRET's
 * `RING_BITS` so the routing keys produced here line up with FRET's ring on the wire.
 */

import type { IRingHash, RingCoord } from "./ports.js";

/** Tier-addressing surface — derives the ring coordinate for tier `d` of a topic. */
export interface TierAddressing {
	/** Fan-out per tier (default 16). */
	readonly F: number;
	/** Tier-0 root coordinate: `H(0x00 ‖ topicId)`. Peer-independent. */
	coord0(topicId: Uint8Array): RingCoord;
	/** Tier-`d` coordinate for `d ≥ 1`: `H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)` where `H(P)` is the ring-hash of `peerId`. */
	coordD(d: number, peerId: Uint8Array, topicId: Uint8Array): RingCoord;
	/** Dispatches `d === 0` to {@link coord0}, otherwise to {@link coordD}. */
	coord(d: number, peerId: Uint8Array, topicId: Uint8Array): RingCoord;
}

/** Default fan-out per tier (`log₂16 = 4`). */
export const DEFAULT_FANOUT = 16;

/**
 * `prefix(P, n)` — the `n` most-significant bits of `P`, packed MSB-first into `⌈n/8⌉` bytes with
 * the trailing partial byte's unused low bits zeroed. If `P` carries fewer than `n` bits it is
 * **left-padded**: the high `(n − bits(P))` positions are zero and `P`'s bits occupy the low end, so
 * the result is always exactly `n` bits wide. `n === 0` yields an empty array (the tier-0 case).
 *
 * Exported for tests; not part of the public substrate surface.
 */
export function prefixBits(peerId: Uint8Array, n: number): Uint8Array {
	if (!Number.isInteger(n) || n < 0) {
		throw new RangeError(`prefix bit count must be a non-negative integer, got ${n}`);
	}
	const outBytes = Math.ceil(n / 8);
	const out = new Uint8Array(outBytes);
	const available = peerId.length * 8;
	const pad = Math.max(0, n - available);
	for (let j = 0; j < n; j++) {
		// Result bit j (MSB-first). High `pad` positions are zero (left-pad); the rest map to P.
		if (j < pad) continue;
		const srcBit = j - pad;
		const srcByte = peerId[srcBit >>> 3]!;
		const bit = (srcByte >>> (7 - (srcBit & 7))) & 1;
		if (bit) out[j >>> 3]! |= 1 << (7 - (j & 7));
	}
	return out;
}

/** Implements {@link TierAddressing} over an injected {@link IRingHash}. */
export class HashTierAddressing implements TierAddressing {
	public readonly F: number;
	private readonly log2F: number;

	constructor(private readonly hash: IRingHash, F: number = DEFAULT_FANOUT) {
		if (!Number.isInteger(F) || F < 2) {
			throw new RangeError(`fan-out F must be an integer ≥ 2, got ${F}`);
		}
		const log2F = Math.log2(F);
		if (!Number.isInteger(log2F)) {
			throw new RangeError(`fan-out F must be a power of two, got ${F}`);
		}
		this.F = F;
		this.log2F = log2F;
	}

	coord0(topicId: Uint8Array): RingCoord {
		// H(0x00 ‖ topicId)
		const input = new Uint8Array(1 + topicId.length);
		input[0] = 0x00;
		input.set(topicId, 1);
		return this.hash.H(input);
	}

	coordD(d: number, peerId: Uint8Array, topicId: Uint8Array): RingCoord {
		if (!Number.isInteger(d) || d < 1) {
			throw new RangeError(`coordD requires an integer tier d ≥ 1, got ${d}`);
		}
		if (d > 255) {
			throw new RangeError(`tier d must fit in one byte (≤ 255), got ${d}`);
		}
		// H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)  — ring-hash P first so the shard input is uniform
		// NOTE: re-hashes peerId on every coordD call; a walk over a tier ladder recomputes H(self) per
		// tier. Negligible today (walk steps are network-bound); if coord becomes hot, cache H(peerId).
		const prefix = prefixBits(this.hash.H(peerId), d * this.log2F);
		const input = new Uint8Array(1 + prefix.length + topicId.length);
		input[0] = d;
		input.set(prefix, 1);
		input.set(topicId, 1 + prefix.length);
		return this.hash.H(input);
	}

	coord(d: number, peerId: Uint8Array, topicId: Uint8Array): RingCoord {
		return d === 0 ? this.coord0(topicId) : this.coordD(d, peerId, topicId);
	}
}

/** Convenience factory mirroring the db-p2p adapter construction style. */
export function createTierAddressing(hash: IRingHash, F: number = DEFAULT_FANOUT): TierAddressing {
	return new HashTierAddressing(hash, F);
}
