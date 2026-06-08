import { sha256 } from '@noble/hashes/sha2.js';
import type { IRingHash, RingCoord } from './ports.js';

/**
 * Default ring width in bits. 256 = the full SHA-256 digest, which lines up byte-for-byte with
 * FRET's coordinate type (FRET hashes ring keys with SHA-256). Override only when targeting a
 * DHT with a narrower ring.
 */
export const RING_BITS = 256;

/**
 * db-core's {@link IRingHash}, backed by its own SHA-256 (the same digest db-core already uses
 * for logs and block ids) — **not** an import of any FRET hash module. This keeps db-core
 * FRET-free while guaranteeing on-the-wire coord compatibility: at the default `ringBits = 256`,
 * `H(bytes)` is the full SHA-256 digest, identical to what FRET produces for the same input.
 *
 * For ring widths that are not a whole number of bytes, the digest is truncated to
 * `ceil(ringBits / 8)` bytes and the trailing partial byte's unused low bits are zeroed, so two
 * inputs whose digests share the first `ringBits` bits yield byte-identical coords.
 */
export class RingHash implements IRingHash {
	public readonly ringBits: number;
	private readonly nBytes: number;
	private readonly tailMask: number;

	constructor(ringBits: number = RING_BITS) {
		if (!Number.isInteger(ringBits) || ringBits <= 0 || ringBits > 256) {
			throw new RangeError(`ringBits must be an integer in [1, 256], got ${ringBits}`);
		}
		this.ringBits = ringBits;
		this.nBytes = Math.ceil(ringBits / 8);
		const remBits = ringBits - (this.nBytes - 1) * 8;
		this.tailMask = remBits === 8 ? 0xff : (0xff << (8 - remBits)) & 0xff;
	}

	H(bytes: Uint8Array): RingCoord {
		const digest = sha256(bytes);
		if (this.nBytes === digest.length && this.tailMask === 0xff) {
			return digest;
		}
		const coord = digest.slice(0, this.nBytes);
		coord[this.nBytes - 1] = coord[this.nBytes - 1]! & this.tailMask;
		return coord;
	}
}

/** Convenience factory mirroring the db-p2p adapter construction style. */
export function createRingHash(ringBits: number = RING_BITS): IRingHash {
	return new RingHash(ringBits);
}
