import type { SimWorldCore, PeerRef, VTime } from './types.js';
import type { RingCoord } from './ring-model.js';
import { createSimWorld } from './world.js';
import { DeterministicLatency, DEFAULT_HOP_MS } from './latency.js';
import { generatePeers } from './peer.js';
import { bytesToHex } from './hex.js';
import { Metrics } from './metrics.js';
import { TopicTree, DEFAULT_LIFECYCLE_CONFIG } from './topic-tree.js';
import { expectedDepth, uniformLadder } from './promotion-convergence.js';
import {
	ParticipantWalk,
	type WalkTrace
} from './walk.js';
import {
	distinctStartCoords,
	acceptedAtTier,
	hopPercentile
} from './walk-metrics.js';
import { CohortMembership } from './cohort-membership.js';
import { TopicCohort, ParticipantRenewal } from './registration.js';
import { checkConvergence } from './partition.js';
import {
	CohortPushState,
	simulateRotationBurst,
	DEFAULT_REACTIVITY_CONFIG,
	type ReactivityConfig
} from './reactivity.js';
import {
	SeekerWalk,
	TierProviderModel,
	type TierProviderConfig,
	type SeekerTrace,
	type TrafficReporter
} from './seeker-walk.js';
import type { SimProvider, CapabilityFilter } from './matchmaking.js';

/**
 * The scenario runner — the orchestration half of `simulator-metrics-and-scenarios`. Each `Scenario`
 * sets up a population/topology, drives the modeled subsystems to completion on the virtual clock
 * folding every quantitative readout into a `MetricsSink`, then validates the design's claims out of
 * that sink as a pass/fail `ClaimReport`. The five scenarios mirror the §Worked scenarios across
 * cohort-topic.md (cold-start storm, voting-quorum herd), reactivity.md (tail rotation), and
 * matchmaking.md (adversarial reporting), plus the churn-recovery failure mode.
 *
 * Scenarios reuse the sequence-4/5 model drivers verbatim (`ParticipantWalk`, `TopicTree`,
 * `TopicCohort`/`ParticipantRenewal`, `simulateRotationBurst`, `SeekerWalk`) — this ticket adds the
 * aggregation + claim-validation layer on top, it does not re-model behaviour. Where a reused driver
 * owns its own `SimWorld` (the rotation burst; the per-seeker walks), the scenario seeds those
 * sub-worlds deterministically from its own `seed`; the rest drive the runner-provided `world`.
 */

/** The simulator world handed to a scenario (the discrete-event core: scheduler, rng, latency). */
export type SimWorld = SimWorldCore;

/** One validated design claim: what was expected, what was observed, and whether it held. */
export interface Claim {
	readonly id: string;
	readonly expected: string;
	readonly observed: string;
	readonly pass: boolean;
}

/** The per-scenario pass/fail report the runner emits (ticket §Scenario runner `ClaimReport`). */
export interface ClaimReport {
	readonly scenario: string;
	readonly claims: Claim[];
}

/** A runnable end-to-end scenario (ticket §Scenario runner `Scenario`). */
export interface Scenario {
	readonly name: string;
	readonly seed: number;
	setup(world: SimWorld): void;
	run(world: SimWorld): void;
	validate(metrics: Metrics): ClaimReport;
}

/** Build a `Claim`, deriving `pass` from a predicate over the observed value. */
function claim(id: string, expected: string, observed: number | string | boolean, pass: boolean): Claim {
	return { id, expected, observed: String(observed), pass };
}

/** Whether every claim in a report passed. */
export function allClaimsPass(report: ClaimReport): boolean {
	return report.claims.every((c) => c.pass);
}

const TOPIC = 'c0ffee';
const GOSSIP_ROUND_MS = 1000;

/**
 * Drive a scenario end-to-end against a fresh world + metrics sink seeded from the scenario.
 * The same `Metrics` instance is wired into the scenario's models (so it captures the event stream)
 * and read back by `validate`. Returns the report and the populated metrics for export/inspection.
 */
export function runScenario(make: (metrics: Metrics) => Scenario, hopMs: VTime = DEFAULT_HOP_MS): { report: ClaimReport; metrics: Metrics } {
	const metrics = new Metrics();
	const scenario = make(metrics);
	const world = createSimWorld({ seed: scenario.seed, gossipRoundMs: GOSSIP_ROUND_MS }, new DeterministicLatency(hopMs));
	scenario.setup(world);
	scenario.run(world);
	const report = scenario.validate(metrics);
	return { report, metrics };
}

