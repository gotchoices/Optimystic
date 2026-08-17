import { hashKey, minDistance, type RingCoord } from 'p2p-fret';

export type { RingCoord };

/** Big-endian bytes → bigint, matching FRET's coordinate ordering (size-estimator.ts). */
function bytesToBigInt(bytes: Uint8Array): bigint {
	let v = 0n;
	for (let i = 0; i < bytes.length; i++) {
		v = (v << 8n) | BigInt(bytes[i]!);
	}
	return v;
}

/**
 * Ring-coordinate derivation and ring distance, delegated to real FRET (`hashKey`,
 * `minDistance`). Nothing here reimplements the hash or the distance — the simulator measures
 * the *same* coordinate distribution production sees.
 *
 * The metric is FRET's own `minDistance`: the shorter of the two arcs between the coordinates,
 * so the ring's wrap-around point behaves like every other point. FRET measures routing,
 * payload inclusion, and relevance sparsity with it, and it replaced the earlier XOR metric —
 * following it here is what keeps "same distribution as production" true.
 *
 * `coordOf` is async because FRET hashes with sha256 (`hashKey` returns a Promise). This is
 * the only async seam in the model and runs at seeding time, never inside a scheduler event;
 * sha256 is deterministic, so byte-reproducibility is unaffected. Real peers are placed via
 * FRET `hashPeerId`; synthetic simulator peers carry an opaque 256-bit `key`, so we use
 * `hashKey` — the same digest production applies to non-PeerId ring keys.
 */
export class RingModel {
	/** Ring coordinate for a synthetic peer/key, via FRET `hashKey` (sha256). */
	async coordOf(key: Uint8Array): Promise<RingCoord> {
		return hashKey(key);
	}

	/** Ring distance between two coordinates as a bigint, via FRET `minDistance`. */
	distance(a: RingCoord, b: RingCoord): bigint {
		return bytesToBigInt(minDistance(a, b));
	}
}
