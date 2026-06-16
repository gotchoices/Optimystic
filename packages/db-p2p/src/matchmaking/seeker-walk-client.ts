/**
 * Matchmaking — seeker walk client (db-p2p, drives the hang-out-vs-continue walk over the substrate).
 *
 * `docs/matchmaking.md` §Hang-out vs. continue. This is the RPC orchestration on top of the pure
 * db-core {@link decide} engine: starting at `d_max`, it registers the seeker, issues `QueryV1`,
 * re-validates and dedupes returned providers, and on each `Accepted` reply asks {@link decide} whether
 * to finish, hang out (renew + requery on the `requery_interval_ms` poll cadence), or escalate (withdraw
 * + re-register one tier toward the root). At `d = 0` there is nowhere left to walk, so it hangs out for
 * the remaining patience and returns whatever matched (possibly `< wantCount`).
 *
 * Patience is a single budget that **drains across hops** (`docs/matchmaking.md` §Patience budgeting):
 * a wall-clock deadline is fixed at the start, so every walked tier and every hang-out poll consumes
 * the same `patienceMs` — escalation makes the next tier's hang-out progressively less attractive, which
 * is correct since the root is terminal.
 *
 * The transport, clock, sleep, and per-entry verifier are all injected, so the walk unit-tests without a
 * live libp2p stack (mock-tier e2e is a documented follow-on). This client implements the **poll path**
 * only; the arrival-push path (`pushOnArrival`) is a separate slice.
 *
 * Edge cases encoded here (`docs/matchmaking.md` §Edge cases — the rest live in {@link decide}):
 * - **`topicTraffic` absent (case 1):** the cohort is treated as zero-rate; the seeker issues one query
 *   (immediate-match) and walks one tier toward the root **without** hanging out.
 * - **Stale `arrivalsPerMin = 0` after an epoch change (case 2):** never withdraw on a single zero
 *   reading — the immediate `QueryV1` runs first; a cohort that actually holds `>= wantCount` providers
 *   resolves to `done`, and only a query that also yields below threshold escalates.
 * - **`UnwillingCohort`/`UnwillingMember` (case 3):** the hang-out decision is never entered (no
 *   `Accepted`); the walk terminates with whatever matched and standard substrate back-off applies.
 */

import {
	decide,
	filterAcceptRatio,
	matchesFilter,
	newFilterAcceptRatioState,
	observeYield,
	verifyProviderEntry,
	DEFAULT_HANG_OUT_CONFIG,
	DEFAULT_MEAN_WANT_COUNT,
	FILTER_ACCEPT_RATIO_INITIAL,
	type CapabilityFilter,
	type EntrySigVerifier,
	type FilterAcceptRatioState,
	type HangOutConfig,
	type ProviderEntryV1,
	type QueryReplyV1,
} from "@optimystic/db-core";

/** A seeker register/probe reply at a tree tier (the matchmaking-relevant subset of `RegisterReplyV1`). */
export interface SeekerProbeReply {
	readonly result: "accepted" | "no_state" | "promoted" | "unwilling_member" | "unwilling_cohort";
	/** Present on `accepted` and `promoted` (the substrate's barometer); absent triggers edge case 1. */
	readonly topicTraffic?: QueryReplyV1["topicTraffic"];
	/** Present on `promoted` — the tier to descend to. */
	readonly targetTier?: number;
}

/** The substrate seam the walk drives: register/query/renew/withdraw against a tree tier. */
export interface SeekerWalkTransport {
	/** Register (or re-register) the seeker at tree tier `treeTier`; resolves the probe reply. */
	register(treeTier: number): Promise<SeekerProbeReply>;
	/** Issue a `QueryV1` against the cohort the seeker is currently registered with. */
	query(treeTier: number): Promise<QueryReplyV1>;
	/** Renew the live seeker registration (hang-out keep-alive via TTL renewal). */
	renew(): Promise<void>;
	/** Withdraw the seeker registration before escalating (polite `RenewV1` TTL = 0; optional). */
	withdraw(): Promise<void>;
}

