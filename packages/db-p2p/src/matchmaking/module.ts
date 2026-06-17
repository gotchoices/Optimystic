/**
 * Matchmaking — cohesive public module (db-p2p, the cohort-topic-integrated entry points).
 *
 * `docs/matchmaking.md` §Overview / §Configuration names two public roles. This module composes the
 * lower db-core state + db-p2p substrate wiring (managers, seeker walk client, multi-cohort sweep) into
 * those roles, plus the `QuorumDiscovery` binding the voting plan consumes:
 *
 *  - {@link MatchmakingProviderSession} — `register(topic, payload)` / `renew()` / `withdraw()` (plus
 *    `setCapacity` / `signalFull` self-throttling), driving a {@link MatchmakingProvider} through the
 *    {@link MatchmakingProviderManager} at cohort-topic tier **T2**.
 *  - {@link MatchmakingSeekerSession} — `register(topic, payload)` (brief T2 registration), `query(q)`
 *    (one-shot cohort query), and `walk(topic, want)` (the hang-out engine, escalating to the
 *    multi-cohort sweep on a hot topic).
 *  - {@link createMatchmakingQuorumDiscovery} — binds the db-core voting `QuorumDiscovery` port to the
 *    seeker walk (single-cohort) + {@link runMultiCohortSweep} (sweep), so `VotingQuorumAssembler` runs
 *    over real substrate I/O.
 *
 * **Naming note (honest):** the db-core `MatchmakingProvider` / `MatchmakingSeeker` are the
 * transport-free *state + signed-payload builders*; these `*Session` classes are the substrate-wired
 * *public entry points* the doc's `MatchmakingProvider` / `MatchmakingSeeker` sketch refers to. They are
 * named `*Session` to avoid colliding with the re-exported db-core state classes.
 *
 * The substrate I/O is **injected** — the seeker walk transport, the one-shot query, the `d_max`
 * estimate, and the sweep ports are all ports the FRET host binds. The module therefore unit-tests
 * without a live libp2p stack; the mock-tier e2e that drives these against a real promoted tree is a
 * documented follow-on (the same posture as the rest of the subsystem).
 */

import {
	MatchmakingProvider,
	MatchmakingSeeker,
	createMatchTopicAnchor,
	runMultiCohortSweep,
	type MatchTopicAnchor,
	type MatchTopicKind,
	type CohortTopicService,
	type NodeProfile,
	type CapabilityFilter,
	type EntrySigVerifier,
	type HangOutConfig,
	type ProviderEntryV1,
	type QueryReplyV1,
	type QueryV1,
	type MultiCohortSweepPorts,
	type QuorumDiscovery,
	type QuorumDiscoveryRequest,
	type QuorumDiscoverySlice,
} from "@optimystic/db-core";
import { MatchmakingProviderManager } from "./provider-manager.js";
import { MatchmakingSeekerManager } from "./seeker-manager.js";
import { SeekerWalkClient, type SeekerWalkTransport } from "./seeker-walk-client.js";

/** A matchmaking topic reference: `(kind, label)` resolved to `topicId = H(kind ‖ label ‖ "match")`. */
export interface MatchTopicRef {
	readonly kind: MatchTopicKind;
	readonly label: string;
}

// --- provider session ----------------------------------------------------------------------------

/** The provider registration inputs a {@link MatchmakingProviderSession.register} call carries. */
export interface ProviderRegistrationInput {
	readonly capabilities: readonly string[];
	readonly capacityBudget: number;
	readonly contactHint: string;
	readonly serviceUntil?: number;
}

/** Construction inputs for a {@link MatchmakingProviderSession}. */
export interface MatchmakingProviderSessionDeps {
	/** Participant-facing cohort-topic substrate API. */
	readonly service: CohortTopicService;
	/** Sign the provider registration image (db-p2p supplies the libp2p peer key). */
	readonly sign: (payload: Uint8Array) => Promise<string>;
	/** Topic anchor; defaults to db-core's ring-hash anchor. */
	readonly anchor?: MatchTopicAnchor;
	/** Node profile used to derive the provider TTL (Core 90 s / Edge 60 s). */
	readonly profile?: NodeProfile;
	/** Explicit provider TTL (ms); overrides the profile-derived TTL. */
	readonly ttlMs?: number;
	/** CSPRNG source for the provider correlation id (injectable for deterministic tests). */
	readonly randomBytes?: (n: number) => Uint8Array;
}

