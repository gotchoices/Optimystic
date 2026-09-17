import type { Startable, Libp2p } from '@libp2p/interface'
import { hashKey } from 'p2p-fret'
import type { FretService } from 'p2p-fret'
import { routingKeyForBlock } from '@optimystic/db-core'
import type { IKeyNetwork } from '@optimystic/db-core'
import type { PartitionDetector } from './partition-detector.js'
import type { ArachnodeFretAdapter, ArachnodeInfo } from '../storage/arachnode-fret-adapter.js'
import { createLogger } from '../logger.js'

const log = createLogger('rebalance-monitor')

export interface RebalanceEvent {
	/**
	 * Block IDs this node has gained responsibility for (the reaction pulls each). A block first seen
	 * through a commit this node holds ({@link RebalanceMonitor.recordCommittedHolders}) is not
	 * reported: there is nothing to pull.
	 */
	gained: string[]
	/** Block IDs this node has lost responsibility for */
	lost: string[]
	/** Peers that are now closer for the lost blocks: blockId → peerId[] */
	newOwners: Map<string, string[]>
	/**
	 * Blocks this node KEEPS responsibility for whose cohort now contains peers it has not seen
	 * co-responsible before: blockId → the newly co-responsible peer ids (never self). This is the
	 * cohort-GROWTH arm: the founder case (a block committed while the deployment was one node) never
	 * appears in `lost` — the holder keeps the block — so without this arm nothing ever pushes the
	 * second copy and the block stays readable only by its sole holder. The reaction pushes each
	 * block to these peers (capped by the replication floor). A block can appear in both `gained`
	 * and `grown` (first observation after a restart/regain — the push then finds no local data and
	 * is a benign no-op); it can never appear in both `lost` and `grown` (lost ⇒ not responsible).
	 */
	grown: Map<string, string[]>
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

/**
 * What the growth reaction learned about ONE block reported `grown`. Fed back to
 * {@link RebalanceMonitor.recordGrowthOutcome} so the seen set is confirmation-driven: a peer
 * enters a block's seen set only once a replica is confirmed on it, or once the block has
 * otherwise reached its floor. A block the reaction had NO information about (its confirm was
 * deduped against one already in flight) gets no outcome at all — the monitor's state stays
 * untouched and the next check re-detects.
 */
export interface GrowthOutcome {
	/** Newly co-responsible peers that may now be recorded as seen for this block. */
	satisfiedPeers: string[]
	/** True when nothing about this block is still owed a push. */
	complete: boolean
}

/**
 * What an acknowledged commit proved about who holds its blocks, reported by the node that holds them.
 * Only ever reported for a commit THIS node's own storage durably holds, so a block named here needs
 * no pull. See {@link RebalanceMonitor.recordCommittedHolders}.
 */
export interface CommittedHolders {
	blockIds: readonly string[]
	/** Peers evidenced to hold the committed revision. Self may appear; it is ignored. */
	holders: readonly string[]
	/**
	 * Cohort members the commit's coordinator knows did NOT confirm holding the revision. Withdraws
	 * any earlier record of them as holders, so the growth arm pushes them the block.
	 */
	unconfirmed?: readonly string[]
}

/** Evidence gathered between two checks for one block: `holders` and `unconfirmed` stay disjoint. */
interface CommitEvidence {
	holders: Set<string>
	unconfirmed: Set<string>
}

export interface RebalanceMonitorConfig {
	/** Debounce window for topology changes (ms). Default: 5000 */
	debounceMs?: number
	/** Maximum frequency of full rebalance scans (ms). Default: 60000 */
	minRebalanceIntervalMs?: number
	/** Whether to suppress rebalancing during detected partitions. Default: true */
	suppressDuringPartition?: boolean
	/**
	 * Maximum blocks reported `grown` per check. Bounds the work a single peer join can trigger on a
	 * node with a large owned-block set — the primary bound is already the floor (a cohort is at most
	 * floor-sized, so each grown block pushes to ≤ floor−1 peers, and the reaction stops per block
	 * once the floor is met); this cap bounds the block COUNT per pass. A block dropped by the cap is
	 * NOT recorded as seen, so the next check re-detects the same growth — deferred, never lost.
	 * Default: 64
	 */
	growthBlockBudget?: number
	/**
	 * How many incomplete growth outcomes ({@link GrowthOutcome} with `complete: false`) a block
	 * absorbs before its still-unsatisfied peers are moved to a per-block abandoned set and no longer
	 * pushed to. Without this bound a peer that permanently refuses would be re-pushed on every check
	 * forever, and its block would re-consume `growthBlockBudget` slots and starve genuinely-new
	 * growth. An abandoned peer that leaves the cohort and later rejoins is retried from scratch.
	 * Default: 5
	 */
	growthMaxAttempts?: number
	/**
	 * Self-arming re-check timer for outstanding growth work (reported-but-unconfirmed peers, or
	 * blocks deferred by `growthBlockBudget`). Checks otherwise fire only on libp2p connection
	 * events, so a failed push on a then-quiet network would never be retried. Armed at the end of a
	 * check only while work is outstanding; fires `maybeRebalance()` so the existing
	 * `minRebalanceIntervalMs` throttle still bounds the push rate. `0` disables.
	 * Default: `minRebalanceIntervalMs`
	 */
	growthRecheckIntervalMs?: number
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
	/**
	 * The node's key network. When provided, a block's cohort is `findCluster` on its routing key —
	 * the rule the writer routes by, the coordinator refuses writes by, and `RepoService` redirects
	 * by — so the monitor never calls a peer responsible (and pushes it a replica) that the rest of
	 * the node does not, nor releases a block the node is still responsible for. Omit for standalone
	 * construction (unit tests): the cohort is then FRET's nearest {@link RebalanceMonitor.getCohortSize}.
	 */
	keyNetwork?: Pick<IKeyNetwork, 'findCluster'>
	/**
	 * The node's resolved `clusterSize`. Caps {@link RebalanceMonitor.getCohortSize}: a floor wider
	 * than the cohort can never be confirmed (a lost block would never be released), and on the
	 * standalone path it would assemble peers outside the configured cohort.
	 */
	clusterSize?: number
}

type RebalanceHandler = (event: RebalanceEvent) => void

/** Per-block rebalance/growth state (the `responsibilitySnapshot` entry). */
interface BlockGrowthState {
	responsible: boolean
	/**
	 * The growth arm's seen set: peers CONFIRMED to hold a replica of this block (or satisfied
	 * another way — floor met, or nothing local to push). Peers enter ONLY via
	 * {@link RebalanceMonitor.recordGrowthOutcome} or an acknowledged commit's holders
	 * ({@link RebalanceMonitor.recordCommittedHolders}), never at report time.
	 */
	cohortPeers: Set<string>
	/** Peers reported grown at the last emitting check whose confirmation is still outstanding. */
	pendingPeers: Set<string>
	/** Consecutive incomplete growth outcomes — the give-up counter against `growthMaxAttempts`. */
	growthAttempts: number
	/**
	 * Peers given up on after `growthMaxAttempts` incomplete outcomes — excluded from growth reports
	 * until they leave the cohort and rejoin (each check intersects this with the current cohort).
	 */
	abandonedPeers: Set<string>
}

const emptyGrowthState = (responsible: boolean): BlockGrowthState => ({
	responsible,
	cohortPeers: new Set<string>(),
	pendingPeers: new Set<string>(),
	growthAttempts: 0,
	abandonedPeers: new Set<string>()
})

const intersect = (remembered: Set<string> | undefined, current: Set<string>): Set<string> =>
	new Set([...(remembered ?? [])].filter(id => current.has(id)))

/**
 * Carry a still-responsible block's growth state into the next check, intersecting both remembered
 * peer sets against the CURRENT cohort: a peer that left drops out of `cohortPeers` (so its return
 * is re-detected — the departure self-heal) and out of `abandonedPeers` (so a rejoin is retried from
 * scratch). Commit evidence gathered since the last check is folded into `cohortPeers` first.
 * `pendingPeers` is always rebuilt from this check's own report, never carried.
 */
const carryGrowthState = (
	prior: BlockGrowthState | undefined,
	currentPeers: Set<string>,
	evidence: CommitEvidence | undefined
): BlockGrowthState => {
	const confirmed = new Set([...(prior?.cohortPeers ?? []), ...(evidence?.holders ?? [])])
	for (const peerId of evidence?.unconfirmed ?? []) confirmed.delete(peerId)
	return {
		responsible: true,
		cohortPeers: intersect(confirmed, currentPeers),
		pendingPeers: new Set<string>(),
		growthAttempts: prior?.growthAttempts ?? 0,
		abandonedPeers: intersect(prior?.abandonedPeers, currentPeers)
	}
}

export class RebalanceMonitor implements Startable {
	private running = false
	private readonly trackedBlocks: Set<string>
	// Per-monitor was-responsible memory (NOT shared, unlike trackedBlocks). When the shared
	// trackedBlocks set is mutated externally — spread's no-local-data self-prune, or the node's
	// responsibility-loss eviction going through untrackBlock — a snapshot entry for a since-removed
	// block may linger here. That is acceptable: performRebalanceCheck only iterates trackedBlocks, so
	// a lingering entry is inert; if the block is later re-fed, its responsibility is simply re-derived.
	//
	// `cohortPeers` is the growth arm's CONFIRMED-co-responsible memory. A MISSING entry is
	// deliberately treated as "prior cohort = empty", so the first check after a topology event
	// reports the whole non-self cohort as grown — that is what heals the founder case (A alone
	// commits; B joins → first check pushes to B) and the restarted-holder case (snapshot memory is
	// process-local, so a restarted holder re-pushes to everyone once). Peers enter the set only
	// through recordGrowthOutcome or a commit's confirmed holders (recordCommittedHolders) — a
	// reported-but-unconfirmed peer stays out, so a failed push is re-detected on the next check
	// instead of being recorded as done.
	private readonly responsibilitySnapshot = new Map<string, BlockGrowthState>()
	// Commit evidence (recordCommittedHolders) waiting for the next check, which consumes each block's
	// entry once its cohort lookup succeeds and drops entries for blocks no longer tracked. Held apart
	// from the snapshot because a commit does not say whether this node is responsible — only a check does.
	private readonly commitEvidence = new Map<string, CommitEvidence>()
	private readonly handlers: RebalanceHandler[] = []
	private debounceTimer: ReturnType<typeof setTimeout> | null = null
	private recheckTimer: ReturnType<typeof setTimeout> | null = null
	private lastRebalanceAt = 0
	private pendingTopologyChange = false
	private topologyChangeTimestamp = 0
	private lastGrowthDeferred = 0