// --- Scenario 1: cold-start storm --------------------------------------------

export interface ColdStartOptions {
	readonly seed?: number;
	/** Subscribers arriving in the burst (cohort-topic.md §Anti-flood: cold-start storm). */
	readonly subscribers?: number;
	/** Burst arrival window (ms); arrivals jitter uniformly across it. */
	readonly burstWindowMs?: VTime;
}

/**
 * **Cold-start storm** (cohort-topic.md §Anti-flood properties). A burst of subscribers arrives at a
 * cold topic; each runs the full `d_max`→root `ParticipantWalk`. Validates anti-flood: the root
 * never absorbs more than `cap_promote` direct participants (it promotes and fans the herd to tier 1),
 * the walks fan across distinct start coords rather than colliding, promotion fires, and lookup cost
 * stays O(log N) (`hops ≤ d_max + 2`).
 */
export class ColdStartStormScenario implements Scenario {
	readonly name = 'cold-start-storm';
	readonly seed: number;
	private readonly subscribers: number;
	private readonly burstWindowMs: VTime;
	private readonly F = DEFAULT_LIFECYCLE_CONFIG.F;
	private readonly capPromote = DEFAULT_LIFECYCLE_CONFIG.capPromote;
	private readonly dMax: number;
	private readonly traces: WalkTrace[] = [];
	private tree!: TopicTree;
	private peers: PeerRef[] = [];

	constructor(private readonly metrics: Metrics, opts: ColdStartOptions = {}) {
		this.seed = opts.seed ?? 1;
		this.subscribers = opts.subscribers ?? 10_000;
		this.burstWindowMs = opts.burstWindowMs ?? 5_000;
		this.dMax = expectedDepth(this.subscribers, this.F, this.capPromote) + 2;
	}

	setup(world: SimWorld): void {
		// Slope-based pre-promotion is disabled for the storm (as in `simulateRotationBurst`): under the
		// steep arrival ramp it would pre-promote cohorts below `cap_promote`, transiently over-deepening
		// the tree and inflating lookup hops past the doc's `d_max + 2` cold worst case. With it off,
		// promotion fires strictly at `cap_promote`, so the depth and the hop bound are real checks.
		const config = { ...DEFAULT_LIFECYCLE_CONFIG, tPromoteLookaheadMs: 0 };
		this.tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: GOSSIP_ROUND_MS, config, sink: this.metrics });
		this.peers = generatePeers(this.subscribers, world.rng.fork('coldstart-peers'));
	}

	run(world: SimWorld): void {
		const jitter = world.rng.fork('coldstart-jitter');
		for (let i = 0; i < this.subscribers; i++) {
			const at = jitter.nextInt(this.burstWindowMs);
			const index = i;
			world.scheduler.scheduleAt(at, () => this.launchWalk(world, index));
		}
		world.scheduler.run();
		this.aggregate();
	}

	private launchWalk(world: SimWorld, index: number): void {
		const ladder = uniformLadder(index, this.dMax, this.F);
		const walk = new ParticipantWalk({
			scheduler: world.scheduler,
			tree: this.tree,
			participant: this.peers[index]!,
			topicId: TOPIC,
			ladder,
			sink: this.metrics,
			onComplete: (trace) => {
				this.traces.push(trace);
				this.metrics.histogram('coldstart.walkHops', trace.hops);
				this.metrics.histogram('coldstart.walkLatency', trace.latency);
			}
		});
		walk.start();
	}

	private aggregate(): void {
		const gaveUp = this.traces.filter((t) => t.outcome === 'gave-up').length;
		this.metrics.counter('coldstart.completed', this.traces.length);
		this.metrics.counter('coldstart.gaveUp', gaveUp);
		this.metrics.counter('coldstart.acceptedTier0', acceptedAtTier(this.traces, 0));
		this.metrics.counter('coldstart.distinctStartCoords', distinctStartCoords(this.traces));
	}

	validate(metrics: Metrics): ClaimReport {
		const m = metrics;
		const rootDirect = m.counterValue('coldstart.acceptedTier0');
		const distinct = m.counterValue('coldstart.distinctStartCoords');
		const promotions = m.counterTotal('event.Promoted');
		const maxHops = hopPercentile(this.traces, 100);
		const gaveUp = m.counterValue('coldstart.gaveUp');
		const claims: Claim[] = [
			claim('root-not-overloaded', `tier-0 accepts ≤ cap_promote (${this.capPromote})`, rootDirect, rootDirect <= this.capPromote),
			claim('walks-fan', `distinct start coords == subscribers (${this.subscribers})`, distinct, distinct === this.subscribers),
			claim('promotion-fires', 'Promoted events ≥ 1', promotions, promotions >= 1),
			claim('lookup-is-log-cost', `max hops ≤ d_max + 2 (${this.dMax + 2})`, maxHops, maxHops <= this.dMax + 2),
			claim('no-give-ups', 'every walk attached (gave-up == 0)', gaveUp, gaveUp === 0)
		];
		return { scenario: this.name, claims };
	}
}

