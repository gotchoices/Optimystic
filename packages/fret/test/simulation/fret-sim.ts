import { DeterministicRNG } from './deterministic-rng.js'
import { EventScheduler, type SimEvent } from './event-scheduler.js'
import { MetricsCollector, type SimMetrics } from './sim-metrics.js'
import { DigitreeStore } from '../../src/store/digitree-store.js'

export interface SimPeer {
	id: string
	coord: Uint8Array
	alive: boolean
	connected: Set<string>
	neighbors: Set<string>
}

export interface SimConfig {
	seed: number
	n: number // total peers
	k: number // cluster size
	m: number // neighbors
	churnRatePerSec: number // peers leaving/joining per second
	stabilizationIntervalMs: number
	durationMs: number
}

export class FretSimulation {
	private readonly rng: DeterministicRNG
	private readonly scheduler: EventScheduler
	private readonly metrics: MetricsCollector
	private readonly config: SimConfig
	private readonly peers = new Map<string, SimPeer>()
	private readonly stores = new Map<string, DigitreeStore>()

	constructor(config: SimConfig) {
		this.config = config
		this.rng = new DeterministicRNG(config.seed)
		this.scheduler = new EventScheduler()
		this.metrics = new MetricsCollector()
	}

	initialize(): void {
		// Create initial peers
		for (let i = 0; i < this.config.n; i++) {
			const peer = this.createPeer(i)
			this.peers.set(peer.id, peer)
			const store = new DigitreeStore()
			store.upsert(peer.id, peer.coord)
			this.stores.set(peer.id, store)
			this.metrics.recordJoin()
		}

		// Schedule initial connections
		for (const peer of this.peers.values()) {
			this.scheduler.schedule({ type: 'connect', peerId: peer.id }, this.rng.nextInt(0, 100))
		}

		// Schedule stabilization cycles
		this.scheduleStabilization()

		// Schedule churn events
		if (this.config.churnRatePerSec > 0) {
			this.scheduleChurn()
		}
	}

	private createPeer(index: number): SimPeer {
		const id = `peer-${index.toString().padStart(4, '0')}`
		const coord = new Uint8Array(32)
		// Deterministic coordinate distribution
		const bigIndex = BigInt(index)
		const range = (1n << 256n) / BigInt(this.config.n)
		const val = bigIndex * range
		for (let i = 0; i < 32; i++) {
			coord[31 - i] = Number((val >> BigInt(i * 8)) & 0xffn)
		}
		return { id, coord, alive: true, connected: new Set(), neighbors: new Set() }
	}

	private scheduleStabilization(): void {
		const interval = this.config.stabilizationIntervalMs
		for (let t = interval; t < this.config.durationMs; t += interval) {
			this.scheduler.schedule({ type: 'stabilize' }, t)
		}
	}

	private scheduleChurn(): void {
		const intervalMs = Math.floor(1000 / this.config.churnRatePerSec)
		for (let t = intervalMs; t < this.config.durationMs; t += intervalMs) {
			const alive = Array.from(this.peers.values()).filter((p) => p.alive)
			if (alive.length === 0) continue
			const leaving = this.rng.pick(alive)
			if (leaving) {
				this.scheduler.schedule({ type: 'leave', peerId: leaving.id }, t)
			}
		}
	}

	run(): SimMetrics {
		this.initialize()

		while (this.scheduler.pending() > 0) {
			const evt = this.scheduler.nextEvent()
			if (!evt) break
			if (evt.time > this.config.durationMs) break
			this.handleEvent(evt)
		}

		return this.metrics.finalize()
	}

	private handleEvent(evt: SimEvent): void {
		switch (evt.type) {
			case 'connect':
				if (evt.peerId) this.handleConnect(evt.peerId)
				break
			case 'leave':
				if (evt.peerId) this.handleLeave(evt.peerId)
				break
			case 'stabilize':
				this.handleStabilize()
				break
		}
	}

	private handleConnect(peerId: string): void {
		const peer = this.peers.get(peerId)
		if (!peer || !peer.alive) return

		// Find nearest peers to connect to
		const store = this.stores.get(peerId)
		if (!store) return

		// Seed store with a few random peers
		const alivePeers = Array.from(this.peers.values())
			.filter((p) => p.id !== peerId && p.alive)
		const sample = this.rng.shuffle(alivePeers).slice(0, Math.min(5, alivePeers.length))
		for (const other of sample) {
			store.upsert(other.id, other.coord)
			peer.connected.add(other.id)
			this.metrics.recordConnection()
		}
	}

	private handleLeave(peerId: string): void {
		const peer = this.peers.get(peerId)
		if (!peer || !peer.alive) return

		peer.alive = false
		peer.connected.clear()
		peer.neighbors.clear()
		this.metrics.recordLeave()
	}

	private handleStabilize(): void {
		this.metrics.recordStabilization()

		for (const peer of this.peers.values()) {
			if (!peer.alive) continue

			const store = this.stores.get(peer.id)
			if (!store) continue

			// Update neighbors from store
			const right = store.neighborsRight(peer.coord, this.config.m)
			const left = store.neighborsLeft(peer.coord, this.config.m)
			const neighbors = new Set([...right, ...left].filter((id) => id !== peer.id))

			peer.neighbors = neighbors
			this.metrics.recordNeighbors(neighbors.size)

			// Exchange with neighbors
			for (const nid of neighbors) {
				const neighbor = this.peers.get(nid)
				if (!neighbor || !neighbor.alive) continue

				const nstore = this.stores.get(nid)
				if (!nstore) continue

				// Merge a few entries
				for (const p of Array.from(this.peers.values()).slice(0, 3)) {
					if (p.alive) {
						store.upsert(p.id, p.coord)
						nstore.upsert(p.id, p.coord)
					}
				}
			}
		}
	}

	getPeers(): ReadonlyMap<string, SimPeer> {
		return this.peers
	}

	getStores(): ReadonlyMap<string, DigitreeStore> {
		return this.stores
	}
}

