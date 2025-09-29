import type { PeerId } from '@libp2p/interface'

export type RingCoord = Uint8Array

export function xorDistance(a: Uint8Array, b: Uint8Array): Uint8Array {
	const len = Math.max(a.length, b.length)
	const out = new Uint8Array(len)
	for (let i = 0; i < len; i++) {
		const ai = a[a.length - 1 - i] ?? 0
		const bi = b[b.length - 1 - i] ?? 0
		out[len - 1 - i] = ai ^ bi
	}
	return out
}

export function lessLex(a: Uint8Array, b: Uint8Array): boolean {
	const len = Math.max(a.length, b.length)
	for (let i = 0; i < len; i++) {
		const av = a[i] ?? 0
		const bv = b[i] ?? 0
		if (av < bv) return true
		if (av > bv) return false
	}
	return false
}

export function coordOfPeer(peerId: PeerId): RingCoord {
	return peerId.toMultihash().bytes
}

export function sortByDistanceTo(target: Uint8Array, coords: Array<{ id: PeerId }>): Array<{ id: PeerId }>{
	return coords
		.map(p => ({ p, d: xorDistance(coordOfPeer(p.id), target) }))
		.sort((a, b) => (lessLex(a.d, b.d) ? -1 : 1))
		.map(x => x.p)
}