/**
 * Public provider entry point: registers a {@link MatchmakingProvider} at a topic (cohort-topic T2) and
 * drives its lifecycle. One session owns one live registration; calling {@link register} again
 * re-registers (e.g. at a different topic).
 */
export class MatchmakingProviderSession {
	private readonly deps: MatchmakingProviderSessionDeps;
	private readonly anchor: MatchTopicAnchor;
	private manager?: MatchmakingProviderManager;

	constructor(deps: MatchmakingProviderSessionDeps) {
		this.deps = deps;
		this.anchor = deps.anchor ?? createMatchTopicAnchor();
	}

	/** The live registration handle, or `undefined` before the first {@link register}. */
	get registration(): MatchmakingProviderManager["registration"] {
		return this.manager?.registration;
	}

	/** Register the provider at `topic` with the signed payload, at cohort-topic tier T2. */
	async register(topic: MatchTopicRef, reg: ProviderRegistrationInput): Promise<void> {
		const topicId = this.anchor.topicId(topic.kind, topic.label);
		const provider = new MatchmakingProvider({
			topicId,
			capabilities: reg.capabilities,
			capacityBudget: reg.capacityBudget,
			contactHint: reg.contactHint,
			sign: this.deps.sign,
			...(reg.serviceUntil !== undefined ? { serviceUntil: reg.serviceUntil } : {}),
			...(this.deps.randomBytes !== undefined ? { randomBytes: this.deps.randomBytes } : {}),
		});
		this.manager = new MatchmakingProviderManager({
			service: this.deps.service,
			provider,
			...(this.deps.ttlMs !== undefined ? { ttlMs: this.deps.ttlMs } : {}),
			...(this.deps.profile !== undefined ? { profile: this.deps.profile } : {}),
		});
		await this.manager.register();
	}

	/** Run one renewal cycle (keep-alive). No-op before {@link register}. */
	async renew(): Promise<void> {
		await this.manager?.renew();
	}

	/** Update the live capacity budget and push it by re-registering (`RenewV1` cannot carry a payload). */
	async setCapacity(budget: number): Promise<void> {
		await this.requireManager().setCapacity(budget);
	}

	/** Signal "available but at capacity" (`capacityBudget = 0`) by re-registering. */
	async signalFull(): Promise<void> {
		await this.requireManager().signalFull();
	}

	/** Withdraw (`RenewV1` TTL = 0 — an optimization; the record otherwise TTL-expires). No-op before register. */
	async withdraw(): Promise<void> {
		await this.manager?.withdraw();
	}

	private requireManager(): MatchmakingProviderManager {
		if (this.manager === undefined) {
			throw new Error("MatchmakingProviderSession: register() must precede setCapacity()/signalFull()");
		}
		return this.manager;
	}
}

// --- seeker session ------------------------------------------------------------------------------

/** The seeker registration inputs a {@link MatchmakingSeekerSession.register} call carries. */
export interface SeekerRegistrationInput {
	readonly wantCount: number;
	readonly contactHint: string;
	readonly filter?: CapabilityFilter;
	readonly pushOnArrival?: boolean;
}

/** A {@link MatchmakingSeekerSession.walk} request — the hang-out engine's per-task knobs. */
export interface SeekerWalkRequest {
	readonly wantCount: number;
	readonly patienceMs: number;
	readonly filter?: CapabilityFilter;
	/** Force the multi-cohort sweep even when the single-cohort walk would suffice (representativeness). */
	readonly preferSweep?: boolean;
}

