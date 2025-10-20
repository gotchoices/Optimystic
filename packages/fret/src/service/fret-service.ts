import type { Startable, PeerId, PeerInfo } from '@libp2p/interface';
import type {
	FretService as IFretService,
	FretMode,
	FretConfig,
	ReportEvent,
	RouteAndMaybeActV1,
	NearAnchorV1,
	NeighborSnapshotV1,
} from '../index.js';
import { DigitreeStore, type PeerEntry } from '../store/digitree-store.js';
import { hashKey, hashPeerId, coordToBase64url } from '../ring/hash.js';
import type { Libp2p } from 'libp2p';
import { makeProtocols } from '../rpc/protocols.js';
import { registerNeighbors, fetchNeighbors, announceNeighbors } from '../rpc/neighbors.js';
import { registerMaybeAct, sendMaybeAct } from '../rpc/maybe-act.js';
import { registerLeave, sendLeave } from '../rpc/leave.js';
import { registerPing, sendPing } from '../rpc/ping.js';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { estimateSizeAndConfidence } from '../estimate/size-estimator.js';
import { TokenBucket } from '../utils/token-bucket.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { chooseNextHop } from '../selector/next-hop.js';
import {
    createSparsityModel,
    normalizedLogDistance,
    touch as scoreTouch,
    recordSuccess as scoreSuccess,
    recordFailure as scoreFailure,
    type SparsityModel,
} from '../store/relevance.js';
import { createLogger } from '../logger.js';

const log = createLogger('service:fret');

interface WithPeerStore {
	peerStore?: { getPeers?: () => Array<{ id: PeerId }> };
}

export class FretService implements IFretService, Startable {
	private mode: FretMode = 'passive';
	private readonly store = new DigitreeStore();
	private readonly cfg: FretConfig;
	private readonly node: Libp2p;
	private stabilizing = false;
	private inflightAct = 0;
	private readonly bucketNeighbors: TokenBucket;
	private readonly bucketMaybeAct: TokenBucket;
	private readonly bucketDiscovery: TokenBucket;
	private readonly announcedIds = new Map<string, number>();
	private postBootstrapAnnounced = false;
	private readonly sparsity: SparsityModel = createSparsityModel();
	private cachedSelfCoord: Uint8Array | null = null;
	private preconnectRunning = false;
	private readonly protocols: ReturnType<typeof import('../rpc/protocols.js').makeProtocols>;
	private metadata?: Record<string, any>;
	private readonly diag = {
		peersDiscovered: 0,
		snapshotsFetched: 0,
		announcementsSent: 0,
		pingsSent: 0,
		pingsOk: 0,
		pingsFail: 0,
		maybeActForwarded: 0,
		evictions: 0,
	};

	// Network size observation tracking
	private networkObservations: Array<{
		estimate: number;
		confidence: number;
		timestamp: number;
		source: string;
	}> = [];
	private readonly maxObservations = 100;
	private readonly observationWindowMs = 300000; // 5 minutes

	constructor(node: Libp2p, cfg?: Partial<FretConfig>) {
		this.node = node;
		this.cfg = {
			k: cfg?.k ?? 15,
			m: cfg?.m ?? Math.ceil((cfg?.k ?? 15) / 2),
			capacity: cfg?.capacity ?? 2048,
			profile: cfg?.profile ?? 'core',
			bootstraps: cfg?.bootstraps ?? [],
			networkName: cfg?.networkName ?? 'default',
		};
		// Create network-specific protocols
		this.protocols = makeProtocols(this.cfg.networkName);
		// Discovery rate differs by profile
		this.bucketDiscovery = new TokenBucket(
			this.cfg.profile === 'core' ? 50 : 10,
			this.cfg.profile === 'core' ? 25 : 3
		);
		this.bucketNeighbors = new TokenBucket(
			this.cfg.profile === 'core' ? 20 : 8,
			this.cfg.profile === 'core' ? 10 : 4
		);
		this.bucketMaybeAct = new TokenBucket(
			this.cfg.profile === 'core' ? 32 : 8,
			this.cfg.profile === 'core' ? 16 : 4
		);
	}

	public getDiagnostics(): Readonly<typeof this.diag> {
		return this.diag;
	}

	private async selfCoord(): Promise<Uint8Array> {
		if (this.cachedSelfCoord) return this.cachedSelfCoord;
		this.cachedSelfCoord = await hashPeerId(this.node.peerId);
		return this.cachedSelfCoord;
	}

