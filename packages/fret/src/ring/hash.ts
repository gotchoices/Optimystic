import type { PeerId } from '@libp2p/interface';
import { sha256 } from 'multiformats/hashes/sha2';
import { toString as u8ToString } from 'uint8arrays/to-string';
import { fromString as u8FromString } from 'uint8arrays/from-string';

export const RING_BITS = 256;
export const COORD_BYTES = 32;

export type RingCoord = Uint8Array;

export async function hashPeerId(peerId: PeerId): Promise<RingCoord> {
	// Use raw multihash bytes of peerId as input
	const bytes = peerId.toMultihash().bytes;
	const digest = await sha256.encode(bytes);
	return digest;
}

export async function hashKey(key: Uint8Array): Promise<RingCoord> {
	const digest = await sha256.encode(key);
	return digest;
}

export function coordToHex(coord: RingCoord): string {
	// Fixed-length 64 hex chars
	let s = '';
	for (let i = 0; i < coord.length; i++) {
		const b = coord[i]!.toString(16).padStart(2, '0');
		s += b;
	}
	return s;
}

export function hexToCoord(hex: string): RingCoord {
	const out = new Uint8Array(COORD_BYTES);
	for (let i = 0; i < COORD_BYTES; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

export function coordToBase64url(coord: RingCoord): string {
	return u8ToString(coord, 'base64url');
}

export function base64urlToCoord(s: string): RingCoord {
	return u8FromString(s, 'base64url');
}
