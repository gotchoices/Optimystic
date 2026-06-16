/**
 * Matchmaking — voting-quorum assembler (db-core, discovery-only composition).
 *
 * The voting subsystem's **discovery** flow, built as a thin composition over the matchmaking module
 * (`docs/matchmaking.md` §Voting-quorum assembly). Matchmaking already provides "find the peers": the
 * stable {@link import("./topic-anchor.js").MatchTopicAnchor}, the signed provider registration
 * ({@link MatchmakingProvider}), the single-cohort hang-out walk and the hot-topic multi-cohort sweep,
 * and the reply-side per-entry `registrationSig` re-validation ({@link verifyProviderEntry}). This
 * module adds the small amount of glue that turns that surface into "assemble a quorum of eligible
 * voters for proposal `P`".
 *
 * **No matchmaking wire-protocol change is introduced.** The genuinely voting-layer pieces are injected
 * or left out of scope entirely:
 *
 * - **Eligibility proof minting** — the caller mints an opaque proof (a signature over the proposal from
 *   a stake-bearing key, etc.) and supplies the {@link VotingQuorumRequest.verifyEligibility} predicate
 *   over it. Matchmaking treats the proof as opaque bytes carried in the provider's `capabilities`.
 * - **The quorum selection rule** (random sample, stake-weighted, geographic) — injected via
 *   {@link VotingQuorumRequest.select}; the default is first-`targetSize`.
 * - **Ballots, tally, dispute, ballot privacy** — out of scope; a separate forthcoming voting doc.
 *
 * ## Resolved design decisions (`docs/matchmaking.md` §Voting-quorum assembly)
 *
 * 1. **Reply-side per-entry verification is the default and required path; a client-side reputation
 *    pre-filter is optional and additive.** Quorum-assembly *liveness* must never depend on
 *    reputation-subsystem *availability*, so reputation is an optimization, never a dependency.
 *    Matchmaking forwards each entry's `registrationSig` plus the eligibility proof in `capabilities`,
 *    so reply-side verification is effectively free; the cohort returns ineligible entries the
 *    coordinator discards (bandwidth bounded by `query_limit_max × swept-cohort-count`).
 * 2. **Flash-vote fairness among competing coordinators is a voting-layer concern; no matchmaking signal
 *    is added.** Matchmaking returns an advisory *candidate set*, never an allocation — overlapping sets
 *    are expected and quorum non-collision is decided by the voting protocol.
 * 3. **No matchmaking protocol additions are needed.** `AggregateCountV1` is threshold-signed (an
 *    attested *registered*-provider count); an attested *eligible*-voter count, if voting needs one, is a
 *    voting-layer aggregate computed after discovery+verification, not a matchmaking message.
 * 4. **Quorum-assembler delegation.** The seeker role may be held by the coordinator itself or by a
 *    delegated assembler peer; whoever holds it owns `patienceMs` and the reply-side re-validation duty.
 *    A delegated assembler returns an already-validated {@link ProviderEntryV1}`[]`; because every entry
 *    carries `registrationSig` + the proof in `capabilities`, the set is independently checkable, so the
 *    coordinator MAY re-validate (trust-but-verify) on receipt by re-running the verify→select pipeline.
 *
 * ## Architecture seam
 *
 * db-core is transport-free, so the actual discovery I/O (the register/query/renew walk, the root
 * `AggregateCountV1` sweep) is **injected** as a {@link QuorumDiscovery} port — exactly as the seeker
 * walk client and entry verifier are injected elsewhere in this module. db-p2p binds the port to
 * `MatchmakingSeeker.walk` (single-cohort) and `multi-cohort-seeker` (sweep). The assembler itself never
 * dials voters, never collects ballots, never tallies.
 */

import { createMatchTopicAnchor, type MatchTopicAnchor } from "./topic-anchor.js";
import { MatchmakingProvider } from "./provider.js";
import { verifyProviderEntry, type ProviderEntryV1, type EntrySigVerifier } from "./wire.js";

/** Default concurrent-vote-collection budget for a registered voter — accepts one vote-collection RPC. */
export const DEFAULT_VOTER_CAPACITY_BUDGET = 1;

/**
 * Indicative `patienceMs` range for voting-quorum assembly (`docs/matchmaking.md` §Patience budgeting).
 * Advisory only — the layer does not dictate; {@link VotingQuorumAssembler.assembleQuorum} requires a
 * positive budget but does not clamp to this window.
 */
