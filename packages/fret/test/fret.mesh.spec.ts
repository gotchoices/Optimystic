import { describe, it } from 'mocha'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { FretService as CoreFretService } from '../src/service/fret-service.js'

async function createNode() {
    const node = await createLibp2p({
        addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()]
    })
    return node
}

function toMultiaddrs(node: any): string[] {
	return node.getMultiaddrs().map((ma: any) => ma.toString())
}

describe('FRET basic mesh', function () {
	this.timeout(20000)

	it('starts two nodes and exchanges discovery', async () => {
    const a = await createNode()
		await a.start()
		const addrs = a.getMultiaddrs()

    const b = await createNode()
		await b.start()
		await b.dial(addrs[0]!)

    const serviceA = new CoreFretService(a, {})
    const serviceB = new CoreFretService(b, { bootstraps: toMultiaddrs(a) })
    await serviceA.start()
    await serviceB.start()

    // wait a moment for stabilization ticks
    await new Promise(r => setTimeout(r, 1500))

		// read diagnostics via service wrapper
    const diag = (serviceB as any).getDiagnostics?.()
		if (!diag) throw new Error('Missing diagnostics')

    await serviceB.stop()
    await serviceA.stop()
		await b.stop()
		await a.stop()
	})
})
