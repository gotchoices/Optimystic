import type { Startable, Logger, PeerId } from '@libp2p/interface'

export type NetworkManagerServiceInit = {
  clusterSize?: number
  seedKeys?: Uint8Array[]
  estimation?: { samples: number, kth: number, timeoutMs: number, ttlMs: number }
  readiness?: { minPeers: number, maxWaitMs: number }
  cacheTTLs?: { coordinatorMs: number, clusterMs: number }
  expectedRemotes?: boolean
}

type Components = {
  logger: { forComponent: (name: string) => Logger },
  registrar: { handle: (...args: any[]) => Promise<void>, unhandle: (...args: any[]) => Promise<void> }
}

export class NetworkManagerService implements Startable {
  private running = false
  private readonly log: Logger
  private readonly cfg: Required<NetworkManagerServiceInit>
  private readyPromise: Promise<void> | null = null
  private readonly coordinatorCache = new Map<string, { id: PeerId, expires: number }>()
  private readonly clusterCache = new Map<string, { ids: PeerId[], expires: number }>()
  private lastEstimate: { estimate: number, samples: number, updated: number } | null = null
  // lightweight blacklist (local reputation)
  private readonly blacklist = new Map<string, { score: number, expires: number }>()
  // direct libp2p reference to avoid accessing components.libp2p before ready
  private libp2pRef: any | undefined

  constructor(private readonly components: Components, init: NetworkManagerServiceInit = {}) {
    this.log = components.logger.forComponent('db-p2p:network-manager')
    this.cfg = {
      clusterSize: init.clusterSize ?? 1,
      seedKeys: init.seedKeys ?? [],
      estimation: init.estimation ?? { samples: 8, kth: 5, timeoutMs: 1000, ttlMs: 60_000 },
      readiness: init.readiness ?? { minPeers: 1, maxWaitMs: 2000 },
      cacheTTLs: init.cacheTTLs ?? { coordinatorMs: 30 * 60_000, clusterMs: 5 * 60_000 },
      expectedRemotes: init.expectedRemotes ?? false
    }
  }

  // Allow external wiring to provide the libp2p instance early
  setLibp2p(libp2p: any): void { this.libp2pRef = libp2p }

  private getLibp2p(): any {
    try {
      return this.libp2pRef ?? (this.components as any).libp2p
    } catch {
      return this.libp2pRef
    }
  }