export const VOTING_PATIENCE_MIN_MS = 30_000;
export const VOTING_PATIENCE_MAX_MS = 300_000;

/**
 * Reserved capability-tag prefix carrying a voter's opaque eligibility proof. The proof is bound into the
 * provider `capabilities`, which {@link import("./wire.js").providerSigningPayload} covers, so the
 * provider's `registrationSig` attests the proof verbatim. The caller's `verifyEligibility` predicate
 * reads it back from the forwarded entry via {@link eligibilityProofOf}.
 */
export const ELIGIBILITY_TAG_PREFIX = "voter-eligibility:";

/** Encode an opaque eligibility proof as the reserved capability tag. */
export function eligibilityTag(proof: string): string {
	return ELIGIBILITY_TAG_PREFIX + proof;
}

/** Extract the eligibility proof from a capability set, or `undefined` if no eligibility tag is present. */
export function eligibilityProofFromCapabilities(capabilities: readonly string[]): string | undefined {
	const tag = capabilities.find((c) => c.startsWith(ELIGIBILITY_TAG_PREFIX));
	return tag === undefined ? undefined : tag.slice(ELIGIBILITY_TAG_PREFIX.length);
}

/** Extract the eligibility proof carried by a forwarded {@link ProviderEntryV1} (`undefined` if absent). */
export function eligibilityProofOf(entry: ProviderEntryV1): string | undefined {
	return eligibilityProofFromCapabilities(entry.capabilities);
}

// --- discovery seam (satisfied by MatchmakingSeeker.walk + multi-cohort-seeker, wired in db-p2p) ---

/** One discovery slice: candidate entries plus the hotness signal that drives the single-vs-sweep choice. */
export interface QuorumDiscoverySlice {
	/** Candidate provider entries returned by this discovery hop (advisory — the assembler re-verifies). */
	readonly entries: readonly ProviderEntryV1[];
	/**
	 * Max `topicTraffic.childCohortCount` observed across the walked tiers. `> 0` means the topic has
	 * promoted (it is hot), so a single-cohort sample is unrepresentative and the assembler escalates to
	 * the multi-cohort sweep. The sweep hop sets this to `0` (the decision is already made).
	 */
	readonly childCohortCount: number;
}

/** Inputs to one discovery hop. */
export interface QuorumDiscoveryRequest {
	/** The quorum topic id (`H("quorum" ‖ proposalHash ‖ "match")`). */
	readonly topicId: Uint8Array;
	/** Providers desired (drives the hang-out feasibility math / how many shards the sweep unions). */
	readonly wantCount: number;
	/** Patience budget remaining for this hop (ms); drains across walk → sweep. */
	readonly patienceMs: number;
}

/**
 * The discovery surface {@link VotingQuorumAssembler} composes over. db-p2p binds:
 * - {@link QuorumDiscovery.walk} → `MatchmakingSeeker.walk` (single-cohort hang-out walk), and
 * - {@link QuorumDiscovery.sweep} → `multi-cohort-seeker` (root `AggregateCountV1` → tier shards union).
 *
 * Both surface already-deduped, `registrationSig`-validated entries in production; the assembler treats
 * them as advisory candidates and re-validates regardless, which keeps the delegated-assembler
 * (trust-but-verify) path and the mock-tier test fixtures honest.
 */
export interface QuorumDiscovery {
	/** Single-cohort hang-out walk; returns matched candidates plus the observed hotness signal. */
	walk(req: QuorumDiscoveryRequest): Promise<QuorumDiscoverySlice>;
	/** Multi-cohort sweep across high-population tier shards; returns the unioned candidate slice. */
	sweep(req: QuorumDiscoveryRequest): Promise<QuorumDiscoverySlice>;
}

// --- request / result ---