// --- Scenario 2: churn recovery ----------------------------------------------

export interface ChurnRecoveryOptions {
	readonly seed?: number;
	/** Cohort member count. */
	readonly members?: number;
	/** Attached participants whose registrations must survive the turnover. */
	readonly participants?: number;
	/** Per-cohort turnover fraction (ticket: 20%). */
	readonly turnoverPct?: number;
	readonly ttl?: VTime;
}

/**
 * **Churn recovery** (cohort-topic.md §Failure modes, §Partition heal). A fraction of cohort members
 * crash; attached participants must fail over to backups within the renewal window with no lost
 * registrations, and a partition split→heal must re-converge every participant on the same
 * deterministic primary. Validates failover (backup promotion / re-lookup) and heal convergence.
 */
export class ChurnRecoveryScenario implements Scenario {
	readonly name = 'churn-recovery';
	readonly seed: number;
	private readonly memberCount: number;
	private readonly participantCount: number;
	private readonly turnoverPct: number;
	private readonly ttl: VTime;
	private membership!: CohortMembership;
	private cohort!: TopicCohort;
	private renewals: ParticipantRenewal[] = [];

	constructor(private readonly metrics: Metrics, opts: ChurnRecoveryOptions = {}) {
		this.seed = opts.seed ?? 4242;
		this.memberCount = opts.members ?? 16;
		this.participantCount = opts.participants ?? 64;
		this.turnoverPct = opts.turnoverPct ?? 0.2;
		this.ttl = opts.ttl ?? 90_000;
	}

	private memberId(i: number): string {
		return `m${i.toString().padStart(3, '0')}`;
	}

	setup(world: SimWorld): void {
		void world;
		const ids = Array.from({ length: this.memberCount }, (_v, i) => this.memberId(i));
		this.membership = new CohortMembership(ids);
		this.cohort = new TopicCohort({ topicId: TOPIC, coord: 'root', tier: 1, membership: this.membership, sink: this.metrics });
	}

	run(world: SimWorld): void {
		for (let i = 0; i < this.participantCount; i++) {
			const id = `sub-${i}`;
			this.cohort.register(id, 0, this.ttl);
			this.renewals.push(new ParticipantRenewal({ scheduler: world.scheduler, cohort: this.cohort, participantId: id, ttl: this.ttl, sink: this.metrics }));
		}
		for (const r of this.renewals) {
			r.start();
		}
		// Turnover: crash a deterministic 20% of members.
		const kills = this.pickKills(world);
		for (const id of kills) {
			this.cohort.kill(id);
		}
		this.metrics.counter('churn.killedMembers', kills.length);
		// Drive renewal loops long enough for three-failure backup promotion (3 × ttl/3 = ttl) plus margin.
		world.scheduler.run(2 * this.ttl);
		this.aggregate();
		this.measurePartitionHeal(kills);
	}

	/** A deterministic 20% slice of members chosen via the seeded rng. */
	private pickKills(world: SimWorld): string[] {
		const rng = world.rng.fork('churn-kills');
		const pool = Array.from({ length: this.memberCount }, (_v, i) => this.memberId(i));
		const count = Math.round(this.memberCount * this.turnoverPct);
		const kills: string[] = [];
		for (let i = 0; i < count && pool.length > 0; i++) {
			kills.push(pool.splice(rng.nextInt(pool.length), 1)[0]!);
		}
		return kills;
	}

