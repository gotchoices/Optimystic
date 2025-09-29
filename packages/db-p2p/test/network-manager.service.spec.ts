import { expect } from 'aegir/chai'
import type { Logger } from '@libp2p/interface'
import { NetworkManagerService } from '../src/network/network-manager-service.js'

function makePeer(idStr: string): any { return { toString: () => idStr, toMultihash: () => ({ bytes: new TextEncoder().encode(idStr) }) } }

function makeLibp2p(peers: string[], connections: string[], self: string): any {
  const idObjs = peers.map(makePeer)
  const connObjs = connections.map(makePeer)
  return {
    peerId: makePeer(self),
    peerStore: { getPeers() { return idObjs.map(id => ({ id })) } },
    getConnections() { return connObjs.map(id => ({ remotePeer: id })) },
    peerRouting: { async *getClosestPeers(_key: Uint8Array) { for (const p of idObjs) yield p } }
  }
}

function dummyComponents(): { logger: { forComponent: (name: string) => Logger }, registrar: any, libp2p?: any } {
  const logger: any = { forComponent: () => ({ error() {}, warn() {}, info() {}, debug() {} }) }
  const registrar: any = { handle: async () => {}, unhandle: async () => {} }
  return { logger, registrar }
}

describe('NetworkManagerService - unit', () => {
  it('getCluster returns up to K closest to anchor', async () => {
    const comps = dummyComponents()
    const svc = new NetworkManagerService(comps as any, { clusterSize: 2 }) as any
    const libp2p = makeLibp2p(['a', 'b', 'c'], ['b'], 'self')
    svc.setLibp2p(libp2p)
    const key = new TextEncoder().encode('x')
    const cluster = await svc.getCluster(key)
    expect(cluster.length).to.be.at.least(1)
    expect(cluster.length).to.be.at.most(2)
  })
})

