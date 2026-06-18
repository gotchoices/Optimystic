import type { SeededRng, VTime } from './types.js';
import { createSimWorld } from './world.js';
import { createRng } from './rng.js';
import { Metrics } from './metrics.js';
import { CohortMembership } from './cohort-membership.js';
import { TopicCohort, ParticipantRenewal } from './registration.js';
import {
	findBoundary,
	recordBoundary,
	type EnvelopeBoundary,
	type BoundaryAxisSpec
} from './boundary.js';

/**
 * The cohort-topic **failure-mode** operating-envelope boundaries (`simulator-envelope-churn`): two
 * stress axes layered on the generic `findBoundary` harness, each pairing one monotone-in-harm axis
 * with a `ChurnRecoveryScenario` claim, driven against **timed** failover/partition on the virtual
 * clock (kills/partitions staggered across the renewal window) rather than a settled post-crash
 * steady state. This is new *measurement* over the existing registration/partition models — it reuses
 * `TopicCohort`, `ParticipantRenewal`, `CohortMembership`, and `checkConvergence`'s assignment math
 * rather than re-modeling failover. (The R* / `root-not-overloaded` reference axis lives in
 * `simulator-envelope-core`; the three full-tree rows live in `simulator-envelope-tree`; this module
 * adds the two churn/partition rows of the parent ticket's candidate table.)
 *
 *  1. **no-lost-registrations vs member-kill rate** — members are crashed at a sustained per-window
 *     fraction, staggered just after the renewal tick (worst phase). A registration is *lost* when its
 *     served primary is unreachable at the measurement horizon (the `ChurnRecoveryScenario`
 *     `lostRegistrations` readout). Past some kill rate the serving cohort can no longer cover every
 *     participant within the renewal window and a registration is left stranded.
 *
 *  2. **heal-convergence vs partition severity** — the live membership is split, each side mutated
 *     under concurrent churn (joins re-slot harmlessly; *leaves* remove serving members), then healed.
 *     A participant *converges* when it repoints to the healed deterministic primary within **one**
 *     renewal window (a clean `primary_moved`); a participant whose served primary was removed by the
 *     concurrent churn must instead run a multi-window backup-promotion failover and so misses the
 *     one-window bound. Past some severity at least one participant fails to converge in the window.
 *
 * Both axes drive the real `ParticipantRenewal` loop on the virtual clock, so the edge reflects the
 * renewal cadence (`ttl/3`) and three-strikes failover timing, not a structural identity. The
 * `heal-convergence` axis in particular is deliberately built so the structurally-trivial
 * `merge(a,b).epoch === pre.epoch` path (always true) is **not** what keeps the claim true — the
 * concurrent churn makes the healed set differ from the pre-split set, and the claim is then the
 * *timing* of the lazy repoint, which can genuinely fail.
 */

const TOPIC = 'envelope-churn-topic';
const GOSSIP_ROUND_MS = 1000;
const DEFAULT_TTL = 90_000;

/** Cohort member id `m###` (sorted-stable, matches `ChurnRecoveryScenario`). */
function memberId(i: number): string {
	return `m${i.toString().padStart(3, '0')}`;
}

/** Attached-participant id `sub-#`. */
function participantId(i: number): string {
	return `sub-${i}`;
}

/** A freshly-arriving member id (a partition-side join), namespaced so it never collides with `m###`. */
function joinId(side: string, i: number): string {
	return `j${side}${i.toString().padStart(3, '0')}`;
}

/** Fisher–Yates over a copy, drawing from the seeded rng — a deterministic kill/leave priority order. */
function seededOrder(items: readonly string[], rng: SeededRng): string[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = rng.nextInt(i + 1);
		const tmp = out[i]!;
		out[i] = out[j]!;
		out[j] = tmp;
	}
	return out;
}

// =============================================================================
// Boundary 1 — no-lost-registrations vs member-kill rate × timing
// =============================================================================