	private enforceCapacity(): void {
		const cap = Math.max(1, this.cfg.capacity);
		if (this.store.size() <= cap) return;
		// Protect immediate neighbors around self
		const self = this.cachedSelfCoord;
		if (!self) return;
		const protectedIds = this.store.protectedIdsAround(self, Math.max(2, this.cfg.m));
		// Evict the lowest relevance non-protected entries until under cap
		const entries = this.store.list();
		entries.sort((a, b) => a.relevance - b.relevance);
		for (const e of entries) {
			if (this.store.size() <= cap) break;
			if (protectedIds.has(e.id)) continue;
			this.store.remove(e.id);
		}
	}

	private async applyTouch(id: string, coord: Uint8Array): Promise<void> {
		const entry = this.store.getById(id) ?? this.store.upsert(id, coord);
		const x = normalizedLogDistance(await this.selfCoord(), coord);
		const next = scoreTouch(entry, x, this.sparsity);
		this.store.update(id, {
			lastAccess: next.lastAccess,
			relevance: next.relevance,
			accessCount: next.accessCount
		});
	}

	private async applySuccess(id: string, coord: Uint8Array, latencyMs: number): Promise<void> {
		const entry = this.store.getById(id) ?? this.store.upsert(id, coord);
		const x = normalizedLogDistance(await this.selfCoord(), coord);
		const next = scoreSuccess(entry, latencyMs, x, this.sparsity);
		this.store.update(id, {
			lastAccess: next.lastAccess,
			relevance: next.relevance,
			successCount: next.successCount,
			avgLatencyMs: next.avgLatencyMs
		});
	}

	private async applyFailure(id: string, coord: Uint8Array): Promise<void> {
		const entry = this.store.getById(id) ?? this.store.upsert(id, coord);
		const x = normalizedLogDistance(await this.selfCoord(), coord);
		const next = scoreFailure(entry, x, this.sparsity);
		this.store.update(id, {
			lastAccess: next.lastAccess,
			relevance: next.relevance,
			failureCount: next.failureCount
		});
	}

	async start(): Promise<void> {
		await this.seedFromPeerStore();
		this.registerRpcHandlers();
		await this.proactiveAnnounceOnStart();
		this.startStabilizationLoop();
		if (this.mode === 'active') void this.preconnectNeighbors();
		// One-time post-bootstrap announce when first remote connects
		this.node.addEventListener('peer:connect', async (evt: any) => {
			if (this.postBootstrapAnnounced) return;
			this.postBootstrapAnnounced = true;
			try { await this.announceNeighborsBounded(8); } catch (err) { log('postBootstrap announce failed - %o', err) }
		});
		this.node.addEventListener('peer:connect', async (evt: any) => {
			try {
				const id = evt?.detail?.id?.toString?.();
				if (!id) return;
				const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
				this.store.setState(id, 'connected');
				await this.applyTouch(id, coord);
			} catch (err) { log('peer:connect handler failed - %o', err) }
		});
		this.node.addEventListener('peer:disconnect', async (evt: any) => {
			try {
				const id = evt?.detail?.id?.toString?.();
				if (!id) return;
				const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
				this.store.setState(id, 'disconnected');
				await this.applyFailure(id, coord);
			} catch (err) { log('peer:disconnect handler failed - %o', err) }
		});
	}

	async stop(): Promise<void> {
		this.stabilizing = false;
		try { await this.sendLeaveToNeighbors(); } catch (err) { console.warn('sendLeaveToNeighbors failed', err); }
	}

	setMode(mode: FretMode): void {
		this.mode = mode;
		if (mode === 'active' && !this.preconnectRunning) this.startActivePreconnectLoop();
	}

	async ready(): Promise<void> {}

	// RPC registration
	private registerRpcHandlers(): void {
		registerNeighbors(
			this.node,
			async () => this.handleNeighborsRequest(),
			(from, snap) => {
				void this.mergeAnnounceSnapshot(from, snap);
			},
			this.protocols
		);
		registerMaybeAct(this.node, async (msg) => this.handleMaybeAct(msg), this.protocols.PROTOCOL_MAYBE_ACT);
		registerLeave(this.node, async (notice) => this.handleLeave(notice.from), this.protocols.PROTOCOL_LEAVE);
		registerPing(
			this.node,
			this.protocols.PROTOCOL_PING,
			() => this.getNetworkSizeEstimate()
		);
	}

	private async handleNeighborsRequest(): Promise<NeighborSnapshotV1> {
		if (!this.bucketNeighbors.tryTake()) {
			return {
				v: 1,
				from: this.node.peerId.toString(),
				timestamp: Date.now(),
				successors: [],
				predecessors: [],
				sig: '',
			};
		}
		return await this.snapshot();
	}

