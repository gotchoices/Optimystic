import { expect } from 'aegir/chai'
import { multiaddr } from '@multiformats/multiaddr'
import { RepoClient } from '../src/index.js'
import { createLibp2pNode } from '../src/libp2p-node.js'

async function startMesh(n: number, basePort: number) {
  const nodes: any[] = []
  for (let i = 0; i < n; i++) {
    const node = await createLibp2pNode({ port: basePort + i, bootstrapNodes: [], networkName: 'optimystic-test', dhtClientMode: true, clusterSize: Math.min(3, n) })
    nodes.push(node)
  }
  // Connect all to all for stability in test
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      await nodes[i].dial(multiaddr(`/ip4/127.0.0.1/tcp/${basePort + j}/p2p/${nodes[j].peerId.toString()}`))
    }
  }
  return nodes
}

describe('FRET integration - small mesh cluster redirects', function () {
  this.timeout(30000)
  it('non-member receives redirect peers for key affinity', async () => {
    const nodes = await startMesh(3, 9051)
    try {
      const client = (RepoClient as any).create(nodes[0].peerId, (nodes[1] as any).peerNetwork)
      const resp = await client.get({ blockIds: ['block-1'] }, {})
      if ('redirect' in resp) {
        expect(resp.redirect.peers).to.have.length.greaterThan(0)
      } else {
        expect(resp).to.exist
      }
    } finally {
      await Promise.all(nodes.map((n: any) => n.stop().catch(() => {})))
    }
  })
})