export interface KillRateOptions {
	/** Cohort member count (default 20). */
	readonly memberCount?: number;
	/** Attached participants whose registrations must survive turnover (default 80). */
	readonly participantCount?: number;
	/** Registration TTL; renewal ping cadence is `ttl/3` (default 90_000). */
	readonly ttl?: VTime;
	readonly seed?: number;
	/** Windows over which kills are sustained at the per-window rate (default 4). */
	readonly killWindows?: number;
	/** Failover-budget windows after the last kill, before the horizon snapshot (default 4 = > 3 strikes). */
	readonly settleWindows?: number;
	/** Warm backups per registration (default 2 — the cohort-topic default). */
	readonly backupsPerRegistration?: number;
}

/** Which mechanism left a registration stranded at the kill-rate edge. */
export type KillMechanism = 'none' | 'renewal-race' | 'backup-exhaustion';

/** The kill-rate evaluation readout: lost count, the mechanism, and the recovery-window diagnostic. */
export interface KillRateReadout {
	/** True ⇒ `no-lost-registrations` holds: every participant served by a reachable primary at the horizon. */
	readonly holds: boolean;
	/** Participants whose served primary is unreachable at the horizon (mirrors `churn.lostRegistrations`). */
	readonly lost: number;
	readonly total: number;
	/** Members actually crashed over the run (≤ memberCount). */
	readonly killedTotal: number;
	/** Reachable members remaining at the horizon — 0 ⇒ the cohort was driven to full exhaustion. */
	readonly reachableMembersAtHorizon: number;
	/**
	 * Which failure mechanism flipped the claim: `backup-exhaustion` (the lost participants had no
	 * reachable serving member left — the cohort ran out of coverage) vs `renewal-race` (reachable
	 * members remained but the participant was still mid-failover at the snapshot). Diagnosable so the
	 * readout says *why* a registration was lost, not just that it was.
	 */
	readonly mechanism: KillMechanism;
	/** Peak simultaneous lost count sampled across the run — the transient race signature. */
	readonly peakTransientLost: number;
}

/**
 * Run the cohort + renewal loops under a sustained per-window kill rate `k`, staggered just after the
 * renewal tick (worst phase: a member's crash is not seen until the next ping a full window later),
 * and read back the lost-registration count at the horizon. Kills are drawn from a single seeded
 * priority order, so the dead set at rate `k2 > k1` is a time-wise superset of the dead set at `k1`
 * (monotone-in-harm). `lost` is the `ChurnRecoveryScenario` aggregation — `!reachable(primary)` over
 * every participant — sampled `settleWindows` after the last kill so a single crash has its full
 * three-strikes failover budget; what remains lost is genuine coverage loss, not a sampling artifact.
 */
function evalKillRate(k: number, p: Required<KillRateOptions>): KillRateReadout {
	const pingInterval = Math.max(1, Math.floor(p.ttl / 3));
	const world = createSimWorld({ seed: p.seed, gossipRoundMs: GOSSIP_ROUND_MS });
	const ids = Array.from({ length: p.memberCount }, (_v, i) => memberId(i));
	const membership = new CohortMembership(ids);
	const cohort = new TopicCohort({
		topicId: TOPIC,
		coord: 'root',
		tier: 1,
		membership,
		backupsPerRegistration: p.backupsPerRegistration
	});
	const renewals: ParticipantRenewal[] = [];
	for (let i = 0; i < p.participantCount; i++) {
		const pid = participantId(i);
		cohort.register(pid, 0, p.ttl);
		renewals.push(new ParticipantRenewal({ scheduler: world.scheduler, cohort, participantId: pid, ttl: p.ttl }));
	}
	for (const r of renewals) {
		r.start();
	}

	// Sustained, staggered kills from a seeded priority order: q new crashes per window, each landing
	// just after the window-opening tick (worst phase) and jittered across the window via the rng.
	const order = seededOrder(ids, world.rng.fork('kill-order'));
	const stagger = world.rng.fork('kill-stagger');
	const q = Math.floor(k * p.memberCount);
	let cursor = 0;
	for (let w = 0; w < p.killWindows && cursor < order.length; w++) {
		const windowStart = w * pingInterval;
		for (let j = 0; j < q && cursor < order.length; j++) {
			const id = order[cursor++]!;
			const at = windowStart + 1 + stagger.nextInt(Math.max(1, pingInterval - 1));
			world.scheduler.scheduleAt(at, () => cohort.kill(id));
		}
	}
	const killedTotal = cursor;

	// Run window-by-window, sampling the transient lost count (the race signature) after each ping.
	const totalWindows = p.killWindows + p.settleWindows;
	let peakTransientLost = 0;
	for (let w = 1; w <= totalWindows; w++) {
		world.scheduler.run(w * pingInterval);
		let nowLost = 0;
		for (const r of renewals) {
			if (!cohort.reachable(r.primary)) {
				nowLost++;
			}
		}
		if (nowLost > peakTransientLost) {
			peakTransientLost = nowLost;
		}
	}

	// Horizon snapshot — lost = served primary unreachable, exactly as `ChurnRecoveryScenario` aggregates.
	const reachableMembersAtHorizon = membership.members.filter((m) => cohort.reachable(m)).length;
	let lost = 0;
	let raceLost = 0;
	let exhaustLost = 0;
	for (const r of renewals) {
		if (!cohort.reachable(r.primary)) {
			lost++;
			// A lost participant with a reachable backup still in hand was racing renewal (mid-failover);
			// one with no reachable serving member at all is a coverage (backup-exhaustion) loss.
			const anyBackupReachable = r.backups.some((b) => cohort.reachable(b));
			if (anyBackupReachable || reachableMembersAtHorizon > 0) {
				raceLost++;
			} else {
				exhaustLost++;
			}
		}
	}
	const mechanism: KillMechanism = lost === 0 ? 'none' : exhaustLost >= raceLost ? 'backup-exhaustion' : 'renewal-race';

	return {
		holds: lost === 0,
		lost,
		total: p.participantCount,
		killedTotal,
		reachableMembersAtHorizon,
		mechanism,
		peakTransientLost
	};
}