/** A request to assemble a voting quorum for one proposal. All voting-layer policy is injected here. */
export interface VotingQuorumRequest {
	/** The proposal hash — the quorum topic's label. */
	readonly proposalHash: string;
	/** Desired quorum size (integer `>= 1`). */
	readonly targetSize: number;
	/** Patience budget (ms); positive. Voting range is 30–300 s (§Patience budgeting), advisory. */
	readonly patienceMs: number;
	/** Voting/stake-layer eligibility predicate over the opaque proof in an entry's `capabilities`. */
	readonly verifyEligibility: (entry: ProviderEntryV1) => boolean;
	/** Voting-layer quorum selection rule; default = first `targetSize`. Must choose from the input set. */
	readonly select?: (eligible: ProviderEntryV1[], targetSize: number) => ProviderEntryV1[];
	/** Optional, additive reputation pre-filter applied *before* verification to trim candidates. */
	readonly reputationPrefilter?: (candidates: ProviderEntryV1[]) => ProviderEntryV1[];
	/** Force the multi-cohort sweep even when a single-cohort walk would suffice (representativeness). */
	readonly preferSweep?: boolean;
}

/** The outcome of {@link VotingQuorumAssembler.assembleQuorum}. */
export interface VotingQuorumResult {
	/** The selected, eligibility-verified quorum, deduped by `participantId`. */
	readonly quorum: ProviderEntryV1[];
	/** Distinct candidates discovery surfaced (after dedup, before eligibility filtering). */
	readonly candidates: number;
	/** Candidates that passed `registrationSig` re-validation **and** `verifyEligibility`. */
	readonly eligible: number;
	/** Whether the assembled quorum met `targetSize` (`quorum.length >= targetSize`). */
	readonly metTarget: boolean;
	/** Whether the multi-cohort sweep was used (hot topic or `preferSweep`). */
	readonly swept: boolean;
}

/** Construction inputs for a {@link VotingQuorumAssembler}; deps are per-role and validated at call time. */
export interface VotingQuorumAssemblerDeps {
	/** Stable topic anchor; defaults to db-core's ring-hash anchor ({@link createMatchTopicAnchor}). */
	readonly anchor?: MatchTopicAnchor;
	/** Discovery surface (walk + sweep) — required by {@link VotingQuorumAssembler.assembleQuorum}. */
	readonly discovery?: QuorumDiscovery;
	/**
	 * Per-entry `registrationSig` verifier (db-p2p binds `verifyPeerSig`) — required by
	 * {@link VotingQuorumAssembler.assembleQuorum}. db-core is crypto-free, so the peer-key check is
	 * injected, matching {@link verifyProviderEntry}'s contract.
	 */
	readonly verifyEntrySig?: EntrySigVerifier;
	/** Sign a provider registration image — required by {@link VotingQuorumAssembler.registerEligibleVoter}. */
	readonly sign?: (payload: Uint8Array) => Promise<string>;
	/**
	 * Register a signed voter-provider payload at the quorum topic (cohort-topic T2) — required by
	 * {@link VotingQuorumAssembler.registerEligibleVoter}. db-p2p binds this to the provider manager /
	 * `MatchmakingProvider.register` once `matchmaking-sweep-adversarial-module` lands.
	 */
	readonly registerProvider?: (req: RegisterVoterProviderRequest) => Promise<void>;
	/** CSPRNG source for the provider correlation id (injectable for deterministic tests). */
	readonly randomBytes?: (n: number) => Uint8Array;
	/** Wall clock (unix ms), injectable for tests; default `Date.now`. Splits patience across walk → sweep. */
	readonly clock?: () => number;
}

/** What {@link VotingQuorumAssembler.registerEligibleVoter} hands the injected `registerProvider` port. */
export interface RegisterVoterProviderRequest {
	/** The quorum topic id this voter registers at. */
	readonly topicId: Uint8Array;
	/** The opaque, signed cohort-topic `RegisterV1.appPayload` bytes for the voter provider. */
	readonly appPayloadBytes: Uint8Array;
}

/** Construction inputs for {@link VotingQuorumAssembler.registerEligibleVoter}. */
export interface RegisterEligibleVoterRequest {
	/** The proposal hash — the quorum topic's label. */
	readonly proposalHash: string;
	/** base64url, app-defined eligibility proof minted by the voting/stake layer. */
	readonly eligibilityProof: string;
	/** Extra application capability tags merged into the registration (the proof tag is always added). */
	readonly capabilityTags?: readonly string[];
	/** Concurrent vote-collection budget; default {@link DEFAULT_VOTER_CAPACITY_BUDGET} (1). */
	readonly capacityBudget?: number;
	/** Multiaddr or PeerId-based callback for the vote-collection dial. */
	readonly contactHint: string;
	/** Optional soft expiry hint (unix ms). */
	readonly serviceUntil?: number;
}

