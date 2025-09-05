import type { PeerId } from '@libp2p/interface'
import { sha256 } from 'multiformats/hashes/sha2'

export interface SimpleClusterCoordinator {
  selectCoordinator(key: Uint8Array, peers: PeerId[]): Promise<PeerId>
  selectReplicas(key: Uint8Array, peers: PeerId[], replicationFactor: number): Promise<PeerId[]>
}

/**
 * Simple consistent hashing for small clusters
 * Uses modulo arithmetic instead of XOR distance
 */
export class ModuloCoordinator implements SimpleClusterCoordinator {
  async hashPeer(peerId: PeerId): Promise<bigint> {
    const mh = await sha256.digest(peerId.toMultihash().bytes)
    // Take first 8 bytes as bigint
    const view = new DataView(mh.digest.buffer, mh.digest.byteOffset, 8)
    return view.getBigUint64(0, false)
  }

  async hashKey(key: Uint8Array): Promise<bigint> {
    const mh = await sha256.digest(key)
    const view = new DataView(mh.digest.buffer, mh.digest.byteOffset, 8)
    return view.getBigUint64(0, false)
  }

  async selectCoordinator(key: Uint8Array, peers: PeerId[]): Promise<PeerId> {
    if (peers.length === 0) throw new Error('No peers available')
    if (peers.length === 1) return peers[0]!

    // Simple modulo selection - deterministic but not distance-based
    const keyHash = await this.hashKey(key)
    const index = Number(keyHash % BigInt(peers.length))
    return peers[index]!
  }

  async selectReplicas(key: Uint8Array, peers: PeerId[], replicationFactor: number): Promise<PeerId[]> {
    if (peers.length <= replicationFactor) return [...peers]

    const coordinator = await this.selectCoordinator(key, peers)
    const replicas = [coordinator]
    const remaining = peers.filter(p => !p.equals(coordinator))

    // Select additional replicas deterministically
    for (let i = 1; i < replicationFactor && remaining.length > 0; i++) {
      const subKey = new Uint8Array([...key, i])
      const replica = await this.selectCoordinator(subKey, remaining)
      replicas.push(replica)
      remaining.splice(remaining.findIndex(p => p.equals(replica)), 1)
    }

    return replicas
  }
}

/**
 * For very small clusters, just replicate everywhere
 */
export class FullReplicationCoordinator implements SimpleClusterCoordinator {
  async selectCoordinator(key: Uint8Array, peers: PeerId[]): Promise<PeerId> {
    // Always select first peer as primary
    if (peers.length === 0) throw new Error('No peers available')
    return peers[0]!
  }

  async selectReplicas(key: Uint8Array, peers: PeerId[], replicationFactor: number): Promise<PeerId[]> {
    // Replicate to all peers in small clusters
    return [...peers]
  }
}