	private async handleMaybeAct(
		msg: RouteAndMaybeActV1
	): Promise<NearAnchorV1 | { commitCertificate: string }> {
		// quick guards
		if (msg.ttl <= 0) return await this.nearAnchorOnly(msg);
		if (msg.activity && msg.activity.length > 128 * 1024) return await this.nearAnchorOnly(msg);
		if (!this.bucketMaybeAct.tryTake()) return await this.nearAnchorOnly(msg);
		const limit = this.cfg.profile === 'core' ? 16 : 4;
		if (this.inflightAct >= limit) return this.nearAnchorOnly(msg);
		this.inflightAct++;
		try {
			return await this.routeAct(msg);
		} catch (err) {
			console.error('routeAct failed:', err);
			return await this.nearAnchorOnly(msg);
		} finally {
			this.inflightAct--;
		}
	}

	private isConnected(id: string): boolean {
		try {
			return this.node.getConnections(peerIdFromString(id)).length > 0;
		} catch {
			return false;
		}
	}

	private hasAddresses(id: string): boolean {
		try {
			// libp2p >=2 exposes getMultiaddrsForPeer
			const addrs = (this.node as any).getMultiaddrsForPeer?.(peerIdFromString(id)) ?? [];
			return Array.isArray(addrs) && addrs.length > 0;
		} catch {
			return false;
		}
	}

	private async proactiveAnnounceOnStart(): Promise<void> {
		try {
			await this.announceNeighborsBounded(8);
		} catch (err) {
			console.warn('proactiveAnnounceOnStart failed', err);
		}
	}

	private async announceNeighborsBounded(maxCount: number): Promise<void> {
		const selfCoord = await hashPeerId(this.node.peerId);
		const selfStr = this.node.peerId.toString();
		const ids = Array.from(new Set([
			...this.getNeighbors(selfCoord, 'right', this.cfg.m),
			...this.getNeighbors(selfCoord, 'left', this.cfg.m)
		])).filter((id) => id !== selfStr).slice(0, maxCount);
		const snap = await this.snapshot();
		for (const id of ids) {
			if (this.isConnected(id) || this.hasAddresses(id)) {
				try { await announceNeighbors(this.node, id, snap, this.protocols.PROTOCOL_NEIGHBORS_ANNOUNCE); this.diag.announcementsSent++; } catch (err) { console.warn('announce failed', id, err); }
			}
		}
	}

	private async preconnectNeighbors(): Promise<void> {
		try {
			const selfCoord = await hashPeerId(this.node.peerId);
			const selfStr = this.node.peerId.toString();
			const ids = Array.from(new Set([
				...this.getNeighbors(selfCoord, 'right', Math.min(6, this.cfg.m)),
				...this.getNeighbors(selfCoord, 'left', Math.min(6, this.cfg.m))
			])).filter((id) => id !== selfStr);
			for (const id of ids) {
				if (this.isConnected(id) || this.hasAddresses(id)) {
					try { await sendPing(this.node, id, this.protocols.PROTOCOL_PING); this.diag.pingsSent++; } catch (err) { log('preconnectNeighbors ping failed for %s - %o', id, err) }
				}
			}
		} catch (err) { log('preconnectNeighbors outer failed - %o', err) }
	}

	private startActivePreconnectLoop(): void {
		if (this.preconnectRunning) return;
		this.preconnectRunning = true;
		const tick = async () => {
			if (!this.preconnectRunning || this.mode !== 'active') { this.preconnectRunning = false; return; }
			try {
				const selfCoord = await this.selfCoord();
				const selfStr = this.node.peerId.toString();
				const budget = this.cfg.profile === 'core' ? 6 : 3;
				const ids = Array.from(new Set([
					...this.getNeighbors(selfCoord, 'right', Math.min(12, this.cfg.m)),
					...this.getNeighbors(selfCoord, 'left', Math.min(12, this.cfg.m))
				])).filter((id) => id !== selfStr).slice(0, budget);
				for (const id of ids) {
					if (this.isConnected(id) || this.hasAddresses(id)) {
						try { await sendPing(this.node, id, this.protocols.PROTOCOL_PING); this.diag.pingsSent++; } catch (err) { log('active preconnect ping failed for %s - %o', id, err) }
					}
				}
			} catch (err) { log('active preconnect tick failed - %o', err) }
			setTimeout(tick, 1000);
		};
		void tick();
	}

