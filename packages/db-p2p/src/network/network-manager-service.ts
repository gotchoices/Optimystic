import type { Startable, Logger, PeerId, Libp2p } from '@libp2p/interface'
import type { FretService } from 'p2p-fret'
import { hashKey } from 'p2p-fret'
import { toString as u8ToString } from 'uint8arrays/to-string'

export type NetworkManagerServiceInit = {
	clusterSize?: number
	seedKeys?: Uint8Array[]
	estimation?: { samples: number, kth: number, timeoutMs: number, ttlMs: number }
	readiness?: { minPeers: number, maxWaitMs: number }
	cacheTTLs?: { coordinatorMs: number, clusterMs: number }
	expectedRemotes?: boolean
	allowClusterDownsize?: boolean
	clusterSizeTolerance?: number
}

type Components = {
	logger: { forComponent: (name: string) => Logger },
	registrar: { handle: (...args: any[]) => Promise<void>, unhandle: (...args: any[]) => Promise<void> },
	libp2p?: Libp2p
}

interface WithFretService {
	services?: { fret?: FretService }
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
	private libp2pRef: Libp2p | undefined

	constructor(private readonly components: Components, init: NetworkManagerServiceInit = {}) {
		this.log = components.logger.forComponent('db-p2p:network-manager')
		this.cfg = {
			clusterSize: init.clusterSize ?? 1,
			seedKeys: init.seedKeys ?? [],
			estimation: init.estimation ?? { samples: 8, kth: 5, timeoutMs: 1000, ttlMs: 60_000 },
			readiness: init.readiness ?? { minPeers: 1, maxWaitMs: 2000 },
			cacheTTLs: init.cacheTTLs ?? { coordinatorMs: 30 * 60_000, clusterMs: 5 * 60_000 },
			expectedRemotes: init.expectedRemotes ?? false,
			allowClusterDownsize: init.allowClusterDownsize ?? true,
			clusterSizeTolerance: init.clusterSizeTolerance ?? 0.5
		}
	}

	setLibp2p(libp2p: Libp2p): void {
		this.libp2pRef = libp2p;
	}

	private getLibp2p(): Libp2p | undefined {
		return this.libp2pRef ?? this.components.libp2p;
	}

	private getFret(): FretService | undefined {
		const libp2p = this.getLibp2p();
		if (!libp2p) {
			return undefined;
		}
		return (libp2p as unknown as WithFretService).services?.fret;
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
		if (this.readyPromise) return this.readyPromise;
		this.readyPromise = (async () => {
			const results = await Promise.allSettled(
				(this.cfg.seedKeys ?? []).map(k => this.seedKey(k))
			);
			const failures = results.filter(r => r.status === 'rejected');
			if (failures.length > 0) {
				this.log('Failed to seed %d keys', failures.length);
			}
			await new Promise(r => setTimeout(r, 50));
		})();
		return this.readyPromise;
	}

	private async seedKey(key: Uint8Array): Promise<void> {
		const fret = this.getFret();
		if (!fret) {
			throw new Error('FRET service not available for seeding keys');
		}
		const coord = await hashKey(key);
		const _neighbors = fret.getNeighbors(coord, 'both', 1);
	}

	private toCacheKey(key: Uint8Array): string {
		return u8ToString(key, 'base64url')
	}

	private getKnownPeers(): PeerId[] {
		const libp2p = this.getLibp2p();
		if (!libp2p) {
			return [];
		}
		const selfId: PeerId = libp2p.peerId;
		const storePeers: Array<{ id: PeerId }> = (libp2p.peerStore as any)?.getPeers?.() ?? [];
		const connPeers: PeerId[] = (libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer);
		const all = [...storePeers.map(p => p.id), ...connPeers];
		const uniq = all.filter((p, i) => all.findIndex(x => x.toString() === p.toString()) === i);
		return uniq.filter((pid: PeerId) => pid.toString() !== selfId.toString());
	}

	getStatus(): { mode: 'alone' | 'healthy' | 'degraded', connections: number } {
		const libp2p = this.getLibp2p();
		if (!libp2p) {
			return { mode: this.cfg.expectedRemotes ? 'degraded' : 'alone', connections: 0 };
		}
		const peers: Array<{ id: PeerId }> = (libp2p.peerStore as any)?.getPeers?.() ?? [];
		const remotes = peers.filter(p => p.id.toString() !== libp2p.peerId.toString()).length;
		if (remotes === 0) {
			return { mode: this.cfg.expectedRemotes ? 'degraded' : 'alone', connections: 0 };
		}
		return { mode: 'healthy', connections: remotes };
	}

