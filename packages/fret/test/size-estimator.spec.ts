import { describe, it } from 'mocha'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { estimateSizeAndConfidence } from '../src/estimate/size-estimator.js'

function coordByte(b: number): Uint8Array { const u = new Uint8Array(32); u[31] = b; return u }

describe('Size estimator', () => {
	it('increases confidence with more peers and balanced gaps', () => {
		const storeFew = new DigitreeStore()
		storeFew.upsert('a', coordByte(0))
		storeFew.upsert('b', coordByte(128))
		const few = estimateSizeAndConfidence(storeFew, 8)
		const storeMany = new DigitreeStore()
		for (let i = 0; i < 16; i++) storeMany.upsert(`p${i}`, coordByte((i * 16) & 255))
		const many = estimateSizeAndConfidence(storeMany, 8)
		if (!(many.confidence > few.confidence)) throw new Error('confidence should increase')
	})
})