	private async sendLeaveToNeighbors(): Promise<void> {
		try {
			const selfCoord = await hashPeerId(this.node.peerId);
			const selfStr = this.node.peerId.toString();
			const ids = Array.from(new Set([
				...this.getNeighbors(selfCoord, 'right', this.cfg.m),
				...this.getNeighbors(selfCoord, 'left', this.cfg.m)
			])).filter((id) => id !== selfStr).slice(0, 8);
		const notice = { v: 1, from: this.node.peerId.toString(), timestamp: Date.now() } as const;
		for (const id of ids) {
			try { await sendLeave(this.node, id, notice, this.protocols.PROTOCOL_LEAVE); } catch (err) { log('sendLeave failed for %s - %o', id, err) }
		}
		} catch (err) { log('sendLeaveToNeighbors outer failed - %o', err) }
	}

	private async handleLeave(peerId: string): Promise<void> {
		try {
			let coord: Uint8Array | null = null;
			const entry = this.store.getById(peerId);
			if (entry) coord = entry.coord;
			else {
				try {
					coord = await hashPeerId(peerIdFromString(peerId));
				} catch (e) {
					console.warn('handleLeave: could not hash departing peer id', peerId, e);
				}
			}
			// remove leaving peer
			this.store.remove(peerId);
			// penalize the departed peer slightly (if re-seen soon, it must rebuild)
			if (coord) {
				try { await this.applyFailure(peerId, coord); } catch {}
			}
			if (!coord) return;
			// compute baseline neighbors and expand breadth to refill coverage
			const base = Array.from(
				new Set([
					...this.store.neighborsRight(coord, this.cfg.m),
					...this.store.neighborsLeft(coord, this.cfg.m),
				])
			);
			const expanded = this.expandCohort(base, coord, Math.max(2, Math.ceil(this.cfg.m / 2)));
			const baseSet = new Set(base);
			const newIds = expanded.filter((id) => !baseSet.has(id));
			// proactively warm a bounded number of replacements and merge their neighbor views
			const warm = newIds.slice(0, Math.min(newIds.length, 6));
			for (const id of warm) {
				try {
					await sendPing(this.node, id, this.protocols.PROTOCOL_PING);
					if (!this.isConnected(id)) {
						const snap = await this.snapshot();
						await announceNeighbors(this.node, id, snap, this.protocols.PROTOCOL_NEIGHBORS_ANNOUNCE);
					}
				} catch (err) {
					console.warn('warm/announce failed for', id, err);
				}
			}
			await this.mergeNeighborSnapshots(warm.slice(0, 4));
		} catch (err) {
			console.error('handleLeave failed for', peerId, err);
		}
	}

	private async mergeAnnounceSnapshot(from: string, snap: NeighborSnapshotV1): Promise<void> {
		try {
			const self = peerIdFromString(from);
			const selfCoord = await hashPeerId(self);
			const discovered: string[] = [];
			if (!this.store.getById(from)) discovered.push(from);
			this.store.upsert(from, selfCoord);
			await this.applyTouch(from, selfCoord);

			if (snap.metadata) {
				// Update metadata via store.update to avoid mutating frozen entries
				this.store.update(from, { metadata: snap.metadata });
			}

			for (const pid of [...(snap.successors ?? []), ...(snap.predecessors ?? [])]) {
				try {
					const coord = await hashPeerId(peerIdFromString(pid));
					if (!this.store.getById(pid)) discovered.push(pid);
					this.store.upsert(pid, coord);
					await this.applyTouch(pid, coord);
				} catch (err) {
					console.warn('mergeAnnounceSnapshot: failed for', pid, err);
				}
			}
			// merge bounded sample if present
			for (const s of snap.sample ?? []) {
					try {
					const coord = u8FromString(s.coord, 'base64url');
					if (!this.store.getById(s.id)) discovered.push(s.id);
					this.store.upsert(s.id, coord);
					await this.applyTouch(s.id, coord);
					} catch (err) { log('mergeAnnounceSnapshot sample upsert failed for %s - %o', s.id, err) }
			}
			this.enforceCapacity();
			this.emitDiscovered(discovered);
		} catch (err) {
			console.warn('mergeAnnounceSnapshot failed for', from, err);
		}
	}

