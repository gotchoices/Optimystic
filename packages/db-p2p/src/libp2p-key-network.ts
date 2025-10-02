import type { AbortOptions, Libp2p, PeerId, Stream } from "@libp2p/interface";
import { toString as u8ToString } from 'uint8arrays/to-string'
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork, IPeerNetwork } from "@optimystic/db-core";
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { FretService } from '@optimystic/fret'
import { hashKey } from '@optimystic/fret'

interface WithFretService { services?: { fret?: FretService } }

export class Libp2pKeyPeerNetwork implements IKeyNetwork, IPeerNetwork {
	constructor(private readonly libp2p: Libp2p) {}

	// coordinator cache: key (base64url) -> peerId until expiry (bounded LRU-ish via Map insertion order)
	private readonly coordinatorCache = new Map<string, { id: PeerId, expires: number }>()
	private static readonly MAX_CACHE_ENTRIES = 1000

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
		const cached = this.getCachedCoordinator(key)
		if (cached != null) return cached

		const ids = await this.getNeighborIdsForKey(key, 1)
		const idStr = ids[0] ?? this.libp2p.peerId.toString()
		const pid = peerIdFromString(idStr)
		this.recordCoordinator(key, pid)
		return pid
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
		const cohort = fret.assembleCohort(coord, 16)
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