	private readonly debounceMs: number
	private readonly minRebalanceIntervalMs: number
	private readonly suppressDuringPartition: boolean
	private readonly growthBlockBudget: number
	private readonly growthMaxAttempts: number
	private readonly growthRecheckIntervalMs: number

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
		this.growthBlockBudget = config.growthBlockBudget ?? 64
		this.growthMaxAttempts = config.growthMaxAttempts ?? 5
		this.growthRecheckIntervalMs = config.growthRecheckIntervalMs ?? this.minRebalanceIntervalMs

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
		if (this.recheckTimer) {
			clearTimeout(this.recheckTimer)
			this.recheckTimer = null
		}

		this.pendingTopologyChange = false
		this.commitEvidence.clear()
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
		this.commitEvidence.delete(blockId)
	}

	getTrackedBlockCount(): number {
		return this.trackedBlocks.size
	}

	async checkNow(): Promise<RebalanceEvent | null> {
		return this.performRebalanceCheck(Date.now())
	}

	/**
	 * Feedback from the growth reaction for one block reported `grown`. `satisfiedPeers` enter the
	 * block's seen set; an incomplete outcome counts an attempt against `growthMaxAttempts`, and on
	 * reaching the bound the block's still-unsatisfied reported peers are abandoned (no longer
	 * pushed to until they leave the cohort and rejoin). Never called for a block the reaction had
	 * no information about (a confirm deduped against one already in flight) — a missing outcome
	 * leaves the block's state untouched so the next check retries.
	 */
	recordGrowthOutcome(blockId: string, outcome: GrowthOutcome): void {
		const state = this.responsibilitySnapshot.get(blockId)
		// No state (untracked since) or responsibility lost since the report: the growth state was
		// cleared, and recording into it would survive the clear and suppress the regain re-push.
		if (!state || !state.responsible) return

		for (const peerId of outcome.satisfiedPeers) {
			state.cohortPeers.add(peerId)
			state.pendingPeers.delete(peerId)
		}

		if (outcome.complete) {
			state.growthAttempts = 0
			state.pendingPeers.clear()
		} else {
			// NOTE: growthMaxAttempts is a floor on the retry count, not an exact one. `pendingPeers` is
			// rebuilt from each check's own report, so two cases blunt the bound: a check that defers
			// this block on growthBlockBudget clears pendingPeers, and a give-up landing right then
			// abandons nobody while still resetting the counter; and two checks racing (the second
			// re-reporting the same peer after the first's confirm left `inFlight` but before its outcome
			// landed) double-count one attempt. Both are rare, both only change how many pushes a doomed
			// peer absorbs. If a deployment ever tracks far more blocks than growthBlockBudget, deferral
			// stops being rare — carry the report's peer list on GrowthOutcome and match it against
			// pendingPeers instead of trusting the latest report.
			state.growthAttempts++
			if (state.growthAttempts >= this.growthMaxAttempts) {
				for (const peerId of state.pendingPeers) {
					state.abandonedPeers.add(peerId)
				}
				log('growth give-up: block=%s abandoning %d unsatisfied peer(s) after %d attempts',
					blockId, state.pendingPeers.size, state.growthAttempts)
				state.pendingPeers.clear()
				state.growthAttempts = 0
			}
		}

		this.updateRecheckTimer()
	}

