import { expect } from 'aegir/chai'
import { createLibp2pNode } from '../src/libp2p-node.js'
import { RepoClient } from '../src/index.js'
import { multiaddr } from '@multiformats/multiaddr'
import { sha256 } from 'multiformats/hashes/sha2'

async function startMesh(n: number, basePort: number, clusterSize: number) {
  const nodes: any[] = []
  for (let i = 0; i < n; i++) {
    const node = await createLibp2pNode({ port: basePort + i, bootstrapNodes: [], networkName: 'optimystic-test', dhtClientMode: true, clusterSize })
    nodes.push(node)
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      await nodes[i].dial(multiaddr(`/ip4/127.0.0.1/tcp/${basePort + j}/p2p/${nodes[j].peerId.toString()}`))
    }
  }
  // Wait until peerStore reflects all peers
  const start = Date.now()
  while (Date.now() - start < 3000) {
    const peers: Array<{ id: any }> = (nodes[0] as any).peerStore.getPeers() ?? []
    const remotes = peers.filter(p => p.id.toString() !== (nodes[0] as any).peerId.toString())
    if (remotes.length >= Math.max(0, n - 1)) break
    await new Promise(r => setTimeout(r, 50))
  }
  return nodes
}

describe('FRET integration - mesh sizes', function () {
	this.timeout(40000)
	const basePort = 9111
	const k = 3

	async function runCase(n: number, blockId: string) {
		const nodes = await startMesh(n, basePort + n * 10, k)
		try {
			const digest = await sha256.digest(new TextEncoder().encode(blockId))
			const key = digest.digest
      const fret0: any = (nodes[0] as any).services?.fret
      let cluster: any[] = []
      const expected = Math.min(k, n)
      const t0 = Date.now()
      while (Date.now() - t0 < 5000) {
        cluster = fret0 ? await fret0.getCluster(key) : []
        if (cluster.length >= expected) break
        await new Promise(r => setTimeout(r, 50))
      }
      expect(cluster.length).to.be.at.least(Math.min(1, expected))
      expect(cluster.length).to.be.at.most(expected)
			// For single-node, skip RPC (dialing self is invalid); just assert membership
			if (n === 1) return
			// Find a non-member if any
			const nonMemberIdx = nodes.findIndex((nd: any) => !cluster.some((p: any) => p.toString() === nd.peerId.toString()))
			const clientIdx = nonMemberIdx >= 0 ? nonMemberIdx : 0
			const targetIdx = clientIdx === 0 ? 1 : 0
			const client = (RepoClient as any).create(nodes[targetIdx].peerId, (nodes[clientIdx] as any).peerNetwork)
			const resp = await client.get({ blockIds: [blockId] }, {})
			if (nonMemberIdx >= 0) {
				expect('redirect' in resp).to.equal(true)
				expect(resp.redirect.peers).to.have.length.greaterThan(0)
			} else {
				expect('redirect' in resp).to.equal(false)
			}
		} finally {
			await Promise.all(nodes.map((n: any) => n.stop().catch(() => {})))
		}
	}

	it('n=1', async () => { await runCase(1, 'block-A') })
	it('n=2', async () => { await runCase(2, 'block-B') })
	it('n=5', async () => { await runCase(5, 'block-C') })
})

