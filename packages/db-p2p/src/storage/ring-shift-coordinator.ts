import { hashKey } from 'p2p-fret';
import type { FretService } from 'p2p-fret';
import type { PartitionDetector } from '../cluster/partition-detector.js';
import type { ArachnodeFretAdapter, ArachnodeInfo } from './arachnode-fret-adapter.js';
import type { RingSelector } from './ring-selector.js';
import { partitionCovers, qualifiesForFloor } from './arachnode-partition.js';
import { createLogger } from '../logger.js';

const log = createLogger('ring-shift');
const textEncoder = new TextEncoder();

/**
 * The confirm primitive the handoff gates release on. Satisfied by `BlockTransferCoordinator`; kept
 * as a narrow structural interface so the coordinator is unit-testable with a stub.
 */
export interface ReplicationConfirmer {
	confirmReplicated(
		blockIds: string[],
		owners: Map<string, string[]>,
		floor: number
	): Promise<{ confirmed: string[]; unconfirmed: string[] }>;
}

export interface RingShiftDeps {
	fretAdapter: ArachnodeFretAdapter;
	ringSelector: RingSelector;
	fret: FretService;
	partitionDetector: PartitionDetector;
	/** Confirms a shed block replicated to ≥ N qualifying holders (Phase B). */
	confirmer: ReplicationConfirmer;
	/** The blocks this node physically holds — the candidate set the shed range is drawn from. */
	ownedBlocks: Set<string>;
	/** This node's own peer id string (excluded from the qualifying-holder count). */
	selfPeerId: string;
	/** The replication floor `N` (e.g. `RebalanceMonitor.getCohortSize`), read fresh per shift. */
	getFloor: () => number;
	/**
	 * Called with the shed block ids the instant Phase C releases them. The wiring stops serving +
	 * spreading them (untrack) and marks their local bytes GC-eligible — nothing may reclaim a shed
	 * range before this fires.
	 */
	onRelease: (blockIds: string[]) => void;
}

export interface RingShiftConfig {
	/**
	 * How many extra candidate holders beyond the floor to request from FRET per shed block, giving
	 * headroom to exclude self and same-range movers while still finding `N` qualifying holders.
	 * Default 2.
	 */
	candidateMargin?: number;
}

/** The result of a single `executeShift` — what happened and why, for logging/tests. */
export type ShiftOutcome =
	| { status: 'moved-out'; from: number; to: number; released: string[] }
	| { status: 'moved-in'; from: number; to: number }
	| { status: 'rolled-back'; ring: number; reason: string }
	| { status: 'skipped'; reason: string };

/**
 * Drives a single damped ring transition through the **advertise → confirm-replication → release**
 * handoff (`docs/arachnode-ring-handoff.md` § Part 2), so a ring shift never drops a key below its
 * replication floor `N`.
 *
 * - **Move-out** (`R → R+1`, sheds half its keyspace) runs all three phases: advertise the target
 *   ring while still serving the old range (Phase A), confirm every shed block is replicated to ≥ N
 *   qualifying post-move holders (Phase B), then release the shed range (Phase C). Any Phase-B
 *   failure — partition, unreachable holders, floor unmet — rolls back to `active` at the old ring,
 *   keeping the range. No shed block is released unless EVERY shed block confirmed.
 * - **Move-in** (`R → R-1`, gains keyspace, sheds nothing) is Phase A only: it advertises the inner
 *   ring so peers observe the membership change, then pulls the gained half via the restoration /
 *   rebalance path. The floor is never at risk from a mover that only gains, so there is no
 *   confirm/release.
 *
 * The trigger is the (damped) `RingSelector.shouldTransition()` decision; this class is the state
 * machine that decision drives.
 */
export class RingShiftCoordinator {
	private readonly candidateMargin: number;
	/** Guards against a re-entrant shift if the driving interval overlaps a long confirm. */
	private inFlight = false;

	constructor(
		private readonly deps: RingShiftDeps,
		config: RingShiftConfig = {}
	) {
		this.candidateMargin = config.candidateMargin ?? 2;
	}

