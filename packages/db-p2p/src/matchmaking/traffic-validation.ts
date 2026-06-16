/**
 * Matchmaking — seeker-side adversarial traffic-reporting bounds + reputation cross-check hooks (db-p2p).
 *
 * `docs/matchmaking.md` §Adversarial cohort traffic reporting. A `QueryReplyV1.topicTraffic` (and the
 * registration reply's traffic) is signed by the cohort **primary's single member key, not a threshold
 * signature**, because the response is advisory — so a malicious primary can over- or under-report. The
 * doc proves the harm is bounded either way; this module makes those bounds explicit for the seeker walk
 * and emits the cross-check signals the reputation subsystem consumes.
 *
 *  - **Over-reporting** (fake *hot* tier ⇒ seeker hangs out): bounded by the seeker's `patienceMs`. The
 *    worst case is wasted patience plus the one `register → walk` hop after timeout — there is **no
 *    spatial flood**, because the decision rule only ever walks *toward the root*, never speculatively
 *    outward. {@link boundReportedTraffic} therefore caps any hang-out to the seeker's remaining
 *    wall-clock patience ({@link TrafficBoundResult.capPatienceMs}).
 *  - **Under-reporting** (fake *cold* tier ⇒ seeker escalates): bounded to **one extra hop per affected
 *    tier**, terminating at the root where aggregated truth is hardest to fake
 *    ({@link TrafficBoundResult.escalateAfterTiers}).
 *  - **Cross-check via cohort gossip → reputation.** Other cohort members can detect a primary whose
 *    reported rate diverges from the gossip-derived view. Detection *routing* is the reputation
 *    subsystem's job (out of scope to implement); this module provides the **emission points**
 *    ({@link TrafficCrossCheckSignal}) and a thin bridge ({@link reportTrafficCrossCheck}) into the
 *    existing {@link IPeerReputation}. It scores nothing itself — the reputation subsystem owns the
 *    aggregation/decay policy that turns a stream of advisory signals into an actual penalty.
 *
 * **GROUNDING (matchmaking.md §Adversarial traffic reporting):** no threshold signature is added per
 * `QueryReplyV1` — the single-member signature stands; the bounded worst-case here does not justify the
 * per-reply threshold cost. This module enforces the bounds purely seeker-side instead.
 */

import { type QueryReplyV1 } from "@optimystic/db-core";
import { PenaltyReason, type IPeerReputation } from "../reputation/index.js";

/**
 * The seeker's running walk state at the moment a reply lands — enough to bound the reply's reported
 * traffic and attribute a cross-check signal. The seeker walk client (or the public seeker session)
 * supplies it per reply.
 */
export interface SeekerWalkState {
	/** Tree tier `d` the reply came from. */
	readonly currentTier: number;
	/** Starting tier `d_max` (the walk only descends from here toward `0`). */
	readonly dMax: number;
	/** Register hops issued so far (probes + escalations). Bounded by `d_max + 1` — the walk never loops. */
	readonly tiersWalked: number;
	/** Total patience budget for the task (ms). */
	readonly patienceMs: number;
	/** Patience left on the wall-clock deadline (ms) — the hang-out cap. */
	readonly patienceRemainingMs: number;
	/** Filter-matched providers the seeker's *own* immediate `QueryV1` at this tier actually returned. */
	readonly observedMatches: number;
	/** The reply's cohort primary peer id, for reputation attribution (absent → no attribution). */
	readonly primaryId?: string;
}

/** Tunables for {@link boundReportedTraffic}. */
export interface TrafficBoundConfig {
	/**
	 * Upper bound on extra register hops a single under-reported tier may cost. The doc fixes this at
	 * **1** ("one extra hop per affected tier"); exposed for tests / future policy, not meant to change.
	 */
	readonly maxExtraHopsPerTier: number;
	/**
	 * Over-report plausibility ratio. When a reply claims `directParticipants` more than this multiple of
	 * the seeker's *own* query yield, the over-report is flagged *suspect* (a cross-check signal — never a
	 * hard reject; the patience cap already bounds the harm).
	 */
	readonly overReportSuspectRatio: number;
}

/** The documented defaults (`maxExtraHopsPerTier = 1`; suspect ratio chosen to tolerate normal churn). */
export const DEFAULT_TRAFFIC_BOUND_CONFIG: TrafficBoundConfig = {
	maxExtraHopsPerTier: 1,
	overReportSuspectRatio: 8,
};

/** The kind of divergence a {@link TrafficCrossCheckSignal} reports. */
export type TrafficCrossCheckKind = "over-report-suspected" | "under-report-suspected";

/**
 * One advisory cross-check observation about a cohort primary's reported traffic. Emitted by
 * {@link boundReportedTraffic}; consumed by the reputation subsystem (via {@link reportTrafficCrossCheck}
 * or a custom sink). Carries the raw discrepancy so the reputation policy — not this module — decides
 * whether it warrants a penalty.
 */
