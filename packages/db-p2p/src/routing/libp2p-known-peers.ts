import type { Libp2p } from 'libp2p'
import type { PeerId } from '@libp2p/interface'
import type { KnownPeer } from './responsibility.js'

export function buildKnownPeers(libp2p: Libp2p): KnownPeer[] {
  const self: KnownPeer = {
    id: libp2p.peerId as unknown as PeerId,
    addrs: libp2p.getMultiaddrs().map(ma => ma.toString())
  }

  const connections = libp2p.getConnections()
  const byPeer: Record<string, { id: PeerId, addrs: Set<string> }> = {}

  for (const c of connections) {
    const pid = c.remotePeer
    const key = pid.toString()
    const entry = byPeer[key] ?? (byPeer[key] = { id: pid as unknown as PeerId, addrs: new Set() })
    const addrStr = c.remoteAddr?.toString?.()
    if (addrStr) entry.addrs.add(addrStr)
  }

  const others: KnownPeer[] = Object.values(byPeer).map(e => ({ id: e.id, addrs: Array.from(e.addrs) }))
  return [self, ...others]
}


