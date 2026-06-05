import type { PeerRef, SeededRng } from './types.js';

/** Bytes in a synthetic peer key — 256 bits, sized for the ring math added downstream. */
const KEY_BYTES = 32;

/**
 * Decision 5 — deterministically generate `count` synthetic peers from an rng stream. These
 * are opaque ids, NOT real libp2p PeerIds (real keygen does not scale to 1M). XOR-distance
 * ring placement over these keys is `simulator-fret-cohort-model`'s job, not the engine's.
 *
 * Pass a forked stream (e.g. `rng.fork('peers')`) when you want peer generation insulated
 * from the rest of the simulation's draws.
 */
export function generatePeers(count: number, rng: SeededRng): PeerRef[] {
	if (!Number.isInteger(count) || count < 0) {
		throw new RangeError(`count must be a non-negative integer, got ${count}`);
	}
	const peers: PeerRef[] = [];
	for (let i = 0; i < count; i++) {
		peers.push(makePeer(rng));
	}
	return peers;
}

function makePeer(rng: SeededRng): PeerRef {
	const key = new Uint8Array(KEY_BYTES);
	for (let word = 0; word < KEY_BYTES / 4; word++) {
		const value = rng.nextU32();
		const base = word * 4;
		key[base] = (value >>> 24) & 0xff;
		key[base + 1] = (value >>> 16) & 0xff;
		key[base + 2] = (value >>> 8) & 0xff;
		key[base + 3] = value & 0xff;
	}
	return { id: toHex(key), key };
}

function toHex(bytes: Uint8Array): string {
	let hex = '';
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, '0');
	}
	return hex;
}
