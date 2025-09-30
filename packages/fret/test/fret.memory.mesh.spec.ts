import { describe, it } from 'mocha'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { FretService as CoreFretService } from '../src/service/fret-service.js'

async function createNode(name: string) {
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()]
  })
  return node
}

function toPeerIds(node: any): string[] { return [node.peerId.toString()] }

describe('FRET 3-node memory mesh', function () {
  this.timeout(30000)

  it('exchanges neighbor snapshots and returns anchors', async () => {
    const a = await createNode('a'); await a.start()
    const b = await createNode('b'); await b.start()
    const c = await createNode('c'); await c.start()

    const sa = new CoreFretService(a, {})
    const sb = new CoreFretService(b, { bootstraps: toPeerIds(a) })
    const sc = new CoreFretService(c, { bootstraps: toPeerIds(a) })
    await sa.start(); await sb.start(); await sc.start()

    await new Promise(r => setTimeout(r, 2000))

    const diagB = (sb as any).getDiagnostics?.()
    const diagC = (sc as any).getDiagnostics?.()
    if (!diagB || !diagC) throw new Error('missing diagnostics')

    // Route maybeAct near self
    const msg = { v: 1 as const, key: 'AA', want_k: 3, ttl: 3, min_sigs: 2, correlation_id: 'xyz', timestamp: Date.now(), signature: '' }
    const res = await sb.routeAct(msg as any)
    if (!('anchors' in res) || (res.anchors ?? []).length === 0) throw new Error('no anchors returned')

    await sc.stop(); await sb.stop(); await sa.stop()
    await c.stop(); await b.stop(); await a.stop()
  })
})

