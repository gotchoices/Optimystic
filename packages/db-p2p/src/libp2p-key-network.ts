import type { AbortOptions, Libp2p, PeerId, Stream } from "@libp2p/interface";
import { toString as u8ToString } from 'uint8arrays/to-string'
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork, IPeerNetwork } from "@optimystic/db-core";
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { FretService } from 'p2p-fret'
import { hashKey } from 'p2p-fret'
import { createLogger } from './logger.js'

interface WithFretService { services?: { fret?: FretService } }

/**
 * Configuration options for self-coordination behavior
 */
export interface SelfCoordinationConfig {
	/** Time (ms) after last connection before allowing self-coordination. Default: 30000 */
	gracePeriodMs?: number;
	/** Threshold for suspicious network shrinkage (0-1). >50% drop is suspicious. Default: 0.5 */
	shrinkageThreshold?: number;
	/** Allow self-coordination at all. Default: true (for testing). Set false in production. */
	allowSelfCoordination?: boolean;
}

/**
 * Decision result from self-coordination guard
 */
export interface SelfCoordinationDecision {
	allow: boolean;
	reason: 'bootstrap-node' | 'partition-detected' | 'suspicious-shrinkage' | 'grace-period-not-elapsed' | 'extended-isolation' | 'disabled';
	warn?: boolean;
}

export class Libp2pKeyPeerNetwork implements IKeyNetwork, IPeerNetwork {
	private readonly selfCoordinationConfig: Required<SelfCoordinationConfig>;
	private networkHighWaterMark = 1;
	private lastConnectedTime = Date.now();

	constructor(
		private readonly libp2p: Libp2p,
		private readonly clusterSize: number = 16,
		selfCoordinationConfig?: SelfCoordinationConfig
	) {
		this.selfCoordinationConfig = {
			gracePeriodMs: selfCoordinationConfig?.gracePeriodMs ?? 30_000,
			shrinkageThreshold: selfCoordinationConfig?.shrinkageThreshold ?? 0.5,
			allowSelfCoordination: selfCoordinationConfig?.allowSelfCoordination ?? true
		};
		this.setupConnectionTracking();
	}

	// coordinator cache: key (base64url) -> peerId until expiry (bounded LRU-ish via Map insertion order)
	private readonly coordinatorCache = new Map<string, { id: PeerId, expires: number }>()
	private static readonly MAX_CACHE_ENTRIES = 1000
	private readonly log = createLogger('libp2p-key-network')

	private toCacheKey(key: Uint8Array): string { return u8ToString(key, 'base64url') }

	/**
	 * Set up connection event tracking to update high water mark and last connected time.
	 */
	private setupConnectionTracking(): void {
		this.libp2p.addEventListener('connection:open', () => {
			this.updateNetworkObservations();
		});
	}

	/**
	 * Update network high water mark and last connected time.
	 * Called on new connections.
	 */
	private updateNetworkObservations(): void {
		const connections = this.libp2p.getConnections?.() ?? [];
		if (connections.length > 0) {
			this.lastConnectedTime = Date.now();
		}

		try {
			const fret = this.getFret();
			const estimate = fret.getNetworkSizeEstimate();
			if (estimate.size_estimate > this.networkHighWaterMark) {
				this.networkHighWaterMark = estimate.size_estimate;
				this.log('network-hwm-updated mark=%d confidence=%f', this.networkHighWaterMark, estimate.confidence);
			}
		} catch {
			// FRET not available - use connection count as fallback
			const connectionCount = this.libp2p.getConnections?.().length ?? 0;
			const observedSize = connectionCount + 1; // +1 for self
			if (observedSize > this.networkHighWaterMark) {
				this.networkHighWaterMark = observedSize;
				this.log('network-hwm-updated mark=%d (from connections)', this.networkHighWaterMark);
			}
		}
	}

