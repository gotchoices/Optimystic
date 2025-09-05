import type { AbortOptions, Libp2p, PeerId, Stream } from "@libp2p/interface";
import { toString as u8ToString } from 'uint8arrays/to-string'
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork, IPeerNetwork } from "@optimystic/db-core";
import { getNetworkManager } from './network/get-network-manager.js'

export class Libp2pKeyPeerNetwork implements IKeyNetwork, IPeerNetwork {
	constructor(private readonly libp2p: Libp2p) {
	}

  // coordinator cache: key (base64url) -> peerId until expiry (bounded LRU-ish via Map insertion order)
  private readonly coordinatorCache = new Map<string, { id: PeerId, expires: number }>()
  private static readonly MAX_CACHE_ENTRIES = 1000

  public recordCoordinator(key: Uint8Array, peerId: PeerId, ttlMs = 30 * 60 * 1000): void {
    const k = u8ToString(key, 'base64url')
    const now = Date.now()
    // prune expired
    for (const [ck, entry] of this.coordinatorCache) {
      if (entry.expires <= now) this.coordinatorCache.delete(ck)
    }
    this.coordinatorCache.set(k, { id: peerId, expires: now + ttlMs })
    // evict oldest if over capacity
    while (this.coordinatorCache.size > Libp2pKeyPeerNetwork.MAX_CACHE_ENTRIES) {
      const firstKey = this.coordinatorCache.keys().next().value as string | undefined
      if (firstKey == null) break
      this.coordinatorCache.delete(firstKey)
    }
  }

  private getCachedCoordinator(key: Uint8Array): PeerId | undefined {
    const k = u8ToString(key, 'base64url')
    const hit = this.coordinatorCache.get(k)
    if (hit && hit.expires > Date.now()) return hit.id
    if (hit) this.coordinatorCache.delete(k)
    return undefined
  }

	connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream> {
		const dialOptions = { runOnLimitedConnection: true, negotiateFully: false } as const;
		return this.libp2p.dialProtocol(peerId, [protocol], dialOptions);
	}

  async findCoordinator<T>(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
    const cached = this.getCachedCoordinator(key)
    if (cached != null) return cached
    // Choose nearest connected peer (including self) to avoid dependency on
    // service wiring during early startup; caller will dial as needed.
    const id = this.getNearestConnectedPeer(key)
    this.recordCoordinator(key, id)
    return id
  }

	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		try {
			const nm = getNetworkManager(this.libp2p as any)
      const status = nm.getStatus?.()
      if (status && status.mode === 'degraded') {
        throw new Error('Network is degraded (no remote peers)')
      }
			const peers: ClusterPeers = {} as ClusterPeers
			const members = await nm.getCluster(key)
			const selfIdStr = this.libp2p.peerId.toString()
			// Build address index from current connections
			const conns = this.libp2p.getConnections()
			const byPeer: Record<string, string[]> = {}
			for (const c of conns) {
				const id = c.remotePeer.toString()
				const addr = c.remoteAddr?.toString?.()
				if (addr) (byPeer[id] ??= []).push(addr)
			}
			for (const pid of members) {
				const idStr = pid.toString()
				if (idStr === selfIdStr) {
					(peers as any)[idStr] = { multiaddrs: this.libp2p.getMultiaddrs(), publicKey: this.libp2p.peerId.publicKey?.raw || new Uint8Array() }
				} else {
					const lastCtor = conns.find(c => c.remotePeer.toString() === idStr)?.remoteAddr?.constructor as any | undefined
					let addrs: any[] = []
					if (lastCtor != null) {
						const list = byPeer[idStr] ?? []
						addrs = list.map((a: string) => lastCtor.fromString(a))
					}
					(peers as any)[idStr] = { multiaddrs: addrs, publicKey: new Uint8Array() }
				}
			}
			return peers
		} catch (e) {
			const log = this.libp2p.logger.forComponent('db-p2p:key-network/findCluster')
			log.error('networkManager.getCluster failed: %e', e)
		}
		// Fallback: return connected peers (including self) only when not in explicit degraded mode
		return this.getConnectedCluster();
	}

	private getNearestConnectedPeer(key: Uint8Array): PeerId {
		const remoteMap = new Map(this.libp2p.getConnections().map(c => [c.remotePeer.toString(), c.remotePeer]));
		const remotes = Array.from(remoteMap.values());
		const candidates: PeerId[] = [this.libp2p.peerId, ...remotes];
		const keyBytes = key;

		const choose = (a: PeerId, b: PeerId) => {
			const da = this.xorDistanceBytes(a.toMultihash().bytes, keyBytes);
			const db = this.xorDistanceBytes(b.toMultihash().bytes, keyBytes);
			return this.lexicographicLess(da, db) ? a : b;
		};

		return candidates.reduce((best, current) => choose(best, current));
	}

	private xorDistanceBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
		const len = Math.max(a.length, b.length);
		const out = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			const ai = a[a.length - 1 - i] ?? 0;
			const bi = b[b.length - 1 - i] ?? 0;
			out[len - 1 - i] = ai ^ bi;
		}
		return out;
	}

	private lexicographicLess(a: Uint8Array, b: Uint8Array): boolean {
		const len = Math.max(a.length, b.length);
		for (let i = 0; i < len; i++) {
			const av = a[i] ?? 0;
			const bv = b[i] ?? 0;
			if (av < bv) return true;
			if (av > bv) return false;
		}
		return false;
	}

	private getConnectedCluster(): ClusterPeers {
		const selfId = this.libp2p.peerId.toString();
		const result: ClusterPeers = {
			[selfId]: {
				multiaddrs: this.libp2p.getMultiaddrs(),
				publicKey: this.libp2p.peerId.publicKey?.raw || new Uint8Array()
			}
		} as ClusterPeers;

		const connections = this.libp2p.getConnections();
		const byPeer: Record<string, { addrs: string[]; lastAddr?: any }> = {};
		for (const c of connections) {
			const id = c.remotePeer.toString();
			const addrStr = c.remoteAddr?.toString?.() ?? '';
			const entry = byPeer[id] ?? (byPeer[id] = { addrs: [] });
			if (addrStr && !entry.addrs.includes(addrStr)) {
				entry.addrs.push(addrStr);
			}
			entry.lastAddr = c.remoteAddr ?? entry.lastAddr;
		}

		for (const [id, info] of Object.entries(byPeer)) {
			const lastCtor = info.lastAddr?.constructor as any | undefined;
			const addrs = lastCtor != null
				? info.addrs.map(s => lastCtor.fromString(s))
				: [];
			(result as any)[id] = {
				multiaddrs: addrs,
				publicKey: new Uint8Array()
			};
		}

		return result;
	}
}
