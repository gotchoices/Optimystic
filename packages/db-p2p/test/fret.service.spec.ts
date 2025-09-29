import { expect } from 'aegir/chai'
import type { Logger } from '@libp2p/interface'
import { FretService } from '../src/fret/service.js'

function makePeer(idStr: string): any {
  const bytes = new TextEncoder().encode(idStr.padStart(32, '0')).slice(0, 32)
  return {
    toString() { return idStr },
    toMultihash() { return { bytes } }
  }
}

function makeLibp2p(selfId: any, others: any[]): any {
  return {
    peerId: selfId,
    peerStore: { getPeers() { return others.map(id => ({ id })) } },
    getConnections() { return [] }
  }
}

function dummyComponents(): { logger: { forComponent: (name: string) => Logger }, registrar: any, libp2p?: any } {
  const logger: any = { forComponent: () => ({ error() {}, warn() {}, info() {}, debug() {} }) }
  const registrar: any = { handle: async () => {}, unhandle: async () => {} }
  return { logger, registrar }
}

describe('FRET service - unit', () => {
  it('returns cohort of expected size including nearest to key', async () => {
    const self = makePeer('p-self')
    const others = ['p-a', 'p-b', 'p-c', 'p-d'].map(makePeer)
    const comps = dummyComponents()
    const svc = new FretService(comps, { clusterSize: 3 })
    ;(svc as any).setLibp2p(makeLibp2p(self, others))
    const key = new TextEncoder().encode('p-a'.padStart(32, '0')).slice(0, 32)
    const cohort = await svc.getCluster(key)
    expect(cohort).to.have.lengthOf(3)
    // nearest should be first element of XOR ranking (p-a)
    expect(cohort.some(p => p.toString() === 'p-a')).to.equal(true)
  })

  it('isInCluster true when self is nearest to key', async () => {
    const self = makePeer('p-self')
    const others = ['p-a', 'p-b'].map(makePeer)
    const comps = dummyComponents()
    const svc = new FretService(comps, { clusterSize: 2 })
    ;(svc as any).setLibp2p(makeLibp2p(self, others))
    const key = new TextEncoder().encode('p-self'.padStart(32, '0')).slice(0, 32)
    const inCluster = await svc.isInCluster(key)
    expect(inCluster).to.equal(true)
  })
})