/** The injected substrate-I/O seam a seeker session drives. The FRET host binds these to libp2p RPCs. */
export interface MatchmakingSeekerSessionDeps {
	/** Participant-facing cohort-topic substrate API (seeker registration). */
	readonly service: CohortTopicService;
	/** Sign the seeker registration image. */
	readonly sign: (payload: Uint8Array) => Promise<string>;
	/** Per-entry signature verifier (db-p2p binds `verifyPeerSig`). */
	readonly verifyEntry: EntrySigVerifier;
	/** Topic anchor; defaults to db-core's ring-hash anchor. */
	readonly anchor?: MatchTopicAnchor;
	/** Build the seeker walk transport (register/query/renew/withdraw at a tier) for a topic. */
	readonly walkTransport: (topicId: Uint8Array) => SeekerWalkTransport;
	/** Issue a one-shot `QueryV1` (resolves the cohort from `q.topicId`). */
	readonly queryCohort: (q: QueryV1) => Promise<QueryReplyV1>;
	/** Estimate `d_max` for a topic (the size-estimator seam). */
	readonly estimateDMax: (topicId: Uint8Array) => Promise<number>;
	/** Build the multi-cohort sweep ports for a topic; absent ⇒ the sweep is unavailable (walk only). */
	readonly sweepPorts?: (topicId: Uint8Array) => MultiCohortSweepPorts;
	/** Seeker registration TTL (ms); default {@link MatchmakingSeekerManager}'s seeker TTL. */
	readonly ttlMs?: number;
	/** Hang-out decision config (default {@link import("@optimystic/db-core").DEFAULT_HANG_OUT_CONFIG}). */
	readonly config?: HangOutConfig;
	/** Assumed competing-seeker mean `wantCount`. */
	readonly meanWantCount?: number;
	/** Wall clock (unix ms); injectable for tests. */
	readonly clock?: () => number;
	/** Sleep for the requery cadence; injectable for tests. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Public seeker entry point: brief registration, one-shot query, and the hang-out `walk` (which escalates
 * to the multi-cohort sweep on a hot topic). One session may register and walk independently.
 */
export class MatchmakingSeekerSession {
	private readonly deps: MatchmakingSeekerSessionDeps;
	private readonly anchor: MatchTopicAnchor;
	private manager?: MatchmakingSeekerManager;

	constructor(deps: MatchmakingSeekerSessionDeps) {
		this.deps = deps;
		this.anchor = deps.anchor ?? createMatchTopicAnchor();
	}

	/** Resolve the `topicId` for a topic ref. */
	topicIdFor(topic: MatchTopicRef): Uint8Array {
		return this.anchor.topicId(topic.kind, topic.label);
	}

	/** Register the seeker briefly at `topic` (cohort-topic T2, short TTL). */
	async register(topic: MatchTopicRef, reg: SeekerRegistrationInput): Promise<void> {
		const topicId = this.topicIdFor(topic);
		const seeker = new MatchmakingSeeker({
			topicId,
			wantCount: reg.wantCount,
			contactHint: reg.contactHint,
			sign: this.deps.sign,
			...(reg.filter !== undefined ? { filter: reg.filter } : {}),
			...(reg.pushOnArrival !== undefined ? { pushOnArrival: reg.pushOnArrival } : {}),
		});
		this.manager = new MatchmakingSeekerManager({
			service: this.deps.service,
			seeker,
			...(this.deps.ttlMs !== undefined ? { ttlMs: this.deps.ttlMs } : {}),
		});
		await this.manager.register();
	}

	/** Drop the seeker registration (the cohort soft-state TTL-expires). No-op before register. */
	async withdraw(): Promise<void> {
		await this.manager?.withdraw();
	}

	/** Issue a one-shot `QueryV1` against the topic's cohort (resolved from `q.topicId`). */
	async query(q: QueryV1): Promise<QueryReplyV1> {
		return this.deps.queryCohort(q);
	}