/**
 * Discovery-only voting-quorum assembler over the matchmaking module. One instance can act in either
 * role: a voter calls {@link registerEligibleVoter}; a coordinator (or delegated assembler) calls
 * {@link assembleQuorum}. Deps are role-specific and asserted per method, so a coordinator need not
 * supply `sign`/`registerProvider` and a voter need not supply `discovery`/`verifyEntrySig`.
 */
export class VotingQuorumAssembler {
	private readonly anchor: MatchTopicAnchor;
	private readonly deps: VotingQuorumAssemblerDeps;
	private readonly clock: () => number;

	constructor(deps: VotingQuorumAssemblerDeps = {}) {
		this.deps = deps;
		this.anchor = deps.anchor ?? createMatchTopicAnchor();
		this.clock = deps.clock ?? ((): number => Date.now());
	}

	/**
	 * The quorum topic anchor for a proposal: `kind = "quorum"`, `label = proposalHash`, yielding
	 * `topicId = H("quorum" ‖ proposalHash ‖ "match")` via the matchmaking topic anchor.
	 */
	static quorumTopic(proposalHash: string): { kind: "quorum"; label: string } {
		return { kind: "quorum", label: proposalHash };
	}

	/** Resolve the cohort-topic `topicId` for a proposal's quorum topic. */
	topicIdFor(proposalHash: string): Uint8Array {
		const { kind, label } = VotingQuorumAssembler.quorumTopic(proposalHash);
		return this.anchor.topicId(kind, label);
	}

	/**
	 * Voter side: bind the caller-minted eligibility proof into `capabilities`, build the signed provider
	 * registration, and register it at the quorum topic (cohort-topic T2). The proof is opaque to
	 * matchmaking; the provider `signature` covers `(topicId, capabilities, capacityBudget)`, so it binds
	 * the proof to the registration.
	 */
	async registerEligibleVoter(req: RegisterEligibleVoterRequest): Promise<void> {
		const sign = this.requireSign();
		const registerProvider = this.requireRegisterProvider();
		const topicId = this.topicIdFor(req.proposalHash);
		const capacityBudget = req.capacityBudget ?? DEFAULT_VOTER_CAPACITY_BUDGET;
		const capabilities = mergeEligibilityCapabilities(req.capabilityTags ?? [], req.eligibilityProof);

		const provider = new MatchmakingProvider({
			topicId,
			capabilities,
			capacityBudget,
			contactHint: req.contactHint,
			sign,
			...(req.serviceUntil !== undefined ? { serviceUntil: req.serviceUntil } : {}),
			...(this.deps.randomBytes !== undefined ? { randomBytes: this.deps.randomBytes } : {}),
		});

		await registerProvider({ topicId, appPayloadBytes: await provider.appPayloadBytes() });
	}

	/**
	 * Coordinator / delegated-assembler side: discover → verify → select. Drives the single-cohort walk,
	 * escalates to the multi-cohort sweep on a hot topic (`childCohortCount > 0`) or when `preferSweep`,
	 * dedups by `participantId`, applies the optional reputation pre-filter, re-validates each entry's
	 * `registrationSig` **and** `verifyEligibility`, then applies the selection rule. Passes the *draining*
	 * patience budget to each discovery hop (walk, then sweep) — the deadline is fixed at entry and each
	 * hop receives the remaining slice — and on exhaustion returns whatever matched with `metTarget = false`.
	 * (Honouring that budget is the port's duty: the single-cohort walk enforces it; the multi-cohort sweep
	 * leg is currently bounded by its shard fan-out rather than the budget — see the sweep-patience follow-up.)
	 */
	async assembleQuorum(req: VotingQuorumRequest): Promise<VotingQuorumResult> {
		const discovery = this.requireDiscovery();
		const verifyEntrySig = this.requireVerifyEntrySig();
		const targetSize = requireTargetSize(req.targetSize);
		requirePositivePatience(req.patienceMs);
		const topicId = this.topicIdFor(req.proposalHash);

		const deadline = this.clock() + req.patienceMs;
		const remaining = (): number => Math.max(0, deadline - this.clock());

		// Step 2: single-cohort walk, then the single-vs-sweep decision.
		const walkSlice = await discovery.walk({ topicId, wantCount: targetSize, patienceMs: remaining() });
		const swept = req.preferSweep === true || walkSlice.childCohortCount > 0;
		const slices: QuorumDiscoverySlice[] = [walkSlice];
		if (swept) {
			slices.push(await discovery.sweep({ topicId, wantCount: targetSize, patienceMs: remaining() }));
		}

		// Step 3: dedup the unioned candidate set by participantId (defensive — promotion/redirect overlap).
		const candidates = dedupByParticipant(slices.flatMap((s) => [...s.entries]));

		// Step 4: optional, additive reputation pre-filter (bandwidth/quality trim; never a dependency).
		const prefiltered = req.reputationPrefilter ? req.reputationPrefilter([...candidates]) : candidates;

		// Step 5: reply-side default — both registrationSig re-validation AND verifyEligibility must pass.
		const eligible = prefiltered.filter(
			(entry) => verifyProviderEntry(topicId, entry, verifyEntrySig) && req.verifyEligibility(entry),
		);

		// Step 6: selection rule (default first targetSize), deduped defensively.
		const select = req.select ?? defaultSelect;
		const quorum = dedupByParticipant(select([...eligible], targetSize));

		return {
			quorum,
			candidates: candidates.length,
			eligible: eligible.length,
			metTarget: quorum.length >= targetSize,
			swept,
		};
	}