	/**
	 * Evidence from an acknowledged commit that this node's storage holds: `holders` are recorded as
	 * confirmed co-holders of each block at the next check, and the block is not reported `gained`
	 * then (this node already holds it, so there is nothing to pull). Without this, every freshly
	 * committed block has no growth memory, so the next check reports the whole cohort grown and
	 * pushes the block back to the members that stored it as part of the commit — and reports it
	 * gained, pulling it back from them.
	 *
	 * Later evidence for the same block overrides earlier evidence about the same peer, so the
	 * coordinator's durability-checked answer corrects the member-side signer list recorded moments
	 * before it on the coordinating node. Ignored while stopped: nothing would consume it.
	 *
	 * Does not affect the founder case: a commit no other peer confirmed names no holders, so the
	 * cohort is still reported grown once peers appear.
	 */
	recordCommittedHolders(committed: CommittedHolders): void {
		if (!this.running) return
		for (const blockId of committed.blockIds) {
			let evidence = this.commitEvidence.get(blockId)
			if (!evidence) {
				evidence = { holders: new Set<string>(), unconfirmed: new Set<string>() }
				this.commitEvidence.set(blockId, evidence)
			}
			for (const peerId of committed.holders) {
				evidence.holders.add(peerId)
				evidence.unconfirmed.delete(peerId)
			}
			for (const peerId of committed.unconfirmed ?? []) {
				evidence.unconfirmed.add(peerId)
				evidence.holders.delete(peerId)
			}
		}
	}