	private aggregate(): void {
		let lost = 0;
		let backupPromotions = 0;
		let reLookups = 0;
		for (const r of this.renewals) {
			backupPromotions += r.backupPromotions;
			reLookups += r.reLookups;
			if (!this.cohort.reachable(r.primary)) {
				lost++;
			}
		}
		this.metrics.counter('churn.backupPromotions', backupPromotions);
		this.metrics.counter('churn.reLookups', reLookups);
		this.metrics.counter('churn.lostRegistrations', lost);
	}

	/** Split the live membership in two, then heal; assert each participant re-converges (partition.ts). */
	private measurePartitionHeal(killed: readonly string[]): void {
		const live = this.membership.members.filter((m) => !killed.includes(m));
		const sideA = new Set(live.slice(0, Math.ceil(live.length / 2)));
		const [a, b] = this.membership.split((id) => sideA.has(id));
		let converged = 0;
		for (let i = 0; i < this.participantCount; i++) {
			const conv = checkConvergence(this.membership, a, b, `sub-${i}`);
			if (conv.converged) {
				converged++;
			}
		}
		this.metrics.counter('churn.partitionsConverged', converged);
		this.metrics.counter('churn.partitionsTotal', this.participantCount);
	}

	validate(metrics: Metrics): ClaimReport {
		const m = metrics;
		const lost = m.counterValue('churn.lostRegistrations');
		const backupPromotions = m.counterValue('churn.backupPromotions');
		const reLookups = m.counterValue('churn.reLookups');
		const converged = m.counterValue('churn.partitionsConverged');
		const total = m.counterValue('churn.partitionsTotal');
		const failover = backupPromotions + reLookups;
		const claims: Claim[] = [
			claim('no-lost-registrations', 'every participant served by a reachable primary (lost == 0)', lost, lost === 0),
			claim('failover-engaged', 'failover (backup promotion / re-lookup) ≥ 1', failover, failover >= 1),
			claim('heal-convergence', `all ${total} participants re-converge after heal`, converged, total > 0 && converged === total)
		];
		return { scenario: this.name, claims };
	}
}

// --- Scenario 3: tail rotation under load ------------------------------------

export interface TailRotationOptions {
	readonly seed?: number;
	readonly subscribers?: number;
	readonly config?: ReactivityConfig;
	/** Revisions to push through the replay pipeline for the continuity check. */
	readonly revisions?: number;
}

/**
 * **Tail rotation under load** (reactivity.md §Tail rotation). All subscribers re-register at the new
 * tail with jitter over `T_rejoin_jitter`; validates the re-registration wave stays within
 * `cap_promote_fast` at the new root, completes inside `T_drain`, and that the monotonic revision
 * stream stays gap-free (continuity). Reuses `simulateRotationBurst` and `CohortPushState`.
 */
export class TailRotationScenario implements Scenario {
	readonly name = 'tail-rotation-under-load';
	readonly seed: number;
	private readonly subscribers: number;
	private readonly config: ReactivityConfig;
	private readonly revisions: number;

	constructor(private readonly metrics: Metrics, opts: TailRotationOptions = {}) {
		this.seed = opts.seed ?? 1;
		this.subscribers = opts.subscribers ?? 2_000;
		this.config = opts.config ?? DEFAULT_REACTIVITY_CONFIG;
		this.revisions = opts.revisions ?? 1_000;
	}

	setup(_world: SimWorld): void {}

	run(_world: SimWorld): void {
		const burst = simulateRotationBurst({ subscriberCount: this.subscribers, config: this.config, seed: this.seed });
		this.metrics.counter('rotation.peakRootDirect', burst.peakRootDirect);
		this.metrics.counter('rotation.capPromoteFast', burst.capPromoteFast);
		this.metrics.counter('rotation.lastArrivalAt', burst.lastArrivalAt);
		this.metrics.counter('rotation.finalDepth', burst.finalDepth);
		this.metrics.counter('rotation.withinCapPromoteFast', burst.withinCapPromoteFast ? 1 : 0);
		this.metrics.counter('rotation.completedWithinDrain', burst.completedWithinDrain ? 1 : 0);
		this.measureContinuity();
	}

