import type { PeerId } from '@libp2p/interface'

export type KnownPeer = { id: PeerId, addrs: string[] }

export type ResponsibilityResult = {
  inCluster: boolean
  nearest: KnownPeer[]
}

export function xorDistanceBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = Math.max(a.length, b.length)
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    const ai = a[a.length - 1 - i] ?? 0
    const bi = b[b.length - 1 - i] ?? 0
    out[len - 1 - i] = ai ^ bi
  }
  return out
}

export function lessThanLex(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av < bv) return true
    if (av > bv) return false
  }
  return false
}

export function sortPeersByDistance(peers: KnownPeer[], key: Uint8Array): KnownPeer[] {
  return peers
    .map(p => ({ p, d: xorDistanceBytes(p.id.toMultihash().bytes, key) }))
    .sort((a, b) => (lessThanLex(a.d, b.d) ? -1 : 1))
    .map(x => x.p)
}

export function computeResponsibility(
  key: Uint8Array,
  self: KnownPeer,
  others: KnownPeer[],
  k: number
): ResponsibilityResult {
  const all = [self, ...others]
  const sorted = sortPeersByDistance(all, key)

  // For small meshes, use a different strategy
  if (all.length <= 3) {
    // With 3 or fewer nodes, the first node in XOR order handles it
    // This ensures only ONE node considers itself responsible
    const inCluster = sorted[0]!.id.equals(self.id)
    return { inCluster, nearest: sorted }
  }

  // For larger meshes, use traditional k-nearest
  const effectiveK = Math.min(k, Math.max(1, Math.floor(all.length / 2)))
  const topK = sorted.slice(0, effectiveK)
  const inCluster = topK.some(p => p.id.equals(self.id))
  return { inCluster, nearest: topK }
}


