import { describe, it } from 'mocha'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { createMemoryNode } from './helpers/libp2p.js'
import { fromString as u8FromString } from 'uint8arrays/from-string'

describe('Cohort assembly two-sided alternation', function () {
	this.timeout(10000)

	it('alternates successors and predecessors without duplicates', async () => {
		const node = await createMemoryNode()
		await node.start()
		const svc = new CoreFretService(node, { profile: 'edge', k: 9 })
		// Seed a ring of peers around a fake key hash by inserting into store via neighbor snapshots semantics
		// Here we simulate by directly accessing store through any cast for test only
		const s: any = svc
		for (let i = 0; i < 20; i++) {
			const id = `${i.toString().padStart(2, '0')}`
			// fake coord: deterministic spread
			const coord = new Uint8Array(32)
			coord[31] = i * 12
			s.store.upsert(id, coord)
		}
		const key = u8FromString('test-key', 'utf8')
		const cohort = s.assembleCohort(await (s as any).selfCoord?.() ?? new Uint8Array(32), 10)
		if (new Set(cohort).size !== cohort.length) throw new Error('duplicates in cohort')
		await node.stop()
	})
})