/** Resolve `KillRateOptions` with defaults. */
function killRateParams(opts: KillRateOptions): Required<KillRateOptions> {
	return {
		memberCount: opts.memberCount ?? 20,
		participantCount: opts.participantCount ?? 80,
		ttl: opts.ttl ?? DEFAULT_TTL,
		seed: opts.seed ?? 4242,
		killWindows: opts.killWindows ?? 4,
		settleWindows: opts.settleWindows ?? 4,
		backupsPerRegistration: opts.backupsPerRegistration ?? 2
	};
}

/**
 * Build the kill-rate axis spec: `holds(k)` runs the sustained-kill failover loop and returns
 * `lostRegistrations === 0`. `designAssumption = 0` — the design assumes turnover slower than the
 * renewal window can absorb; the located `k*` and `margin = k* − 0` are what the three-backup +
 * `ttl/3` cadence buys against sustained member crashes.
 */
export function killRateAxis(opts: KillRateOptions = {}): BoundaryAxisSpec {
	const p = killRateParams(opts);
	return {
		claim: 'no-lost-registrations',
		axis: 'killRatePerWindow',
		designAssumption: 0,
		lo: 0,
		hi: 1,
		integer: false,
		holds(k: number): boolean {
			return evalKillRate(k, p).holds;
		}
	};
}

/** Public diagnostic for the kill-rate axis: the full readout (lost, mechanism, transient peak) at rate `k`. */
export function measureKillRateFailover(k: number, opts: KillRateOptions = {}): KillRateReadout {
	return evalKillRate(k, killRateParams(opts));
}

// =============================================================================
// Boundary 2 — heal-convergence vs partition severity × concurrent churn
// =============================================================================

export interface PartitionSeverityOptions {
	/** Cohort member count, split in two (default 16). */
	readonly memberCount?: number;
	/** Attached participants, split across the two sides (default 64). */
	readonly participantCount?: number;
	readonly ttl?: VTime;
	readonly seed?: number;
	/** Max concurrent membership changes per side at severity 1.0 (default 8). */
	readonly maxChangesPerSide?: number;
	/**
	 * Changes that are *joins* (epoch-shifting but reachable, so they repoint lazily within the
	 * window) before any *leaves* (which remove a serving member) are applied. This is the margin the
	 * heal absorbs: re-slotting churn converges; only removing a served primary can break the
	 * one-window bound. Default 2.
	 */
	readonly joinBudget?: number;
	readonly backupsPerRegistration?: number;
}