/** Construction inputs for {@link SeekerWalkClient}. */
export interface SeekerWalkClientDeps {
	readonly transport: SeekerWalkTransport;
	/** The matchmaking topic id (used to re-validate each forwarded entry's `registrationSig`). */
	readonly topicId: Uint8Array;
	/** Providers the seeker needs. */
	readonly wantCount: number;
	/** The starting tree tier `d_max`. */
	readonly dMax: number;
	/** Total patience budget (ms); drains across hops + hang-out. */
	readonly patienceMs: number;
	/** Optional capability filter (re-applied seeker-side over the returned set). */
	readonly filter?: CapabilityFilter;
	/** Per-entry signature verifier (db-p2p binds `verifyPeerSig`). */
	readonly verifyEntry: EntrySigVerifier;
	/** Hang-out decision config. Default {@link DEFAULT_HANG_OUT_CONFIG}. */
	readonly config?: HangOutConfig;
	/** Assumed competing-seeker mean `wantCount`. Default {@link DEFAULT_MEAN_WANT_COUNT}. */
	readonly meanWantCount?: number;
	/** Starting `filterAcceptRatio` (refined per walk). Default {@link FILTER_ACCEPT_RATIO_INITIAL}. */
	readonly filterAcceptRatioInitial?: number;
	/** Wall clock (unix ms); injectable for tests. Default `Date.now`. */
	readonly clock?: () => number;
	/** Sleep for the requery cadence; injectable for tests. Default a real timer. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/** The result of a completed walk. */
export interface SeekerWalkResult {
	/** Matched, re-validated, deduped providers (up to whatever accumulated; may be `< wantCount`). */
	readonly providers: ProviderEntryV1[];
	/** Whether `wantCount` was met. */
	readonly metWantCount: boolean;
	/** The tier the walk terminated at. */
	readonly terminalTier: number;
	/** Total register hops issued (probes + escalations + descends). */
	readonly hops: number;
	/**
	 * Max `topicTraffic.childCohortCount` observed across every `Accepted` reply this walk saw. `> 0`
	 * means the topic has promoted (it is hot), so the single-cohort sample is unrepresentative — the
	 * public seeker session / voting `QuorumDiscovery` binding uses this to decide whether to escalate to
	 * the multi-cohort sweep (`docs/matchmaking.md` §Multi-cohort sweep).
	 */
	readonly maxChildCohortCount: number;
}

/** Outcome of evaluating one `Accepted` tier. */
type AcceptedOutcome = "done" | "escalate" | "terminal";

/** Drives the seeker hang-out-vs-continue walk for one matchmaking topic. See the module header. */
export class SeekerWalkClient {
	private readonly transport: SeekerWalkTransport;
	private readonly topicId: Uint8Array;
	private readonly wantCount: number;
	private readonly dMax: number;
	private readonly patienceMs: number;
	private readonly filter?: CapabilityFilter;
	private readonly verifyEntry: EntrySigVerifier;
	private readonly config: HangOutConfig;
	private readonly meanWantCount: number;
	private readonly filterAcceptRatioInitial: number;
	private readonly clock: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	/** Matched providers, deduped by `participantId` (a provider seen via two queries counts once). */
	private readonly matched = new Map<string, ProviderEntryV1>();
	private ratioState: FilterAcceptRatioState = newFilterAcceptRatioState();
	private deadline = 0;
	private hops = 0;
	/** Max `childCohortCount` seen across `Accepted` replies — the hot-topic / sweep-escalation signal. */
	private maxChildCohortCount = 0;