	// Seeding and stabilization
	private async seedFromPeerStore(): Promise<void> {
		try {
			const peers = (this.node as unknown as WithPeerStore).peerStore?.getPeers?.() ?? [];
			const discovered: string[] = [];
			for (const p of peers) {
				try {
					const coord = await hashPeerId(p.id);
					const pidStr = p.id.toString();
					if (!this.store.getById(pidStr)) discovered.push(pidStr);
					this.store.upsert(pidStr, coord);
				} catch (err) {
					console.warn('failed to add peer from peerStore', p?.id?.toString?.(), err);
				}
			}
			try {
				const coord = await hashPeerId(this.node.peerId);
				const selfStr = this.node.peerId.toString();
				if (!this.store.getById(selfStr)) discovered.push(selfStr);
				this.store.upsert(selfStr, coord);
			} catch (err) {
				console.error('failed to add self to store', err);
			}
			this.enforceCapacity();
			this.emitDiscovered(discovered);
		} catch (err) {
			console.error('seedFromPeerStore failed:', err);
		}
	}

	private startStabilizationLoop(): void {
		if (this.stabilizing) return;
		this.stabilizing = true;
		const tick = async () => {
			if (!this.stabilizing) return;
			try {
				await this.seedFromPeerStore();
				await this.seedFromBootstraps();
				await this.stabilizeOnce();
			} catch (err) {
				console.error('stabilize tick failed:', err);
			} finally {
				const delay = this.mode === 'active' ? 300 : 1500;
				setTimeout(tick, delay);
			}
		};
		tick();
	}

	private async seedFromBootstraps(): Promise<void> {
		if (!this.cfg.bootstraps || this.cfg.bootstraps.length === 0) return;
		const discovered: string[] = [];
		for (const bootstrapEntry of this.cfg.bootstraps.slice(0, 8)) {
			try {
				let id = bootstrapEntry;
				// If it's a multiaddr, extract the peer ID using proper parsing
				if (bootstrapEntry.startsWith('/')) {
					try {
						const ma = multiaddr(bootstrapEntry);
						const peerIdStr = ma.getPeerId();
						if (peerIdStr) id = peerIdStr;
					} catch {
						// Not a valid multiaddr, assume it's already a peer ID
					}
				}
				const pid = peerIdFromString(id);
				const coord = await hashPeerId(pid);
				if (!this.store.getById(id)) discovered.push(id);
				this.store.upsert(id, coord);
				await this.applyTouch(id, coord);
			} catch (err) {
				console.warn('seedFromBootstraps failed for', bootstrapEntry, err);
			}
		}
		this.enforceCapacity();
		this.emitDiscovered(discovered);
	}

	private async stabilizeOnce(): Promise<void> {
		const selfCoord = await hashPeerId(this.node.peerId);
		const selfStr = this.node.peerId.toString();
		const nearAll = this.getNeighbors(selfCoord, 'both', Math.max(2, this.cfg.m));
		const near = nearAll.filter((id) => id !== selfStr && (this.isConnected(id) || this.hasAddresses(id)));
		await this.probeNeighborsLatency(near.slice(0, 4));
		await this.mergeNeighborSnapshots(near.slice(0, 4));
	}

	private async probeNeighborsLatency(ids: string[]): Promise<void> {
		for (const id of ids) {
			try {
				const res = await sendPing(this.node, id, this.protocols.PROTOCOL_PING);
				this.diag.pingsSent++;
				if (res.ok) {
					const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
					await this.applySuccess(id, coord, res.rttMs);
					this.diag.pingsOk++;
				} else {
					const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
					await this.applyFailure(id, coord);
					this.diag.pingsFail++;
				}
			} catch (err) {
				// benign during churn - do not warn each tick
				// console.warn('ping failed for', id, err);
				try {
					const coord = this.store.getById(id)?.coord ?? (await hashPeerId(peerIdFromString(id)));
					await this.applyFailure(id, coord);
					this.diag.pingsFail++;
				} catch {}
			}
		}
	}

	private async mergeNeighborSnapshots(ids: string[]): Promise<void> {
		const announced: string[] = [];
		for (const id of ids) {
			try {
				const snap: NeighborSnapshotV1 = await fetchNeighbors(this.node, id, this.protocols.PROTOCOL_NEIGHBORS);
				this.diag.snapshotsFetched++;
				const capSucc = this.cfg.profile === 'core' ? 16 : 8;
				const capPred = this.cfg.profile === 'core' ? 16 : 8;
				const succList = (snap.successors ?? []).slice(0, capSucc);
				const predList = (snap.predecessors ?? []).slice(0, capPred);
				for (const pid of [...succList, ...predList]) {
					try {
						const coord = await hashPeerId(peerIdFromString(pid));
						if (!this.store.getById(pid)) announced.push(pid);
						this.store.upsert(pid, coord);
						await this.applyTouch(pid, coord);
					} catch (err) {
						console.warn('failed to merge neighbor', pid, err);
					}
				}
				const capSample = this.cfg.profile === 'core' ? 8 : 6;
		for (const s of (snap.sample ?? []).slice(0, capSample)) {
			try {
						const coord = u8FromString(s.coord, 'base64url');
						if (!this.store.getById(s.id)) announced.push(s.id);
						this.store.upsert(s.id, coord);
						await this.applyTouch(s.id, coord);
				} catch (err) { log('mergeNeighborSnapshots sample upsert failed for %s - %o', s.id, err) }
				}
			} catch (err) {
				console.warn('fetchNeighbors failed for', id, err);
			}
		}
		this.enforceCapacity();
		this.emitDiscovered(announced);
	}