	/**
	 * Growth-arm observability: how many tracked blocks still await confirmation on reported peers,
	 * how many (block, peer) pairs have been given up on, and whether the re-check timer is armed.
	 */
	getGrowthDiagnostics(): { blocksAwaitingConfirmation: number; abandonedPairs: number; recheckArmed: boolean } {
		let blocksAwaitingConfirmation = 0
		let abandonedPairs = 0
		for (const [blockId, state] of this.responsibilitySnapshot) {
			if (!state.responsible || !this.trackedBlocks.has(blockId)) continue
			if (state.pendingPeers.size > 0) blocksAwaitingConfirmation++
			abandonedPairs += state.abandonedPeers.size
		}
		return { blocksAwaitingConfirmation, abandonedPairs, recheckArmed: this.recheckTimer !== null }
	}

	/** Growth work is outstanding while any reported peer is unconfirmed or blocks were budget-deferred. */
	private hasOutstandingGrowthWork(): boolean {
		if (this.lastGrowthDeferred > 0) return true
		for (const [blockId, state] of this.responsibilitySnapshot) {
			if (state.responsible && state.pendingPeers.size > 0 && this.trackedBlocks.has(blockId)) {
				return true
			}
		}
		return false
	}

	/**
	 * Arm the growth re-check timer while work is outstanding; disarm it when there is none. The
	 * timer fires maybeRebalance(), so minRebalanceIntervalMs still bounds the push rate, and it
	 * re-arms itself after firing for as long as work remains. unref'd so it never holds the
	 * process open; stop() clears it.
	 */
	private updateRecheckTimer(): void {
		if (this.growthRecheckIntervalMs <= 0) return

		if (!this.running || !this.hasOutstandingGrowthWork()) {
			if (this.recheckTimer) {
				clearTimeout(this.recheckTimer)
				this.recheckTimer = null
			}
			return
		}

		if (this.recheckTimer) return // already armed

		this.recheckTimer = setTimeout(() => {
			this.recheckTimer = null
			void this.maybeRebalance()
				.catch(err => { log('recheck error: %O', err) })
				.finally(() => this.updateRecheckTimer())
		}, this.growthRecheckIntervalMs)
		;(this.recheckTimer as unknown as { unref?: () => void }).unref?.()
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

		// NOTE: the check samples FRET's cohort once, debounceMs after the last connection event. A joiner
		// FRET has not admitted by then is not reported grown, and nothing re-checks until the next
		// connection event outside minRebalanceIntervalMs — so a machine that wrote alone would not push its
		// blocks to its new backup. Over loopback FRET admits well inside the default (the backup phase of
		// `small-deployment-lifecycle.integration.spec.ts` lands in ~10s); if a slower link, such as a phone
		// pair over a relay, ever shows a joiner that never receives the founder's blocks, re-check when FRET
		// reports the peer instead of on this timer alone.
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
			// Nothing left to grow, so any prior deferral is moot — drop it and let the re-check timer
			// disarm, rather than re-arming forever against blocks that were untracked out from under it.
			this.lastGrowthDeferred = 0
			this.commitEvidence.clear()
			this.updateRecheckTimer()
			return null
		}

