import type { Startable, Libp2p } from '@libp2p/interface'
import { hashKey } from 'p2p-fret'
import type { FretService } from 'p2p-fret'
import type { PartitionDetector } from './partition-detector.js'
import type { ArachnodeFretAdapter, ArachnodeInfo } from '../storage/arachnode-fret-adapter.js'
import { createLogger } from '../logger.js'

const log = createLogger('rebalance-monitor')
const textEncoder = new TextEncoder()

export interface RebalanceEvent {
	/** Block IDs this node has gained responsibility for */
	gained: string[]
	/** Block IDs this node has lost responsibility for */
	lost: string[]
	/** Peers that are now closer for the lost blocks: blockId → peerId[] */
	newOwners: Map<string, string[]>
	/**
	 * Replication floor `N` for this event — the cohort size FRET assembled at check time
	 * ({@link RebalanceMonitor.getCohortSize}). The reaction gates release of a `lost` block on
	 * confirming it replicated to this many new owners, so a lost block is never released below the
	 * floor. See `docs/arachnode-ring-handoff.md` § Part 2.
	 */
	floor: number
	/** Timestamp of the topology change that triggered this */
	triggeredAt: number
}

export interface RebalanceMonitorConfig {
	/** Debounce window for topology changes (ms). Default: 5000 */
	debounceMs?: number
	/** Maximum frequency of full rebalance scans (ms). Default: 60000 */
	minRebalanceIntervalMs?: number
	/** Whether to suppress rebalancing during detected partitions. Default: true */
	suppressDuringPartition?: boolean
}

export interface RebalanceMonitorDeps {
	libp2p: Libp2p
	fret: FretService
	partitionDetector: PartitionDetector
	fretAdapter: ArachnodeFretAdapter
	/**
	 * The owned-block tracked set. When provided (e.g. the shared `ownedBlocks` set wired in
	 * `libp2p-node-base`), the monitor references this exact `Set` instead of constructing its own,
	 * so it stays in lock-step with the `SpreadOnChurnMonitor` that shares it. Omit for standalone
	 * construction (unit tests) — a fresh private `Set` preserves all existing behavior. Note: only
	 * `trackedBlocks` is shared; `responsibilitySnapshot` stays per-monitor (it is rebalance's own
	 * was-responsible memory, not owned-block tracking).
	 */
	trackedBlocks?: Set<string>
}

type RebalanceHandler = (event: RebalanceEvent) => void

export class RebalanceMonitor implements Startable {
	private running = false
	private readonly trackedBlocks: Set<string>
	// Per-monitor was-responsible memory (NOT shared, unlike trackedBlocks). When the shared
	// trackedBlocks set is mutated externally — spread's no-local-data self-prune, or the node's
	// responsibility-loss eviction going through untrackBlock — a snapshot entry for a since-removed
	// block may linger here. That is acceptable: performRebalanceCheck only iterates trackedBlocks, so
	// a lingering entry is inert; if the block is later re-fed, its responsibility is simply re-derived.
	private readonly responsibilitySnapshot = new Map<string, boolean>()
	private readonly handlers: RebalanceHandler[] = []
	private debounceTimer: ReturnType<typeof setTimeout> | null = null
	private lastRebalanceAt = 0
	private pendingTopologyChange = false
	private topologyChangeTimestamp = 0

	private readonly debounceMs: number
	private readonly minRebalanceIntervalMs: number
	private readonly suppressDuringPartition: boolean

	private readonly onConnectionOpen: () => void
	private readonly onConnectionClose: () => void

	constructor(
		private readonly deps: RebalanceMonitorDeps,
		config: RebalanceMonitorConfig = {}
	) {
		// Share the injected owned-block set when present (so spread + rebalance never drift);
		// otherwise own a private set (standalone construction / unit tests). Only trackedBlocks is
		// shared — responsibilitySnapshot stays per-monitor.
		this.trackedBlocks = deps.trackedBlocks ?? new Set<string>()
		this.debounceMs = config.debounceMs ?? 5000
		this.minRebalanceIntervalMs = config.minRebalanceIntervalMs ?? 60000
		this.suppressDuringPartition = config.suppressDuringPartition ?? true

		this.onConnectionOpen = () => this.handleTopologyChange()
		this.onConnectionClose = () => this.handleTopologyChange()
	}

	async start(): Promise<void> {
		if (this.running) return
		this.running = true

		this.deps.libp2p.addEventListener('connection:open', this.onConnectionOpen)
		this.deps.libp2p.addEventListener('connection:close', this.onConnectionClose)

		log('started, tracking %d blocks', this.trackedBlocks.size)
	}