export interface TrafficCrossCheckSignal {
	readonly kind: TrafficCrossCheckKind;
	/** The cohort primary peer id (the subject), if the walk state attributed one. */
	readonly subjectId?: string;
	/** The tier the reply came from. */
	readonly tier: number;
	/** `topicTraffic.directParticipants` as reported. */
	readonly reportedDirectParticipants: number;
	/** `topicTraffic.arrivalsPerMin` as reported. */
	readonly reportedArrivalsPerMin: number;
	/** The seeker's own immediate-query yield, which the report is cross-checked against. */
	readonly observedMatches: number;
}

/** The outcome of {@link boundReportedTraffic}. */
export interface TrafficBoundResult {
	/** Whether the reported traffic is within plausible bounds (advisory; a flag, not an admission). */
	readonly trusted: boolean;
	/**
	 * Over-report bound: never hang out at this tier beyond the seeker's remaining wall-clock patience.
	 * Equals `max(0, patienceRemainingMs)` — so a fabricated hot tier wastes at most that, then the walk
	 * proceeds with its one register hop.
	 */
	readonly capPatienceMs: number;
	/** Under-report bound: at most this many extra register hops attributable to one tier (== config). */
	readonly escalateAfterTiers: number;
	/** Cross-check emission points (possibly empty). Forward to the reputation subsystem if desired. */
	readonly reputationSignals: TrafficCrossCheckSignal[];
}

/**
 * Bound the harm of a (possibly adversarial) `topicTraffic` report and emit cross-check signals. Pure —
 * no I/O, no clock, no reputation scoring. The seeker walk consults `capPatienceMs` before hanging out
 * and treats `escalateAfterTiers` as the per-tier hop ceiling; the bounds it returns hold *by
 * construction* of the toward-root-only walk, so this function documents + asserts them rather than
 * changing the walk topology.
 */
export function boundReportedTraffic(
	reply: QueryReplyV1,
	walkState: SeekerWalkState,
	cfg: TrafficBoundConfig = DEFAULT_TRAFFIC_BOUND_CONFIG,
): TrafficBoundResult {
	const traffic = reply.topicTraffic;
	const signals: TrafficCrossCheckSignal[] = [];

	// Over-report: a primary advertising a hot tier (many directParticipants) whose own query yields far
	// fewer matches is suspect. Harm is bounded regardless — the patience cap below means a fabricated hot
	// tier can only waste the seeker's remaining patience before it walks on (no spatial flood, since the
	// walk only steps toward the root).
	const overReportSuspect =
		traffic.directParticipants > cfg.overReportSuspectRatio * Math.max(walkState.observedMatches, 1);
	if (overReportSuspect) {
		signals.push(crossCheckSignal("over-report-suspected", traffic, walkState));
	}

	// Under-report: a primary claiming a cold tier (zero arrivals) while the seeker's own query yields
	// matches is suspect. Either way the escalation costs at most one extra hop for this tier and
	// terminates at the root.
	const underReportSuspect = traffic.arrivalsPerMin === 0 && walkState.observedMatches > 0;
	if (underReportSuspect) {
		signals.push(crossCheckSignal("under-report-suspected", traffic, walkState));
	}

	return {
		trusted: !overReportSuspect && !underReportSuspect,
		capPatienceMs: Math.max(0, walkState.patienceRemainingMs),
		escalateAfterTiers: cfg.maxExtraHopsPerTier,
		reputationSignals: signals,
	};
}

function crossCheckSignal(kind: TrafficCrossCheckKind, traffic: QueryReplyV1["topicTraffic"], walkState: SeekerWalkState): TrafficCrossCheckSignal {
	const signal: TrafficCrossCheckSignal = {
		kind,
		tier: walkState.currentTier,
		reportedDirectParticipants: traffic.directParticipants,
		reportedArrivalsPerMin: traffic.arrivalsPerMin,
		observedMatches: walkState.observedMatches,
	};
	if (walkState.primaryId !== undefined) {
		(signal as { subjectId: string }).subjectId = walkState.primaryId;
	}
	return signal;
}

/**
 * The total hop budget the toward-root-only walk can consume under any sequence of (honest or
 * adversarial) traffic reports: at most `maxExtraHopsPerTier` per tier from `d_max` down to the root,
 * plus the terminal hop — i.e. `(dMax + 1) * maxExtraHopsPerTier`. Exposed so the walk and its tests can
 * assert the under-report bound holds (the walk never exceeds it, because escalation is monotone toward
 * `d = 0`).
 */
export function maxWalkHops(dMax: number, cfg: TrafficBoundConfig = DEFAULT_TRAFFIC_BOUND_CONFIG): number {
	return Math.max(0, dMax + 1) * cfg.maxExtraHopsPerTier;
}

/**
 * Integration hook: forward cross-check signals into the reputation subsystem. This is the **emission
 * point only** — it records a `ProtocolViolation` against the reporting primary; the reputation
 * subsystem's own weighting, decay, and deprioritize/ban thresholds (`PeerReputationService`) decide
 * whether an accumulation of these advisory signals actually penalizes the peer. Signals without an
 * attributed `subjectId` are skipped.
 */
export function reportTrafficCrossCheck(reputation: IPeerReputation, signals: readonly TrafficCrossCheckSignal[]): void {
	for (const signal of signals) {
		if (signal.subjectId === undefined) {
			continue;
		}
		reputation.reportPeer(signal.subjectId, PenaltyReason.ProtocolViolation, `matchmaking:${signal.kind}`);
	}
}
