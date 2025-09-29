import type { PeerId } from '@libp2p/interface'
import { xorDistance, coordOfPeer, lessLex } from './ring.js'

export type CohortResult = { anchors: [PeerId, PeerId], cohort: PeerId[] }

export function assembleTwoSidedCohort(
	key: Uint8Array,
	peers: PeerId[],
	wants: number
): CohortResult {
	if (peers.length === 0) return { anchors: [undefined as unknown as PeerId, undefined as unknown as PeerId], cohort: [] }
	const distances = peers.map(p => ({ p, d: xorDistance(coordOfPeer(p), key) }))
	distances.sort((a, b) => (lessLex(a.d, b.d) ? -1 : 1))
	const succ = distances[0]!.p
	const pred = distances[1]?.p ?? succ
	const anchors: [PeerId, PeerId] = [succ, pred]

	const sorted = distances.map(x => x.p)
	const cohort: PeerId[] = []
	let i = 0
	let lo = sorted.indexOf(succ)
	let hi = sorted.indexOf(pred)
	if (hi < 0) hi = lo
	while (cohort.length < wants && (lo >= 0 || hi < sorted.length)) {
		if (i % 2 === 0) {
			if (lo >= 0) cohort.push(sorted[lo]!)
			--lo
		} else {
			if (hi < sorted.length) cohort.push(sorted[hi]!)
			++hi
		}
		++i
	}
	return { anchors, cohort }
}