		const selfId = this.deps.libp2p.peerId.toString()
		const gained: string[] = []
		const lost: string[] = []
		const newOwners = new Map<string, string[]>()
		const grown = new Map<string, string[]>()
		let growthDeferred = 0
		let lookupFailed = 0
		const growthCandidates: Array<{ blockId: string; newPeers: string[]; state: BlockGrowthState }> = []

		for (const blockId of this.trackedBlocks) {
			let cohort: string[]
			try {
				cohort = await this.cohortFor(blockId)
			} catch (err) {
				// Responsibility is undetermined: leave this block's state untouched (never guess lost or
				// gained off a failed lookup) and count it as outstanding so the re-check timer retries it.
				log('cohort lookup failed: block=%s %o', blockId, err)
				lookupFailed++
				continue
			}
			const isResponsible = cohort.includes(selfId)
			const prior = this.responsibilitySnapshot.get(blockId)
			const wasResponsible = prior?.responsible ?? false
			// Consumed only once the lookup succeeded, so a failed lookup leaves it for the next check.
			const evidence = this.commitEvidence.get(blockId)
			this.commitEvidence.delete(blockId)

			if (isResponsible && !wasResponsible && !evidence) {
				gained.push(blockId)
			} else if (!isResponsible && wasResponsible) {
				lost.push(blockId)
				// The cohort members are the new owners
				newOwners.set(blockId, cohort.filter(id => id !== selfId))
			}

			// Growth arm: while this node STAYS responsible, any cohort peer not yet CONFIRMED to hold
			// the block (and not abandoned) gets it pushed (up to the floor). Runs on every responsible
			// check — NOT gated on wasResponsible — so a first observation (no snapshot entry) treats
			// the whole non-self cohort as new; see the responsibilitySnapshot comment for why that is
			// load-bearing. Not responsible ⇒ arm skipped, so `lost` ∩ `grown` is impossible.
			//
			// Reporting a peer does NOT record it as seen — only recordGrowthOutcome does — so a push
			// that fails (dial timeout, receiver refused to persist, partition mid-reaction, reaction
			// threw) leaves the peer un-seen and the next check re-detects it.
			let state: BlockGrowthState
			if (isResponsible) {
				const currentSet = new Set(cohort.filter(id => id !== selfId))
				state = carryGrowthState(prior, currentSet, evidence)
				const newPeers = [...currentSet].filter(id => !state.cohortPeers.has(id) && !state.abandonedPeers.has(id))
				if (newPeers.length > 0) {
					growthCandidates.push({ blockId, newPeers, state })
				} else {
					// Nothing owed for this block. growthAttempts counts CONSECUTIVE incomplete outcomes
					// against outstanding growth, so it must not carry across a quiet stretch — otherwise a
					// block that failed a few times, then had that peer leave, would spend the leftovers on
					// whichever peer joins next and abandon it early.
					state.growthAttempts = 0
				}
			} else {
				// Not responsible: clear ALL growth state (seen set, attempts, abandoned peers), so a
				// later regain re-pushes to the whole cohort (benign when the local data is gone — the
				// push finds nothing and no-ops).
				state = emptyGrowthState(false)
			}

			this.responsibilitySnapshot.set(blockId, state)
		}

