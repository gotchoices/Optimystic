import { describe, it } from 'mocha'
import { createMemoryNode, connectLine, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'
import { fromString as u8FromString } from 'uint8arrays/from-string'

async function makeMesh(n: number) {
	const nodes = [] as any[]
	for (let i = 0; i < n; i++) { const node = await createMemoryNode(); await node.start(); nodes.push(node) }
	await connectLine(nodes)
	const services = [] as any[]
	for (let i = 0; i < n; i++) {
		const boot = i === 0 ? [] : [nodes[0]!.peerId.toString()]
		const svc = new CoreFretService(nodes[i], { profile: 'edge', k: 7, bootstraps: boot })
		await svc.start()
		services.push(svc)
	}
	return { nodes, services }
}

describe('maybeAct routing', function () {
	this.timeout(20000)

	it('returns near anchors and cohort hints with breadcrumbs', async () => {
		const { nodes, services } = await makeMesh(3)
		await new Promise(r => setTimeout(r, 1500))
		const msg = {
			v: 1,
			key: 'aWQ', // 'id' base64url
			want_k: 7,
			wants: 5,
			ttl: 3,
			min_sigs: 3,
			digest: 'Zg',
			breadcrumbs: [] as string[],
			correlation_id: 'Yw',
			timestamp: Date.now(),
			signature: ''
		}
		const res = await services[1].routeAct(msg)
		if (!('anchors' in res)) throw new Error('expected NearAnchor response')
		if ((res as any).anchors.length === 0) throw new Error('no anchors returned')
		await Promise.all(services.map((s: any) => s.stop()))
		await stopAll(nodes)
	})
})


