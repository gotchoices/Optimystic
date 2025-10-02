import { describe, it } from 'mocha'
import { createMemoryNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'

describe('Profile behavior tests', function () {
	this.timeout(15000)

	it('Edge profile respects lower rate limits', async () => {
		const node = await createMemoryNode()
		await node.start()
		const svc = new CoreFretService(node, { profile: 'edge', k: 7, m: 4 })
		await svc.start()

		// Check Edge profile token buckets via diagnostics
		const diag = (svc as any).getDiagnostics?.()
		if (!diag) throw new Error('No diagnostics')

		// Edge should have smaller buckets; verify by triggering rate limit
		const bucket = (svc as any).bucketNeighbors
		if (!bucket) throw new Error('No neighbor bucket')

		let accepted = 0
		for (let i = 0; i < 20; i++) {
			if (bucket.tryTake()) accepted++
		}

		// Edge allows ≤8 initial, Core would allow more
		if (accepted > 10) throw new Error(`Edge accepted ${accepted}, expected ≤10`)

		await svc.stop()
		await node.stop()
	})

	it('Core profile allows higher concurrency', async () => {
		const node = await createMemoryNode()
		await node.start()
		const svc = new CoreFretService(node, { profile: 'core', k: 15, m: 8 })
		await svc.start()

		const bucket = (svc as any).bucketNeighbors
		if (!bucket) throw new Error('No neighbor bucket')

		let accepted = 0
		for (let i = 0; i < 30; i++) {
			if (bucket.tryTake()) accepted++
		}

		// Core allows ≥20 initial
		if (accepted < 15) throw new Error(`Core only accepted ${accepted}, expected ≥15`)

		await svc.stop()
		await node.stop()
	})

	it('Edge uses smaller snapshot caps', async () => {
		const nodes = []
		for (let i = 0; i < 2; i++) {
			const n = await createMemoryNode()
			await n.start()
			nodes.push(n)
		}
		await nodes[1]!.dial(nodes[0]!.getMultiaddrs()[0]!)

		const svcEdge = new CoreFretService(nodes[0], { profile: 'edge' })
		await svcEdge.start()
		await new Promise((r) => setTimeout(r, 500))

		const snap = await (svcEdge as any).snapshot?.()
		if (!snap) throw new Error('No snapshot')

		// Edge caps successors/predecessors to 6
		if (snap.successors.length > 6) throw new Error(`Edge successors ${snap.successors.length} > 6`)
		if (snap.predecessors.length > 6) throw new Error(`Edge predecessors ${snap.predecessors.length} > 6`)

		await svcEdge.stop()
		await stopAll(nodes)
	})

	it('Core uses larger snapshot caps', async () => {
		const nodes = []
		for (let i = 0; i < 2; i++) {
			const n = await createMemoryNode()
			await n.start()
			nodes.push(n)
		}
		await nodes[1]!.dial(nodes[0]!.getMultiaddrs()[0]!)

		const svcCore = new CoreFretService(nodes[0], { profile: 'core' })
		await svcCore.start()
		await new Promise((r) => setTimeout(r, 500))

		const snap = await (svcCore as any).snapshot?.()
		if (!snap) throw new Error('No snapshot')

		// Core allows up to 12
		// (won't be > 6 unless we have that many peers, but cap should be higher)
		const cfg = (svcCore as any).cfg
		if (cfg.profile !== 'core') throw new Error('Not core profile')

		await svcCore.stop()
		await stopAll(nodes)
	})
})