	private requireDiscovery(): QuorumDiscovery {
		if (this.deps.discovery === undefined) {
			throw new Error("VotingQuorumAssembler.assembleQuorum requires a `discovery` dependency");
		}
		return this.deps.discovery;
	}

	private requireVerifyEntrySig(): EntrySigVerifier {
		if (this.deps.verifyEntrySig === undefined) {
			throw new Error("VotingQuorumAssembler.assembleQuorum requires a `verifyEntrySig` dependency");
		}
		return this.deps.verifyEntrySig;
	}

	private requireSign(): (payload: Uint8Array) => Promise<string> {
		if (this.deps.sign === undefined) {
			throw new Error("VotingQuorumAssembler.registerEligibleVoter requires a `sign` dependency");
		}
		return this.deps.sign;
	}

	private requireRegisterProvider(): (req: RegisterVoterProviderRequest) => Promise<void> {
		if (this.deps.registerProvider === undefined) {
			throw new Error("VotingQuorumAssembler.registerEligibleVoter requires a `registerProvider` dependency");
		}
		return this.deps.registerProvider;
	}
}

/** The default selection rule: take the first `targetSize` eligible entries (the discovery order). */
export function defaultSelect(eligible: ProviderEntryV1[], targetSize: number): ProviderEntryV1[] {
	return eligible.slice(0, targetSize);
}

/**
 * Merge application capability tags with the eligibility proof tag: drop any caller-supplied tag that
 * already uses the reserved prefix (the proof is authoritative), then append exactly one proof tag.
 * Order is preserved end-to-end (the cohort forwards `capabilities` verbatim), so the provider signature
 * reconstructs byte-for-byte on the seeker side.
 */
function mergeEligibilityCapabilities(tags: readonly string[], proof: string): string[] {
	const appTags = tags.filter((tag) => !tag.startsWith(ELIGIBILITY_TAG_PREFIX));
	return [...appTags, eligibilityTag(proof)];
}

/** Dedup entries by `participantId`, keeping the first occurrence (preserves discovery/FCFS order). */
function dedupByParticipant(entries: readonly ProviderEntryV1[]): ProviderEntryV1[] {
	const seen = new Map<string, ProviderEntryV1>();
	for (const entry of entries) {
		if (!seen.has(entry.participantId)) {
			seen.set(entry.participantId, entry);
		}
	}
	return [...seen.values()];
}

/** Validate `targetSize` is an integer `>= 1`. */
function requireTargetSize(targetSize: number): number {
	if (!Number.isInteger(targetSize) || targetSize < 1) {
		throw new RangeError(`voting quorum: targetSize must be an integer >= 1, got ${targetSize}`);
	}
	return targetSize;
}

/** Validate `patienceMs` is a finite number `> 0` (the voting 30–300 s range is advisory, not enforced). */
function requirePositivePatience(patienceMs: number): number {
	if (!Number.isFinite(patienceMs) || patienceMs <= 0) {
		throw new RangeError(`voting quorum: patienceMs must be a finite number > 0, got ${patienceMs}`);
	}
	return patienceMs;
}
