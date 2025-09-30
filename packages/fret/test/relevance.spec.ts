import { describe, it } from 'mocha'
import { createSparsityModel, touch, recordSuccess, recordFailure, normalizedLogDistance } from '../src/store/relevance.js'
import { DigitreeStore } from '../src/store/digitree-store.js'

function coord(n: number): Uint8Array {
	const u = new Uint8Array(32)
	u[31] = n & 0xff
	return u
}

describe('relevance scoring', () => {
	it('touch increases accessCount and updates lastAccess', () => {
		const s = new DigitreeStore()
		const id = 'p1'
		const c = coord(1)
		const e = s.upsert(id, c)
		const model = createSparsityModel()
		const x = normalizedLogDistance(c, coord(2))
		const next = touch(e, x, model, Date.now())
		if (next.accessCount !== e.accessCount + 1) throw new Error('accessCount not incremented')
		if (next.lastAccess < e.lastAccess) throw new Error('lastAccess not updated')
	})

	it('success updates avgLatency and increases successCount', () => {
		const s = new DigitreeStore()
		const id = 'p2'
		const c = coord(2)
		const e = s.upsert(id, c)
		const model = createSparsityModel()
		const x = normalizedLogDistance(c, coord(130))
		const next = recordSuccess(e, 50, x, model, Date.now())
		if (next.successCount !== e.successCount + 1) throw new Error('successCount not incremented')
		if (next.avgLatencyMs <= 0) throw new Error('avgLatency not set')
	})

	it('failure increases failureCount and does not crash', () => {
		const s = new DigitreeStore()
		const id = 'p3'
		const c = coord(3)
		const e = s.upsert(id, c)
		const model = createSparsityModel()
		const x = normalizedLogDistance(c, coord(200))
		const next = recordFailure(e, x, model, Date.now())
		if (next.failureCount !== e.failureCount + 1) throw new Error('failureCount not incremented')
	})
})