	/** Push a contiguous revision stream through the replay pipeline; confirm gap-free monotonic delivery. */
	private measureContinuity(): void {
		const state = new CohortPushState(this.config);
		let forwarded = 0;
		let contiguous = true;
		let prev = 0;
		for (let rev = 1; rev <= this.revisions; rev++) {
			if (state.ingest(rev, `d${rev}`, rev) === 'forwarded') {
				forwarded++;
			}
			if (state.lastRevision !== prev + 1) {
				contiguous = false;
			}
			prev = state.lastRevision;
		}
		const low = state.replay.lowestRevision() ?? 0;
		const high = state.replay.highestRevision() ?? -1;
		const windowContiguous = high - low + 1 === state.replay.size;
		this.metrics.counter('rotation.revisionsForwarded', forwarded);
		this.metrics.counter('rotation.revisionsExpected', this.revisions);
		this.metrics.counter('rotation.monotoneContiguous', contiguous ? 1 : 0);
		this.metrics.counter('rotation.windowContiguous', windowContiguous ? 1 : 0);
	}

	validate(metrics: Metrics): ClaimReport {
		const m = metrics;
		const peak = m.counterValue('rotation.peakRootDirect');
		const cap = m.counterValue('rotation.capPromoteFast');
		const withinDrain = m.counterValue('rotation.completedWithinDrain') === 1;
		const lastArrival = m.counterValue('rotation.lastArrivalAt');
		const forwarded = m.counterValue('rotation.revisionsForwarded');
		const expected = m.counterValue('rotation.revisionsExpected');
		const monotone = m.counterValue('rotation.monotoneContiguous') === 1;
		const windowContiguous = m.counterValue('rotation.windowContiguous') === 1;
		const claims: Claim[] = [
			claim('burst-within-cap-promote-fast', `peak root direct ≤ cap_promote_fast (${cap})`, peak, peak <= cap),
			claim('completes-within-drain', `last re-registration ≤ T_drain (${this.config.tDrainMs}ms)`, lastArrival, withinDrain),
			claim('revision-continuity', `all ${expected} revisions forwarded, monotone & gap-free`, forwarded, forwarded === expected && monotone && windowContiguous)
		];
		return { scenario: this.name, claims };
	}
}

// --- Scenario 4: voting-quorum assembly on a hot proposal --------------------

export interface VotingQuorumOptions {
	readonly seed?: number;
	/** Eligible voters that flash-register within the voting window. */
	readonly voters?: number;
}

/**
 * **Voting-quorum assembly on a hot proposal** (cohort-topic.md §Worked scenarios: voting on a popular
 * proposal). A large eligible-voter population flash-registers; validates the tree promotion absorbs
 * the herd — steady-state depth settles at `⌈log_F(N/cap_promote)⌉` and the root never holds more than
 * `cap_promote` direct registrations (the storm gets `Promoted(1)` quickly). Drives the eager
 * `TopicTree.register` growth path.
 */
export class VotingQuorumScenario implements Scenario {
	readonly name = 'voting-quorum-hot-proposal';
	readonly seed: number;
	private readonly voters: number;
	private readonly F = DEFAULT_LIFECYCLE_CONFIG.F;
	private readonly capPromote = DEFAULT_LIFECYCLE_CONFIG.capPromote;
	private readonly expected: number;
	private readonly dMax: number;
	private tree!: TopicTree;

	constructor(private readonly metrics: Metrics, opts: VotingQuorumOptions = {}) {
		this.seed = opts.seed ?? 7;
		this.voters = opts.voters ?? 5_000;
		this.expected = expectedDepth(this.voters, this.F, this.capPromote);
		this.dMax = this.expected + 2;
	}

	setup(world: SimWorld): void {
		this.tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: GOSSIP_ROUND_MS, sink: this.metrics });
	}

	run(_world: SimWorld): void {
		for (let i = 0; i < this.voters; i++) {
			this.tree.register(TOPIC, uniformLadder(i, this.dMax, this.F), 0);
		}
		const rootCoord = bytesToHex(uniformLadder(0, this.dMax, this.F)[0]!);
		const rootDirect = this.tree.get(TOPIC, rootCoord)?.directParticipants ?? 0;
		this.metrics.counter('voting.steadyStateDepth', this.tree.maxOccupiedTier(TOPIC));
		this.metrics.counter('voting.expectedDepth', this.expected);
		this.metrics.counter('voting.rootDirect', rootDirect);
	}

	validate(metrics: Metrics): ClaimReport {
		const m = metrics;
		const depth = m.counterValue('voting.steadyStateDepth');
		const rootDirect = m.counterValue('voting.rootDirect');
		const promotions = m.counterTotal('event.Promoted');
		const claims: Claim[] = [
			claim('absorbs-herd-depth-law', `steady-state depth == ⌈log_F(N/cap)⌉ (${this.expected})`, depth, depth === this.expected),
			claim('root-not-overloaded', `root direct ≤ cap_promote (${this.capPromote})`, rootDirect, rootDirect <= this.capPromote),
			claim('promotion-fires', 'Promoted events ≥ 1', promotions, promotions >= 1)
		];
		return { scenario: this.name, claims };
	}
}

