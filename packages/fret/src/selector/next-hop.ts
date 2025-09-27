import type { DigitreeStore } from '../store/digitree-store.js'
import { xorDistance, lexLess } from '../ring/distance.js'

export type LinkQuality = (id: string) => number; // [0..1]
export type IsConnected = (id: string) => boolean;

function leadingByteIndex(u8: Uint8Array): number {
	for (let i = 0; i < u8.length; i++) if (u8[i] !== 0) return i;
	return Number.POSITIVE_INFINITY;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function betterByDist(idA: string, distA: Uint8Array, idB: string, distB: Uint8Array): boolean {
	if (lexLess(distA, distB)) return true;
	if (lexLess(distB, distA)) return false;
	// equal distance: tie-break by peer id lex order
	return idA < idB;
}

export function chooseNextHop(
	store: DigitreeStore,
	targetCoord: Uint8Array,
	candidates: string[],
	isConnected: IsConnected,
	linkQ: LinkQuality,
	connectedToleranceBytes = 1 // connected peers within this many leading bytes are preferred
): string | undefined {
	let bestByDist: { id: string; dist: Uint8Array } | undefined;
	const scored: Array<{ id: string; dist: Uint8Array; connected: boolean; score: number }> = [];

	for (const id of candidates) {
		const entry = store.getById(id);
		if (!entry) continue;
		const dist = xorDistance(entry.coord, targetCoord);
		const connected = isConnected(id);
		const score = (connected ? 1 : 0) + 0.25 * linkQ(id);
		scored.push({ id, dist, connected, score });
		if (!bestByDist || betterByDist(id, dist, bestByDist.id, bestByDist.dist)) bestByDist = { id, dist };
	}
	if (!bestByDist) return undefined;

	const bestLead = leadingByteIndex(bestByDist.dist);
	let bestConnected: { id: string; dist: Uint8Array; score: number } | undefined;
	for (const s of scored) {
		if (!s.connected) continue;
		const lead = leadingByteIndex(s.dist);
		if (lead <= bestLead + connectedToleranceBytes) {
			if (!bestConnected) {
				bestConnected = { id: s.id, dist: s.dist, score: s.score };
				continue;
			}
			// Prefer strictly better distance; tie-break by higher score; then by id
			if (betterByDist(s.id, s.dist, bestConnected.id, bestConnected.dist)) {
				bestConnected = { id: s.id, dist: s.dist, score: s.score };
			} else if (equalBytes(s.dist, bestConnected.dist)) {
				if (s.score > bestConnected.score || (s.score === bestConnected.score && s.id < bestConnected.id)) {
					bestConnected = { id: s.id, dist: s.dist, score: s.score };
				}
			}
		}
	}

	return bestConnected?.id ?? bestByDist.id;
}
