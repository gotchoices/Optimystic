import { randomBytes } from '@libp2p/crypto';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Generates a unique transaction stamp ID that includes a hash of the peer ID
 * to reduce collision probability across distributed nodes.
 *
 * Format: {peerIdHash}-{randomBytes}
 * - peerIdHash: First 16 bytes of SHA-256 hash of peer ID (base64url)
 * - randomBytes: 16 random bytes (base64url)
 * - Total: 32 bytes, base64url encoded
 *
 * @param peerId Optional peer ID to include in the hash. If not provided, only random bytes are used.
 * @returns A unique transaction stamp ID string
 */
export function generateStampId(peerId?: string): string {
	const randomPart = randomBytes(16);

	if (peerId) {
		// Hash the peer ID and take first 16 bytes
		const peerIdBytes = new TextEncoder().encode(peerId);
		const peerIdHash = sha256(peerIdBytes);
		const peerIdHashPart = peerIdHash.slice(0, 16);

		// Combine peer ID hash and random bytes
		const combined = new Uint8Array(32);
		combined.set(peerIdHashPart, 0);
		combined.set(randomPart, 16);

		return uint8ArrayToString(combined, 'base64url');
	}

	// Fallback: just use random bytes (padded to 32 bytes for consistency)
	const fallback = new Uint8Array(32);
	fallback.set(randomPart, 0);
	fallback.set(randomBytes(16), 16);

	return uint8ArrayToString(fallback, 'base64url');
}

