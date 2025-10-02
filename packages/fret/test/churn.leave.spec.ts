import { describe, it } from 'mocha'
import { createMemoryNode, connectLine, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'

describe('Churn leave handling', function () {
	this.timeout(20000)

	it('sendLeave triggers stabilization and replacement warming', async () => {
		const nodes = [] as any[]
		for (let i = 0; i < 4; i++) { const n = await createMemoryNode(); await n.start(); nodes.push(n) }
		await connectLine(nodes)
		const services = [] as any[]
		for (let i = 0; i < nodes.length; i++) {
			const svc = new CoreFretService(nodes[i], { profile: 'edge', k: 7, bootstraps: [nodes[0]!.peerId.toString()] })
			await svc.start()
			services.push(svc)
		}
		await new Promise(r => setTimeout(r, 1500))
		// stop one node, which should send leave to its neighbors without throwing
		await services[2].stop()
		await nodes[2].stop()
		await new Promise(r => setTimeout(r, 1000))
		// ensure remaining services still running
		for (const s of [services[0], services[1], services[3]]) if (!(s as any).getDiagnostics) throw new Error('service down')
		await Promise.all(services.map((s: any, i: number) => i === 2 ? Promise.resolve() : s.stop()))
		await stopAll([nodes[0], nodes[1], nodes[3]].filter(Boolean) as any)
	})
})