/** The partition-severity evaluation readout: convergence verdict, fraction, and the structural-trap guard. */
export interface PartitionSeverityReadout {
	/** True ⇒ `heal-convergence` holds: *every* participant repoints to the healed primary within one window. */
	readonly holds: boolean;
	/** Fraction of participants that re-converged within one renewal window (records the edge, not just a boolean). */
	readonly convergedFraction: number;
	readonly converged: number;
	readonly total: number;
	/** Participants forced into a multi-window backup-promotion failover (their served primary was removed). */
	readonly failoverForced: number;
	readonly preEpoch: string;
	readonly healedEpoch: string;
	/**
	 * True ⇒ the healed membership differs from the pre-split set (`healedEpoch !== preEpoch`). The
	 * boundary is meaningful only when this is true at the edge: it proves the claim is NOT being held
	 * up by the structurally-trivial `merge(a,b).epoch === pre.epoch` path.
	 */
	readonly healedEpochChanged: boolean;
}

/** Resolved per-side churn plan for one severity value. */
interface ChurnPlan {
	readonly leaves: number;
	readonly joins: number;
}

/** Map a severity scalar to per-side `(joins, leaves)`: joins fill `joinBudget` first, then leaves. */
function churnPlan(severity: number, p: Required<PartitionSeverityOptions>): ChurnPlan {
	const changes = Math.round(severity * p.maxChangesPerSide);
	const joins = Math.min(changes, p.joinBudget);
	const leaves = Math.max(0, changes - p.joinBudget);
	return { joins, leaves };
}

/**
 * Run one partition side through pre → split → late-churn → heal on the virtual clock, returning how
 * many of its participants repoint to the healed deterministic primary within one renewal window.
 *
 * Timeline (worst-phase, recency-aware): the side settles on the whole-cohort membership (participants
 * cache their served primary), the partition isolates it to `sideMembers`, then — in the *final*
 * window before heal — the concurrent churn lands (members leave, joins arrive). A participant whose
 * cached primary just left has only that one window before heal, far short of the three strikes a
 * backup promotion needs, so on heal its cached primary is gone from `H` and it cannot converge inside
 * one window. A participant whose cached primary survived re-points lazily via `primary_moved` in the
 * single post-heal ping. Convergence is therefore exactly `renewal.primary === H.assign(pid).primary`
 * one window after heal.
 */
function runSideConvergence(
	p: Required<PartitionSeverityOptions>,
	allMembers: readonly string[],
	sideMembers: readonly string[],
	sideParticipants: readonly string[],
	healed: CohortMembership,
	churnedSide: readonly string[]
): { converged: number; total: number; failoverForced: number } {
	const pingInterval = Math.max(1, Math.floor(p.ttl / 3));
	const world = createSimWorld({ seed: p.seed, gossipRoundMs: GOSSIP_ROUND_MS });
	const pre = new CohortMembership(allMembers);
	const cohort = new TopicCohort({
		topicId: TOPIC,
		coord: 'root',
		tier: 1,
		membership: pre,
		backupsPerRegistration: p.backupsPerRegistration
	});
	const renewals: ParticipantRenewal[] = [];
	for (const pid of sideParticipants) {
		cohort.register(pid, 0, p.ttl);
		renewals.push(new ParticipantRenewal({ scheduler: world.scheduler, cohort, participantId: pid, ttl: p.ttl }));
	}
	for (const r of renewals) {
		r.start();
	}

	// Settle on the whole membership: every participant caches its served primary.
	let t = 2 * pingInterval;
	world.scheduler.run(t);

	// Partition: isolate this side. Cross-side orphans begin failing over within the side; give them a
	// couple of windows so the *only* freshly-broken caches at heal are the ones the late churn removes.
	cohort.rotate(new CohortMembership(sideMembers));
	t += 3 * pingInterval;
	world.scheduler.run(t);

	// Late, concurrent churn (the final pre-heal window): leaves remove serving members, joins arrive.
	cohort.rotate(new CohortMembership(churnedSide));
	t += pingInterval;
	world.scheduler.run(t);

	// Heal: merge to the shared healed membership and allow exactly one renewal window to repoint.
	cohort.rotate(healed);
	t += pingInterval;
	world.scheduler.run(t);

	let converged = 0;
	let failoverForced = 0;
	for (const r of renewals) {
		const target = healed.assign(r.participantId).primary;
		if (r.primary === target && cohort.reachable(r.primary)) {
			converged++;
		} else {
			failoverForced++;
		}
	}
	return { converged, total: renewals.length, failoverForced };
}