	async stop(): Promise<void> {
		if (!this.running) return
		this.running = false

		this.deps.libp2p.removeEventListener('connection:open', this.onConnectionOpen)
		this.deps.libp2p.removeEventListener('connection:close', this.onConnectionClose)

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}

		this.pendingTopologyChange = false
		log('stopped')
	}

	onRebalance(handler: RebalanceHandler): void {
		this.handlers.push(handler)
	}

	trackBlock(blockId: string): void {
		this.trackedBlocks.add(blockId)
	}

	untrackBlock(blockId: string): void {
		this.trackedBlocks.delete(blockId)
		this.responsibilitySnapshot.delete(blockId)
	}

	getTrackedBlockCount(): number {
		return this.trackedBlocks.size
	}

	async checkNow(): Promise<RebalanceEvent | null> {
		return this.performRebalanceCheck(Date.now())
	}

	private handleTopologyChange(): void {
		if (!this.running) return

		if (!this.pendingTopologyChange) {
			this.topologyChangeTimestamp = Date.now()
		}
		this.pendingTopologyChange = true

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null
			this.pendingTopologyChange = false
			this.maybeRebalance()
		}, this.debounceMs)
	}

	private async maybeRebalance(): Promise<void> {
		if (!this.running) return

		const now = Date.now()
		const elapsed = now - this.lastRebalanceAt
		if (elapsed < this.minRebalanceIntervalMs) {
			log('throttled, %dms since last rebalance', elapsed)
			return
		}

		const event = await this.performRebalanceCheck(this.topologyChangeTimestamp || now)
		if (event) {
			this.emitEvent(event)
		}
	}

	private async performRebalanceCheck(triggeredAt: number): Promise<RebalanceEvent | null> {
		if (this.suppressDuringPartition && this.deps.partitionDetector.detectPartition()) {
			log('partition detected, suppressing rebalance')
			return null
		}

		if (this.trackedBlocks.size === 0) {
			this.lastRebalanceAt = Date.now()
			return null
		}

		const selfId = this.deps.libp2p.peerId.toString()
		const gained: string[] = []
		const lost: string[] = []
		const newOwners = new Map<string, string[]>()

		for (const blockId of this.trackedBlocks) {
			const key = textEncoder.encode(blockId)
			const coord = await hashKey(key)

			// Get the current cohort — assembleCohort returns peer IDs sorted by distance
			const cohort = this.deps.fret.assembleCohort(coord, this.getCohortSize())
			const isResponsible = cohort.includes(selfId)
			const wasResponsible = this.responsibilitySnapshot.get(blockId) ?? false

			if (isResponsible && !wasResponsible) {
				gained.push(blockId)
			} else if (!isResponsible && wasResponsible) {
				lost.push(blockId)
				// The cohort members are the new owners
				newOwners.set(blockId, cohort.filter(id => id !== selfId))
			}

			this.responsibilitySnapshot.set(blockId, isResponsible)
		}

		this.lastRebalanceAt = Date.now()

		if (gained.length === 0 && lost.length === 0) {
			return null
		}

		log('rebalance check: gained=%d lost=%d', gained.length, lost.length)

		return { gained, lost, newOwners, floor: this.getCohortSize(), triggeredAt }
	}

	/**
	 * The replication floor `N` — the cohort size FRET assembles for a block. Public so the ring-shift
	 * handoff and the rebalance reaction can gate release on confirming replication to this many
	 * holders (`docs/arachnode-ring-handoff.md` § Replication floor). Derives from FRET's network-size
	 * estimate: `clamp(ceil(sqrt(n_est)), 1, 3)`, defaulting to 3 when no confident estimate exists.
	 */
	getCohortSize(): number {
		const diag: any = (this.deps.fret as any).getDiagnostics?.()
		const estimate = diag?.estimate ?? diag?.n
		if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0) {
			return Math.max(1, Math.min(3, Math.ceil(Math.sqrt(estimate))))
		}
		return 3
	}

	private emitEvent(event: RebalanceEvent): void {
		for (const handler of this.handlers) {
			try {
				handler(event)
			} catch (err) {
				log('handler error: %O', err)
			}
		}
	}

	/**
	 * Update ArachnodeInfo status through the fret adapter.
	 */
	setStatus(status: ArachnodeInfo['status']): void {
		this.deps.fretAdapter.setStatus(status)
	}
}
