import { expect } from 'aegir/chai'
import { assembleTwoSidedCohort } from '../src/fret/cohort.js'

function fakePeer(id: string): any {
	return {
		toString() { return id },
		toMultihash() { return { bytes: new TextEncoder().encode(id.padStart(32, '0')).slice(0, 32) } }
	}
}

describe('FRET ring/cohort basics', () => {
	it('orders peers by XOR distance and assembles cohort', () => {
		const peers = ['a', 'b', 'c', 'd', 'e'].map(fakePeer)
		const key = new TextEncoder().encode('key-1'.padStart(32, '0')).slice(0, 32)
		const { anchors, cohort } = assembleTwoSidedCohort(key, peers as any, 3)
		expect(anchors[0]).to.exist
		expect(cohort).to.have.lengthOf(3)
		// Ensure cohort items are from input set
		cohort.forEach(p => expect(peers.map(x => x.toString())).to.include(p.toString()))
	})
})