/**
 * Evaluate `heal-convergence` at partition severity `σ`. Splits the live membership, mutates each side
 * under concurrent churn whose magnitude scales with `σ` (`maxChangesPerSide`), heals into the merged
 * membership, and reports whether *every* participant on *both* sides re-converges on the shared
 * deterministic primary within one renewal window. The two sides churn from independent seeded orders,
 * so convergence can hold for one side's participants and fail for the other — the readout records the
 * converged fraction, not just a boolean.
 */
function evalPartitionSeverity(severity: number, p: Required<PartitionSeverityOptions>): PartitionSeverityReadout {
	const allMembers = Array.from({ length: p.memberCount }, (_v, i) => memberId(i));
	const pre = new CohortMembership(allMembers);
	const half = Math.ceil(p.memberCount / 2);
	const sideAMembers = allMembers.slice(0, half);
	const sideBMembers = allMembers.slice(half);

	// Participants split across the two sides by index parity (network co-location).
	const sideAParticipants: string[] = [];
	const sideBParticipants: string[] = [];
	for (let i = 0; i < p.participantCount; i++) {
		(i % 2 === 0 ? sideAParticipants : sideBParticipants).push(participantId(i));
	}

	const plan = churnPlan(severity, p);

	// Per-side post-churn membership: drop `leaves` serving members (seeded order), add `joins` fresh
	// arrivals. Leaves are what remove a member from the healed set `H`; joins only re-slot.
	const churnRng = createRng(p.seed);
	const applyChurn = (side: readonly string[], label: string): string[] => {
		const order = seededOrder(side, churnRng.fork(`leave-${label}`));
		const leaving = new Set(order.slice(0, Math.min(plan.leaves, side.length - 1)));
		const survivors = side.filter((m) => !leaving.has(m));
		const joined = Array.from({ length: plan.joins }, (_v, i) => joinId(label, i));
		return [...survivors, ...joined];
	};
	const churnedA = applyChurn(sideAMembers, 'A');
	const churnedB = applyChurn(sideBMembers, 'B');
	const healed = new CohortMembership([...churnedA, ...churnedB]);

	const a = runSideConvergence(p, allMembers, sideAMembers, sideAParticipants, healed, churnedA);
	const b = runSideConvergence(p, allMembers, sideBMembers, sideBParticipants, healed, churnedB);

	const converged = a.converged + b.converged;
	const failoverForced = a.failoverForced + b.failoverForced;
	const total = a.total + b.total;
	return {
		holds: converged === total,
		convergedFraction: total === 0 ? 1 : converged / total,
		converged,
		total,
		failoverForced,
		preEpoch: pre.epoch,
		healedEpoch: healed.epoch,
		healedEpochChanged: healed.epoch !== pre.epoch
	};
}

/** Resolve `PartitionSeverityOptions` with defaults. */
function partitionParams(opts: PartitionSeverityOptions): Required<PartitionSeverityOptions> {
	return {
		memberCount: opts.memberCount ?? 16,
		participantCount: opts.participantCount ?? 64,
		ttl: opts.ttl ?? DEFAULT_TTL,
		seed: opts.seed ?? 909,
		maxChangesPerSide: opts.maxChangesPerSide ?? 8,
		joinBudget: opts.joinBudget ?? 2,
		backupsPerRegistration: opts.backupsPerRegistration ?? 2
	};
}

/**
 * Build the partition-severity axis spec: `holds(σ)` splits/churns/heals and returns whether every
 * participant re-converges within one renewal window. `designAssumption = 0` (no concurrent churn,
 * instant heal); the located `σ*` and `margin = σ* − 0` are how much concurrent re-slotting the heal
 * absorbs before a removed serving member breaks the one-window convergence bound.
 */
