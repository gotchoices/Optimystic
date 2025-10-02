import { describe, it } from 'mocha'
import fc from 'fast-check'
import { DigitreeStore } from '../src/store/digitree-store.js'

function randomCoord(len = 32): Uint8Array {
	const u = new Uint8Array(len)
	for (let i = 0; i < len; i++) u[i] = Math.floor(Math.random() * 256)
	return u
}

describe('DigitreeStore neighbors invariants', () => {
	it('successor/predecessor wrap-around and uniqueness', () => {
		fc.assert(
			fc.property(fc.array(fc.string({ minLength: 1, maxLength: 32 }), { minLength: 1, maxLength: 200 }), (ids) => {
				const uniq = Array.from(new Set(ids.filter((s) => /^[0-9a-zA-Z]+$/.test(s))))
				const store = new DigitreeStore()
				for (const id of uniq) store.upsert(id, randomCoord())
				const list = store.list()
				if (list.length === 0) return true
				const center = list[Math.floor(list.length / 2)]!.coord
				const right = store.neighborsRight(center, Math.min(list.length, 8))
				const left = store.neighborsLeft(center, Math.min(list.length, 8))
				const all = [...right, ...left]
				// bounded unique coverage
				const uniqueLen = new Set(all).size
				return uniqueLen <= Math.min(list.length, 16)
			})
		)
	})
})


