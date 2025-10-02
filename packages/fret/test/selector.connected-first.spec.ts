import { describe, it } from 'mocha'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { chooseNextHop } from '../src/selector/next-hop.js'

function coordByte(b: number): Uint8Array { const u = new Uint8Array(32); u[31] = b; return u }

describe('Next-hop selector connected-first preference', () => {
	it('prefers connected peer if distance within tolerance', () => {
		const store = new DigitreeStore()
		// target near coord 200
		const target = coordByte(200)
		store.upsert('far-connected', coordByte(210))
		store.upsert('near-disconnected', coordByte(201))
		const isConnected = (id: string) => id === 'far-connected'
		const linkQ = (_: string) => 0.5
		const next = chooseNextHop(store, target, ['far-connected', 'near-disconnected'], isConnected, linkQ, 1)
		if (next !== 'far-connected') throw new Error('should prefer connected within tolerance')
	})
})