// --- Scenario 5: adversarial traffic reporting -------------------------------

export interface AdversarialOptions {
	readonly seed?: number;
	readonly patienceMs?: VTime;
	readonly wantCount?: number;
}

const PDF_FILTER: CapabilityFilter = { must: ['pdf'] };

/**
 * **Adversarial traffic reporting** (matchmaking.md §Adversarial traffic reporting). A lying cohort
 * primary mis-reports `topicTraffic`; validates bounded harm — an under-reporter (claim a cold tier)
 * costs at most one extra escalation hop per under-reported tier, and an over-reporter (claim a hot
 * tier) wastes at most `patienceMs` of hang-out drain. Runs honest vs. adversarial `SeekerWalk`s over
 * the same provider model and compares (mirrors `seeker-walk.spec` §Adversarial traffic reporting).
 */
export class AdversarialReportingScenario implements Scenario {
	readonly name = 'adversarial-traffic-reporting';
	readonly seed: number;
	private readonly patienceMs: VTime;
	private readonly wantCount: number;
	private readonly hopMs = DEFAULT_HOP_MS;

	constructor(private readonly metrics: Metrics, opts: AdversarialOptions = {}) {
		this.seed = opts.seed ?? 90909;
		this.patienceMs = opts.patienceMs ?? 10_000;
		this.wantCount = opts.wantCount ?? 8;
	}

	setup(_world: SimWorld): void {}

	run(_world: SimWorld): void {
		this.measureUnderReport();
		this.measureOverReport();
	}

	private providers(n: number, from: number): SimProvider[] {
		return Array.from({ length: n }, (_v, i) => ({ id: `p${from + i}`, capabilities: ['pdf'], capacityBudget: 1, attachedAt: 0 }));
	}

	/** A coord ladder of `tiers` coords (mirrors seeker-walk.spec's `ladderOf`). */
	private ladder(tiers: number, marker: number): RingCoord[] {
		return Array.from({ length: tiers + 1 }, (_v, tier) => {
			const c = new Uint8Array(32);
			c[0] = tier;
			c[1] = marker;
			return c;
		});
	}

