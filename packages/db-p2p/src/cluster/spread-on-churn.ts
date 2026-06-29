import type { Startable, Libp2p } from '@libp2p/interface'
import type { IRepo, IPeerNetwork } from '@optimystic/db-core'
import { hashKey } from 'p2p-fret'
import type { FretService } from 'p2p-fret'
import { peerIdFromString } from '@libp2p/peer-id'
import type { PartitionDetector } from './partition-detector.js'
import { BlockTransferClient } from './block-transfer-service.js'
import { createLogger } from '../logger.js'

const log = createLogger('spread-on-churn')
const textEncoder = new TextEncoder()

// ── Types ────────────────────────────────────────────────────────────

export interface SpreadOnChurnConfig {
	/** Enable the churn-resilient spread protocol. Default: true */
	enabled: boolean
	/** Number of middle-closest peers eligible to spread (d). Default: 3 */
	spreadDistance: number
	/** Enable dynamic d scaling based on cluster health. Default: true */
	dynamicSpreadDistance: boolean
	/** Cluster size ratio below which spread becomes more aggressive. Default: 0.6 */
	healthThreshold: number
	/** Debounce window for departure detection (ms). Default: 5000 */
	departureDebounceMs: number
	/** Number of peers beyond cluster boundary to target. Default: 4 */
	expansionStep: number
	/**
	 * Per-target dial deadline (ms) for churn pushes. A target that never accepts
	 * the connection fails fast instead of stalling the sequential spread pass.
	 * Default: 3000 (matches the codebase's other dial caps).
	 */
	pushDialTimeoutMs: number
	/**
	 * Per-target response deadline (ms) for churn pushes. A target that dials OK but
	 * never replies (connects, then goes silent) is given up on — the push throws
	 * `ResponseTimeoutError`, is recorded as failed, and the loop continues to the
	 * next target/block rather than hanging the whole pass. Default: 10000.
	 */
	pushResponseTimeoutMs: number
}

export interface SpreadOnChurnDeps {
	libp2p: Libp2p
	fret: FretService
	partitionDetector: PartitionDetector
	repo: IRepo
	peerNetwork: IPeerNetwork
	clusterSize: number
	protocolPrefix?: string
	/**
	 * The owned-block tracked set. When provided (e.g. the shared `ownedBlocks` set wired in
	 * `libp2p-node-base`), the monitor references this exact `Set` instead of constructing its own,
	 * so it stays in lock-step with the `RebalanceMonitor` that shares it. Omit for standalone
	 * construction (unit tests) — a fresh private `Set` preserves all existing behavior.
	 */
	trackedBlocks?: Set<string>
}

export interface SpreadEvent {
	/** Blocks that were spread */
	spread: Array<{
		blockId: string
		targets: string[]
		succeeded: string[]
		failed: string[]
	}>
	/** Current effective d */
	effectiveD: number
	/** Timestamp of the departure that triggered this */
	triggeredAt: number
}

type SpreadHandler = (event: SpreadEvent) => void

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SpreadOnChurnConfig = {
	enabled: true,
	spreadDistance: 3,
	dynamicSpreadDistance: true,
	healthThreshold: 0.6,
	departureDebounceMs: 5000,
	expansionStep: 4,
	pushDialTimeoutMs: 3000,
	pushResponseTimeoutMs: 10000,
}

// ── Monitor ──────────────────────────────────────────────────────────

export class SpreadOnChurnMonitor implements Startable {
	private running = false
	private readonly trackedBlocks: Set<string>
	private readonly handlers: SpreadHandler[] = []
	private debounceTimer: ReturnType<typeof setTimeout> | null = null
	private departureTimestamps: number[] = []
	private departureTimestamp = 0

	private readonly config: SpreadOnChurnConfig
	private readonly onConnectionClose: () => void

	constructor(
		private readonly deps: SpreadOnChurnDeps,
		config: Partial<SpreadOnChurnConfig> = {}
	) {
		// Share the injected owned-block set when present (so spread + rebalance never drift);
		// otherwise own a private set (standalone construction / unit tests).
		this.trackedBlocks = deps.trackedBlocks ?? new Set<string>()
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.onConnectionClose = () => this.handleDeparture()
	}

	// ── Startable ────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.running) return
		this.running = true

		this.deps.libp2p.addEventListener('connection:close', this.onConnectionClose)