	async awaitHealthy(minRemotes: number, timeoutMs: number): Promise<boolean> {
		const start = Date.now()
		while (Date.now() - start < timeoutMs) {
			const libp2p = this.getLibp2p()
			if (libp2p) {
				// Require actual active connections, not just peerStore knowledge
				const connections = libp2p.getConnections?.() ?? []
				const connectedPeers = new Set(connections.map((c: any) => c.remotePeer.toString()))
				if (connectedPeers.size >= minRemotes) {
					this.log('awaitHealthy: satisfied with %d connections', connectedPeers.size)
					return true
				}
			}
			await new Promise(r => setTimeout(r, 100))
		}
		// Final check
		const libp2p = this.getLibp2p()
		if (libp2p) {
			const connections = libp2p.getConnections?.() ?? []
			const connectedPeers = new Set(connections.map((c: any) => c.remotePeer.toString()))
			const satisfied = connectedPeers.size >= minRemotes
			this.log('awaitHealthy: timeout - %d connections (needed %d)', connectedPeers.size, minRemotes)
			return satisfied
		}
		return false
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
	 * Find the nearest peer to the provided content key using FRET,
	 * falling back to self if FRET is unavailable.
	 */
	private async findNearestPeerToKey(key: Uint8Array): Promise<PeerId> {
		const fret = this.getFret();
		const libp2p = this.getLibp2p();

		if (!libp2p) {
			throw new Error('Libp2p not initialized');
		}

		if (fret) {
			const coord = await hashKey(key);
			const neighbors = fret.getNeighbors(coord, 'both', 1);
			if (neighbors.length > 0) {
				const pidStr = neighbors[0];
				if (pidStr) {
					const { peerIdFromString } = await import('@libp2p/peer-id');
					const pid = peerIdFromString(pidStr);
					if (!this.isBlacklisted(pid)) {
						return pid;
					}
				}
			}
		}

		// Fallback: choose among self + connected peers + known peers by distance to key
		const connected: PeerId[] = (libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer);
		const candidates = [libp2p.peerId, ...connected, ...this.getKnownPeers()]
			.filter((p, i, arr) => arr.findIndex(x => x.toString() === p.toString()) === i)
			.filter(p => !this.isBlacklisted(p));

		if (candidates.length === 0) {
			return libp2p.peerId;
		}

		const best = candidates.reduce((best: PeerId, cur: PeerId) =>
			this.lexLess(this.xor(best.toMultihash().bytes, key), this.xor(cur.toMultihash().bytes, key)) ? best : cur
			, candidates[0]!);
		return best;
	}

	/**
	 * Compute cluster using FRET's assembleCohort for content-addressed peer selection.
	 */
	async getCluster(key: Uint8Array): Promise<PeerId[]> {
		const ck = this.toCacheKey(key);
		const cached = this.clusterCache.get(ck);
		if (cached && cached.expires > Date.now()) {
			return cached.ids;
		}

		const fret = this.getFret();
		const libp2p = this.getLibp2p();

		if (!libp2p) {
			throw new Error('Libp2p not initialized');
		}

		if (fret) {
			const coord = await hashKey(key);
			const diag: any = (fret as any).getDiagnostics?.() ?? {};
			const estimate = typeof diag.estimate === 'number' ? diag.estimate : (typeof diag.n === 'number' ? diag.n : undefined);
			const targetSize = Math.max(1, Math.min(this.cfg.clusterSize, Number.isFinite(estimate) ? (estimate as number) : this.cfg.clusterSize));
			const cohortIds = fret.assembleCohort(coord, targetSize);
			const { peerIdFromString } = await import('@libp2p/peer-id');

			const ids = cohortIds
				.map(idStr => {
					try {
						return peerIdFromString(idStr);
					} catch (error) {
						this.log('Invalid peer ID in cohort: %s, %o', idStr, error);
						return null;
					}
				})
				.filter((pid): pid is PeerId => pid !== null && !this.isBlacklisted(pid));

			if (ids.length > 0) {
				this.clusterCache.set(ck, { ids, expires: Date.now() + this.cfg.cacheTTLs.clusterMs });
				this.lastEstimate = estimate != null ? { estimate, samples: diag.samples ?? 0, updated: Date.now() } : this.lastEstimate;
				return ids;
			}
		}

		// Fallback: peer-centric clustering if FRET unavailable
		const anchor = await this.findNearestPeerToKey(key);
		const anchorMh = anchor.toMultihash().bytes;
		const connected: PeerId[] = (libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer);
		const candidates = [anchor, libp2p.peerId, ...connected, ...this.getKnownPeers()]
			.filter((p, idx, arr) => !this.isBlacklisted(p) && arr.findIndex(x => x.toString() === p.toString()) === idx);
		const sorted = candidates.sort((a, b) => this.lexLess(this.xor(a.toMultihash().bytes, anchorMh), this.xor(b.toMultihash().bytes, anchorMh)) ? -1 : 1);
		const K = Math.min(this.cfg.clusterSize, sorted.length);
		const ids = sorted.slice(0, K);
		this.clusterCache.set(ck, { ids, expires: Date.now() + this.cfg.cacheTTLs.clusterMs });
		return ids;
	}

	async getCoordinator(key: Uint8Array): Promise<PeerId> {
		const ck = this.toCacheKey(key);
		const hit = this.coordinatorCache.get(ck);
		if (hit) {
			if (hit.expires > Date.now()) {
				return hit.id;
			} else {
				this.coordinatorCache.delete(ck);
			}
		}

		const cluster = await this.getCluster(key);
		const libp2p = this.getLibp2p();
		if (!libp2p) {
			throw new Error('Libp2p not initialized');
		}
		const candidate = cluster.find(p => !this.isBlacklisted(p)) ?? libp2p.peerId;
		this.recordCoordinator(key, candidate);
		return candidate;
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