	/** Run one seeker landing at `startTier` against `model`, honest unless a `reporter` is given. */
	private runSeeker(startTier: number, marker: number, model: TierProviderModel, reporter?: TrafficReporter): SeekerTrace {
		const world = createSimWorld({ seed: this.seed, gossipRoundMs: GOSSIP_ROUND_MS }, new DeterministicLatency(this.hopMs));
		const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: GOSSIP_ROUND_MS });
		const ladder = this.ladder(startTier, marker);
		tree.ensure(TOPIC, bytesToHex(ladder[startTier]!), startTier, 0);
		let trace: SeekerTrace | undefined;
		const walk = new SeekerWalk({
			scheduler: world.scheduler,
			tree,
			participant: { id: `seeker-${marker}`, key: new Uint8Array(32) },
			topicId: TOPIC,
			ladder,
			providers: model,
			wantCount: this.wantCount,
			patienceMs: this.patienceMs,
			filter: PDF_FILTER,
			reporter,
			onComplete: (t) => {
				trace = t;
			}
		});
		walk.start();
		world.scheduler.run();
		if (!trace) {
			throw new Error('seeker walk did not complete');
		}
		return trace;
	}

	/** Under-reporting upper tiers (arrivalsPerMin → 0) forces an escalation per lied-about tier. */
	private measureUnderReport(): void {
		const tiers: TierProviderConfig[] = [
			{ tier: 2, initial: this.providers(6, 200), reportedArrivalsPerMin: 90, queriesPerMin: 4, freshArrivalIntervalMs: 500, freshCapabilities: ['pdf'] },
			{ tier: 1, initial: this.providers(6, 300), reportedArrivalsPerMin: 90, queriesPerMin: 4, freshArrivalIntervalMs: 500, freshCapabilities: ['pdf'] },
			{ tier: 0, initial: this.providers(8, 400), reportedArrivalsPerMin: 600, queriesPerMin: 4 }
		];
		const model = new TierProviderModel(tiers);
		const honest = this.runSeeker(2, 0x50, model);
		const underReport: TrafficReporter = (truthful, tier) => (tier > 0 ? { ...truthful, arrivalsPerMin: 0 } : truthful);
		const lied = this.runSeeker(2, 0x55, model, underReport);
		this.metrics.counter('adv.under.honestEscalations', honest.escalations);
		this.metrics.counter('adv.under.liedEscalations', lied.escalations);
		this.metrics.counter('adv.under.liedTerminated', lied.matched ? 1 : 0);
		this.metrics.counter('adv.under.liedTiers', 2);
	}

	/** Over-reporting a thin tier (arrivalsPerMin → huge) makes the seeker waste drain, bounded by patience. */
	private measureOverReport(): void {
		const tiers: TierProviderConfig[] = [
			{ tier: 1, initial: this.providers(2, 500), reportedArrivalsPerMin: 2, queriesPerMin: 1 },
			{ tier: 0, initial: this.providers(8, 600), reportedArrivalsPerMin: 600, queriesPerMin: 4 }
		];
		const model = new TierProviderModel(tiers);
		const overReport: TrafficReporter = (truthful, tier) => (tier === 1 ? { ...truthful, arrivalsPerMin: 100_000 } : truthful);
		// `runSeeker` throws unless the walk completes, so reaching here means it terminated.
		const lied = this.runSeeker(1, 0x66, model, overReport);
		this.metrics.histogram('adv.over.hangOutMs', lied.hangOutDurationMs);
		this.metrics.counter('adv.over.hangOutMs', lied.hangOutDurationMs);
		this.metrics.counter('adv.over.matchLatency', lied.matchLatency);
	}

	validate(metrics: Metrics): ClaimReport {
		const m = metrics;
		const honestEsc = m.counterValue('adv.under.honestEscalations');
		const liedEsc = m.counterValue('adv.under.liedEscalations');
		const liedTerminated = m.counterValue('adv.under.liedTerminated') === 1;
		const liedTiers = m.counterValue('adv.under.liedTiers');
		const overHangOut = m.counterValue('adv.over.hangOutMs');
		const overLatency = m.counterValue('adv.over.matchLatency');
		const extraHops = liedEsc - honestEsc;
		const claims: Claim[] = [
			claim('under-report-bounded', `≤ +1 escalation per under-reported tier (≤ ${liedTiers})`, extraHops, extraHops >= 0 && extraHops <= liedTiers),
			claim('under-report-not-fatal', 'under-reported seeker still terminates (matches at root)', liedTerminated, liedTerminated),
			claim('over-report-bounded-drain', `wasted hang-out ≤ patienceMs (${this.patienceMs}ms)`, overHangOut, overHangOut > 0 && overHangOut <= this.patienceMs),
			claim('over-report-terminates', `seeker terminates within patienceMs + setup (≤ ${this.patienceMs + this.hopMs * 4}ms)`, overLatency, overLatency <= this.patienceMs + this.hopMs * 4)
		];
		return { scenario: this.name, claims };
	}
}

// --- registry ----------------------------------------------------------------

/** Factory list of the five scenarios, each bound to a shared metrics sink. */
export type ScenarioFactory = (metrics: Metrics) => Scenario;

/** The five design scenarios in canonical order. */
export const SCENARIO_FACTORIES: readonly ScenarioFactory[] = [
	(m) => new ColdStartStormScenario(m),
	(m) => new ChurnRecoveryScenario(m),
	(m) => new TailRotationScenario(m),
	(m) => new VotingQuorumScenario(m),
	(m) => new AdversarialReportingScenario(m)
];

/** Run all five scenarios; returns each `ClaimReport` paired with its populated metrics. */
export function runAllScenarios(): { report: ClaimReport; metrics: Metrics }[] {
	return SCENARIO_FACTORIES.map((make) => runScenario(make));
}