		// Evidence for a block that is not tracked has no consumer: a commit this node does not hold
		// as an owned block, or one untracked since.
		for (const blockId of [...this.commitEvidence.keys()]) {
			if (!this.trackedBlocks.has(blockId)) this.commitEvidence.delete(blockId)
		}

		// Fill the growth budget in two passes: fresh growth (no failed attempts yet) first, retrying
		// blocks with what remains — otherwise a stuck retry set at the front of the tracked-block
		// insertion order would starve peers that just joined.
		for (const candidate of [
			...growthCandidates.filter(c => c.state.growthAttempts === 0),
			...growthCandidates.filter(c => c.state.growthAttempts > 0)
		]) {
			if (grown.size < this.growthBlockBudget) {
				grown.set(candidate.blockId, candidate.newPeers)
				candidate.state.pendingPeers = new Set(candidate.newPeers)
			} else {
				// Budget-dropped: the seen set was not touched, so the next check re-detects the same
				// growth — a deferral, not a loss.
				growthDeferred++
			}
		}
		this.lastGrowthDeferred = growthDeferred + lookupFailed

		this.lastRebalanceAt = Date.now()

		if (growthDeferred > 0) {
			// Deferred blocks drain one budget-full per check. Checks fire on libp2p connection events
			// AND — while growth work is outstanding — on the growthRecheckIntervalMs timer armed
			// below, so a backlog drains even on a quiet network.
			log('growth budget reached: %d blocks deferred to the next check (budget=%d)',
				growthDeferred, this.growthBlockBudget)
		}

		this.updateRecheckTimer()

		if (gained.length === 0 && lost.length === 0 && grown.size === 0) {
			return null
		}

		log('rebalance check: gained=%d lost=%d grown=%d', gained.length, lost.length, grown.size)

		return { gained, lost, newOwners, grown, floor: this.getCohortSize(), triggeredAt }
	}

	/**
	 * The peers responsible for a block, nearest first. With a key network wired this is its
	 * `findCluster` cohort (see {@link RebalanceMonitorDeps.keyNetwork}); otherwise FRET's nearest
	 * {@link getCohortSize} ring members.
	 *
	 * NOTE: one `findCluster` (peer-store reads for each cohort member) per tracked block per pass, where
	 * FRET's cohort was one synchronous call; fine under the pass throttle; if passes on nodes holding many
	 * blocks ever show up as slow, share the lookup with the coordinator's responsibility cache.
	 */
	private async cohortFor(blockId: string): Promise<string[]> {
		const key = routingKeyForBlock(blockId)
		if (this.deps.keyNetwork) {
			return Object.keys(await this.deps.keyNetwork.findCluster(key))
		}
		return this.deps.fret.assembleCohort(await hashKey(key), this.getCohortSize())
	}

	/**
	 * The replication floor `N`. Public so the ring-shift handoff and the rebalance reaction can gate
	 * release on confirming replication to this many holders (`docs/arachnode-ring-handoff.md`
	 * § Replication floor). Derives from FRET's network-size estimate: `clamp(ceil(sqrt(n_est)), 1, 3)`,
	 * defaulting to 3 when no confident estimate exists — and never above the configured `clusterSize`,
	 * since no block has more responsible holders than that to confirm on.
	 */
	getCohortSize(): number {
		const diag: any = (this.deps.fret as any).getDiagnostics?.()
		const estimate = diag?.estimate ?? diag?.n
		const size = typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0
			? Math.max(1, Math.min(3, Math.ceil(Math.sqrt(estimate))))
			: 3
		const cap = this.deps.clusterSize
		return cap != null && cap >= 1 ? Math.min(size, cap) : size
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