export function partitionSeverityAxis(opts: PartitionSeverityOptions = {}): BoundaryAxisSpec {
	const p = partitionParams(opts);
	return {
		claim: 'heal-convergence',
		axis: 'partitionSeverity',
		designAssumption: 0,
		lo: 0,
		hi: 1,
		integer: false,
		holds(severity: number): boolean {
			return evalPartitionSeverity(severity, p).holds;
		}
	};
}

/** Public diagnostic for the partition-severity axis: the full readout (fraction, epoch-change guard) at `σ`. */
export function measurePartitionConvergence(severity: number, opts: PartitionSeverityOptions = {}): PartitionSeverityReadout {
	return evalPartitionSeverity(severity, partitionParams(opts));
}

// =============================================================================
// Driver
// =============================================================================

export interface ChurnBoundaryOptions {
	readonly seed?: number;
	readonly killRate?: KillRateOptions;
	readonly partition?: PartitionSeverityOptions;
}

/** The two churn/partition boundaries plus the metrics sink and the per-axis edge diagnostics. */
export interface ChurnBoundaryReport {
	readonly boundaries: EnvelopeBoundary[];
	readonly metrics: Metrics;
	/** Which mechanism flipped `no-lost-registrations` just past its located edge. */
	readonly killMechanism: KillMechanism;
	/** Converged fraction just past the `heal-convergence` edge (the partition that first broke it). */
	readonly convergedFractionAtEdge: number;
	/** True ⇒ the breaking partition's healed set differed from the pre-split set (not the trivial path). */
	readonly healedEpochChangedAtEdge: boolean;
}

/**
 * Run both churn/partition boundaries, folding each into a `Metrics` sink via `recordBoundary`, and
 * diagnose each edge: the mechanism that flipped `no-lost-registrations`, and the converged fraction +
 * epoch-changed guard for the partition that first broke `heal-convergence`. Deterministic from
 * `(seed, config)`.
 */
export function runChurnBoundaries(opts: ChurnBoundaryOptions = {}): ChurnBoundaryReport {
	const seed = opts.seed ?? 4242;
	const killOpts: KillRateOptions = { seed, ...opts.killRate };
	const partOpts: PartitionSeverityOptions = { seed, ...opts.partition };

	const metrics = new Metrics();
	const boundaries: EnvelopeBoundary[] = [];

	// Boundary 1 — no-lost-registrations vs member-kill rate.
	const killBoundary = findBoundary(killRateAxis(killOpts));
	recordBoundary(metrics, killBoundary);
	boundaries.push(killBoundary);
	const killMechanism = diagnoseKillMechanism(killBoundary, killOpts);

	// Boundary 2 — heal-convergence vs partition severity.
	const partBoundary = findBoundary(partitionSeverityAxis(partOpts));
	recordBoundary(metrics, partBoundary);
	boundaries.push(partBoundary);
	const edge = diagnosePartitionEdge(partBoundary, partOpts);

	return {
		boundaries,
		metrics,
		killMechanism,
		convergedFractionAtEdge: edge.convergedFraction,
		healedEpochChangedAtEdge: edge.healedEpochChanged
	};
}

/** Re-evaluate just past the kill-rate edge to record which mechanism (race vs exhaustion) flipped the claim. */
function diagnoseKillMechanism(b: EnvelopeBoundary, opts: KillRateOptions): KillMechanism {
	if (!b.boundaryFound) {
		return 'none';
	}
	const step = b.scanHi * 1e-3;
	const probe = Math.min(b.scanHi, Math.max(b.criticalValue + step, step));
	return measureKillRateFailover(probe, opts).mechanism;
}

/** Re-evaluate just past the partition-severity edge to record the converged fraction + epoch-change guard. */
function diagnosePartitionEdge(b: EnvelopeBoundary, opts: PartitionSeverityOptions): { convergedFraction: number; healedEpochChanged: boolean } {
	if (!b.boundaryFound) {
		return { convergedFraction: 1, healedEpochChanged: false };
	}
	const step = b.scanHi * 1e-3;
	const probe = Math.min(b.scanHi, Math.max(b.criticalValue + step, step));
	const r = measurePartitionConvergence(probe, opts);
	return { convergedFraction: r.convergedFraction, healedEpochChanged: r.healedEpochChanged };
}