	/**
	 * Determine if self-coordination should be allowed based on network observations.
	 *
	 * Principle: If we've ever seen a larger network, assume our connectivity is the problem,
	 * not the network shrinking.
	 */
	shouldAllowSelfCoordination(): SelfCoordinationDecision {
		// Check global disable
		if (!this.selfCoordinationConfig.allowSelfCoordination) {
			return { allow: false, reason: 'disabled' };
		}

		// Case 1: New/bootstrap node (never seen larger network)
		if (this.networkHighWaterMark <= 1) {
			return { allow: true, reason: 'bootstrap-node' };
		}

		// Case 2: Check for partition via FRET
		try {
			const fret = this.getFret();
			if (fret.detectPartition()) {
				this.log('self-coord-blocked: partition-detected');
				return { allow: false, reason: 'partition-detected' };
			}

			// Case 3: Suspicious network shrinkage (>threshold drop)
			const estimate = fret.getNetworkSizeEstimate();
			const shrinkage = 1 - (estimate.size_estimate / this.networkHighWaterMark);
			if (shrinkage > this.selfCoordinationConfig.shrinkageThreshold) {
				this.log('self-coord-blocked: suspicious-shrinkage current=%d hwm=%d shrinkage=%f',
					estimate.size_estimate, this.networkHighWaterMark, shrinkage);
				return { allow: false, reason: 'suspicious-shrinkage' };
			}
		} catch {
			// FRET not available - be conservative
			const connections = this.libp2p.getConnections?.() ?? [];
			if (this.networkHighWaterMark > 1 && connections.length === 0) {
				// We've seen peers before but have none now - suspicious
				const timeSinceConnection = Date.now() - this.lastConnectedTime;
				if (timeSinceConnection < this.selfCoordinationConfig.gracePeriodMs) {
					this.log('self-coord-blocked: grace-period-not-elapsed since=%dms', timeSinceConnection);
					return { allow: false, reason: 'grace-period-not-elapsed' };
				}
			}
		}

		// Case 4: Recently connected (grace period not elapsed)
		const timeSinceConnection = Date.now() - this.lastConnectedTime;
		if (timeSinceConnection < this.selfCoordinationConfig.gracePeriodMs) {
			const connections = this.libp2p.getConnections?.() ?? [];
			// Only block if we have no connections but did recently
			if (connections.length === 0) {
				this.log('self-coord-blocked: grace-period-not-elapsed since=%dms', timeSinceConnection);
				return { allow: false, reason: 'grace-period-not-elapsed' };
			}
		}

		// Case 5: Extended isolation with gradual shrinkage - allow with warning
		this.log('self-coord-allowed: extended-isolation (warn)');
		return { allow: true, reason: 'extended-isolation', warn: true };
	}

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
		const keyStr = this.toCacheKey(key).substring(0, 12);

		this.log('findCoordinator:start key=%s excluded=%o', keyStr, Array.from(excludedSet).map(s => s.substring(0, 12)))

		// honor cache if not excluded
		const cached = this.getCachedCoordinator(key)
		if (cached != null && !excludedSet.has(cached.toString())) {
			this.log('findCoordinator:cached-hit key=%s coordinator=%s', keyStr, cached.toString().substring(0, 12))
			return cached
		}

		// Retry logic: connections can be temporarily down, so retry a few times with delay
		const maxRetries = 3;
		const retryDelayMs = 500;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			// Get currently connected peers for filtering
			const connected = (this.libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer) as PeerId[]
			const connectedSet = new Set(connected.map(p => p.toString()))
			this.log('findCoordinator:connected-peers key=%s count=%d peers=%o attempt=%d', keyStr, connected.length, connected.map(p => p.toString().substring(0, 12)), attempt)