	/**
	 * Execute one single-step ring transition. No-op (`skipped`) if a shift is already in flight or the
	 * node is already `moving`. `direction`/`newRingDepth` come straight from the damped
	 * `shouldTransition()` trigger.
	 */
	async executeShift(transition: { direction: 'in' | 'out'; newRingDepth: number }): Promise<ShiftOutcome> {
		if (this.inFlight) {
			return { status: 'skipped', reason: 'shift-in-flight' };
		}
		const current = this.deps.fretAdapter.getMyArachnodeInfo();
		if (current?.status === 'moving') {
			return { status: 'skipped', reason: 'already-moving' };
		}

		this.inFlight = true;
		try {
			return transition.direction === 'out'
				? await this.moveOut(transition.newRingDepth, current)
				: await this.moveIn(transition.newRingDepth, current);
		} finally {
			this.inFlight = false;
		}
	}

	/**
	 * Reconcile a stale `status='moving'` advertisement left by a crash between advertise (Phase A) and
	 * release (Phase C). The crashed node never ran Phase C, so it never released the shed range and is
	 * still responsible for its OLD range: restore that range and refresh status to `active`. A node
	 * whose advertised status is not `moving` needs no reconciliation. Called once at startup. See
	 * `docs/arachnode-ring-handoff.md` § Part 3 (crash mid-handoff).
	 */
	reconcileOnStart(): { reconciled: boolean } {
		const info = this.deps.fretAdapter.getMyArachnodeInfo();
		if (!info || info.status !== 'moving') {
			return { reconciled: false };
		}
		// Never released → still responsible for the old range. Resume serving it, active at the old ring.
		this.deps.fretAdapter.setArachnodeInfo(
			info.moveFrom
				? this.clearMove({ ...info, ringDepth: info.moveFrom.ringDepth, partition: info.moveFrom.partition, status: 'active' })
				: this.clearMove({ ...info, status: 'active' })
		);
		log('reconcile:resumed-old-range ring=%d', info.moveFrom?.ringDepth ?? info.ringDepth);
		return { reconciled: true };
	}

	// --- Move-out: advertise → confirm → release ---

	private async moveOut(newRingDepth: number, oldInfo: ArachnodeInfo | undefined): Promise<ShiftOutcome> {
		const oldRing = oldInfo?.ringDepth ?? 0;

		// Phase A — advertise the target ring; KEEP serving the old range (moveFrom retains it).
		const target = await this.deps.ringSelector.createArachnodeInfo(this.deps.selfPeerId, newRingDepth);
		const movingInfo: ArachnodeInfo = {
			...target,
			status: 'moving',
			moveFrom: { ringDepth: oldRing, partition: oldInfo?.partition }
		};
		this.deps.fretAdapter.setArachnodeInfo(movingInfo);
		log('phaseA:advertise from=%d to=%d', oldRing, newRingDepth);

		// Phase B — confirm the shed range replicated to ≥ N qualifying holders.
		const shed = await this.computeShedBlocks(oldInfo?.partition, target.partition);
		const floor = Math.max(1, this.deps.getFloor());
		const confirm = await this.confirmShedRange(shed, floor);
		if (!confirm.ok) {
			this.rollback(oldInfo);
			log('phaseB:abort reason=%s → rolled-back to ring=%d', confirm.reason, oldRing);
			return { status: 'rolled-back', ring: oldRing, reason: confirm.reason };
		}

		// Phase C — release: active at the new ring (moveFrom cleared), stop serving/spreading + GC-eligible.
		this.deps.fretAdapter.setArachnodeInfo(this.clearMove({ ...target, status: 'active' }));
		if (shed.length > 0) {
			this.deps.onRelease(shed);
		}
		log('phaseC:release from=%d to=%d shed=%d', oldRing, newRingDepth, shed.length);
		return { status: 'moved-out', from: oldRing, to: newRingDepth, released: shed };
	}