	// Snapshots
	private async snapshot(): Promise<NeighborSnapshotV1> {
		const selfCoord = await hashPeerId(this.node.peerId);
		const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m);
		const capSucc = this.cfg.profile === 'core' ? 12 : 6;
		const capPred = this.cfg.profile === 'core' ? 12 : 6;
		const capSample = this.cfg.profile === 'core' ? 8 : 6;
		const rawSucc = this.getNeighbors(selfCoord, 'right', this.cfg.m);
		const rawPred = this.getNeighbors(selfCoord, 'left', this.cfg.m);
		const successors = rawSucc.slice(0, capSucc);
		const predecessors = rawPred.slice(0, capPred);
		const sampleIds = Array.from(new Set([...successors.slice(0, 4), ...predecessors.slice(0, 4)])).slice(0, capSample);
		const sample = await Promise.all(sampleIds.map(async (id) => {
			const entry = this.store.getById(id);
			if (!entry) return { id, coord: '', relevance: 0 } as { id: string; coord: string; relevance: number };
			return { id, coord: coordToBase64url(entry.coord), relevance: entry.relevance } as { id: string; coord: string; relevance: number };
		}));
		return {
			v: 1,
			from: this.node.peerId.toString(),
			timestamp: Date.now(),
			successors,
			predecessors,
			sample,
			size_estimate: n,
			confidence,
			sig: '',
			metadata: this.metadata,
		};
	}

	// Cohort/neighbors
	neighborDistance(selfId: string, hashedCoord: Uint8Array, k: number): number {
		const exclude = new Set<string>();
		const wants = Math.max(1, k);
		const cohort = this.assembleCohort(hashedCoord, wants, exclude);
		const idx = cohort.findIndex((id) => id === selfId);
		return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
	}

	getNeighbors(
		hashedCoord: Uint8Array,
		direction: 'left' | 'right' | 'both',
		wants: number
	): string[] {
		const ids: string[] = [];
		if (direction === 'right' || direction === 'both')
			ids.push(...this.store.neighborsRight(hashedCoord, wants));
		if (direction === 'left' || direction === 'both')
			ids.push(...this.store.neighborsLeft(hashedCoord, wants));
		return Array.from(new Set(ids)).slice(0, wants);
	}

	private nextSuccessor(cur: PeerEntry, arr: PeerEntry[]): PeerEntry | undefined {
		const idx = arr.findIndex((e) => e.id === cur.id);
		return arr[(idx + 1) % arr.length];
	}
	private nextPredecessor(cur: PeerEntry, arr: PeerEntry[]): PeerEntry | undefined {
		const idx = arr.findIndex((e) => e.id === cur.id);
		return arr[(idx - 1 + arr.length) % arr.length];
	}

	assembleCohort(hashedCoord: Uint8Array, wants: number, exclude?: Set<string>): string[] {
		const out: string[] = [];
		const ex = exclude ?? new Set<string>();
		const succIds = this.store.neighborsRight(hashedCoord, wants * 2);
		const predIds = this.store.neighborsLeft(hashedCoord, wants * 2);
		let si = 0,
			pi = 0;
		while (out.length < wants && (si < succIds.length || pi < predIds.length)) {
			if (out.length % 2 === 0) {
				const id = succIds[si++];
				if (id && !ex.has(id)) out.push(id);
			} else {
				const id = predIds[pi++];
				if (id && !ex.has(id)) out.push(id);
			}
		}
		return Array.from(new Set(out)).slice(0, wants);
	}

	expandCohort(
		current: string[],
		hashedCoord: Uint8Array,
		step: number,
		exclude?: Set<string>
	): string[] {
		const base = new Set(current);
		const next = this.assembleCohort(hashedCoord, current.length + step, exclude);
		for (const id of next) base.add(id);
		return Array.from(base);
	}

	// Routing
	private async nearAnchorOnly(msg: RouteAndMaybeActV1): Promise<NearAnchorV1> {
		const keyBytes = u8FromString(msg.key, 'base64url');
		const coord = await hashKey(keyBytes);
		const right = this.getNeighbors(coord, 'right', this.cfg.m);
		const left = this.getNeighbors(coord, 'left', this.cfg.m);
		const anchors = this.pickAnchors([...right.slice(0, 3), ...left.slice(0, 3)]);
		return {
			v: 1,
			anchors,
			cohort_hint: Array.from(new Set([...right.slice(0, 2), ...left.slice(0, 2)])),
			estimated_cluster_size: this.cfg.k,
			confidence: 0.5,
		};
	}

	// Discovery event emission
	private emitDiscovered(ids: string[]): void {
		if (ids.length === 0) return;
		const now = Date.now();
		const ttl = this.cfg.profile === 'core' ? 10 * 60_000 : 30 * 60_000;
		const target = this.node as unknown as { dispatchEvent?: (evt: Event) => void };
		let emitted = 0;
		for (const id of Array.from(new Set(ids))) {
			const exp = this.announcedIds.get(id) ?? 0;
			if (exp > now) continue;
			if (!this.bucketDiscovery.tryTake()) break;
			try {
				const pid = peerIdFromString(id);
				target.dispatchEvent?.(new CustomEvent('peer:discovery', { detail: { id: pid, multiaddrs: [] } as PeerInfo }));
				this.announcedIds.set(id, now + ttl);
				emitted++;
			} catch (err) {
				console.warn('emitDiscovered failed for', id, err);
			}
		}
		// Optionally prune old entries to cap memory
		if (emitted > 0 && this.announcedIds.size > 4096) {
			for (const [k, v] of this.announcedIds) { if (v <= now) this.announcedIds.delete(k); }
		}
	}

	private pickAnchors(candidates: string[]): string[] {
		const unique = Array.from(new Set(candidates));
		if (unique.length === 0) return [];
		const linkQ = (_id: string) => 0.5; // neutral until reputation is enabled
		// Without a specific target here, prefer connected-first by using self coord as proxy
		// Compute self coord once
		const selfCoord = new Uint8Array(32);
		const first = chooseNextHop(this.store, selfCoord, unique, (id) => this.isConnected(id), linkQ);
		const rest = unique.filter((id) => id !== first);
		const second = chooseNextHop(this.store, selfCoord, rest, (id) => this.isConnected(id), linkQ);
		return [first, second].filter((x): x is string => Boolean(x));
	}

	async routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }> {
		const keyBytes = u8FromString(msg.key, 'base64url');
		const coord = await hashKey(keyBytes);
		// If we are not near the anchor, forward using maybeAct with ttl and breadcrumbs
		const selfId = this.node.peerId.toString();
		const distIdx = this.neighborDistance(selfId, coord, 2);
		if (distIdx > 1 && msg.ttl > 0) {
			const exclude = new Set([...(msg.breadcrumbs ?? []), selfId]);
			const candidates = this.assembleCohort(coord, Math.max(4, this.cfg.m)).filter((id) => !exclude.has(id));
			const linkQ = (_id: string) => 0.5;
			const next = chooseNextHop(this.store, coord, candidates, (id) => this.isConnected(id), linkQ);
			if (next) {
			const fwd: RouteAndMaybeActV1 = {
				...msg,
				ttl: msg.ttl - 1,
				breadcrumbs: [...(msg.breadcrumbs ?? []), selfId]
			};
			try { return await sendMaybeAct(this.node, next, fwd, this.protocols.PROTOCOL_MAYBE_ACT); } catch (err) { console.warn('forward maybeAct failed to', next, err); }
			}
		}
		const { n, confidence } = estimateSizeAndConfidence(this.store, this.cfg.m);
		const right = this.getNeighbors(coord, 'right', this.cfg.m);
		const left = this.getNeighbors(coord, 'left', this.cfg.m);
		const anchors = this.pickAnchors([...right.slice(0, 4), ...left.slice(0, 4)]);
		return {
			v: 1,
			anchors,
			cohort_hint: Array.from(new Set([...right.slice(0, 4), ...left.slice(0, 4)])),
			estimated_cluster_size: Math.max(this.cfg.k, n),
			confidence,
		};
	}

	report(_evt: ReportEvent): void {
		// no-op until reputation is enabled
	}

	/**
	 * Add an external network size observation (e.g., from cluster messages, peer queries)
	 */
	reportNetworkSize(estimate: number, confidence: number, source: string = 'external'): void {
		const now = Date.now();
		this.networkObservations.push({
			estimate,
			confidence,
			timestamp: now,
			source
		});

		// Trim old observations
		const cutoff = now - this.observationWindowMs;
		this.networkObservations = this.networkObservations.filter(o => o.timestamp > cutoff);

		// Keep only most recent observations
		if (this.networkObservations.length > this.maxObservations) {
			this.networkObservations = this.networkObservations.slice(-this.maxObservations);
		}
	}

	/**
	 * Get enhanced network size estimate combining FRET's estimate with external observations
	 */
	getNetworkSizeEstimate(): { size_estimate: number; confidence: number; sources: number } {
		// Get FRET's own estimate
		const fretEstimate = estimateSizeAndConfidence(this.store, this.cfg.m);

		// Add FRET estimate as an observation
		const now = Date.now();
		const allObservations = [
			{
				estimate: fretEstimate.n,
				confidence: fretEstimate.confidence,
				timestamp: now,
				source: 'fret'
			},
			...this.networkObservations
		];

		if (allObservations.length === 0) {
			return { size_estimate: 0, confidence: 0, sources: 0 };
		}

		// Weight recent observations more heavily with exponential decay
		let totalWeight = 0;
		let weightedSum = 0;
		let confidenceSum = 0;

		for (const obs of allObservations) {
			const age = now - obs.timestamp;
			const recencyWeight = Math.exp(-age / (this.observationWindowMs / 3));
			const weight = recencyWeight * obs.confidence;

			weightedSum += obs.estimate * weight;
			confidenceSum += obs.confidence * recencyWeight;
			totalWeight += weight;
		}

		if (totalWeight === 0) {
			return { size_estimate: 0, confidence: 0, sources: 0 };
		}

		const estimate = Math.round(weightedSum / totalWeight);
		const avgConfidence = confidenceSum / allObservations.length;

		return {
			size_estimate: estimate,
			confidence: Math.min(1, avgConfidence),
			sources: allObservations.length
		};
	}

	/**
	 * Calculate recent rate of change in network size estimates
	 * Returns change per minute
	 */
	getNetworkChurn(): number {
		if (this.networkObservations.length < 2) {
			return 0;
		}

		const now = Date.now();
		const halfWindow = this.observationWindowMs / 2;
		const cutoff = now - halfWindow;

		const recentObs = this.networkObservations.filter(o => o.timestamp > cutoff);
		const olderObs = this.networkObservations.filter(o => o.timestamp <= cutoff);

		if (recentObs.length === 0 || olderObs.length === 0) {
			return 0;
		}

		const recentAvg = recentObs.reduce((sum, o) => sum + o.estimate, 0) / recentObs.length;
		const olderAvg = olderObs.reduce((sum, o) => sum + o.estimate, 0) / olderObs.length;

		// Return change per minute
		const changePerMs = (recentAvg - olderAvg) / halfWindow;
		return changePerMs * 60000;
	}

	/**
	 * Detect if we're likely in a network partition based on sudden drop
	 */
	detectPartition(): boolean {
		if (this.networkObservations.length < 10) {
			return false; // Not enough data
		}

		const current = this.getNetworkSizeEstimate();
		if (current.confidence < 0.3) {
			return false; // Not confident enough
		}

		// Get estimate from 30 seconds ago
		const thirtySecondsAgo = Date.now() - 30000;
		const oldObs = this.networkObservations.filter(o => o.timestamp < thirtySecondsAgo);

		if (oldObs.length < 3) {
			return false;
		}

		const oldAvg = oldObs.slice(-5).reduce((sum, o) => sum + o.estimate, 0) / Math.min(5, oldObs.length);

		// Detect sudden drop of more than 50%
		const dropRatio = current.size_estimate / oldAvg;
		if (dropRatio < 0.5) {
			return true;
		}

		// Also check churn rate
		const churn = Math.abs(this.getNetworkChurn());
		const churnThreshold = current.size_estimate * 0.1; // 10% per minute is suspicious

		return churn > churnThreshold;
	}

	setMetadata(metadata: Record<string, any>): void {
		this.metadata = metadata;
	}

	getMetadata(peerId: string): Record<string, any> | undefined {
		const entry = this.store.getById(peerId);
		return entry?.metadata;
	}

	listPeers(): Array<{ id: string; metadata?: Record<string, any> }> {
		return this.store.list().map(entry => ({
			id: entry.id,
			metadata: entry.metadata
		}));
	}
}