	constructor(deps: SeekerWalkClientDeps) {
		this.transport = deps.transport;
		this.topicId = deps.topicId;
		this.wantCount = deps.wantCount;
		this.dMax = deps.dMax;
		this.patienceMs = deps.patienceMs;
		this.filter = deps.filter;
		this.verifyEntry = deps.verifyEntry;
		this.config = deps.config ?? DEFAULT_HANG_OUT_CONFIG;
		this.meanWantCount = deps.meanWantCount ?? DEFAULT_MEAN_WANT_COUNT;
		this.filterAcceptRatioInitial = deps.filterAcceptRatioInitial ?? FILTER_ACCEPT_RATIO_INITIAL;
		this.clock = deps.clock ?? ((): number => Date.now());
		this.sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** Run the walk from `d_max` toward the root; resolves the matched providers + termination info. */
	async run(): Promise<SeekerWalkResult> {
		this.deadline = this.clock() + this.patienceMs;
		let d = this.dMax;

		while (true) {
			this.hops++;
			const reply = await this.transport.register(d);
			switch (reply.result) {
				case "no_state": {
					if (d <= 0) {
						return this.finish(d);
					}
					d -= 1;
					continue;
				}
				case "unwilling_member":
				case "unwilling_cohort": {
					// Substrate-level refusal — never received Accepted, so hang-out is not entered (case 3).
					return this.finish(d);
				}
				case "promoted": {
					const target = reply.targetTier ?? d + 1;
					if (target <= d) {
						return this.finish(d);
					}
					d = target;
					continue;
				}
				case "accepted": {
					const outcome = await this.handleAccepted(d, reply.topicTraffic);
					if (outcome === "done" || outcome === "terminal") {
						return this.finish(d);
					}
					await this.transport.withdraw();
					d -= 1;
					continue;
				}
			}
		}
	}

	/** Remaining patience (ms); the wall-clock deadline drains uniformly across hops + hang-out. */
	private remaining(): number {
		return Math.max(0, this.deadline - this.clock());
	}

	/** Filter, re-validate (`registrationSig`), and dedupe a query reply's providers into {@link matched}. */
	private collect(reply: QueryReplyV1): void {
		const returned = reply.providers ?? [];
		let matchedThisQuery = 0;
		for (const entry of returned) {
			if (!matchesFilter(entry, this.filter)) {
				continue;
			}
			if (!verifyProviderEntry(this.topicId, entry, this.verifyEntry)) {
				continue;
			}
			matchedThisQuery++;
			this.matched.set(entry.participantId, entry);
		}
		this.ratioState = observeYield(this.ratioState, matchedThisQuery, returned.length);
	}

	/** Evaluate one `Accepted` tier: immediate query, then {@link decide} → done / hangOut / escalate. */
	private async handleAccepted(d: number, traffic: SeekerProbeReply["topicTraffic"]): Promise<AcceptedOutcome> {
		// Record the hottest tier seen as soon as this Accepted reply's traffic is available — *before* the
		// immediate-match/done short-circuit below, so the single-cohort-vs-sweep decision (public session /
		// voting QuorumDiscovery binding) still sees a hot topic even when one cohort's query already met
		// wantCount. Folding it only on the `decide` path would drop the signal for a small quorum that a
		// single hot cohort satisfies, leaving the assembler with a prefix-biased sample it should sweep.
		if (traffic !== undefined) {
			this.maxChildCohortCount = Math.max(this.maxChildCohortCount, traffic.childCohortCount);
		}

		// Immediate-match check runs in every case — also satisfies edge case 2 (a stale arrivalsPerMin=0
		// cohort that actually holds enough providers resolves here rather than escalating spuriously).
		this.collect(await this.transport.query(d));
		if (this.matched.size >= this.wantCount) {
			return "done";
		}

		// Edge case 1: a reply without topicTraffic is treated as zero-rate — walk one tier toward the
		// root without hanging out (no estimation against absent inputs).
		if (traffic === undefined) {
			return d <= 0 ? "terminal" : "escalate";
		}

		const decision = decide(
			{
				currentMatches: this.matched.size,
				directParticipants: traffic.directParticipants,
				arrivalsPerMin: traffic.arrivalsPerMin,
				queriesPerMin: traffic.queriesPerMin,
				childCohortCount: traffic.childCohortCount,
				wantCount: this.wantCount,
				patienceMsRemaining: this.remaining(),
				filterAcceptRatio: filterAcceptRatio(this.ratioState, this.filterAcceptRatioInitial),
				meanWantCount: this.meanWantCount,
			},
			this.config,
		);

		if (decision.action === "hangOut") {
			await this.hangOut(d, decision.requeryIntervalMs);
			if (this.matched.size >= this.wantCount) {
				return "done";
			}
			return d <= 0 ? "terminal" : "escalate";
		}

		// escalate — but at the root there is nowhere to walk: hang out the remaining patience, then end.
		if (d <= 0) {
			await this.hangOut(d, this.config.requeryIntervalMs);
			return "terminal";
		}
		return "escalate";
	}

	/** Keep the registration alive and re-query on the poll cadence until `wantCount` met or patience drains. */
	private async hangOut(d: number, requeryIntervalMs: number): Promise<void> {
		while (this.remaining() > 0 && this.matched.size < this.wantCount) {
			await this.sleep(Math.min(requeryIntervalMs, this.remaining()));
			await this.transport.renew();
			this.collect(await this.transport.query(d));
		}
	}

	private finish(terminalTier: number): SeekerWalkResult {
		return {
			providers: [...this.matched.values()],
			metWantCount: this.matched.size >= this.wantCount,
			terminalTier,
			hops: this.hops,
			maxChildCohortCount: this.maxChildCohortCount,
		};
	}
}