			// prefer FRET neighbors that are also connected, pick first non-excluded
			try {
				const ids = await this.getNeighborIdsForKey(key, this.clusterSize)
				this.log('findCoordinator:fret-neighbors key=%s candidates=%o', keyStr, ids.map(s => s.substring(0, 12)))

				// Filter to only connected FRET neighbors
				const connectedFretIds = ids.filter(id => connectedSet.has(id) || id === this.libp2p.peerId.toString())
				this.log('findCoordinator:fret-connected key=%s count=%d peers=%o', keyStr, connectedFretIds.length, connectedFretIds.map(s => s.substring(0, 12)))

				const pick = connectedFretIds.find(id => !excludedSet.has(id))
				if (pick) {
					const pid = peerIdFromString(pick)
					this.recordCoordinator(key, pid)
					this.log('findCoordinator:fret-selected key=%s coordinator=%s', keyStr, pick.substring(0, 12))
					return pid
				}
			} catch (err) {
				this.log('findCoordinator getNeighborIdsForKey failed - %o', err)
			}

			// fallback: prefer any existing connected peer that's not excluded
			const connectedPick = connected.find(p => !excludedSet.has(p.toString()))
			if (connectedPick) {
				this.recordCoordinator(key, connectedPick)
				this.log('findCoordinator:connected-fallback key=%s coordinator=%s', keyStr, connectedPick.toString().substring(0, 12))
				return connectedPick
			}

			// If no connections and not the last attempt, wait and retry
			if (connected.length === 0 && attempt < maxRetries - 1) {
				this.log('findCoordinator:no-connections-retry key=%s attempt=%d delay=%dms', keyStr, attempt, retryDelayMs)
				await new Promise(resolve => setTimeout(resolve, retryDelayMs))
				continue
			}
		}

		// last resort: prefer self only if not excluded and guard allows
		const self = this.libp2p.peerId
		if (!excludedSet.has(self.toString())) {
			const decision = this.shouldAllowSelfCoordination();
			if (!decision.allow) {
				this.log('findCoordinator:self-coord-blocked key=%s reason=%s', keyStr, decision.reason);
				throw new Error(`Self-coordination blocked: ${decision.reason}. No coordinator available for key.`);
			}
			if (decision.warn) {
				this.log('findCoordinator:self-selected-warn key=%s coordinator=%s reason=%s',
					keyStr, self.toString().substring(0, 12), decision.reason);
			} else {
				this.log('findCoordinator:self-selected key=%s coordinator=%s reason=%s',
					keyStr, self.toString().substring(0, 12), decision.reason);
			}
			return self
		}

		this.log('findCoordinator:all-excluded key=%s self=%s', keyStr, self.toString().substring(0, 12))
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

	private parseMultiaddrs(addrs: string[]): string[] {
		const out: string[] = []
		for (const a of addrs) {
			try { multiaddr(a); out.push(a) } catch (err) { console.warn('invalid multiaddr from connection', a, err) }
		}
		return out
	}

	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		const fret = this.getFret()
		const coord = await hashKey(key)
		const cohort = fret.assembleCohort(coord, this.clusterSize)
		const keyStr = this.toCacheKey(key).substring(0, 12);

		// Include self in the cohort
		const ids = Array.from(new Set([...cohort, this.libp2p.peerId.toString()]))

		const connectedByPeer = this.getConnectedAddrsByPeer()
		const connectedPeerIds = Object.keys(connectedByPeer)

		this.log('findCluster key=%s fretCohort=%d connected=%d cohortPeers=%o',
			keyStr, cohort.length, connectedPeerIds.length, ids.map(s => s.substring(0, 12)))

		const peers: ClusterPeers = {}

		for (const idStr of ids) {
			if (idStr === this.libp2p.peerId.toString()) {
				peers[idStr] = { multiaddrs: this.libp2p.getMultiaddrs().map(ma => ma.toString()), publicKey: this.libp2p.peerId.publicKey?.raw ?? new Uint8Array() }
				continue
			}
			const strings = connectedByPeer[idStr] ?? []
			peers[idStr] = { multiaddrs: this.parseMultiaddrs(strings), publicKey: new Uint8Array() }
		}

		this.log('findCluster:result key=%s clusterSize=%d withAddrs=%d connectedInCohort=%d',
			keyStr, Object.keys(peers).length,
			Object.values(peers).filter(p => p.multiaddrs.length > 0).length,
			ids.filter(id => connectedPeerIds.includes(id) || id === this.libp2p.peerId.toString()).length)
		return peers
	}
}