	/**
	 * Phase B. Succeeds only when EVERY shed block is confirmed replicated to ≥ `floor` qualifying
	 * holders. Aborts (no partial release) on a detected partition or any unconfirmed block.
	 */
	private async confirmShedRange(shed: string[], floor: number): Promise<{ ok: true } | { ok: false; reason: string }> {
		if (shed.length === 0) {
			return { ok: true }; // nothing to shed → trivially safe
		}
		if (this.deps.partitionDetector.detectPartition()) {
			return { ok: false, reason: 'partition' };
		}

		const owners = await this.buildOwnersMap(shed, floor);
		const { confirmed, unconfirmed } = await this.deps.confirmer.confirmReplicated(shed, owners, floor);
		if (unconfirmed.length > 0) {
			return { ok: false, reason: `unconfirmed:${unconfirmed.length}` };
		}
		// Belt-and-suspenders: every shed block must be in `confirmed` before any is released.
		return confirmed.length === shed.length ? { ok: true } : { ok: false, reason: 'incomplete' };
	}

	/**
	 * The shed range: blocks this node holds that its OLD partition covers but its NEW (target)
	 * partition does not — i.e. the half of its slice it stops covering by moving out.
	 */
	private async computeShedBlocks(
		oldPartition: ArachnodeInfo['partition'],
		newPartition: ArachnodeInfo['partition']
	): Promise<string[]> {
		const shed: string[] = [];
		for (const blockId of this.deps.ownedBlocks) {
			const coord = await hashKey(textEncoder.encode(blockId));
			if (partitionCovers(oldPartition, coord) && !partitionCovers(newPartition, coord)) {
				shed.push(blockId);
			}
		}
		return shed;
	}

	/**
	 * For each shed block, the qualifying post-move holders to confirm against: the FRET cohort around
	 * the block minus self and minus any peer that does not still cover the block under its OWN
	 * advertised (target) partition — which excludes same-range movers ({@link qualifiesForFloor}). A
	 * candidate with no advertised Arachnode info is excluded (its coverage cannot be verified).
	 */
	private async buildOwnersMap(shed: string[], floor: number): Promise<Map<string, string[]>> {
		const owners = new Map<string, string[]>();
		const want = floor + 1 + this.candidateMargin; // headroom for self + excluded movers
		for (const blockId of shed) {
			const coord = await hashKey(textEncoder.encode(blockId));
			const cohort = this.deps.fret.assembleCohort(coord, want);
			const qualifying = cohort.filter(peerId => {
				if (peerId === this.deps.selfPeerId) return false;
				const info = this.deps.fretAdapter.getArachnodeInfo(peerId);
				return info !== undefined && qualifiesForFloor(info, coord);
			});
			owners.set(blockId, qualifying);
		}
		return owners;
	}

	// --- Move-in: advertise only (sheds nothing) ---

	private async moveIn(newRingDepth: number, oldInfo: ArachnodeInfo | undefined): Promise<ShiftOutcome> {
		const oldRing = oldInfo?.ringDepth ?? 0;
		// Sheds nothing: advertise the (broader) inner ring directly at `active`. The gained half is
		// pulled by the restoration / rebalance path; the old holders keep serving until THEY confirm
		// their own release, so the floor is never at risk from this mover.
		const target = await this.deps.ringSelector.createArachnodeInfo(this.deps.selfPeerId, newRingDepth);
		this.deps.fretAdapter.setArachnodeInfo(this.clearMove({ ...target, status: 'active' }));
		log('moveIn:advertise from=%d to=%d', oldRing, newRingDepth);
		return { status: 'moved-in', from: oldRing, to: newRingDepth };
	}

	// --- Shared helpers ---

	/** Restore the pre-move advertisement (old ring/partition, `active`, no `moveFrom`). */
	private rollback(oldInfo: ArachnodeInfo | undefined): void {
		if (oldInfo) {
			this.deps.fretAdapter.setArachnodeInfo(this.clearMove({ ...oldInfo, status: 'active' }));
		} else {
			this.deps.fretAdapter.setStatus('active');
		}
	}

	/** Strip the transient `moveFrom` field so an `active` advertisement never carries move state. */
	private clearMove(info: ArachnodeInfo): ArachnodeInfo {
		const { moveFrom: _drop, ...rest } = info;
		return rest;
	}
}
