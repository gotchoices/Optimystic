import { createLibp2p } from 'libp2p'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'

export async function createMemoryNode() {
	const node = await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()]
	})
	return node
}

export async function connectLine(nodes: any[]): Promise<void> {
	for (let i = 1; i < nodes.length; i++) {
		const ma = nodes[i - 1]!.getMultiaddrs()[0]
		await nodes[i]!.dial(ma)
	}
}

export async function stopAll(nodes: any[]): Promise<void> {
	for (const n of nodes.reverse()) {
		try { await n.stop() } catch {}
	}
}

export function toMultiaddrs(node: any): string[] {
	return node.getMultiaddrs().map((ma: any) => ma.toString())
}


