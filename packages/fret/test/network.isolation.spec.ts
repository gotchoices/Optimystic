import { describe, it } from 'mocha'
import { createMemoryNode, stopAll } from './helpers/libp2p.js'
import { FretService as CoreFretService } from '../src/service/fret-service.js'

describe('Network isolation', function () {
	this.timeout(15000)

	it('different networkNames cannot exchange neighbor snapshots', async () => {
		const nodeA = await createMemoryNode()
		await nodeA.start()
		const nodeB = await createMemoryNode()
		await nodeB.start()
		await nodeB.dial(nodeA.getMultiaddrs()[0]!)

		const svcA = new CoreFretService(nodeA, { profile: 'edge', networkName: 'network-alpha' })
		const svcB = new CoreFretService(nodeB, { profile: 'edge', networkName: 'network-beta' })
		await svcA.start()
		await svcB.start()

		await new Promise((r) => setTimeout(r, 1000))

		// Nodes should not have discovered each other due to protocol mismatch
		const diagA = (svcA as any).getDiagnostics?.()
		const diagB = (svcB as any).getDiagnostics?.()

		// No snapshots should be fetched across networks
		if ((diagA.snapshotsFetched ?? 0) > 0 || (diagB.snapshotsFetched ?? 0) > 0) {
			throw new Error('Cross-network snapshot exchange occurred')
		}

		await svcA.stop()
		await svcB.stop()
		await stopAll([nodeA, nodeB])
	})

	it('same networkName allows neighbor snapshots', async () => {
		const nodeA = await createMemoryNode()
		await nodeA.start()
		const nodeB = await createMemoryNode()
		await nodeB.start()
		await nodeB.dial(nodeA.getMultiaddrs()[0]!)

		const svcA = new CoreFretService(nodeA, {
			profile: 'edge',
			networkName: 'network-gamma'
		})
		const svcB = new CoreFretService(nodeB, {
			profile: 'edge',
			networkName: 'network-gamma',
			bootstraps: [nodeA.peerId.toString()]
		})
		await svcA.start()
		await svcB.start()

		await new Promise((r) => setTimeout(r, 2000))

		// Nodes in same network should discover each other
		const storeB = (svcB as any).store
		const peersB = storeB.list().map((p: any) => p.id)

		// B should have discovered A via bootstrap
		const hasA = peersB.includes(nodeA.peerId.toString())

		if (!hasA) {
			throw new Error(`Same-network discovery failed: B did not discover A`)
		}

		await svcA.stop()
		await svcB.stop()
		await stopAll([nodeA, nodeB])
	})
})

