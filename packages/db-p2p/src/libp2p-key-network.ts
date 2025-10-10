import type { AbortOptions, Libp2p, PeerId, Stream } from "@libp2p/interface";
import { toString as u8ToString } from 'uint8arrays/to-string'
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork, IPeerNetwork } from "@optimystic/db-core";
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { FretService } from '@optimystic/fret'
import { hashKey } from '@optimystic/fret'
import { createLogger } from './logger.js'

interface WithFretService { services?: { fret?: FretService } }

export class Libp2pKeyPeerNetwork implements IKeyNetwork, IPeerNetwork {
	constructor(
		private readonly libp2p: Libp2p,
		private readonly clusterSize: number = 16
	) { }

	// coordinator cache: key (base64url) -> peerId until expiry (bounded LRU-ish via Map insertion order)
	private readonly coordinatorCache = new Map<string, { id: PeerId, expires: number }>()
	private static readonly MAX_CACHE_ENTRIES = 1000
	private readonly log = createLogger('libp2p-key-network')

	private toCacheKey(key: Uint8Array): string { return u8ToString(key, 'base64url') }

	public recordCoordinator(key: Uint8Array, peerId: PeerId, ttlMs = 30 * 60 * 1000): void {
		const k = this.toCacheKey(key)
		const now = Date.now()
		for (const [ck, entry] of this.coordinatorCache) {
			if (entry.expires <= now) this.coordinatorCache.delete(ck)
		}
		this.coordinatorCache.set(k, { id: peerId, expires: now + ttlMs })
		while (this.coordinatorCache.size > Libp2pKeyPeerNetwork.MAX_CACHE_ENTRIES) {
			const firstKey = this.coordinatorCache.keys().next().value as string | undefined
			if (firstKey == null) break
			this.coordinatorCache.delete(firstKey)
		}
	}

	private getCachedCoordinator(key: Uint8Array): PeerId | undefined {
		const k = this.toCacheKey(key)
		const hit = this.coordinatorCache.get(k)
		if (hit && hit.expires > Date.now()) return hit.id
		if (hit) this.coordinatorCache.delete(k)
		return undefined
	}

	connect(peerId: PeerId, protocol: string, _options?: AbortOptions): Promise<Stream> {
		const conns = (this.libp2p as any).getConnections?.(peerId) ?? []
		if (Array.isArray(conns) && conns.length > 0 && typeof conns[0]?.newStream === 'function') {
			return conns[0].newStream([protocol]) as Promise<Stream>
		}
		const dialOptions = { runOnLimitedConnection: true, negotiateFully: false } as const
		return this.libp2p.dialProtocol(peerId, [protocol], dialOptions)
	}

	private getFret(): FretService {
		const svc = (this.libp2p as unknown as WithFretService).services?.fret
		if (svc == null) throw new Error('FRET service is not registered on this libp2p node')
		return svc
	}

	private async getNeighborIdsForKey(key: Uint8Array, wants: number): Promise<string[]> {
		const fret = this.getFret()
		const coord = await hashKey(key)
		const both = fret.getNeighbors(coord, 'both', wants)
		return Array.from(new Set(both)).slice(0, wants)
	}

	async findCoordinator(key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		const excludedSet = new Set<string>((_options?.excludedPeers ?? []).map(p => p.toString()))

		// honor cache if not excluded
		const cached = this.getCachedCoordinator(key)
		if (cached != null && !excludedSet.has(cached.toString())) return cached

		// prefer FRET neighbors, pick first non-excluded
		try {
			const ids = await this.getNeighborIdsForKey(key, this.clusterSize)
			const pick = ids.find(id => !excludedSet.has(id))
			if (pick) {
				const pid = peerIdFromString(pick)
				this.recordCoordinator(key, pid)
				return pid
			}
		} catch (err) { this.log('findCoordinator getNeighborIdsForKey failed - %o', err) }

		// fallback: prefer an existing connected peer that's not excluded
		const connected = (this.libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer) as PeerId[]
		const connectedPick = connected.find(p => !excludedSet.has(p.toString()))
		if (connectedPick) {
			this.recordCoordinator(key, connectedPick)
			return connectedPick
		}

		// last resort: prefer self only if not excluded; otherwise fail fast to avoid retry cycles
		const self = this.libp2p.peerId
		if (!excludedSet.has(self.toString())) return self
		throw new Error('No coordinator available for key (all candidates excluded)')
	}

	private getConnectedAddrsByPeer(): Record<string, string[]> {
		const conns = this.libp2p.getConnections()
		const byPeer: Record<string, string[]> = {}
		for (const c of conns) {
			const id = c.remotePeer.toString()
			const addr = c.remoteAddr?.toString?.()
			if (addr) (byPeer[id] ??= []).push(addr)
		}
		return byPeer
	}

	private parseMultiaddrs(addrs: string[]): ReturnType<typeof multiaddr>[] {
		const out: ReturnType<typeof multiaddr>[] = []
		for (const a of addrs) {
			try { out.push(multiaddr(a)) } catch (err) { console.warn('invalid multiaddr from connection', a, err) }
		}
		return out
	}

	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		const fret = this.getFret()
		const coord = await hashKey(key)
		const cohort = fret.assembleCohort(coord, this.clusterSize)
		const ids = Array.from(new Set([...cohort, this.libp2p.peerId.toString()]))

		const peers: ClusterPeers = {}
		const connectedByPeer = this.getConnectedAddrsByPeer()

		for (const idStr of ids) {
			if (idStr === this.libp2p.peerId.toString()) {
				peers[idStr] = { multiaddrs: this.libp2p.getMultiaddrs(), publicKey: this.libp2p.peerId.publicKey?.raw ?? new Uint8Array() }
				continue
			}
			const strings = connectedByPeer[idStr] ?? []
			const addrs = this.parseMultiaddrs(strings)
			peers[idStr] = { multiaddrs: addrs, publicKey: new Uint8Array() }
		}
		return peers
	}
}