		log('started, tracking %d blocks', this.trackedBlocks.size)
	}

	async stop(): Promise<void> {
		if (!this.running) return
		this.running = false

		this.deps.libp2p.removeEventListener('connection:close', this.onConnectionClose)

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}

		log('stopped')
	}

	// ── Public API ───────────────────────────────────────────────────

	onSpread(handler: SpreadHandler): void {
		this.handlers.push(handler)
	}

	trackBlock(blockId: string): void {
		this.trackedBlocks.add(blockId)
	}

	untrackBlock(blockId: string): void {
		this.trackedBlocks.delete(blockId)
	}

	getTrackedBlockCount(): number {
		return this.trackedBlocks.size
	}

	/** Force an immediate spread check (useful for testing). */
	async checkNow(): Promise<SpreadEvent | null> {
		return this.performSpread(Date.now())
	}

	// ── Internal ─────────────────────────────────────────────────────

	private handleDeparture(): void {
		if (!this.running) return
		if (!this.config.enabled) return

		if (!this.departureTimestamp) {
			this.departureTimestamp = Date.now()
		}

		// Record for dynamic-d sliding window
		this.departureTimestamps.push(Date.now())

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null
			const ts = this.departureTimestamp
			this.departureTimestamp = 0
			if (this.running) {
				this.performSpread(ts).catch(err => {
					log('spread error: %O', err)
				})
			}
		}, this.config.departureDebounceMs)
	}

	private async performSpread(triggeredAt: number): Promise<SpreadEvent | null> {
		if (!this.config.enabled) return null

		if (this.deps.partitionDetector.detectPartition()) {
			log('partition detected, suppressing spread')
			return null
		}

		if (this.trackedBlocks.size === 0) return null

		const selfId = this.deps.libp2p.peerId.toString()
		const effectiveD = this.computeEffectiveD()
		const spreadResults: SpreadEvent['spread'] = []

		for (const blockId of this.trackedBlocks) {
			const key = textEncoder.encode(blockId)
			const coord = await hashKey(key)

			// Check eligibility: only middle peers spread
			const rank = this.deps.fret.neighborDistance(selfId, coord, this.deps.clusterSize)
			if (rank >= effectiveD) continue

			// Get current cohort and expansion targets
			const cohort = this.deps.fret.assembleCohort(coord, this.deps.clusterSize)
			const cohortSet = new Set(cohort)
			const expanded = this.deps.fret.expandCohort(
				cohort, coord, this.config.expansionStep
			)
			const targets = expanded.filter(id => !cohortSet.has(id) && id !== selfId)
			if (targets.length === 0) continue

			// Read block data from local storage
			const result = await this.deps.repo.get({ blockIds: [blockId] })
			const blockResult = result[blockId]
			if (!blockResult?.block) {
				// The block has left local storage. No deletion event exists today to evict it
				// from the tracked set, so prune here. Deleting the current element of a Set mid
				// for...of is safe - it does not disturb the rest of the iteration. A later
				// re-commit re-adds the block via the owned-block feed.
				log('no-local-data block=%s (untracking)', blockId)
				this.trackedBlocks.delete(blockId)
				continue
			}

			const blockData = textEncoder.encode(JSON.stringify(blockResult.block))

			// Carry the source's revision metadata so the replica's `latest` matches the
			// source instead of being fabricated as rev 1 on the receiver.
			const latest = blockResult.state?.latest
			const blockMeta = latest
				? { [blockId]: { rev: latest.rev, actionId: latest.actionId } }
				: undefined

			// Push to each target
			const succeeded: string[] = []
			const failed: string[] = []

			for (const targetId of targets) {
				try {
					const peerId = peerIdFromString(targetId)
					const client = new BlockTransferClient(
						peerId,
						this.deps.peerNetwork,
						this.deps.protocolPrefix
					)
					// Bound both the dial and the response read. A target that connects but
					// never replies would otherwise hang this sequential loop forever during
					// churn (exactly when slow/dying peers are common); the deadline makes the
					// push throw, which the catch below records as `failed` so the pass advances.
					const response = await client.pushBlocks([blockId], [blockData], 'replication', blockMeta, {
						dialTimeoutMs: this.config.pushDialTimeoutMs,
						responseTimeoutMs: this.config.pushResponseTimeoutMs,
					})
					// A round-trip that does not throw still does not mean the replica
					// landed: handlePush reports a block in `missing` when it could not
					// parse or persist it. Treat that as a failed push so the resilience
					// mechanism does not falsely count the new owner as holding the block.
					if (response.missing.includes(blockId)) {
						failed.push(targetId)
						log('push:rejected block=%s target=%s (receiver did not persist)', blockId, targetId)
					} else {
						succeeded.push(targetId)
						log('push:ok block=%s target=%s', blockId, targetId)
					}
				} catch (err) {
					failed.push(targetId)
					log('push:fail block=%s target=%s err=%s',
						blockId, targetId, (err as Error).message)
				}
			}

			spreadResults.push({ blockId, targets, succeeded, failed })
		}

		if (spreadResults.length === 0) return null

		const event: SpreadEvent = {
			spread: spreadResults,
			effectiveD,
			triggeredAt,
		}

		this.emitEvent(event)
		return event
	}

	private computeEffectiveD(): number {
		const d = this.config.spreadDistance
		if (!this.config.dynamicSpreadDistance) return d

		const maxD = Math.max(d, Math.floor(this.deps.clusterSize / 2))
		const windowMs = this.config.departureDebounceMs * 4
		const now = Date.now()

		// Prune old departure timestamps
		this.departureTimestamps = this.departureTimestamps.filter(
			ts => now - ts < windowMs
		)

		// Rapid churn: 3+ departures in window → increase d by 1
		if (this.departureTimestamps.length >= 3) {
			return Math.min(d + 1, maxD)
		}

		// Low cluster health: observed cohort shrunk relative to expected
		// We approximate observed cohort size from FRET diagnostics
		const diag: any = (this.deps.fret as any).getDiagnostics?.()
		const estimate = diag?.estimate ?? diag?.n
		if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0) {
			const ratio = estimate / this.deps.clusterSize
			if (ratio < this.config.healthThreshold) {
				const scaled = Math.ceil(d * (this.deps.clusterSize / estimate))
				return Math.min(scaled, maxD)
			}
		}

		return d
	}

	private emitEvent(event: SpreadEvent): void {
		for (const handler of this.handlers) {
			try {
				handler(event)
			} catch (err) {
				log('handler error: %O', err)
			}
		}
	}
}