  get [Symbol.toStringTag](): string { return '@libp2p/network-manager' }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    // Do not call ready() here; libp2p components may not be fully set yet.
    // Consumers (e.g., CLI) should invoke ready() after node.start().
  }

  async stop(): Promise<void> {
    this.running = false
  }

  async ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = (async () => {
      // Best-effort seed of keys to populate peer routing cache
      await Promise.all((this.cfg.seedKeys ?? []).map(k => this.seedKey(k).catch(e => this.log.error('seed key failed %o', e))))
      // Minimal settle delay
      await new Promise(r => setTimeout(r, 50))
    })()
    return this.readyPromise
  }

  private async seedKey(key: Uint8Array): Promise<void> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), this.cfg.estimation.timeoutMs)
    try {
      const libp2p = this.getLibp2p()
      for await (const _ of libp2p.peerRouting.getClosestPeers(key, { signal: ctl.signal, useCache: true })) {
        break
      }
    } catch (e) { this.log.error('closestPeers seed failed %o', e) }
    finally { clearTimeout(t) }
  }

  private toCacheKey(key: Uint8Array): string {
    return Buffer.from(key).toString('base64url')
  }

  private getKnownPeers(): PeerId[] {
    try {
      const libp2p = this.getLibp2p()
      const selfId: PeerId = libp2p.peerId
      const storePeers: Array<{ id: PeerId }> = libp2p.peerStore.getPeers() ?? []
      const connPeers: PeerId[] = (libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer)
      const all = [...storePeers.map(p => p.id), ...connPeers]
      const uniq = all.filter((p, i) => all.findIndex(x => x.toString() === p.toString()) === i)
      return uniq.filter((pid: PeerId) => pid.toString() !== selfId.toString())
    } catch (e) {
      // Components may not be set yet; return empty until libp2p is fully started
      return []
    }
  }

  getStatus(): { mode: 'alone' | 'healthy' | 'degraded', connections: number } {
    try {
      const libp2p = this.getLibp2p()
      const peers: Array<{ id: PeerId }> = libp2p.peerStore.getPeers() ?? []
      const remotes = peers.filter(p => p.id.toString() !== libp2p.peerId.toString()).length
      if (remotes === 0) {
        return { mode: this.cfg.expectedRemotes ? 'degraded' : 'alone', connections: 0 }
      }
      return { mode: 'healthy', connections: remotes }
    } catch (e) {
      // If components not set yet, treat as degraded only if remotes expected
      return { mode: this.cfg.expectedRemotes ? 'degraded' : 'alone', connections: 0 }
    }
  }

  async awaitHealthy(minRemotes: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const peers = this.getKnownPeers()
      if (peers.length >= minRemotes) return true
      await new Promise(r => setTimeout(r, 100))
    }
    return this.getKnownPeers().length >= minRemotes
  }

  /**
   * Record a misbehaving peer. Higher score means worse reputation.
   * Entries expire to allow eventual forgiveness.
   */
  reportBadPeer(peerId: PeerId, penalty: number = 1, ttlMs: number = 10 * 60_000): void {
    const id = peerId.toString()
    const prev = this.blacklist.get(id)
    const score = (prev?.score ?? 0) + Math.max(1, penalty)
    this.blacklist.set(id, { score, expires: Date.now() + ttlMs })
  }

  private isBlacklisted(peerId: PeerId): boolean {
    const id = peerId.toString()
    const rec = this.blacklist.get(id)
    if (!rec) return false
    if (rec.expires <= Date.now()) { this.blacklist.delete(id); return false }
    // simple threshold; can be tuned or exposed later
    return rec.score >= 3
  }

  recordCoordinator(key: Uint8Array, peerId: PeerId): void {
    const k = this.toCacheKey(key)
    this.coordinatorCache.set(k, { id: peerId, expires: Date.now() + this.cfg.cacheTTLs.coordinatorMs })
  }

  /**
   * Find the nearest peer to the provided content key using the DHT (if available),
   * falling back to locally known peers. This is used only to choose an anchor peer.
   */
  private async findNearestPeerToKey(key: Uint8Array): Promise<PeerId> {
    const libp2p = this.getLibp2p()
    // Prefer DHT closestPeers to pick a good anchor (fast path when connected)
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), this.cfg.estimation.timeoutMs)
      try {
        for await (const pid of libp2p.peerRouting.getClosestPeers(key, { signal: ctl.signal, useCache: true })) {
          if (!this.isBlacklisted(pid)) { clearTimeout(t); return pid }
        }
      } finally { clearTimeout(t) }
    } catch { /* ignore and fall back */ }

    // Fallback: choose among self + connected peers + known peers by distance to key
    const connected: PeerId[] = (libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer)
    const candidates = [libp2p.peerId, ...connected, ...this.getKnownPeers()]
      .filter((p, i, arr) => arr.findIndex(x => x.toString() === p.toString()) === i)
      .filter(p => !this.isBlacklisted(p))
    const best = candidates.reduce((best: PeerId, cur: PeerId) =>
      this.lexLess(this.xor(best.toMultihash().bytes, key), this.xor(cur.toMultihash().bytes, key)) ? best : cur
    , candidates[0] ?? libp2p.peerId)
    return best
  }

  /**
   * Compute cluster anchored on the nearest peer to the key, then select K peers
   * closest to that anchor's PeerId (peer-centric clusters).
   */
  async getCluster(key: Uint8Array): Promise<PeerId[]> {
    const ck = this.toCacheKey(key)
    const cached = this.clusterCache.get(ck)
    if (cached && cached.expires > Date.now()) return cached.ids

    const libp2p = this.getLibp2p()
    const anchor = await this.findNearestPeerToKey(key)
    const anchorMh = anchor.toMultihash().bytes

    // Start with anchor + connected + known peers, filter blacklist, sort by distance to anchor
    const connected: PeerId[] = (libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer)
    const candidates = [anchor, libp2p.peerId, ...connected, ...this.getKnownPeers()] // include self
      .filter((p, idx, arr) => !this.isBlacklisted(p) && arr.findIndex(x => x.toString() === p.toString()) === idx)
    const sorted = candidates.sort((a, b) => this.lexLess(this.xor(a.toMultihash().bytes, anchorMh), this.xor(b.toMultihash().bytes, anchorMh)) ? -1 : 1)
    const K = Math.min(this.cfg.clusterSize, sorted.length)
    const ids = sorted.slice(0, K)
    this.clusterCache.set(ck, { ids, expires: Date.now() + this.cfg.cacheTTLs.clusterMs })
    return ids
  }

  async getCoordinator(key: Uint8Array): Promise<PeerId> {
		// First try the cache
    const ck = this.toCacheKey(key)
    const hit = this.coordinatorCache.get(ck)
    if (hit) {
			if (hit.expires > Date.now()) {
				return hit.id
			} else {
				this.coordinatorCache.delete(ck)
			}
		}

    // Prefer the nearest peer to the key as coordinator; avoid dialing here to
    // keep discovery fast and avoid component availability issues. The caller
    // will dial when needed via protocol clients.
    const libp2p = this.getLibp2p()
    const anchor = await this.findNearestPeerToKey(key)
    if (!this.isBlacklisted(anchor)) {
      this.recordCoordinator(key, anchor)
      return anchor
    }
    const cluster = await this.getCluster(key)
    const candidate = cluster.find(p => !this.isBlacklisted(p)) ?? libp2p.peerId
    this.recordCoordinator(key, candidate)
    return candidate
  }

  private xor(a: Uint8Array, b: Uint8Array): Uint8Array {
    const len = Math.max(a.length, b.length)
    const out = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      const ai = a[a.length - 1 - i] ?? 0
      const bi = b[b.length - 1 - i] ?? 0
      out[len - 1 - i] = ai ^ bi
    }
    return out
  }

  private lexLess(a: Uint8Array, b: Uint8Array): boolean {
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const av = a[i] ?? 0
      const bv = b[i] ?? 0
      if (av < bv) return true
      if (av > bv) return false
    }
    return false
  }
}

export function networkManagerService(init: NetworkManagerServiceInit = {}) {
  return (components: Components) => new NetworkManagerService(components, init)
}