	/**
	 * Run the hang-out walk for `topic`, then — on a hot topic (`childCohortCount > 0`) or when
	 * `preferSweep` is set, and when the sweep ports are bound — escalate to the multi-cohort sweep and
	 * union the deduped providers. Returns the assembled (possibly `< wantCount`) provider set.
	 */
	async walk(topic: MatchTopicRef, want: SeekerWalkRequest): Promise<ProviderEntryV1[]> {
		const topicId = this.topicIdFor(topic);
		const dMax = await this.deps.estimateDMax(topicId);
		const client = new SeekerWalkClient({
			transport: this.deps.walkTransport(topicId),
			topicId,
			wantCount: want.wantCount,
			dMax,
			patienceMs: want.patienceMs,
			verifyEntry: this.deps.verifyEntry,
			...(want.filter !== undefined ? { filter: want.filter } : {}),
			...(this.deps.config !== undefined ? { config: this.deps.config } : {}),
			...(this.deps.meanWantCount !== undefined ? { meanWantCount: this.deps.meanWantCount } : {}),
			...(this.deps.clock !== undefined ? { clock: this.deps.clock } : {}),
			...(this.deps.sleep !== undefined ? { sleep: this.deps.sleep } : {}),
		});
		const result = await client.run();
		const providers = new Map<string, ProviderEntryV1>(result.providers.map((p) => [p.participantId, p]));

		const hot = result.maxChildCohortCount > 0;
		const wantSweep = want.preferSweep === true || (hot && providers.size < want.wantCount);
		if (wantSweep && this.deps.sweepPorts !== undefined) {
			// Pass want.patienceMs as a fresh (coarser) bound — this path does not track a draining
			// remainder (SeekerWalkClient ran on its own deadline). Still strictly better than unbounded.
			const sweep = await runMultiCohortSweep(this.deps.sweepPorts(topicId), {
				topicId,
				wantCount: want.wantCount,
				verifyEntry: this.deps.verifyEntry,
				patienceMs: want.patienceMs,
				...(want.filter !== undefined ? { filter: want.filter } : {}),
				...(this.deps.clock !== undefined ? { clock: this.deps.clock } : {}),
			});
			for (const entry of sweep.providers) {
				providers.set(entry.participantId, entry);
			}
		}
		return [...providers.values()];
	}
}

// --- voting quorum-discovery binding -------------------------------------------------------------

/** Construction inputs for {@link createMatchmakingQuorumDiscovery}. */
export interface MatchmakingQuorumDiscoveryDeps {
	/** Per-entry signature verifier (db-p2p binds `verifyPeerSig`). */
	readonly verifyEntry: EntrySigVerifier;
	/** Build the seeker walk transport for a topic. */
	readonly walkTransport: (topicId: Uint8Array) => SeekerWalkTransport;
	/** Estimate `d_max` for a topic. */
	readonly estimateDMax: (topicId: Uint8Array) => Promise<number>;
	/** Build the multi-cohort sweep ports for a topic. */
	readonly sweepPorts: (topicId: Uint8Array) => MultiCohortSweepPorts;
	/** Optional capability filter applied to both the walk and the sweep. */
	readonly filter?: CapabilityFilter;
	/** Hang-out decision config (passed to the walk). */
	readonly config?: HangOutConfig;
	/** Assumed competing-seeker mean `wantCount` (passed to the walk). */
	readonly meanWantCount?: number;
	/** Wall clock (unix ms); injectable for tests. */
	readonly clock?: () => number;
	/** Sleep for the requery cadence; injectable for tests. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Bind the db-core voting {@link QuorumDiscovery} port (`docs/matchmaking.md` §Voting-quorum assembly)
 * to the matchmaking substrate: `walk` runs the single-cohort hang-out walk and surfaces its hotness
 * signal (`childCohortCount`); `sweep` runs {@link runMultiCohortSweep} across the high-population tier
 * shards. `VotingQuorumAssembler` composes the two — walk, then sweep on a hot topic — re-validating
 * every entry itself, so this binding stays a thin transport adapter.
 */
export function createMatchmakingQuorumDiscovery(deps: MatchmakingQuorumDiscoveryDeps): QuorumDiscovery {
	return {
		async walk(req: QuorumDiscoveryRequest): Promise<QuorumDiscoverySlice> {
			const dMax = await deps.estimateDMax(req.topicId);
			const client = new SeekerWalkClient({
				transport: deps.walkTransport(req.topicId),
				topicId: req.topicId,
				wantCount: req.wantCount,
				dMax,
				patienceMs: req.patienceMs,
				verifyEntry: deps.verifyEntry,
				...(deps.filter !== undefined ? { filter: deps.filter } : {}),
				...(deps.config !== undefined ? { config: deps.config } : {}),
				...(deps.meanWantCount !== undefined ? { meanWantCount: deps.meanWantCount } : {}),
				...(deps.clock !== undefined ? { clock: deps.clock } : {}),
				...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
			});
			const result = await client.run();
			return { entries: result.providers, childCohortCount: result.maxChildCohortCount };
		},
		async sweep(req: QuorumDiscoveryRequest): Promise<QuorumDiscoverySlice> {
			const result = await runMultiCohortSweep(deps.sweepPorts(req.topicId), {
				topicId: req.topicId,
				wantCount: req.wantCount,
				verifyEntry: deps.verifyEntry,
				patienceMs: req.patienceMs,
				...(deps.filter !== undefined ? { filter: deps.filter } : {}),
				...(deps.clock !== undefined ? { clock: deps.clock } : {}),
			});
			// The sweep hop has already crossed the ring — its childCohortCount is moot (the escalation
			// decision is made). Report 0 so the assembler never double-escalates.
			return { entries: result.providers, childCohortCount: 0 };
		},
	};
}
