/**
 * Cohort-topic FRET host (`docs/cohort-topic.md` §FRET integration L768-803).
 *
 * Composes the db-core substrate (participant-facing {@link CohortTopicService} + cohort-side
 * {@link CohortMemberEngine}) over the FRET + libp2p ports and runs it as a service on one node:
 *
 * - registers the four `/optimystic/cohort-topic/1.0.0/*` protocols on the libp2p node;
 * - sets FRET's activity handler so a `RouteAndMaybeAct`-routed `RegisterV1` runs the cohort decision;
 * - binds the db-core ports to the FRET-backed adapters (router, gossip, membership, size estimator).
 *
 * **Per-served-coord scoping.** A topic's responsible cohort sits at `coord_0(_, topicId)` (and at
 * `coord_d(P, topicId)` for `d ≥ 1`), which is unrelated to any node's own ring position. A node
 * genuinely belongs to *many* cohorts — one per coord FRET routes to it — so this host keeps a lazy
 * {@link CoordRegistry}: a `Map<servedCoord, CoordEngine>` where each {@link CoordEngine} owns the
 * per-coord slice of state (its own store, gossip bus, willingness/traffic/renewal/cold-start, a
 * {@link PromotionLifecycle} with coord-derived tier inputs, a {@link CohortMemberEngine}, its own
 * {@link MembershipCertPublisher}, and its own real `k − x` threshold signer) and threshold-signs with
 * the FRET cohort *around the served coord*. The node-wide collaborators (`hash`, `slots`, `barometer`,
 * the FRET ports, the participant-facing service, and the verify-only verifier signer) stay singletons
 * and are injected into each engine. The host recomputes the served coord from each decoded `RegisterV1`
 * (`addressing.coord(treeTier, participantCoord, topicId)`), so both the activity callback and the direct
 * `register` protocol handler dispatch to the right cohort.
 *
 * **Real threshold signatures.** Each coord engine assembles a genuine `k − x` cohort signature
 * (a collected per-member Ed25519 multisig) over the new `/sign` protocol — see
 * {@link FretCohortThresholdCrypto} — and drives a {@link MembershipCertPublisher}, so a remote
 * `MembershipVerifier` can verify the served `MembershipCertV1` for real. Assembly needs the node's
 * `options.privateKey`; key-less hosts compose but cannot threshold-sign (the publisher/promotion paths
 * are simply not driven). The periodic membership refresh is exposed as the per-engine
 * {@link CoordEngine.pumpMembership} / {@link CoordEngine.onStabilized} hooks for the gossip-cadence
 * driver to call.
 *
 * **Anti-DoS + cold-start (gaps 6–7).** Each {@link CoordEngine} is injected its own per-coord anti-DoS
 * guards — a `RegisterRateLimiter` (4/min per peer-topic), a `CorrelationReplayGuard` (60 s freshness),
 * and a `TopicBudget` (2048 topics, LRU) — so a budget/limit at one coord is independent of another. The
 * node-level {@link BootstrapEvidence} policy (one tier→verifier policy, no per-coord state) is built once
 * and shared. db-core embeds no PoW / reputation scheme, so the host supplies the real verifiers
 * ({@link createPoWVerifier} / {@link createReputationVerifier}) and the participant-side PoW minter
 * ({@link createBootstrapEvidenceBuilder}): once configured, a node gates cold-root `bootstrap: true` at
 * T2/T3 (PoW, or a referee reputation endorsement when offered, or a signed parent reference) and at T0/T1
 * once a committed-existence backing is wired (a signed parent reference); a configured node with no such
 * backing keeps T0/T1 permissive-but-logged so cold-root origination is not blocked
 * (`cohort-topic-bootstrap-coldstart-origination-regression`), and an entirely unconfigured host stays
 * permissive-but-logged at every tier (never an undefined gate). A cold-started tier-`d > 0` forwarder registers with
 * its tier-`(d − 1)` parent by routing a forwarder-link frame over the router (gap 7), staying
 * `awaiting_parent` until the ack.
 *
 * **Scope.** `followOn` derivation for a promoted-redirect arrival is parked in backlog
 * (`cohort-topic-followon-derivation`); this milestone serves a **single tier-0 cohort**, so `followOn`
 * stays `false` and tier-0 bootstrap instantiation goes through the `bootstrap: true` path. The
 * behavioral substrate is validated at mock-tier by `test/cohort-topic/service.spec.ts` and end-to-end
 * across a real multi-node cohort (real Ed25519 keys, mock transport routing the five protocols + FRET
 * `routeAct`/`assembleCohort`) by `test/cohort-topic/live-tier.spec.ts`.
 */

import type { Libp2p } from "libp2p";
import type { Connection, PeerId, PrivateKey, Stream } from "@libp2p/interface";
import type { FretService } from "p2p-fret";
import { hashPeerId, readAllBounded } from "p2p-fret";
import {
	RingHash,
	createRegistrationStore,
	createSlotAssigner,
	createCohortGossipBus,
	createWillingnessCheck,
	createPromotionLifecycle,
	createColdStartManager,
	createTrafficCounters,
	createRenewalCohortSide,
	createMembershipVerifier,
	createMembershipSourceRouter,
	createMembershipCertPublisher,
	createCohortSigner,
	createCohortMemberEngine,
	createCohortTopicService,
	createLoadBarometer,
	createTierAddressing,
	createRegisterRateLimiter,
	createCorrelationReplayGuard,
	createTopicBudget,
	createBootstrapEvidence,
	LruMap,
	coreProfile,
	DEFAULT_MIN_SIGS,
	DEFAULT_MAX_NO_POW_TIER,
	DEFAULT_TRAFFIC_WINDOW_SECONDS,
	DEFAULT_TTL_MS,
	bytesToB64url,
	b64urlToBytes,
	bytesEqual,
	encodeCohortMessage,
	decodeCohortMessage,
	decodeCohortGossipV1,
	membershipCertSignable,
	membershipCertSigningPayload,
	toCohortTopicSummary,
	validateRegisterV1,
	validateRenewV1,
	validateSignRequestV1,
	validateSignReplyV1,
	validatePromotionNoticeV1,
	validateDemotionNoticeV1,
	registerSigningPayload,
	renewSigningPayload,
	cohortGossipSigningPayload,
	promotionNoticeSigningPayload,
	demotionNoticeSigningPayload,
	type BootstrapEvidence,
	type BootstrapEvidenceDeps,
	type CohortGossipV1,
	type CohortGossipSignable,
	type CohortTopicService,
	type CohortMemberEngine,
	type CohortSnapshot,
	type CohortSnapshotView,
	type CohortSigner,
	type CohortView,
	type CorrelationReplayGuardConfig,
	type DemotionNoticeV1,
	type Forwarder,
	type ITopicRouter,
	type MembershipCertPublisher,
	type MembershipCertV1,
	type MembershipVerifier,
	type NodeProfile,
	type ParticipantSigner,
	type PromotionConfig,
	type PromotionNoticeV1,
	type RegisterRateLimiter,
	type RegisterRateLimiterConfig,
	type RegisterReplyV1,
	type RegisterV1,
	type RegistrationRecord,
	type RenewReplyV1,
	type RenewV1,
	type RingCoord,
	type RotationAttestation,
	type SignKind,
	type SignReplyV1,
	type SignRequestV1,
	type Tier,
	type TopicBudgetConfig,
	type TopicTrafficV1,
	type IMembershipSource,
	type TrustRoot,
} from "@optimystic/db-core";
import { randomBytes } from "@libp2p/crypto";
import { peerIdFromString } from "@libp2p/peer-id";
import { FretTopicRouter } from "./topic-router.js";
import { FretCohortGossipTransport, type CohortPeerResolver } from "./cohort-gossip-transport.js";
import { buildCohortGossip, createPendingDeltas, DEFAULT_GOSSIP_INTERVAL_MS, DEFAULT_WILLINGNESS_HEARTBEAT_MS } from "./cohort-gossip-driver.js";
import { FretMembershipSource } from "./membership-source.js";
import { FretMembershipPublishSink } from "./membership-publish-sink.js";
import { FretCohortThresholdCrypto, createVerifyOnlyThresholdCrypto } from "./threshold-crypto.js";
import { FretTrustAnchor } from "./fret-trust-anchor.js";
import { FretSizeEstimator } from "./size-estimator.js";
import { peerIdToBytes, bytesToPeerIdString } from "./peer-codec.js";
import { signPeer, verifyPeerSig } from "./peer-sig.js";
import { createPoWVerifier, createReputationVerifier, type BootstrapReputationView } from "./bootstrap-evidence-verifiers.js";
import { createParentReferenceVerifier, createDefaultParentTopicView, type BootstrapParentTopicView } from "./bootstrap-parent-reference.js";
import { createBootstrapEvidenceBuilder } from "./bootstrap-evidence-builder.js";
import { DEFAULT_COHORT_TOPIC_PROTOCOLS, cohortTopicProtocolList, type CohortTopicProtocols } from "./protocols.js";
import { requestResponse, DEFAULT_STREAM_MAX_BYTES } from "./stream-util.js";
import { createLogger } from "../logger.js";

const log = createLogger("cohort-topic");

export interface CohortTopicHostOptions {
	/** Per-node tier profile. Default {@link coreProfile}. */
	readonly profile?: NodeProfile;
	/** Network name (namespaces the four protocol IDs); default uses the canonical IDs. */
	readonly protocols?: CohortTopicProtocols;
	/** Requested cohort size `wantK`. Default 16. */
	readonly wantK?: number;
	/** Threshold signers `minSigs = k − x`. Default {@link DEFAULT_MIN_SIGS}. */
	readonly minSigs?: number;
	/** Fan-out per tier `F`. Default 16. */
	readonly fanout?: number;
	/** Per-frame ceiling. Default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
	/**
	 * Gossip-round cadence in ms (the periodic driver tick). Default {@link DEFAULT_GOSSIP_INTERVAL_MS}
	 * (~one round). Each tick drives every live {@link CoordEngine}'s gossip broadcast, TTL sweep,
	 * membership-cert refresh, and demotion check; the refresh (5 min) and demotion hysteresis (5 min)
	 * self-gate on elapsed time, so a fast tick is safe.
	 */
	readonly gossipIntervalMs?: number;
	/**
	 * `T_willingness_heartbeat` (ms): how often a genuinely-**idle but willing** {@link CoordEngine}
	 * re-broadcasts a willingness-only heartbeat so a cold cohort can bootstrap (siblings hear it, instantiate
	 * their own engine, and reciprocate — §Cold-start instantiation). Default
	 * {@link DEFAULT_WILLINGNESS_HEARTBEAT_MS} (~30 s). The first idle round after an engine is created emits
	 * immediately regardless of this interval; a record-carrying round resets the clock, so this only paces the
	 * steady-state re-broadcast of an idle willing cohort. Independent of {@link gossipIntervalMs} (the tick
	 * cadence): the tick can fire fast while heartbeats stay throttled.
	 */
	readonly willingnessHeartbeatMs?: number;
	/**
	 * The node's libp2p Ed25519 private key. Required for the live participant signer: register/renew
	 * bodies are peer-key-signed over their canonical image, and inbound register/`reattach` signatures
	 * are verified against the participant's claimed peer id. libp2p does not expose the key off
	 * `node.peerId`, so it is threaded explicitly (mirrors `clusterMember` / `DisputeService`, sourced
	 * from `options.privateKey ?? generateKeyPair('Ed25519')` in `libp2p-node-base.ts`). When omitted,
	 * the host falls back to the interim empty-string signer (one-time warn) and does **not** enforce
	 * inbound participant-signature verification, so unit tests compose without a key.
	 */
	readonly privateKey?: PrivateKey;
	/**
	 * Anti-DoS guard wiring (gap 6). The per-{@link CoordEngine} guards (rate limiter, replay guard,
	 * topic budget) and the node-level bootstrap-evidence policy are always constructed with documented
	 * defaults; this lets a caller (or a test) tune them. Omit for production defaults.
	 */
	readonly antiDos?: CohortTopicAntiDosOptions;
	/**
	 * Promotion / demotion lifecycle tuning (`cap_promote`, hysteresis windows, slope lookahead) applied
	 * to every {@link CoordEngine}'s {@link PromotionLifecycle}. Omit for the production defaults
	 * (`cap_promote = 64`, …); supply a lowered `capPromote` to drive promotion with a small participant
	 * count (the live-tier e2e). The single-cohort milestone never overrides `childCohortCount` / `treeTier`
	 * — those stay coord-derived — so only the count/load thresholds are tunable here.
	 */
	readonly promotion?: PromotionConfig;
	/**
	 * Optional committed-state existence reader backing the **committed-tier (T0/T1)** parent-reference
	 * bootstrap-evidence check (`cohort-topic-bootstrap-parent-reference`). Given `coord_0(parentTopicId)`,
	 * returns whether the node locally knows the parent topic's committed cohort exists. Threaded from
	 * node-base when a coord-keyed committed-membership index is available; when omitted, T0/T1 parent-ref
	 * existence fails closed (a FRET-cached cert must not vouch for committed-tier existence — committed-tier
	 * integrity) while T2/T3 parent-ref still consults the FRET membership cache. See
	 * {@link createDefaultParentTopicView}.
	 */
	readonly committedParentTopicReader?: (coord: RingCoord) => boolean;
	/**
	 * The participant's initial trust roots: the genesis-block-related cohorts, validated against the
	 * genesis block hash **out-of-band by the caller before seeding** (`docs/cohort-topic.md`
	 * §Bootstrapping trust). They are the base case of every attestation chain — a cert matching a root by
	 * `(coord, epoch, member-set)` is trusted directly, ahead of the FRET-ring direct anchor — so a forged
	 * cert for a genesis cohort is rejected even before the ring is consulted. Threaded straight into
	 * `createMembershipVerifier({ trustRoots })`.
	 *
	 * **Network-config, empty by default.** The concrete genesis-cohort set is a property of a specific
	 * network's genesis block; this is the typed seam, not a fabricated value. Omitted (the default `[]`)
	 * the verifier behaves exactly as with no roots — the chain bottoms out at the direct anchor / TOFU, so
	 * a network with no genesis cohort configured is never broken. Do **not** seed fake roots here.
	 */
	readonly genesisTrustRoots?: readonly TrustRoot[];
	/**
	 * Wall clock (ms) the `/sign` membership endorser uses for its `stabilizedAt` far-future sanity bound
	 * (a member refuses to co-sign a cert whose `stabilizedAt` is more than a few seconds ahead of its own
	 * clock — `cohort-topic-sign-endorsement-payload-binding`). Defaults to {@link Date.now}, the right
	 * choice for a production node. A **virtual-time** test harness (which drives publish `stabilizedAt`
	 * from arbitrary explicit timestamps rather than wall clock) injects a clock that does not trip the
	 * bound — e.g. `() => Number.POSITIVE_INFINITY` — so its synthetic future timestamps are not rejected.
	 */
	readonly now?: () => number;
}

// The reputation-view shape the bootstrap-evidence referee verifier consults — `{ isBanned, getScore }`
// (a subset of `IPeerReputation`; `PeerReputationService` satisfies it directly). Defined with the
// verifier it backs and re-exported here so existing importers keep resolving it off the host module.
export type { BootstrapReputationView } from "./bootstrap-evidence-verifiers.js";

/**
 * Anti-DoS wiring overrides for a {@link CohortTopicHost} (`docs/cohort-topic.md` §Anti-DoS).
 *
 * The rate limiter, replay guard, and topic budget are **per-served-coord** (they key on
 * `(peer, topic)` / per-cohort topic state, which is coord-scoped) — one set is built per
 * {@link CoordEngine} from these configs. The bootstrap-evidence policy is **node-level** (a
 * tier→verifier policy with no per-coord state) and is shared by every engine.
 */
export interface CohortTopicAntiDosOptions {
	/** Per-`(peer, topic)` register rate limiter. Default `register_rate_per_peer = 4 / 60 s`, exponential back-off. */
	readonly rateLimiter?: RegisterRateLimiterConfig;
	/** Correlation-id freshness + replay guard. Default `maxAge = 60 s`, `futureSkew = 5 s`. */
	readonly replayGuard?: CorrelationReplayGuardConfig;
	/** Per-cohort forwarder-state budget. Default `topics_max = 2048`, LRU by participant count. */
	readonly topicBudget?: TopicBudgetConfig;
	/**
	 * Bootstrap-evidence verifiers for cold-root instantiation. db-core embeds no PoW / reputation /
	 * committed-work scheme; inject the real checks here. Any verifier supplied wins over the defaults
	 * below; the gate is **never** left undefined (an unset gate means cold-root bootstrap is
	 * unauthenticated — `docs/cohort-topic.md` §Anti-DoS).
	 */
	readonly bootstrapEvidence?: BootstrapEvidenceDeps;
	/**
	 * Optional peer-reputation view backing the **reputation-endorsement** evidence path: a *referee*
	 * peer-key-signs the bootstrap bound image, and the cohort admits it iff the signature verifies and
	 * the referee is sufficiently reputable here (not banned **and** below the deprioritize threshold).
	 * `PeerReputationService` satisfies this `{ isBanned, getScore }` shape directly. Supplying it (or any
	 * `bootstrapEvidence` override) makes the gate **configured**: the real PoW verifier runs, the referee
	 * verifier backs the reputation path, the real signed-parent-reference verifier backs the parent-ref path
	 * (permissive-but-logged only at T0/T1 when this host has no committed-existence backing — see
	 * {@link createBootstrapEvidencePolicy}), and any otherwise-unfilled verifier fails closed — so a
	 * banned/low-rep referee cannot slip the T2/T3 `PoW || reputation || parent-ref` disjunction. When omitted
	 * (and no `bootstrapEvidence` verifier is supplied), the gate is permissive-but-logged (the
	 * entirely-unconfigured interim node).
	 */
	readonly reputation?: BootstrapReputationView;
	/**
	 * Proof-of-work difficulty (leading zero bits) the real PoW verifier requires. Default the db-core
	 * `DEFAULT_POW_DIFFICULTY_BITS`. A low value (e.g. `0`) keeps minting fast/deterministic in tests.
	 * Applies to both the cohort-side PoW verifier and this node's participant-side PoW builder.
	 */
	readonly powDifficultyBits?: number;
	/**
	 * Strict "sufficient reputation" cutoff for a bootstrap referee — a referee with `getScore < this` is
	 * accepted. Default the reputation service's `deprioritize` threshold.
	 */
	readonly deprioritizeThreshold?: number;
	/**
	 * Existence view backing the **signed parent-reference** evidence path (`verifyParentReference`). A test
	 * seam: when supplied it overrides *which* existence view the real verifier consults (the host default is
	 * built from the FRET membership cache + addressing + the optional
	 * {@link CohortTopicHostOptions.committedParentTopicReader}). It does **not** by itself make the gate
	 * "configured" — only a `reputation` view or a `bootstrapEvidence` override flips that (see
	 * {@link createBootstrapEvidencePolicy}); an unconfigured host stays permissive and never consults this
	 * view. Pair it with `reputation`/`bootstrapEvidence` to exercise the real parent-reference verifier. See
	 * {@link createDefaultParentTopicView} / {@link createParentReferenceVerifier}.
	 */
	readonly parentTopicView?: BootstrapParentTopicView;
}

/**
 * One cohort the node serves, bound to a FRET-routed coordinate. Owns the per-coord slice of cohort
 * state; the node-wide collaborators are injected (see {@link CoordEngineContext}).
 */
export interface CoordEngine {
	/** The served ring coordinate this engine is the cohort for. */
	readonly servedCoord: RingCoord;
	/** Tree tier `d` the served coord was instantiated at (fixed by the first register). */
	readonly treeTier: number;
	/** Cohort-side register/renew/sweep engine driven by the protocol handlers + activity callback. */
	readonly engine: CohortMemberEngine;
	/** The FRET-assembled cohort around {@link servedCoord} (self prepended, deduped) + epoch. */
	cohort(): CohortSnapshotView;
	/**
	 * The cohort member peer-id strings this engine served under `epoch` (the **current** or the
	 * immediately-**prior** observed epoch), or `undefined` if it tracked no such epoch. Drives the `/sign`
	 * `"rotation"` endorsement gate: a member endorses a hand-off from `prevEpoch` only when it was a member
	 * of the cohort at that epoch. Returns `undefined` past the two-deep history (a rapid double rotation —
	 * the requester then re-anchors). See `cohort-topic-trust-anchor-rotation-production`.
	 */
	cohortIdentityAt(epoch: Uint8Array): readonly string[] | undefined;
	/** True iff this engine currently holds any registration record (a cold probe leaves it empty). */
	hasState(): boolean;
	/** True iff this engine holds the record for `(topicId, participantId)` — the renewal lookup key. */
	holds(topicId: Uint8Array, participantId: Uint8Array): boolean;
	/**
	 * This cohort's locally-known direct registration records for `topicId` (the cohort-side read the
	 * matchmaking `QueryV1` handler / aggregate-count producer serve from — `docs/matchmaking.md`
	 * §Seeker query). A renewed record is live; a TTL-swept one is gone after the next `gossipRound`.
	 */
	records(topicId: Uint8Array): readonly RegistrationRecord[];
	/**
	 * This cohort's current gossip-derived traffic barometer for `topicId` (own last-published counts +
	 * siblings' last-gossiped summaries + `directParticipants` from the store). The matchmaking `QueryV1`
	 * reply attaches it and the seeker hang-out decision consumes it (`docs/matchmaking.md` §Hang-out vs.
	 * continue). Non-mutating — a synchronous read over the same in-memory state a `gossipRound` mutates,
	 * lagging at most one gossip round (it reflects the last frozen summaries, never raw mid-round counts).
	 */
	topicTraffic(topicId: Uint8Array): TopicTrafficV1;
	/**
	 * Publish a fresh threshold-signed `MembershipCertV1` on a cohort-membership-change / stabilization
	 * event (republishes only when the first `k − x` members changed). Returns the cert if published.
	 * Resolves `undefined` if no republish was needed or the quorum was unreachable this round.
	 */
	onStabilized(now: number): Promise<MembershipCertV1 | undefined>;
	/**
	 * Periodic membership-cert refresh hook for the gossip-cadence driver to call (republishes once
	 * `T_membership_refresh` has elapsed). Returns the cert if (re)published, else `undefined`.
	 */
	pumpMembership(now: number): Promise<MembershipCertV1 | undefined>;
	/**
	 * One gossip round: TTL-sweep stale records (firing the `evicted` deltas), freeze the per-topic
	 * traffic summaries, drain the accumulated record/eviction deltas, and broadcast a signed
	 * {@link CohortGossipV1} (willingness/load/traffic + deltas) to the cohort. Returns the broadcast
	 * frame, or `undefined` when the engine is idle (no resident topics and no deltas → nothing to send).
	 */
	gossipRound(now: number): Promise<CohortGossipV1 | undefined>;
	/**
	 * Time-driven demotion check across this engine's resident topics; broadcasts any threshold-signed
	 * {@link DemotionNoticeV1} the lifecycle returns (root tier-0 cohorts never demote). No-op without a
	 * signing key (the verify-only per-coord signer cannot assemble a notice).
	 */
	demotionTick(now: number): Promise<void>;
	/** The merged per-member gossip view (willingness / load / per-topic summaries) for this cohort. */
	cohortView(): CohortView;
	/** True iff this engine currently serves `topicId` (holds a record or a cold-start forwarder for it). */
	servesTopic(topicId: Uint8Array): boolean;
	/**
	 * Whether `topicId` currently occupies a slot in this coord's anti-DoS topic budget. A drained topic
	 * stays resident-but-cold (`{@link budgetParticipantCount} === 0`) until a new topic reuses its slot;
	 * after that reuse `budgetHasTopic` is `false`. Test/diagnostic introspection over the per-coord budget
	 * (distinct from {@link servesTopic}, which a never-demoted cold-start forwarder keeps `true`).
	 */
	budgetHasTopic(topicId: Uint8Array): boolean;
	/**
	 * The direct-participant count the topic budget last recorded for a resident `topicId` (its LRU
	 * eviction key), or `undefined` when `topicId` holds no budget slot. A resident reporting `0` has
	 * drained and is the next coldest-evictable candidate. Test/diagnostic introspection.
	 */
	budgetParticipantCount(topicId: Uint8Array): number | undefined;
	/**
	 * The cold-start {@link Forwarder} this engine instantiated for `topicId`, or `undefined` if none.
	 * Exposes the parent-link lifecycle (`awaiting_parent` → `serving`) for the cold-start wiring (gap 7).
	 */
	forwarder(topicId: Uint8Array): Forwarder | undefined;
	/** Whether `topicId` is in promoted mode here — reflects both locally-originated and remotely-applied state. */
	isPromoted(topicId: Uint8Array): boolean;
	/** Adopt a verified promotion notice into this cohort's local state (see {@link NoticeApplyTarget}). */
	applyPromotionNotice(notice: PromotionNoticeV1, now: number): void;
	/** Adopt a verified demotion notice into this cohort's local state (see {@link NoticeApplyTarget}). */
	applyDemotionNotice(notice: DemotionNoticeV1, now: number): void;
	/** Tear down the per-coord gossip subscription. */
	close(): void;
}

/** Lazy `servedCoord → CoordEngine` registry: one engine per coord FRET routes to this node. */
export interface CoordRegistry {
	/**
	 * The {@link CoordEngine} for `coord`, creating + caching it on first touch. `treeTier` and
	 * `participantCoord` seed a freshly-created engine's coord-derived tier inputs (ignored if the
	 * engine already exists). Synchronous, so concurrent activity callbacks for the same coord share
	 * one engine without a second being constructed.
	 */
	forCoord(coord: RingCoord, treeTier: number, participantCoord: Uint8Array): CoordEngine;
	/** The engine holding the record for `(topicId, participantId)`, or `undefined` (renewal dispatch). */
	findHolder(topicId: Uint8Array, participantId: Uint8Array): CoordEngine | undefined;
	/**
	 * The already-instantiated engine for `coord`, or `undefined` — a pure lookup that (unlike
	 * {@link forCoord}) never creates one. The `/sign` `"rotation"` endorsement gate uses it to consult this
	 * node's prior-epoch membership for the requested coord without spuriously instantiating a cohort it
	 * does not serve.
	 */
	findByCoord(coord: RingCoord): CoordEngine | undefined;
	/**
	 * The **first** engine serving `topicId` at `treeTier`, or `undefined`. Used by the tier-0 read paths —
	 * matchmaking query serve and the reactivity direct-subscriber lookup — that resolve a served engine by
	 * `(topic, tier)` rather than by an exact coord.
	 *
	 * **First-match caveat.** At `d ≥ 1` a node can serve several sibling cohorts for one `(topic, tier)` under
	 * distinct served coords, and this returns whichever iterates first — exact at the single-cohort / tier-0
	 * milestone, but not a coord-precise lookup. The promote/demote notice path deliberately does **not** use
	 * this: it routes by the notice's signed `cohortCoord` via {@link findByCoord} so a multi-cohort node
	 * applies each notice to the cohort that produced it. Reconciling these tier-0 readers with multi-cohort
	 * serving is follow-on work (`cohort-topic-followon-derivation`).
	 */
	findServing(topicId: Uint8Array, treeTier: number): CoordEngine | undefined;
	/** Every live engine (stop + sweep). */
	all(): readonly CoordEngine[];
	/** Close every engine's gossip subscription. */
	close(): void;
}

/** A running cohort-topic node: the participant service plus the per-coord cohort registry, on one FRET node. */
export interface CohortTopicHost {
	/** Participant-facing substrate API (node scope, not a coord). */
	readonly service: CohortTopicService;
	/** Per-served-coord cohort engines (driven by the protocol handlers + activity callback). */
	readonly registry: CoordRegistry;
	/** The four registered protocol IDs. */
	readonly protocols: CohortTopicProtocols;
	/**
	 * The node's effective {@link NodeProfile} (Edge / Core). Exposed so a layered application (reactivity)
	 * can apply the same profile gate the host configured its engines with (e.g. Edge ⇒ subscriber-only).
	 */
	readonly profile: NodeProfile;
	/**
	 * The intra-cohort gossip transport. Exposed so a layered application (reactivity push-state gossip) can
	 * ride its `broadcastOver` seam — the same one the promote-notice broadcast reuses — rather than standing
	 * up a second transport with duplicate cohort peer resolution.
	 */
	readonly gossipTransport: FretCohortGossipTransport;
	/**
	 * The node-level `promote`-handler anti-abuse gate (per-`(peer, topic)` rate limiter + per-`(topic, tier)`
	 * `effectiveAt` high-water). Exposed for test/diagnostic introspection over its bounded-memory state — the
	 * limiter's `size` and the `highWater` `LruMap` — and so the gossip-cadence sweep wiring is observable.
	 */
	readonly promoteGate: PromoteGate;
	/**
	 * The node's local membership-cert cache. Exposed for test/diagnostic introspection: seed an entry via
	 * `cache(coord, encoded)` to prime the verifier's stale-refetch path over the real `/membership` protocol
	 * without marking it trusted (unlike `verifier.cache()`, which records the cert as self-published), and
	 * read it back via `current(coord)` to observe that a `/membership` refetch replaced a stale cached view.
	 */
	readonly membershipSource: { cache(coord: RingCoord, encoded: Uint8Array): void; current(coord: RingCoord): Promise<Uint8Array | undefined> };
	/** Unregister the four protocols and tear down every coord engine. */
	stop(): Promise<void>;
}

/** Node-wide collaborators injected into every {@link CoordEngine} (shared singletons). */
interface CoordEngineContext {
	readonly hash: RingHash;
	readonly addressing: ReturnType<typeof createTierAddressing>;
	readonly slots: ReturnType<typeof createSlotAssigner>;
	readonly barometer: ReturnType<typeof createLoadBarometer>;
	readonly transport: FretCohortGossipTransport;
	readonly profile: NodeProfile;
	readonly selfMemberBytes: Uint8Array;
	readonly wantK: number;
	readonly minSigs: number;
	readonly maxBytes: number;
	/** `T_willingness_heartbeat` (ms): idle-but-willing heartbeat throttle (§Cold-start instantiation). */
	readonly willingnessHeartbeatMs: number;
	/** Membership-cert sink the per-coord publisher serves through (node-wide; serves this node's cohort). */
	readonly publishSink: FretMembershipPublishSink;
	/**
	 * The node's libp2p key, threaded so each coord engine's threshold signer can add self's own chunk.
	 * Absent → key-less interim mode: the per-coord signer cannot assemble (the publisher/promotion paths
	 * are not driven in that mode), so threshold signing is unavailable until a key is supplied.
	 */
	readonly privateKey?: PrivateKey;
	/** FRET-backed router; a coord engine routes its cold-start forwarder→parent link over it (gap 7). */
	readonly router: ITopicRouter;
	/** Per-coord anti-DoS guard configs (one guard set is built per {@link CoordEngine}). */
	readonly antiDos: {
		readonly rateLimiter?: RegisterRateLimiterConfig;
		readonly replayGuard?: CorrelationReplayGuardConfig;
		readonly topicBudget?: TopicBudgetConfig;
	};
	/** Node-level bootstrap-evidence policy, shared by every engine (no per-coord state). */
	readonly bootstrapEvidence: BootstrapEvidence;
	/** Promotion-lifecycle config applied to every engine (test seam for a lowered `cap_promote`). */
	readonly promotionConfig?: PromotionConfig;
	/** Dial a cohort member's `/sign` RPC (the threshold-assembly collection seam). */
	readonly dialSign: (peerIdStr: string, request: SignRequestV1) => Promise<SignReplyV1>;
	/** FRET two-sided assembly around `coord`, self prepended + deduped, with a deterministic epoch. */
	readonly cohortAround: (coord: RingCoord) => CohortSnapshotView;
	/** Verify an inbound `RegisterV1`'s participant peer-key signature (live-signer mode only). */
	readonly verifyRegisterSig?: (reg: RegisterV1) => boolean;
	/** Verify a privileged `RenewV1`'s participant peer-key signature — gates both the `reattach`
	 * promotion and the `withdraw` eviction (live-signer mode only). */
	readonly verifyParticipantSig?: (renew: RenewV1) => boolean;
	/**
	 * Sign an outbound `CohortGossipV1` envelope with the node peer key over its canonical image
	 * ({@link cohortGossipSigningPayload}). Live-signer mode only; absent → gossip ships unsigned (interim,
	 * matching the participant signer) and the receiver's {@link verifyGossip} gate is likewise absent.
	 */
	readonly signGossip?: (g: CohortGossipSignable) => Promise<string>;
	/**
	 * Authenticate an inbound `CohortGossipV1` for a served `coord`: its `fromMember` peer-key signature
	 * must verify over the gossip image **and** `fromMember` must be a member of the cohort around `coord`.
	 * Live-signer mode only; absent → the bus skips the gate (key-less / unit composition).
	 */
	readonly verifyGossip?: (g: CohortGossipV1, coord: RingCoord) => boolean;
	/**
	 * Broadcast a freshly threshold-signed promotion/demotion notice this engine produced over the
	 * `promote` protocol — to the cohort around `servedCoord`, plus the parent coord for a demotion.
	 * Wired by the host; absent in key-less / unit composition.
	 */
	readonly broadcastNotice?: (notice: PromotionNoticeV1 | DemotionNoticeV1, servedCoord: RingCoord) => void;
	/**
	 * Hook a freshly published `MembershipCertV1` (from {@link CoordEngine.onStabilized} /
	 * {@link CoordEngine.pumpMembership}) into the node's verifier cache, so this node can verify inbound
	 * notices signed by its own cohort without a network refetch. Absent in unit composition.
	 */
	readonly onCertPublished?: (cert: MembershipCertV1) => void;
}

/**
 * Build and start a {@link CohortTopicHost} on `node` over `fret`. Registers the four protocols and
 * sets FRET's activity handler. Async because the node's ring coordinate is derived via FRET's
 * `hashPeerId`.
 */
export async function createCohortTopicHost(node: Libp2p, fret: FretService, options: CohortTopicHostOptions = {}): Promise<CohortTopicHost> {
	const profile = options.profile ?? coreProfile();
	const protocols = options.protocols ?? DEFAULT_COHORT_TOPIC_PROTOCOLS;
	const wantK = options.wantK ?? 16;
	const minSigs = options.minSigs ?? DEFAULT_MIN_SIGS;
	const fanout = options.fanout ?? 16;
	const maxBytes = options.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	const gossipIntervalMs = options.gossipIntervalMs ?? DEFAULT_GOSSIP_INTERVAL_MS;
	const willingnessHeartbeatMs = options.willingnessHeartbeatMs ?? DEFAULT_WILLINGNESS_HEARTBEAT_MS;

	const hash = new RingHash();
	const selfPeerStr = node.peerId.toString();
	const selfMemberBytes = peerIdToBytes(node.peerId); // dialable member id
	const selfCoord = await hashPeerId(node.peerId); // ring position P (the participant gossip handle)
	const addressing = createTierAddressing(hash, fanout);

	// --- cohort resolver (FRET two-sided assembly around a coord) ---
	const resolver: CohortPeerResolver = {
		cohortPeers(coord: RingCoord, wants: number): string[] {
			return fret.assembleCohort(coord, wants);
		},
	};

	// --- ports (node-wide singletons, injected into every coord engine) ---
	const router = new FretTopicRouter(node, fret, { registerProtocol: protocols.register, maxBytes });
	const sizeEstimator = new FretSizeEstimator(fret);
	const gossipTransport = new FretCohortGossipTransport(node, resolver, { gossipProtocol: protocols.gossip, wants: wantK, selfPeerId: selfPeerStr });
	const membershipSource = new FretMembershipSource(node, resolver, { membershipProtocol: protocols.membership, wants: wantK, maxBytes });
	const publishSink = new FretMembershipPublishSink();

	const slots = createSlotAssigner(hash);
	const barometer = createLoadBarometer();

	// Participant-side verifier signer: verify-only (it never assembles), so it needs no key / dial seam.
	// The real k − x assembly lives in each CoordEngine's own threshold signer (constructed per coord).
	const verifyingSigner = createCohortSigner(createVerifyOnlyThresholdCrypto(), minSigs);

	// Collect one cohort member's `/sign` endorsement over the new fifth protocol.
	const dialSign = async (peerIdStr: string, request: SignRequestV1): Promise<SignReplyV1> => {
		const reply = await requestResponse(node, peerIdFromString(peerIdStr), protocols.sign, encodeCohortMessage(request, maxBytes), maxBytes);
		return validateSignReplyV1(decodeCohortMessage(reply, maxBytes));
	};

	/** FRET assembly around `coord`: self prepended + deduped; epoch = H(sorted member join). */
	const cohortAround = (coord: RingCoord): CohortSnapshotView => {
		const peerStrs = fret.assembleCohort(coord, wantK);
		const members = [selfMemberBytes, ...peerStrs.filter((p) => p !== selfPeerStr).map((p) => peerIdToBytes(p))];
		// Deterministic epoch from the sorted member set so a membership change rotates the epoch.
		const epochInput = members.map(bytesToB64url).sort().join("|");
		const cohortEpoch = hash.H(new TextEncoder().encode(epochInput));
		return { members, cohortEpoch };
	};

	// --- participant peer-key signing seam (gap 2) ---
	// The live signer needs the node's libp2p key (libp2p does not expose it off `node.peerId`, so it
	// arrives via options). When absent we keep the interim empty-string signer AND skip inbound
	// participant-signature verification, so key-less unit/mock flows still compose. The signer id is
	// the participant's wire identity (`participantCoord` / `participantId`), which IS its dialable
	// peer-id bytes (db-core threads `self = selfMemberBytes`), so it round-trips to a verifiable key.
	const participantSigner = createParticipantSigner(options.privateKey, log);
	const verifyRegisterSig = options.privateKey === undefined
		? undefined
		: (reg: RegisterV1): boolean =>
			reg.signature.length > 0 &&
			verifyPeerSig(b64urlToBytes(reg.participantCoord), registerSigningPayload(reg), b64urlToBytes(reg.signature));
	const verifyParticipantSig = options.privateKey === undefined
		? undefined
		: (renew: RenewV1): boolean =>
			renew.signature.length > 0 &&
			verifyPeerSig(b64urlToBytes(renew.participantId), renewSigningPayload(renew), b64urlToBytes(renew.signature));

	// --- intra-cohort gossip authenticity seam (gap 5) ---
	// Same peer-key signing pattern as register/renew, applied to the gossip envelope: the originator
	// signs its canonical image, and a receiver drops a frame whose `fromMember` signature does not
	// verify or that comes from a non-cohort member (so willingness/load can't be spoofed and forged
	// records can't replicate). Key-less mode ships/accepts unsigned gossip (documented interim), exactly
	// like the participant signer.
	const nodeKey = options.privateKey;
	const signGossip = nodeKey === undefined
		? undefined
		: async (g: CohortGossipSignable): Promise<string> => bytesToB64url(await signPeer(nodeKey, cohortGossipSigningPayload(g)));
	const verifyGossip = nodeKey === undefined
		? undefined
		: (g: CohortGossipV1, coord: RingCoord): boolean => {
			if (g.signature.length === 0) {
				return false;
			}
			const fromBytes = b64urlToBytes(g.fromMember);
			if (!verifyPeerSig(fromBytes, cohortGossipSigningPayload(g), b64urlToBytes(g.signature))) {
				return false;
			}
			const members = cohortAround(coord).members.map(bytesToPeerIdString);
			return members.includes(bytesToPeerIdString(fromBytes));
		};

	// --- outbound notice broadcast (gap 4) ---
	// A coord engine that threshold-signs a promotion/demotion notice hands it here; we fan it over the
	// `promote` protocol to the cohort around the served coord (siblings adopt the state) and, for a
	// demotion, additionally to the parent coord (childCohortCount bookkeeping). Reuses the gossip
	// transport's cohort peer resolution.
	const broadcastNotice = (notice: PromotionNoticeV1 | DemotionNoticeV1, servedCoord: RingCoord): void => {
		const frame = encodeCohortMessage(notice, maxBytes);
		// NOTE: a demotion also fans to the parent coord for childCohortCount bookkeeping. Since the inbound
		// path now routes by the notice's `cohortCoord` (the demoting CHILD's served coord), a parent-only node
		// receiving this frame does not serve that coord → findByCoord → undefined → dropped (a no-op apply).
		// That matches this milestone: childCohortCount is 0 and the parent-side decrement is not yet wired
		// through applyDemotionNotice. A node that serves BOTH the parent and the child coord still adopts (it
		// serves the child coord as a child sibling). Wiring the real parent decrement is follow-on work owned
		// by `cohort-topic-followon-derivation`.
		for (const coord of noticeBroadcastCoords(notice, servedCoord)) {
			gossipTransport.broadcastOver(protocols.promote, coord, frame);
		}
	};

	// --- anti-DoS (gap 6) ---
	// The bootstrap-evidence policy is node-level (a tier→verifier policy with no per-coord state), so it
	// is built once and shared by every coord engine. The per-coord guards (rate limiter, replay guard,
	// topic budget) are built per CoordEngine from `antiDos` below — they key on `(peer, topic)` /
	// per-cohort topic state, which is coord-scoped, and must not share state across coords.
	// The signed-parent-reference existence view (cohort-topic-bootstrap-parent-reference). A test override
	// (`antiDos.parentTopicView`) wins; otherwise the host default, tier-routed over the FRET membership
	// cache (T2/T3) and the optional committed reader (T0/T1 — fail-closed without one, committed-tier
	// integrity). Synchronous + local: it reads the in-memory caches the node already holds, never a dial.
	const parentTopicView = options.antiDos?.parentTopicView ?? createDefaultParentTopicView({
		membershipSource,
		addressing,
		committedReader: options.committedParentTopicReader,
	});
	// Does this host actually have a committed-existence backing to gate T0/T1 parent-refs against? Only an
	// explicit `parentTopicView` override (the test seam / future production index) or a wired
	// `committedParentTopicReader` provides one. Absent both (today's production node), a T0/T1 root cannot
	// mint any acceptable parent-ref — a root has no parent and the default view fails T0/T1 closed — so the
	// policy keeps T0/T1 permissive-but-logged rather than regressing cold-start origination. See
	// {@link createBootstrapEvidencePolicy}.
	const hasCommittedParentBacking =
		options.antiDos?.parentTopicView !== undefined || options.committedParentTopicReader !== undefined;
	const bootstrapEvidence = createBootstrapEvidencePolicy(options.antiDos, hash, log, parentTopicView, hasCommittedParentBacking);

	// Node-level `promote`-handler anti-abuse gate (`cohort-topic-promote-handler-verify-amplification`):
	// a per-(peer, topic) rate limiter (own instance — the register-path limiter is per-coord inside each
	// engine; this handler is node-level) plus the per-(topic, tier) effectiveAt high-water. Defaults to
	// `register_rate_per_peer` (4 / min / peer / topic) with exponential back-off.
	const promoteGate = createPromoteGate(options.antiDos?.rateLimiter);

	const ctx: CoordEngineContext = {
		hash,
		addressing,
		slots,
		barometer,
		transport: gossipTransport,
		profile,
		selfMemberBytes,
		wantK,
		minSigs,
		maxBytes,
		willingnessHeartbeatMs,
		publishSink,
		privateKey: options.privateKey,
		router,
		antiDos: {
			rateLimiter: options.antiDos?.rateLimiter,
			replayGuard: options.antiDos?.replayGuard,
			topicBudget: options.antiDos?.topicBudget,
		},
		bootstrapEvidence,
		promotionConfig: options.promotion,
		dialSign,
		cohortAround,
		verifyRegisterSig,
		verifyParticipantSig,
		signGossip,
		verifyGossip,
		broadcastNotice,
		// Cache this node's own freshly-published cohort cert into the verifier, so an inbound notice
		// signed by this node's cohort verifies locally without a network refetch. `verifier` is declared
		// just below; the closure only runs on a (later) publish, after it is initialized.
		onCertPublished: (cert: MembershipCertV1): void => verifier.cache(cert),
	};
	const registry = createCoordRegistry(ctx);

	// --- cold-sibling engine instantiation on a verified co-member gossip frame (§Cold-start instantiation) ---
	// A brand-new multi-node cohort deadlocks otherwise: FRET lands every register for a coord on the ONE
	// nearest member, so its siblings are never independently woken by a routed register — they hold no engine,
	// are not subscribed to the coord's gossip, and silently drop the willingness/record frames the served
	// member sends. So replication/failover never materialise. This gate lets a co-member's frame (e.g. the
	// idle-but-willing willingness heartbeat) instantiate the sibling engine, which then joins the gossip and
	// reciprocates its own willingness. Called from the `/cohort-gossip` handler BEFORE `deliver`, so the fresh
	// bus is subscribed in time to merge the very frame that woke it.
	//
	// Bounded to genuine co-members by the existing `verifyGossip` auth check (peer-key signature verifies for
	// `fromMember` AND `fromMember` ∈ `cohortAround(coord).members`), so a peer can only make us instantiate an
	// engine for a coord where FRET assembly agrees we are both members. Live-signer mode only: without a key
	// there is no co-member gate, and unauthenticated engine creation would be a DoS vector, so key-less/interim
	// mode keeps today's behaviour (drop gossip for an unknown coord).
	//
	// Scope: tier-0 only (`treeTier === 0`). A tier-`d > 0` frame carries no topic/participantCoord context a
	// bare willingness heartbeat could seed the parent-coord derivation from, and overlaps the parent-child
	// link work — so a tier-`d > 0` frame for an unknown coord falls through to today's drop (the bus has no
	// engine subscribed to it). See `docs/cohort-topic.md` §Cold-start instantiation.
	//
	// NOTE: engines are never reclaimed today (`createCoordRegistry` has no eviction), so a gossip-instantiated
	// engine is a permanent per-co-member-coord cost. Bounded by real FRET co-membership, but if idle engines
	// ever accumulate, add an LRU / idle-reclaim over gossip-instantiated engines.
	const maybeInstantiateColdSibling = (frame: Uint8Array): void => {
		if (verifyGossip === undefined) {
			return; // key-less / interim mode: no co-member gate, so never auto-instantiate
		}
		let g: CohortGossipV1;
		try {
			g = decodeCohortGossipV1(frame, maxBytes);
		} catch {
			return; // malformed → the normal deliver path drops it
		}
		if (g.treeTier !== 0) {
			return; // tier-0 milestone only (a tier-d>0 unknown-coord frame falls through to drop)
		}
		const coord = b64urlToBytes(g.coord);
		if (registry.findByCoord(coord) !== undefined) {
			return; // already serving this coord — nothing to instantiate
		}
		if (!verifyGossip(g, coord)) {
			return; // co-member gate: bad signature or non-member → do not instantiate
		}
		// The dummy `participantCoord` seeds only the tier-`d > 0` parent-coord derivation, which a tier-0
		// engine never exercises (demotion is gated on `treeTier > 0`); self's member bytes are a safe filler.
		registry.forCoord(coord, g.treeTier, selfMemberBytes);
	};

	// --- intra-cohort sign endorsement (the `/sign` handler body) ---
	// A member dials us to endorse a threshold-signed artifact; we sign the exact request payload iff we
	// and the requester share the cohort+epoch around `coord`. Exported `handleSignRequest` is the testable
	// core; here we bind it to this node's key + the FRET assembly around the requested coord.
	const signEndorse = (request: SignRequestV1, fromPeerStr: string): Promise<SignReplyV1> =>
		handleSignRequest(request, fromPeerStr, {
			privateKey: options.privateKey,
			selfMember: selfMemberBytes,
			cohortMembersAround: (coord: RingCoord): string[] => cohortAround(coord).members.map(bytesToPeerIdString),
			currentEpoch: (coord: RingCoord): Uint8Array => cohortAround(coord).cohortEpoch,
			// Rotation endorsement consults the served coord engine's prior-epoch membership history; a coord
			// this node does not serve has no engine, so the hand-off is refused (no spurious instantiation).
			priorCohortMembersAt: (coord: RingCoord, epoch: Uint8Array): readonly string[] | undefined =>
				registry.findByCoord(coord)?.cohortIdentityAt(epoch),
			// Membership binding: re-derive our own canonical cert fields from the SAME `cohortAround` snapshot
			// the per-coord publisher signs over, so a falsified `members` / `cohortCoord` / internal-epoch
			// payload is refused. `stabilizedAt: 0` — the endorser ignores it (it only bounds the value
			// far-future via `now`), matching the dep contract (cohort-topic-sign-endorsement-payload-binding).
			expectedMembershipFields: (coord: RingCoord): { cohortCoord: string; cohortEpoch: string; members: string[] } => {
				const snap = cohortAround(coord);
				const { cohortCoord, cohortEpoch, members } = membershipCertSignable({
					coord,
					cohortEpoch: snap.cohortEpoch,
					members: snap.members,
					stabilizedAt: 0,
				});
				return { cohortCoord, cohortEpoch, members };
			},
			// Wall clock for the `stabilizedAt` far-future bound. Production: Date.now. A virtual-time harness
			// injects a non-tripping clock (its publish `stabilizedAt` is synthetic, not wall-clock).
			now: options.now ?? ((): number => Date.now()),
		});

	// --- participant-side composition (node scope) ---
	// The participant service exposes a node-level gossip handle (around the node's own ring position)
	// and the membership verifier; its register/renew walk drives the FRET router, not a coord engine.
	const participantStore = createRegistrationStore();
	const participantGossipBus = createCohortGossipBus({
		transport: gossipTransport,
		store: participantStore,
		coord: selfCoord,
		localEpoch: (): Uint8Array => cohortAround(selfCoord).cohortEpoch,
		// Same per-coord auth gate as the coord engines: only a signed gossip from a member of the cohort
		// around the node's own ring position merges here (live-signer mode); absent in key-less composition.
		verifyInbound: verifyGossip === undefined ? undefined : (g): boolean => verifyGossip(g, selfCoord),
	});
	const certSource: IMembershipSource = membershipSource;
	const membershipRouter = createMembershipSourceRouter({ committed: certSource, fret: certSource });
	// --- direct trust anchor (cohort-topic-trust-anchor-fret-binding) ---
	// Bind the db-core trust gate's direct anchor to the FRET ring: for a coord this node serves (a covered,
	// non-partitioned T2/T3 coord whose cohort includes self), the cert's signing quorum is checked against
	// the ring's two-sided assembly — a forged unrelated keyset is `"rejected"`, a legit (slack-tolerant)
	// cohort `"anchored"`, everything else `"unknown"` (→ chain / TOFU). Committed tiers (T0/T1) stay
	// `"unknown"` here so this composes with the future tx-log anchor rather than fighting it. `wantK` matches
	// the cohort size `cohortAround` publishes certs over; `selfPeerStr` is the coverage handle.
	const trustAnchor = new FretTrustAnchor(fret, { k: wantK, selfPeerId: selfPeerStr });
	const verifier = createMembershipVerifier({
		signer: verifyingSigner,
		router: membershipRouter,
		minSigs,
		anchor: trustAnchor,
		// Genesis trust roots (network-config; empty by default → no roots, identical to pre-seam behavior).
		trustRoots: options.genesisTrustRoots ?? [],
	});
	// --- participant-side cold-start evidence builder (gap 6) ---
	// Mints the evidence the participant attaches on a cold-root `bootstrap: true` re-issue. PoW (T2/T3) is
	// keyless, so even a key-less host can bootstrap those tiers; the proof is bound to the register's own
	// (topicId, tier, participantCoord, timestamp) tuple so a verifier reconstructs the same image. T0/T1
	// carries no evidence here (the builder supports an `endorse` self-vouch seam — see
	// `bootstrap-evidence-builder.ts` — but origination at those tiers is the committed-parent-reference
	// follow-on `cohort-topic-bootstrap-parent-reference`, so it is intentionally left unwired for now).
	const buildBootstrapEvidence = createBootstrapEvidenceBuilder({
		hash,
		bits: options.antiDos?.powDifficultyBits,
	});

	const service = createCohortTopicService({
		// `self` is the dialable peer-id bytes (not the ring coord): db-core carries it as the
		// participant's wire identity, so the cohort can verify its peer-key signature (see signing seam).
		self: selfMemberBytes,
		hash,
		router,
		sizeEstimator,
		signer: participantSigner,
		gossipBus: participantGossipBus,
		verifier,
		buildBootstrapEvidence,
		config: { fanout, wantK, minSigs, maxMessageBytes: maxBytes },
	});

	// --- register dispatch: recompute the served coord and run the cohort decision on its engine ---
	const dispatchRegister = async (reg: RegisterV1, fretCohort: readonly string[] | undefined, now: number): Promise<RegisterReplyV1> => {
		const topicId = b64urlToBytes(reg.topicId);
		const participantCoord = b64urlToBytes(reg.participantCoord);
		// FRET's ActivityHandler does not carry the routed key, so recompute it from the frame. For tier
		// `d` this equals the participant's `coord_d(self, topicId)` routing key by construction, i.e. the
		// coordinate FRET routed to (§Tier addressing).
		const servedCoord = addressing.coord(reg.treeTier, participantCoord, topicId);
		const coordEngine = registry.forCoord(servedCoord, reg.treeTier, participantCoord);
		if (fretCohort !== undefined) {
			crossCheckCohort(fret, wantK, servedCoord, fretCohort);
		}
		// `parentCoord` for a cold-start forwarder's parent registration; undefined at the root.
		const parentCoord = reg.treeTier > 0 ? addressing.coord(reg.treeTier - 1, participantCoord, topicId) : undefined;
		return coordEngine.engine.handleRegister(reg, { followOn: false, treeTier: reg.treeTier, parentCoord }, now);
	};

	// --- protocol handlers + activity callback ---
	// Await registration so the host is not returned (and dialed) before the five handlers are live —
	// and, crucially, before the gossip driver below starts ticking (no tick may run on a half-wired node).
	await registerProtocolHandlers(node, protocols, registry, dispatchRegister, signEndorse, verifier, promoteGate, gossipTransport, maybeInstantiateColdSibling, publishSink, membershipSource, selfCoord, maxBytes);
	fret.setActivityHandler(async (activity: string, cohort: string[]): Promise<{ commitCertificate: string }> => {
		const reg = validateRegisterV1(decodeCohortMessage(b64urlToBytes(activity), maxBytes));
		const reply = await dispatchRegister(reg, cohort, Date.now());
		return { commitCertificate: bytesToB64url(encodeCohortMessage(reply, maxBytes)) };
	});

	// --- periodic gossip-cadence driver (gap 5) ---
	// db-core has no timer port (confirmed), so the host owns a single raw `setInterval`. Each tick drives
	// every live coord engine's gossip round + membership refresh + demotion check; the membership-refresh
	// (5 min) and demotion (5 min) hysteresis self-gate on elapsed time, so a fast tick is safe and cheap
	// (idle empty engines build no frame). A re-entrancy guard skips a tick that overlaps a slow prior one;
	// `stopped` short-circuits any tick that fires after `stop()`.
	let stopped = false;
	let ticking = false;
	const driveTick = async (): Promise<void> => {
		if (stopped || ticking) {
			return;
		}
		ticking = true;
		try {
			const now = Date.now();
			for (const engine of registry.all()) {
				if (stopped) {
					break;
				}
				try {
					await engine.gossipRound(now);
					await engine.pumpMembership(now);
					await engine.demotionTick(now);
				} catch (err) {
					log("cohort-topic: gossip tick failed for a coord engine: %o", err);
				}
			}
			// Proactive idle reclaim of the node-level promote-gate limiter on the same cadence the per-coord
			// limiters sweep on. The limiter's inline `maxKeys` cap is the hard worst-case bound; this sweep is
			// the steady-state reclaim of idle `(peer, topic)` keys. Runs after the per-engine loop, inside the
			// `ticking` guard and `stopped` short-circuit, so it is single-threaded with no race on `stop()`.
			promoteGate.rateLimiter.sweep(now);
		} finally {
			ticking = false;
		}
	};
	const timer = setInterval((): void => {
		void driveTick();
	}, gossipIntervalMs);
	// Node timers keep the event loop alive; cohort gossip should not pin a process that is otherwise idle.
	(timer as { unref?: () => void }).unref?.();

	return {
		service,
		registry,
		protocols,
		profile,
		gossipTransport,
		promoteGate,
		membershipSource,
		stop: async (): Promise<void> => {
			stopped = true;
			clearInterval(timer);
			registry.close();
			participantGossipBus.close();
			await node.unhandle(cohortTopicProtocolList(protocols));
		},
	};
}

// --- participant signing seam ---

/**
 * The participant body signer. With a node key it peer-key-signs the canonical register/renew byte
 * image (base64url). Without one it is the interim empty-string signer with a one-time warn that the
 * bodies are unsigned — keeping key-less mock/unit flows composable (e.g. the four-protocol handshake
 * test). The `signRegister`/`signRenew` bodies are the wire-payload-helper inputs verbatim.
 */
function createParticipantSigner(
	privateKey: PrivateKey | undefined,
	log: (formatter: string, ...args: unknown[]) => void,
): ParticipantSigner {
	if (privateKey === undefined) {
		let warned = false;
		const warnOnce = (): void => {
			if (warned) {
				return;
			}
			warned = true;
			log("no privateKey supplied to createCohortTopicHost; participant RegisterV1/RenewV1 bodies are UNSIGNED (interim — supply options.privateKey for peer-key signing)");
		};
		return {
			signRegister: (): Promise<string> => {
				warnOnce();
				return Promise.resolve("");
			},
			signRenew: (): Promise<string> => {
				warnOnce();
				return Promise.resolve("");
			},
		};
	}
	return {
		signRegister: async (body): Promise<string> => bytesToB64url(await signPeer(privateKey, registerSigningPayload(body))),
		signRenew: async (body): Promise<string> => bytesToB64url(await signPeer(privateKey, renewSigningPayload(body))),
	};
}

// --- anti-DoS: node-level bootstrap-evidence policy (gap 6) ---

/**
 * Build the node-level {@link BootstrapEvidence} policy a cold root demands of a `bootstrap: true`
 * registration (`docs/cohort-topic.md` §Anti-DoS bullet 4). The policy itself (tier-dependent: T0/T1
 * need a signed parent reference; T2/T3 accept PoW OR reputation OR a parent reference) is real db-core
 * logic — this only supplies the **verifiers**, which db-core deliberately does not embed (no specific
 * PoW / reputation / committed-work scheme).
 *
 * Resolution per verifier (an injected `antiDos.bootstrapEvidence` override always wins — the test seam):
 *
 * - `verifyPoW` — when **configured**, the real {@link createPoWVerifier} (self-contained: one hash over
 *   the bound preimage). This is a working PoW path, not deny.
 * - `verifyReputation` — when a reputation **view** is supplied, the real {@link createReputationVerifier}
 *   (a referee peer-key-signs the bound image; the cohort checks the signature + the referee's local
 *   reputation). Else (configured, no view) fail closed.
 * - `verifyParentReference` — the real {@link createParentReferenceVerifier} over `parentTopicView`: a
 *   participant-signed reference to a parent topic that the node locally knows exists (committed/membership
 *   state). It is the *only* accepted evidence for T0/T1 and the third T2/T3 option. The view is always
 *   available (the host builds a default from the membership cache + addressing), so this is the real
 *   verifier at T2/T3 and at T0/T1 **once a committed backing is wired**.
 *
 * **T0/T1 without a committed backing (the cold-start-origination interim posture).** A real production
 * node wires a reputation view (so it is *configured*) but, today, no committed-existence backing
 * (`hasCommittedParentBacking === false`): there is no coord-keyed committed-membership index yet, so the
 * default `parentTopicView` fails T0/T1 closed, and the participant-side builder mints no parentRef for a
 * brand-new root (a root has no parent to reference). At those tiers the policy consults *only*
 * `verifyParentReference`, so a real, unfilled T0/T1 parent-ref gate would make cold-start origination
 * impossible. While that backing does not exist we therefore keep T0/T1 **permissive-but-logged** when
 * `hasCommittedParentBacking` is false, and run the real verifier otherwise — i.e. at T2/T3 always, and at
 * T0/T1 once a committed backing IS supplied (the test seam `antiDos.parentTopicView`, or a future
 * production `committedParentTopicReader`). This is the documented refinement of the parent-reference work,
 * narrowed so it does not regress the just-landed real T0/T1 gating exercised with an explicit view.
 *
 * "Configured" = any reputation view or explicit `bootstrapEvidence` override is set; once configured, an
 * unfilled verifier fails **closed** so a banned/low-rep referee cannot slip the T2/T3
 * `verifyPoW || verifyReputation || verifyParentReference` disjunction. The permissive-but-logged
 * fallback is reserved for the *entirely unconfigured* interim node (and the configured-but-no-committed-
 * backing T0/T1 origination path above) — a one-time warning, never an undefined gate — so the
 * db-core/mock-tier flows that bootstrap tier-0 without evidence still pass.
 *
 * @param hasCommittedParentBacking Whether this host has a committed-existence backing to gate T0/T1
 *   parent-refs against (an explicit `antiDos.parentTopicView` override or a wired
 *   `committedParentTopicReader`). False on today's production node, where T0/T1 stays permissive.
 */
function createBootstrapEvidencePolicy(
	antiDos: CohortTopicAntiDosOptions | undefined,
	hash: RingHash,
	log: (formatter: string, ...args: unknown[]) => void,
	parentTopicView: BootstrapParentTopicView,
	hasCommittedParentBacking: boolean,
): BootstrapEvidence {
	const overrides = antiDos?.bootstrapEvidence;
	const reputation = antiDos?.reputation;

	// Once ANY real gating is configured (a reputation view or explicit verifiers), an unfilled verifier
	// must fail **closed** (deny), not open — otherwise a permissive verifier short-circuits the T2/T3
	// `||` disjunction and admits even a banned peer. The permissive-but-logged fallback below is
	// therefore reserved for the *entirely unconfigured* interim node.
	const configured = overrides !== undefined || reputation !== undefined;
	// Mirror the db-core policy's tier split (an override config wins, else the default) so the T0/T1 branch
	// of the parent-reference gate below matches the tiers at which the policy consults it exclusively.
	const maxNoPowTier = overrides?.config?.maxNoPowTier ?? DEFAULT_MAX_NO_POW_TIER;

	// The real, self-contained PoW verifier — available whenever configured (no view / subsystem needed).
	const realPoW = createPoWVerifier({ hash, bits: antiDos?.powDifficultyBits });
	// The real referee verifier — only when a reputation view is supplied (the T2/T3 reputation path).
	const realReputation = reputation === undefined
		? undefined
		: createReputationVerifier({ reputation, deprioritizeThreshold: antiDos?.deprioritizeThreshold });
	// The real signed-parent-reference verifier over the existence view (T2/T3 always; T0/T1 once a committed
	// backing is wired). Replaces the interim reputation stand-in: it demands a real, existing parent.
	const realParentReference = createParentReferenceVerifier({ parentTopicView });

	const deny = (): boolean => false;

	// Permissive-but-logged fallback (one warning total): keeps the gate defined while the production
	// evidence schemes are unwired, instead of silently leaving cold-root bootstrap unauthenticated.
	let warned = false;
	const permissive = (kind: string): ((reg: RegisterV1) => boolean) => (reg: RegisterV1): boolean => {
		void reg;
		if (!warned) {
			warned = true;
			log("cohort-topic anti-DoS: bootstrap-evidence %s verifier is PERMISSIVE — no PoW/reputation view wired, so cold-root bootstrap is NOT cryptographically gated (interim; inject antiDos.bootstrapEvidence/reputation, see cohort-topic-bootstrap-evidence-scheme)", kind);
		}
		return true;
	};
	// An unconfigured verifier: deny when the policy is otherwise configured (fail closed), else permissive.
	const fallback = (kind: string): ((reg: RegisterV1) => boolean) => configured ? deny : permissive(kind);

	// The configured parent-reference gate. At T0/T1 (`reg.tier <= maxNoPowTier`) with NO committed backing,
	// a brand-new root cannot mint any acceptable parent-ref (it has no parent; the default view fails closed)
	// and the policy consults only this verifier there — so admit permissively-but-logged rather than regress
	// cold-start origination. At T2/T3, and at T0/T1 once a committed backing IS wired (the test seam / future
	// production index), run the real verifier.
	const permissiveT0T1 = permissive("parent-reference (T0/T1, no committed backing)");
	const parentReferenceGate = (reg: RegisterV1): boolean => {
		if (reg.tier <= maxNoPowTier && !hasCommittedParentBacking) {
			return permissiveT0T1(reg);
		}
		return realParentReference(reg);
	};

	return createBootstrapEvidence({
		// Configured ⇒ the real PoW path; unconfigured ⇒ permissive (preserves the bare-host tier-0 flows).
		verifyPoW: overrides?.verifyPoW ?? (configured ? realPoW : fallback("proof-of-work")),
		verifyReputation: overrides?.verifyReputation ?? realReputation ?? fallback("reputation"),
		// The real signed-parent-reference verifier when configured (an explicit override still wins), gated so
		// T0/T1-without-committed-backing stays permissive; unconfigured ⇒ permissive (preserves the bare-host
		// tier-0 flows). No longer the reputation stand-in.
		verifyParentReference: overrides?.verifyParentReference ?? (configured ? parentReferenceGate : fallback("parent-reference")),
		config: overrides?.config,
	});
}

// --- cold-start: forwarder → parent registration transport (gap 7) ---

/** Inputs to {@link registerForwarderWithParent} (captured per coord engine + per instantiating register). */
interface ForwarderLink {
	readonly topicId: Uint8Array;
	/** The tier-`(d − 1)` parent cohort coord this link routes to. */
	readonly parentCoord: Uint8Array;
	/** The forwarder's tree tier `d` (`> 0` — the root never links to a parent). */
	readonly treeTier: number;
	/** The topic's capacity tier (T0–T3); stamps the link frame's `tier`. Defaults to 0 if absent. */
	readonly opTier?: number;
	/** The participant coord that seeded this engine — keeps the link frame's recompute consistent. */
	readonly participantCoord: Uint8Array;
}

/**
 * Route a forwarder→parent link to `parentCoord` and resolve on the round-trip (the parent ack).
 *
 * The link is a `RegisterV1`-style frame routed over {@link ITopicRouter.routeAndAct} keyed at the
 * parent coord: it rides the parent's serving tier (`treeTier − 1`) with this engine's seed
 * `participantCoord`, so the parent recomputes `servedCoord = coord_{d−1}(participantCoord, topicId) =
 * parentCoord`. A fresh CSPRNG `correlationId` keeps it clear of the parent's replay guard on retry.
 * Resolution of the route is treated as the ack (richer child-link confirmation — the parent recording
 * `childCohortCount` over a dedicated child-link frame — is the follow-on
 * `cohort-topic-parent-child-link`); a rejection propagates so the cold-start manager keeps the
 * forwarder `awaiting_parent`.
 */
async function registerForwarderWithParent(ctx: CoordEngineContext, link: ForwarderLink): Promise<void> {
	const frame: RegisterV1 = {
		v: 1,
		topicId: bytesToB64url(link.topicId),
		tier: clampTier(link.opTier ?? 0),
		treeTier: Math.max(0, link.treeTier - 1),
		participantCoord: bytesToB64url(link.participantCoord),
		ttl: DEFAULT_TTL_MS,
		// Not a root cold-start: a follow-on link to an already-promoted parent, so no bootstrap evidence.
		bootstrap: false,
		timestamp: Date.now(),
		correlationId: bytesToB64url(randomBytes(16)),
		// Interim: the forwarder cohort cannot sign as the participant; the dedicated child-link frame
		// (follow-on) carries the cohort threshold signature instead.
		signature: "",
	};
	await ctx.router.routeAndAct(link.parentCoord, encodeCohortMessage(frame, ctx.maxBytes), { wantK: ctx.wantK, minSigs: ctx.minSigs });
}

/** Clamp an op tier to the valid T0–T3 range so the link frame validates at a (future) real parent. */
function clampTier(tier: number): number {
	if (!Number.isInteger(tier) || tier < 0) {
		return 0;
	}
	return tier > 3 ? 3 : tier;
}

// --- registry + coord engine ---

/** Build the lazy `servedCoord → CoordEngine` registry over the shared collaborators. */
function createCoordRegistry(ctx: CoordEngineContext): CoordRegistry {
	const engines = new Map<string, CoordEngine>();
	return {
		forCoord(coord: RingCoord, treeTier: number, participantCoord: Uint8Array): CoordEngine {
			const key = bytesToB64url(coord);
			// Compute-if-absent, synchronously — no async gap, so two concurrent callers for the same coord
			// share one engine rather than racing to construct a second.
			let engine = engines.get(key);
			if (engine === undefined) {
				engine = createCoordEngine(ctx, coord, treeTier, participantCoord);
				engines.set(key, engine);
			}
			return engine;
		},
		findByCoord(coord: RingCoord): CoordEngine | undefined {
			return engines.get(bytesToB64url(coord));
		},
		findHolder(topicId: Uint8Array, participantId: Uint8Array): CoordEngine | undefined {
			for (const engine of engines.values()) {
				if (engine.holds(topicId, participantId)) {
					return engine;
				}
			}
			return undefined;
		},
		findServing(topicId: Uint8Array, treeTier: number): CoordEngine | undefined {
			for (const engine of engines.values()) {
				if (engine.treeTier === treeTier && engine.servesTopic(topicId)) {
					return engine;
				}
			}
			return undefined;
		},
		all(): readonly CoordEngine[] {
			return [...engines.values()];
		},
		close(): void {
			for (const engine of engines.values()) {
				engine.close();
			}
			engines.clear();
		},
	};
}

/**
 * One observed cohort identity for a served coord: the deterministic epoch (`H(sorted member set)`),
 * its base64url key, and the member set in both byte and peer-id-string form. The epoch is a pure
 * function of the member set, so an epoch match implies a member-set match.
 */
interface CohortIdentity {
	readonly epoch: Uint8Array;
	readonly epochKey: string;
	readonly memberBytes: readonly Uint8Array[];
	readonly memberStrs: readonly string[];
}

/**
 * Per-{@link CoordEngine} epoch-rotation bookkeeping (`cohort-topic-trust-anchor-rotation-production`).
 * Two roles, one small object:
 *
 * - **Producer** — {@link predecessor} is the identity of the *last published* cert; a publish whose
 *   first `k − x` differ from it is a rotation, and the predecessor identity scopes the rotation `/sign`
 *   round (its epoch is `prevEpoch`, its members are the outgoing cohort to collect from).
 * - **Endorser** — {@link membersAt} answers "was I a member of the cohort at `epoch`?" over a two-deep
 *   observed-epoch history ({@link current} + {@link prior}), kept fresh by {@link observe} on every
 *   cohort assembly. A request for an epoch past that window is refused (the rapid-double-rotation gap).
 *
 * The observed history (for endorsing) is distinct from `lastPublished` (for producing): a non-deciding
 * member endorses rotations it never published, so it cannot rely on its own publish history alone.
 */
class RotationState {
	private current: CohortIdentity | undefined;
	private prior: CohortIdentity | undefined;
	private lastPublished: CohortIdentity | undefined;

	/**
	 * Record the engine's current cohort identity, shifting the previous current into {@link prior} on an
	 * epoch change. Cheap on the hot path: `build` is only invoked when `epochKey` actually changes (the
	 * member set is unchanged within an epoch, so there is nothing to refresh).
	 */
	observe(epochKey: string, build: () => CohortIdentity): void {
		if (this.current?.epochKey === epochKey) {
			return;
		}
		const next = build();
		this.prior = this.current;
		this.current = next;
	}

	/** Mark `identity` as the most recently published cert's identity (the rotation chain predecessor). */
	recordPublished(identity: CohortIdentity): void {
		this.lastPublished = identity;
	}

	/** The last-published identity (the predecessor a fresh rotation attests from), or `undefined`. */
	predecessor(): CohortIdentity | undefined {
		return this.lastPublished;
	}

	/** The member peer-id strings observed under `epochKey` (current or prior), or `undefined`. */
	membersAt(epochKey: string): readonly string[] | undefined {
		if (this.current?.epochKey === epochKey) {
			return this.current.memberStrs;
		}
		if (this.prior?.epochKey === epochKey) {
			return this.prior.memberStrs;
		}
		return undefined;
	}
}

/**
 * Compose one {@link CoordEngine} bound to `servedCoord`. The cohort it threshold-signs / shards with
 * is the FRET assembly around `servedCoord` (not the node's own ring position). The promotion tier
 * inputs are coord-derived: `treeTier` is fixed at instantiation; `parentCoord` is
 * `coord_{d-1}(participantCoord, topicId)` (the shard's parent shares the prefix, so any participant
 * routed here yields the same parent); `childCohortCount` is `0` for the single-cohort milestone.
 */
function createCoordEngine(ctx: CoordEngineContext, servedCoord: RingCoord, treeTier: number, participantCoord: Uint8Array): CoordEngine {
	const store = createRegistrationStore();
	// Epoch-rotation bookkeeping. `cohort()` observes every assembly so the endorser history stays fresh
	// (the gossip-cadence driver assembles each round); the producer reads `predecessor()` on publish.
	const rotationState = new RotationState();
	const identityOf = (view: { members: readonly Uint8Array[]; cohortEpoch: Uint8Array }): CohortIdentity => {
		const memberBytes = [...view.members];
		return {
			epoch: view.cohortEpoch,
			epochKey: bytesToB64url(view.cohortEpoch),
			memberBytes,
			memberStrs: memberBytes.map(bytesToPeerIdString),
		};
	};
	const cohort = (): CohortSnapshotView => {
		const view = ctx.cohortAround(servedCoord);
		rotationState.observe(bytesToB64url(view.cohortEpoch), () => identityOf(view));
		return view;
	};
	const localEpoch = (): Uint8Array => cohort().cohortEpoch;

	// Inbound gossip is routed to this bus by its `coord`; the optional auth gate (live-signer mode) drops
	// a frame whose `fromMember` signature is bad or who is not a member of the cohort around THIS coord.
	const bus = createCohortGossipBus({
		transport: ctx.transport,
		store,
		coord: servedCoord,
		localEpoch,
		verifyInbound: ctx.verifyGossip === undefined ? undefined : (g): boolean => ctx.verifyGossip!(g, servedCoord),
		// Sibling-drain half of the topic-budget release: a topic whose participants are sharded onto a
		// sibling primary drains into this store as a gossip eviction (never this member's own TTL sweep),
		// so re-`touch` the budget down from the post-delete store count — mirroring the engine's `sweepStale`
		// re-touch. `topicBudget` is a forward `const` here, only read when this callback fires at merge time
		// (long after both are initialized). A no-op for a topic the budget does not hold (`touch` guards it).
		onRecordsEvicted: (topicIds): void => {
			for (const topicId of topicIds) {
				topicBudget.touch(topicId, store.directParticipants(topicId));
			}
		},
	});
	const view = bus.view();
	const selfMember = bytesToB64url(ctx.selfMemberBytes);

	// Per-touch replication delta queue: the renewal cohort side appends each served touch / TTL eviction
	// here; the next gossip round drains the batch into the broadcast frame (one round, not one per ping).
	const pending = createPendingDeltas();

	// Per-coord threshold signers: each assembles a real k − x signature by signing locally and collecting
	// the rest of the cohort around THIS served coord over the `/sign` RPC. `membership` signs the cert;
	// `promotion` signs promote/demote notices (kind drives the dialed members' endorsement policy). In
	// key-less interim mode there is no key to sign self's chunk, so the signer is verify-only (the
	// publisher / promotion paths are simply not driven without a key).
	const makeCoordSigner = (kind: SignKind): CohortSigner => {
		if (ctx.privateKey === undefined) {
			return createCohortSigner(createVerifyOnlyThresholdCrypto(), ctx.minSigs);
		}
		const crypto = new FretCohortThresholdCrypto({
			kind,
			privateKey: ctx.privateKey,
			selfMember: ctx.selfMemberBytes,
			coord: (): RingCoord => servedCoord,
			cohortEpoch: localEpoch,
			cohortMembers: (): string[] => cohort().members.map(bytesToPeerIdString),
			dialSign: ctx.dialSign,
		});
		return createCohortSigner(crypto, ctx.minSigs);
	};
	const noticeSigner = makeCoordSigner("promotion");
	const membershipSigner = makeCoordSigner("membership");

	// Cohort-side membership-cert publisher: threshold-signs a MembershipCertV1 over this coord's cohort
	// and serves it through the node's publish sink. Driven by the onStabilized / pumpMembership hooks.
	const membershipPublisher: MembershipCertPublisher = createMembershipCertPublisher({
		signer: membershipSigner,
		sink: ctx.publishSink,
		minSigs: ctx.minSigs,
		maxMessageBytes: ctx.maxBytes,
	});
	const snapshotAt = (now: number): CohortSnapshot => {
		const { members, cohortEpoch } = cohort();
		return { coord: servedCoord, cohortEpoch, members, stabilizedAt: now };
	};
	// Key-less interim mode has only a verify-only per-coord signer (its `assemble` rejects), so the
	// publish hooks must no-op rather than surface a rejected promise — matching the documented
	// "publisher paths are simply not driven without a key" contract. Without this guard a future
	// gossip-cadence driver iterating `registry.all()` would reject on every key-less engine.
	const canPublish = ctx.privateKey !== undefined;

	// --- epoch-rotation attestation production (cohort-topic-trust-anchor-rotation-production) ---
	// Any change to the cohort identity (`epochKey = H(sorted members)`) is a rotation — head OR tail
	// (mirrors the publisher's own republish gate — both now key on the epoch, so the two agree on what is
	// a rotation).
	// NOTE: the `/sign` "rotation" endorsement gate remembers only the current + immediately-prior observed
	// epoch (RotationState.membersAt). That two-deep bound is orthogonal to attesting on any epoch change —
	// RotationState.observe already shifts on every observed epoch change (any member change rotates the
	// epoch), so rapid churn could age a predecessor epoch out of the window regardless. If rapid multi-step
	// churn ever makes rotation attestations frequently unproducible, that is a history-depth concern in
	// RotationState, not this trigger.
	const epochChanged = (a: CohortIdentity, b: CohortIdentity): boolean => a.epochKey !== b.epochKey;

	/**
	 * Threshold-sign the new cert's canonical payload under the **predecessor** cohort identity, producing the
	 * `{ prevEpoch, rotationSig, rotationSigners }` attestation — or `undefined` if the predecessor quorum is
	 * unreachable (mass churn / partition), in which case the caller publishes the rotation cert WITHOUT an
	 * attestation (trust falls to the direct anchor / TOFU, no worse than a non-rotation publish). The `/sign`
	 * round is scoped to the prior epoch's members (`kind: "rotation"`), so the endorsers are the genuinely
	 * outgoing cohort. The payload is built through the SAME `membershipCertSignable` the publisher signs, so
	 * the signature image matches exactly (the db-core chain check verifies `rotationSig` over it).
	 */
	const produceRotation = async (snapshot: CohortSnapshot, predecessor: CohortIdentity): Promise<RotationAttestation | undefined> => {
		const payload = membershipCertSigningPayload(membershipCertSignable(snapshot));
		const selfStr = bytesToPeerIdString(ctx.selfMemberBytes);
		const crypto = new FretCohortThresholdCrypto({
			kind: "rotation",
			privateKey: ctx.privateKey!, // canPublish guard: rotation only runs from a publish, which no-ops key-less
			selfMember: ctx.selfMemberBytes,
			coord: (): RingCoord => servedCoord,
			cohortEpoch: (): Uint8Array => predecessor.epoch, // prevEpoch — scopes the endorsement to the prior epoch
			cohortMembers: (): string[] => [...predecessor.memberStrs], // dial the OUTGOING cohort
			dialSign: ctx.dialSign,
			selfEligible: (): boolean => predecessor.memberStrs.includes(selfStr),
		});
		const signer = createCohortSigner(crypto, ctx.minSigs);
		try {
			const { thresholdSig, signers } = await signer.thresholdSign(payload);
			return { prevEpoch: predecessor.epoch, rotationSig: thresholdSig, rotationSigners: signers };
		} catch (err) {
			log("cohort-topic: rotation attestation skipped at coord %s — predecessor quorum unavailable: %o", bytesToB64url(servedCoord), err);
			return undefined;
		}
	};

	/**
	 * Publish (or refresh) this cohort's membership cert, attaching a rotation attestation when the cohort
	 * identity (epoch) changed since the last publish. `refresh` selects the publisher path: `false` for a
	 * stabilization event ({@link CoordEngine.onStabilized}), `true` for the periodic refresh
	 * ({@link CoordEngine.pumpMembership}). An epoch change is a stabilization regardless of which hook
	 * fired, so it routes through `onStabilized` (which republishes promptly on the change) carrying the
	 * attestation; the `/sign` round runs only on that change, so it costs one round per rotation, never per
	 * tick. Key-less interim mode no-ops (the verify-only signer cannot assemble).
	 */
	const publishMembership = async (now: number, refresh: boolean): Promise<MembershipCertV1 | undefined> => {
		if (!canPublish) {
			return undefined;
		}
		const snapshot = snapshotAt(now); // also observes the current identity (snapshotAt → cohort())
		const current = identityOf(snapshot);
		const predecessor = rotationState.predecessor();
		const rotating = predecessor !== undefined && epochChanged(predecessor, current);
		let published: MembershipCertV1 | undefined;
		if (rotating) {
			const rotation = await produceRotation(snapshot, predecessor!);
			published = await membershipPublisher.onStabilized(snapshot, now, rotation);
		} else {
			published = await (refresh ? membershipPublisher.tick(snapshot, now) : membershipPublisher.onStabilized(snapshot, now));
		}
		if (published !== undefined) {
			rotationState.recordPublished(current);
			ctx.onCertPublished?.(published);
		}
		return published;
	};

	const willingness = createWillingnessCheck({
		barometer: ctx.barometer,
		view,
		selfMember,
		primaryTopicCount: (tier: Tier): number => countPrimaryTopics(store, ctx.selfMemberBytes, tier),
		config: { cohortSize: ctx.wantK },
	});
	const traffic = createTrafficCounters({ view, store, selfMember });
	const promotion = createPromotionLifecycle({
		store,
		loadBucket: (topicId: Uint8Array): number => ctx.barometer.bucket(tierOfTopic(store, topicId)),
		// Single-cohort milestone: a tier-0 cohort with no children. Child-cohort tracking is a follow-on.
		childCohortCount: (): number => 0,
		treeTier: (): number => treeTier,
		// `coord_{d-1}(P, topicId)`; never invoked at the root (demotion is gated on `treeTier > 0`), so
		// the `d = 0` branch (clamped to `coord_0`) is a well-formed placeholder that the lifecycle skips.
		parentCoord: (topicId: Uint8Array): Uint8Array => ctx.addressing.coord(Math.max(0, treeTier - 1), participantCoord, topicId),
		// The served coord this engine was instantiated at — stamped on every notice as `cohortCoord` and
		// covered by its threshold signature, so a receiver routes + verifies the notice by exactly this coord.
		cohortCoord: (): Uint8Array => servedCoord,
		cohortEpoch: localEpoch,
		signer: noticeSigner,
		// Production defaults (cap_promote = 64, …) unless the host was given a promotion override — the
		// live-tier e2e lowers `capPromote` to drive promotion with a small participant count. The
		// coord-derived inputs above (treeTier / childCohortCount / parentCoord) are never overridden.
		config: ctx.promotionConfig ?? { capPromote: undefined },
	});
	// Cold-start forwarder → parent registration (gap 7). A freshly-instantiated tier-`d > 0` forwarder
	// registers with its tier-`(d − 1)` parent cohort at `parentCoord` so the parent counts it as a child;
	// the ColdStartManager holds the forwarder in `awaiting_parent` (accepts participants, holds
	// parent-involving ops) until this resolves. This supplies the TRANSPORT: route a forwarder-link frame
	// to `parentCoord` over the same `RouteAndMaybeAct` path a participant register rides. A resolved
	// round-trip is the parent ack (flip to `serving`); a rejected/timed-out route leaves the forwarder
	// `awaiting_parent` for a later retry and never crashes the instantiating register (cold-start fires
	// this fire-and-forget). The parent-side child-cohort RECORDING (`childCohortCount`, a dedicated
	// child-link frame) is a follow-on (`tickets/backlog/cohort-topic-parent-child-link`); the
	// single-tier-0 milestone has no parent (the root serves immediately), so a unit test exercises this.
	const coldStart = createColdStartManager({
		parentRegistrar: {
			registerWithParent: (topicId: Uint8Array, parentCoord: Uint8Array, tier: number, opTier?: number): Promise<void> =>
				registerForwarderWithParent(ctx, { topicId, parentCoord, treeTier: tier, opTier, participantCoord }),
		},
	});

	// Per-coord anti-DoS guards (gap 6): each CoordEngine owns its own set — a rate-limit budget / replay
	// window / topic budget for coord A is independent of coord B. The bootstrap-evidence policy
	// (`ctx.bootstrapEvidence`) is node-level and shared by design.
	const rateLimiter = createRegisterRateLimiter(ctx.antiDos.rateLimiter);
	// The read-only lookup-probe path gets its OWN per-coord rate limiter (same config, separate budget),
	// so a probe flood cannot exhaust a participant's register budget at this coord, or vice-versa.
	const probeRateLimiter = createRegisterRateLimiter(ctx.antiDos.rateLimiter);
	const replayGuard = createCorrelationReplayGuard(ctx.antiDos.replayGuard);
	const topicBudget = createTopicBudget(ctx.antiDos.topicBudget);
	const renewal = createRenewalCohortSide({
		store,
		self: ctx.selfMemberBytes,
		slots: ctx.slots,
		cohort,
		gossip: {
			// Per-touch replication, batched to one gossip round: a served ping/re-attach queues the touched
			// record; the next round drains it so cohort members converge on the active set + assignments.
			touch: (rec): void => pending.touch(rec),
			// A TTL sweep eviction is gossiped so siblings drop the dead record (convergence on eviction).
			evicted: (rec): void => pending.evicted(rec),
		},
		verifyParticipantSig: ctx.verifyParticipantSig,
	});

	const engine = createCohortMemberEngine({
		self: ctx.selfMemberBytes,
		profile: ctx.profile,
		hash: ctx.hash,
		store,
		slots: ctx.slots,
		willingness,
		promotion,
		coldStart,
		traffic,
		renewal,
		cohort,
		quorumWilling: (tier: Tier): boolean => ctx.profile.willingTiers.has(tier),
		// Anti-DoS guards (gap 6): per-coord rate/replay/budget; node-level bootstrap-evidence policy.
		rateLimiter,
		// Dedicated probe-path rate limiter (independent budget from `rateLimiter`).
		probeRateLimiter,
		replayGuard,
		topicBudget,
		bootstrapEvidence: ctx.bootstrapEvidence,
		verifyRegisterSig: ctx.verifyRegisterSig,
		// Admission-time replication: enqueue the just-admitted record so siblings hold a replica before the
		// participant's first renewal touch (closes the accept→first-touch durability window). Same queue +
		// last-writer-wins as the renewal `gossip.touch`.
		onAdmit: (rec): void => pending.touch(rec),
		// A promotion notice signed on an arrival is broadcast to the cohort around this served coord
		// (and the parent for a demotion). The engine only knows the notice; the host adds the coord.
		onNotice: (notice): void => ctx.broadcastNotice?.(notice, servedCoord),
		log,
	});

	/** Distinct topics this engine currently holds state for (the gossip-summary / demotion iteration set). */
	const residentTopics = (): Uint8Array[] => {
		const byKey = new Map<string, Uint8Array>();
		for (const rec of store.listAll()) {
			byKey.set(bytesToB64url(rec.topicId), rec.topicId);
		}
		return [...byKey.values()];
	};

	// Timestamp of the last frame this engine actually emitted (any frame carries willingness). Drives the
	// idle-but-willing heartbeat throttle: an idle round heartbeats only if this engine has never emitted
	// (first idle round → immediate, so bootstrap converges fast) or `T_willingness_heartbeat` has elapsed.
	// A record-carrying round emits every round and updates this clock, so the throttle governs only
	// genuinely-idle engines. `undefined` until the first emit.
	// NOTE: re-broadcasts willingness for every idle-but-willing cohort every T_willingness_heartbeat; if a
	// node ever serves very many idle cohorts, batch the heartbeats or lengthen the interval.
	let lastGossipAt: number | undefined;

	// One gossip round: sweep stale records (firing the `evicted` deltas), freeze each resident topic's
	// traffic summary, drain the touch/evicted deltas, then assemble + sign + broadcast the frame. An idle
	// engine (no topics, no deltas) normally builds no frame — except a willingness heartbeat, where an idle
	// but willing engine still emits a willingness/load-only frame so a cold cohort can bootstrap.
	const gossipRound = async (now: number): Promise<CohortGossipV1 | undefined> => {
		engine.sweepStale(now);
		const topicSummaries = residentTopics().map((topicId) =>
			toCohortTopicSummary(topicId, traffic.publish(topicId, now), {
				tier: tierOfTopic(store, topicId),
				directParticipants: store.directParticipants(topicId),
				promoted: promotion.isPromoted(topicId),
				// Single-cohort milestone: no child cohorts tracked. Child-cohort tracking is a follow-on.
				childCohortCount: 0,
			}),
		);
		const { records, evicted } = pending.drain();
		const idle = topicSummaries.length === 0 && records.length === 0 && evicted.length === 0;
		const heartbeat = idle && (lastGossipAt === undefined || now - lastGossipAt >= ctx.willingnessHeartbeatMs);
		const g = buildCohortGossip({
			fromMember: selfMember,
			coord: bytesToB64url(servedCoord),
			cohortEpoch: bytesToB64url(localEpoch()),
			treeTier,
			heartbeat,
			profile: ctx.profile,
			barometer: ctx.barometer,
			windowSeconds: DEFAULT_TRAFFIC_WINDOW_SECONDS,
			topicSummaries,
			records,
			evicted,
			timestamp: now,
		});
		if (g === undefined) {
			return undefined;
		}
		lastGossipAt = now;
		if (ctx.signGossip !== undefined) {
			g.signature = await ctx.signGossip(g);
		}
		bus.broadcast(g);
		return g;
	};

	// Time-driven demotion across resident topics; any returned notice is broadcast to the cohort (and the
	// parent coord) via the same path a promotion uses. Skipped without a key (verify-only signer can't
	// assemble); for the single-cohort tier-0 milestone the lifecycle never demotes (the root has no parent).
	const demotionTick = async (now: number): Promise<void> => {
		if (!canPublish) {
			return;
		}
		for (const topicId of residentTopics()) {
			let notice: DemotionNoticeV1 | undefined;
			try {
				notice = await promotion.maybeDemote(topicId, now);
			} catch (err) {
				log("cohort-topic: demotion sign/broadcast failed for topic %s: %o", bytesToB64url(topicId), err);
				continue;
			}
			if (notice !== undefined) {
				ctx.broadcastNotice?.(notice, servedCoord);
			}
		}
	};

	return {
		servedCoord,
		treeTier,
		engine,
		cohort,
		cohortIdentityAt: (epoch: Uint8Array): readonly string[] | undefined => rotationState.membersAt(bytesToB64url(epoch)),
		hasState: (): boolean => store.listAll().length > 0,
		holds: (topicId: Uint8Array, participantId: Uint8Array): boolean =>
			store.getByParticipant(topicId, participantId) !== undefined,
		records: (topicId: Uint8Array): readonly RegistrationRecord[] => store.listByTopic(topicId),
		topicTraffic: (topicId: Uint8Array): TopicTrafficV1 => traffic.snapshot(topicId),
		cohortView: (): CohortView => view,
		servesTopic: (topicId: Uint8Array): boolean =>
			store.directParticipants(topicId) > 0 || coldStart.get(topicId) !== undefined,
		budgetHasTopic: (topicId: Uint8Array): boolean => topicBudget.has(topicId),
		budgetParticipantCount: (topicId: Uint8Array): number | undefined => topicBudget.participantCount(topicId),
		forwarder: (topicId: Uint8Array): Forwarder | undefined => coldStart.get(topicId),
		isPromoted: (topicId: Uint8Array): boolean => promotion.isPromoted(topicId),
		applyPromotionNotice: (notice, now): void => promotion.applyPromotionNotice(notice, now),
		applyDemotionNotice: (notice, now): void => promotion.applyDemotionNotice(notice, now),
		onStabilized: (now: number): Promise<MembershipCertV1 | undefined> => publishMembership(now, false),
		pumpMembership: (now: number): Promise<MembershipCertV1 | undefined> => publishMembership(now, true),
		gossipRound,
		demotionTick,
		close: (): void => bus.close(),
	};
}

/**
 * Resolve an inbound `RenewV1` to the coord engine holding its record and run the renewal. A `RenewV1`
 * carries no `treeTier`, so the held record — not a recomputed coord — names the cohort. If no engine
 * on this host holds it (cross-node renewal, post-restart eviction, or replication lag), reply
 * `unknown_registration` so the participant's failover loop tries its backups and ultimately re-runs
 * the `d_max` lookup (§TTL and renewal) — never throw.
 */
export function resolveRenew(registry: CoordRegistry, renew: RenewV1, now: number): RenewReplyV1 {
	const topicId = b64urlToBytes(renew.topicId);
	const participantId = b64urlToBytes(renew.participantId);
	const holder = registry.findHolder(topicId, participantId);
	if (holder === undefined) {
		return { v: 1, result: "unknown_registration" };
	}
	return holder.engine.handleRenew(renew, now);
}

// --- intra-cohort sign endorsement ---

/** Dependencies for the `/sign` endorsement policy ({@link handleSignRequest}). */
export interface SignEndorsementDeps {
	/** The node's libp2p key (signs the endorsement). Absent → every request is refused (no key to sign with). */
	readonly privateKey: PrivateKey | undefined;
	/** Self's dialable member id (UTF-8 peer-id string bytes). */
	readonly selfMember: Uint8Array;
	/** Cohort member peer-id strings around `coord` (self included). */
	readonly cohortMembersAround: (coord: RingCoord) => string[];
	/** Current cohort epoch (raw bytes) for `coord`. */
	readonly currentEpoch: (coord: RingCoord) => Uint8Array;
	/**
	 * For a `"rotation"` request: the cohort member peer-id strings this node served under `epoch` (the
	 * predecessor epoch carried as `request.cohortEpoch`), or `undefined` if it tracked no such epoch. The
	 * host wires it to the served coord's {@link CoordEngine.cohortIdentityAt}; absent → rotation
	 * endorsement is unavailable (a node with no per-coord rotation history refuses the hand-off).
	 */
	readonly priorCohortMembersAt?: (coord: RingCoord, epoch: Uint8Array) => readonly string[] | undefined;
	/**
	 * The endorser's own canonical `MembershipCertV1` signable fields for `coord` at its **current** epoch,
	 * re-derived from its own cohort snapshot ({@link membershipCertSignable} with `stabilizedAt`
	 * omitted/ignored). Binds a `membership` endorsement to the endorser's independent view so a cohort
	 * insider cannot collect honest signatures over a cert the cohort never agreed to (falsified `members`
	 * or `cohortCoord`). `cohortEpoch` here MUST equal `bytesToB64url(currentEpoch(coord))`; `members` is the
	 * ascending-sorted base64url cohort set (the cert / sharding order). Absent → a `membership` request is
	 * refused (no view to bind the cert against). See `cohort-topic-sign-endorsement-payload-binding`.
	 */
	readonly expectedMembershipFields?: (coord: RingCoord) => { cohortCoord: string; cohortEpoch: string; members: string[] };
	/**
	 * Wall clock (ms) for the `stabilizedAt` far-future sanity bound on a `membership` payload. The host
	 * wires {@link Date.now}; tests inject a fixed clock. Absent → the far-future bound is skipped (only
	 * finiteness is enforced), keeping minimal / key-less composition working.
	 */
	readonly now?: () => number;
}

/** Tolerated future skew (ms) for a `membership` payload's `stabilizedAt` — a value beyond this is refused. */
const SIGN_STABILIZED_AT_SKEW_MS = 5_000;

/** The canonical signable-image tag a non-`rotation` {@link SignKind} must carry (binds tag ↔ kind). */
const SIGNABLE_IMAGE_TAG: Record<Exclude<SignKind, "rotation">, string> = {
	membership: "MembershipCertV1",
	promotion: "PromotionNoticeV1",
	demotion: "DemotionNoticeV1",
};

/**
 * Decode a `/sign` payload's canonical signable array image — `utf8(JSON.stringify([...]))` produced by
 * `sig/payloads.ts`. Returns the decoded array, or `undefined` when the bytes are not base64url of a JSON
 * array. NOTE: the payload is a raw signable image, **not** a `CohortMessageV1`, so it is decoded with
 * `JSON.parse`, never `decodeCohortMessage`.
 */
function decodeSignableImage(payloadB64: string): unknown[] | undefined {
	try {
		const decoded = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as unknown;
		return Array.isArray(decoded) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Deep-equal of an unknown payload field against the endorser's own ascending-sorted base64url member
 * list. Guards the `unknown` (a non-array payload field → not a match) before delegating to the shared
 * ordered-string-array equality; element-wise `!==` makes a non-string entry a mismatch.
 */
function sameMemberList(image: unknown, expected: readonly string[]): boolean {
	return Array.isArray(image) && sameStringOrder(image, expected);
}

/**
 * The `/sign` endorsement policy: decide whether to endorse a {@link SignRequestV1} and, if so, return
 * this node's Ed25519 peer-key signature over the **exact** request payload. A member endorses only when
 * both it and the requester are members of the cohort around `coord` under the request's epoch, **and**
 * the payload bytes re-derive to something this node independently agrees to attest — so it never signs
 * for outsiders and never blindly signs requester-supplied bytes. It still signs the exact image (no
 * re-canonicalization), so the assembled signature verifies against what the requester collected.
 *
 * **Payload binding (cohort-topic-sign-endorsement-payload-binding).** The cohort + wire-epoch gates never
 * inspect `request.payload`; without binding it an insider could collect honest signatures over a cert the
 * cohort never agreed to. After those gates the endorser decodes the canonical signable image
 * (`sig/payloads.ts` — a `JSON.parse`d array, NOT a `CohortMessageV1`) and refuses unless:
 *
 * - **all kinds** — the image tag matches the kind (`membership`→`MembershipCertV1`, etc.) and the
 *   payload-internal `cohortEpoch` equals this node's current epoch for `coord`; and
 * - **`membership`** — `cohortCoord`, the full `members` list (deep-equal to the endorser's own ascending
 *   re-derived set), and a finite, not-far-future `stabilizedAt` all match its independent view
 *   ({@link SignEndorsementDeps.expectedMembershipFields}). Because epoch = H(members) in this host, the
 *   members and internal-epoch checks are mutually reinforcing: a forged member list cannot also carry the
 *   honest epoch. The participant verifier still independently re-checks `signers ⊆ cert.members`.
 *
 * The kind-specific **hot/cold** refinement for `promotion` / `demotion` (the endorser additionally
 * requiring its own replicated `directParticipants` to be hot / cold) remains deferred: it needs a
 * per-topic binding the `(payload, minSigs)` port can't carry and gossip record replication that is still
 * interim. Parked in `cohort-topic-sign-endorsement-hotcold-refinement` (backlog).
 *
 * **`"rotation"` (epoch hand-off).** A rotation request carries the **prior** epoch as `cohortEpoch` and
 * asks the outgoing cohort to sign the *successor* cert. The gate therefore checks **prior**-epoch
 * membership instead of current: the endorser must have served the cohort at `prevEpoch`, and the
 * requester must have been a member of that prior cohort too (the genuinely outgoing set). The verifier
 * still independently re-checks `rotationSigners ⊆ predecessor-cert.members`, so this gate is the
 * load-shedding sanity check, not the trust root. See `cohort-topic-trust-anchor-rotation-production`.
 */
export async function handleSignRequest(request: SignRequestV1, fromPeerStr: string, deps: SignEndorsementDeps): Promise<SignReplyV1> {
	if (deps.privateKey === undefined) {
		return { v: 1, refused: true, reason: "node has no signing key" };
	}
	const coord = b64urlToBytes(request.coord);
	const selfStr = bytesToPeerIdString(deps.selfMember);

	if (request.kind === "rotation") {
		// Prior-epoch gate: endorse a hand-off only from an epoch THIS node was a member of, and only for a
		// requester that was a member of that same prior cohort. `request.cohortEpoch` IS the prevEpoch.
		const prevEpoch = b64urlToBytes(request.cohortEpoch);
		const priorMembers = deps.priorCohortMembersAt?.(coord, prevEpoch);
		if (priorMembers === undefined) {
			return { v: 1, refused: true, reason: "not a member of the prior cohort at prevEpoch" };
		}
		if (!priorMembers.includes(selfStr)) {
			return { v: 1, refused: true, reason: "self not in the prior cohort" };
		}
		if (!priorMembers.includes(fromPeerStr)) {
			return { v: 1, refused: true, reason: "requester not in the prior cohort" };
		}
		// Structural sanity only: a rotation carries the SUCCESSOR cert image. Full successor re-derivation is
		// out of scope here (the endorser is the OUTGOING cohort and may not know the successor member set), so
		// the prior-epoch gate stays the trust check — but reject a payload that is not even a MembershipCertV1
		// image so the gate cannot be tricked into signing junk bytes. See the rotation follow-on note.
		const rotImage = decodeSignableImage(request.payload);
		if (rotImage === undefined || rotImage[0] !== SIGNABLE_IMAGE_TAG.membership) {
			return { v: 1, refused: true, reason: "rotation payload is not a MembershipCertV1 image" };
		}
		const signature = await signPeer(deps.privateKey, b64urlToBytes(request.payload));
		return { v: 1, signer: bytesToB64url(deps.selfMember), signature: bytesToB64url(signature) };
	}

	const members = deps.cohortMembersAround(coord);
	if (!members.includes(selfStr)) {
		return { v: 1, refused: true, reason: "not a cohort member for coord" };
	}
	if (!members.includes(fromPeerStr)) {
		return { v: 1, refused: true, reason: "requester not in cohort" };
	}
	if (!bytesEqual(b64urlToBytes(request.cohortEpoch), deps.currentEpoch(coord))) {
		return { v: 1, refused: true, reason: "cohort epoch mismatch" };
	}

	// --- payload binding: re-derive what we are willing to attest and refuse anything that does not match ---
	// The wire-field gates above never inspect `request.payload`; without this an insider could collect honest
	// signatures over a cert the cohort never agreed to (falsified members / kind-mismatched bytes).
	const image = decodeSignableImage(request.payload);
	if (image === undefined) {
		return { v: 1, refused: true, reason: "payload is not a decodable signable image" };
	}
	// All kinds — bind tag ↔ kind (a `membership` request must carry a MembershipCertV1 image, closing the
	// kind-mismatch hole where a kind-agnostic threshold blob verifies for whatever the bytes decode to).
	const expectedTag = SIGNABLE_IMAGE_TAG[request.kind];
	if (image[0] !== expectedTag) {
		return { v: 1, refused: true, reason: `payload kind tag mismatch (expected ${expectedTag})` };
	}
	// All kinds — bind the payload-internal `cohortEpoch` to our own current epoch (closes the falsified-internal
	// -epoch hole, for promotion / demotion too). It is `image[2]` for a MembershipCertV1 image and the last
	// element for promotion / demotion (see `sig/payloads.ts`).
	// NOTE: this reads the notice epoch positionally as the LAST element — `sig/payloads.ts` deliberately keeps
	// `cohortEpoch` last (with the newer `cohortCoord` inserted just before it) to preserve this. Do not append
	// a field after `cohortEpoch` in those images without updating this read.
	const currentEpochB64 = bytesToB64url(deps.currentEpoch(coord));
	const embeddedEpoch = request.kind === "membership" ? image[2] : image[image.length - 1];
	if (embeddedEpoch !== currentEpochB64) {
		return { v: 1, refused: true, reason: "payload cohortEpoch does not match endorser view" };
	}

	if (request.kind === "membership") {
		// The core fix: bind coord + members + stabilizedAt to the endorser's independently re-derived view.
		// Because epoch = H(members) in this host, a forged member list cannot also carry the honest epoch — the
		// embedded-epoch gate above and this members gate are mutually reinforcing.
		const expected = deps.expectedMembershipFields?.(coord);
		if (expected === undefined) {
			return { v: 1, refused: true, reason: "no membership view to bind the cert against" };
		}
		if (image[1] !== expected.cohortCoord) {
			return { v: 1, refused: true, reason: "payload cohortCoord does not match endorser view" };
		}
		if (!sameMemberList(image[3], expected.members)) {
			return { v: 1, refused: true, reason: "payload members do not match endorser view" };
		}
		const stabilizedAt = image[4];
		if (typeof stabilizedAt !== "number" || !Number.isFinite(stabilizedAt)) {
			return { v: 1, refused: true, reason: "payload stabilizedAt is not a finite number" };
		}
		if (deps.now !== undefined && stabilizedAt > deps.now() + SIGN_STABILIZED_AT_SKEW_MS) {
			return { v: 1, refused: true, reason: "payload stabilizedAt is far-future" };
		}
	}

	const signature = await signPeer(deps.privateKey, b64urlToBytes(request.payload));
	return { v: 1, signer: bytesToB64url(deps.selfMember), signature: bytesToB64url(signature) };
}

// --- inbound promote-protocol notices (verify + apply) ---

/** A decoded `promote`-protocol frame, tagged by which notice it is. */
export type InboundNotice =
	| { readonly kind: "promotion"; readonly notice: PromotionNoticeV1 }
	| { readonly kind: "demotion"; readonly notice: DemotionNoticeV1 };

/** Outcome of {@link verifyAndApplyNotice}. */
export type NoticeOutcome = "applied" | "untrusted" | "dropped";

/**
 * Outcome of {@link handleInboundNotice} — the {@link NoticeOutcome}s plus the cheap pre-verify drops the
 * anti-abuse gate adds before any signature work runs:
 *
 * - `"undecodable"`  — the frame is neither a promotion nor a demotion notice.
 * - `"rate-limited"` — the dialing `(peer, topic)` is over its `register_rate_per_peer` ceiling.
 * - `"stale"`        — the notice's `effectiveAt` is at or below the last *applied* notice for its served
 *   cohort coord (a replay / out-of-order frame); dropped before `verifyMessage`.
 */
export type InboundNoticeResult = NoticeOutcome | "undecodable" | "rate-limited" | "stale";

/**
 * Node-level anti-abuse state for the `promote` handler (`cohort-topic-promote-handler-verify-amplification`).
 * The handler is node-level (one per node, not per coord), so unlike the per-{@link CoordEngine} register-path
 * guards it owns its own instances here.
 */
export interface PromoteGate {
	/**
	 * Per-`(peer, topic)` inbound-notice rate limiter (reuses the register-path limiter). A peer streaming
	 * forged notices at one topic is dropped once it exceeds the ceiling, before any verify / membership work.
	 */
	readonly rateLimiter: RegisterRateLimiter;
	/**
	 * Per-served-coord high-water (key: `` `${cohortCoord}|${tier}` ``) of the last *applied* notice's
	 * `effectiveAt`. A notice at or below the water is a replay / out-of-order frame and is dropped before
	 * verification. Keyed by the served coord — not `(topic, tier)` — so two sibling cohorts a node serves for
	 * one `(topic, tier)` do not share an entry (an applied notice for one must not stale-drop a legitimate
	 * notice for the other). Updated **only** on an `"applied"` outcome (never on an unverified frame), so a
	 * forged notice carrying `effectiveAt = Infinity` cannot poison the water and lock out legitimate notices.
	 *
	 * **Bounded.** An {@link LruMap} capped at {@link PROMOTE_HIGHWATER_MAX_KEYS} so the retain-forever shape
	 * cannot leak on a long-lived node. Unlike the limiter this is *not* attacker-growable (it is written only
	 * on an `"applied"` outcome, which needs a verified `≥ minSigs` cohort signature — reads of forged
	 * `topicId`s via `.get` create nothing), so it never evicts under legitimate load; the cap is the
	 * belt-and-suspenders bound. Evicting an entry is safe: the engine's {@link PromotionLifecycle} is
	 * independently idempotent and `effectiveAt`-ordered (`PromotionState.lastEffectiveAt`), so an
	 * evicted-then-replayed older notice re-verifies (one bounded, rate-capped `verifyMessage`) and then
	 * **no-ops at the engine** rather than (re-)applying. Water absence only *opens* the gate, never closes it.
	 */
	readonly highWater: LruMap<string, number>;
}

/**
 * Hard cap on tracked per-served-coord high-water entries; the least-recently-touched are evicted beyond
 * this. A modest bound is plenty — only verified applies grow the map, so it never evicts under legitimate
 * load — but it caps the otherwise retain-forever shape on a long-lived node.
 */
export const PROMOTE_HIGHWATER_MAX_KEYS = 8192;

/** Build the default {@link PromoteGate} from the (optional) anti-DoS rate-limiter config. */
export function createPromoteGate(rateLimiterConfig?: RegisterRateLimiterConfig): PromoteGate {
	return { rateLimiter: createRegisterRateLimiter(rateLimiterConfig), highWater: new LruMap<string, number>(PROMOTE_HIGHWATER_MAX_KEYS) };
}

/**
 * The slice of a {@link CoordEngine} the inbound notice path needs: the cohort coord the signers should
 * belong to (for verification) and the apply hooks. {@link CoordEngine} satisfies this; tests can pass a
 * minimal stand-in.
 */
export interface NoticeApplyTarget {
	readonly servedCoord: RingCoord;
	applyPromotionNotice(notice: PromotionNoticeV1, now: number): void;
	applyDemotionNotice(notice: DemotionNoticeV1, now: number): void;
}

/**
 * Decode a `promote`-protocol frame as a {@link PromotionNoticeV1} or {@link DemotionNoticeV1} (try one,
 * then the other), or `undefined` if it is neither. The two shapes are disjoint — a promotion carries
 * `fromTier`/`toTier`, a demotion carries `parentCohortCoord` — so the structural validators cleanly
 * discriminate.
 */
export function decodeInboundNotice(frame: Uint8Array, maxBytes?: number): InboundNotice | undefined {
	const decoded = decodeCohortMessage(frame, maxBytes);
	const promotion = tryValidate(() => validatePromotionNoticeV1(decoded));
	if (promotion !== undefined) {
		return { kind: "promotion", notice: promotion };
	}
	const demotion = tryValidate(() => validateDemotionNoticeV1(decoded));
	if (demotion !== undefined) {
		return { kind: "demotion", notice: demotion };
	}
	return undefined;
}

/**
 * Per-coord minimum interval (ms) between membership refetches on the inbound `promote` path. Caps the
 * amplification a flood of forged notices can drive: a stream of verify-misses triggers at most one
 * `source.fetch()` per coord per this window, while a cold cache / membership rotation still re-fetches
 * once it elapses (eventual refetch preserved). 60 s mirrors the anti-DoS rate window.
 */
export const PROMOTE_REFETCH_MIN_INTERVAL_MS = 60_000;

/**
 * Verify an inbound notice's threshold signature against the cohort `MembershipCertV1` for
 * `target.servedCoord` and, on success, apply it to the target's promotion lifecycle. Returns:
 *
 * - `"dropped"`  — no local engine serves the notice's carried `cohortCoord` (e.g. a demotion arriving at a
 *   parent-only node that does not serve the demoting child's coord); nothing to apply to.
 * - `"untrusted"` — the `signers` are not a `≥ minSigs` subset of the cohort cert, or the multisig does
 *   not verify (a forged single-signer / short-quorum notice); local state is left unchanged.
 * - `"applied"`  — verified and applied.
 *
 * The payload is rebuilt with the canonical `sig/payloads` image the signer used — never re-canonicalized
 * independently. The verifier owns the cert lookup; this function never re-verifies inside the apply step
 * (db-core trusts this gate).
 *
 * **Bounded refetch (anti-amplification).** Both verify calls pass a {@link PROMOTE_REFETCH_MIN_INTERVAL_MS}
 * refetch bound, so a stream of forged notices drives at most **one** membership `source.fetch()` per coord
 * per interval rather than one dial per message. Eventual refetch is preserved (full suppression was
 * rejected: a legitimate sibling-adopt / demotion-to-parent notice whose cohort cert is not yet locally
 * cached must still be able to fetch it once — see `live-tier.spec.ts` test 4). A node that has cached its
 * own cohort cert via `onCertPublished` verifies a sibling-adopt notice from cache with zero fetches; a
 * cold-cache receiver pays one bounded fetch. Per `cohort-topic-promote-handler-verify-amplification`.
 */
export async function verifyAndApplyNotice(
	inbound: InboundNotice,
	target: NoticeApplyTarget | undefined,
	verifier: MembershipVerifier,
	now: number,
): Promise<NoticeOutcome> {
	if (target === undefined) {
		return "dropped";
	}
	let signers: Uint8Array[];
	let sig: Uint8Array;
	try {
		signers = inbound.notice.signers.map(b64urlToBytes);
		sig = b64urlToBytes(inbound.notice.thresholdSig);
	} catch {
		return "untrusted"; // a signer / sig that is not valid base64url cannot verify
	}
	// Narrow on `inbound` (not a destructured `notice`) so the tier field and apply hook are typed per kind.
	if (inbound.kind === "promotion") {
		const payload = promotionNoticeSigningPayload(inbound.notice);
		const result = await verifier.verifyMessage(signers, target.servedCoord, inbound.notice.fromTier, payload, sig, { minRefetchIntervalMs: PROMOTE_REFETCH_MIN_INTERVAL_MS, now });
		if (result !== "verified") {
			return "untrusted";
		}
		target.applyPromotionNotice(inbound.notice, now);
		return "applied";
	}
	const payload = demotionNoticeSigningPayload(inbound.notice);
	const result = await verifier.verifyMessage(signers, target.servedCoord, inbound.notice.tier, payload, sig, { minRefetchIntervalMs: PROMOTE_REFETCH_MIN_INTERVAL_MS, now });
	if (result !== "verified") {
		return "untrusted";
	}
	target.applyDemotionNotice(inbound.notice, now);
	return "applied";
}

/**
 * Full inbound `promote`-frame pipeline with the anti-abuse gate, exported so it is unit-testable without a
 * live node (`cohort-topic-promote-handler-verify-amplification`). Runs the cheapest checks first — each
 * step strictly cheaper than the next — so a flood of forged frames is shed before any signature / network
 * work:
 *
 * ```
 *   decode → per-(peer,topic) rate limit → resolve engine by carried cohortCoord → effectiveAt high-water → verify+apply
 * ```
 *
 * - **Rate limit** (`gate.rateLimiter`) keys on `(from, topicId)`; an over-rate peer is dropped before the
 *   coord lookup and the verify, so a peer cannot amplify junk into verify/network work.
 * - **Resolve engine by `cohortCoord`** ({@link CoordRegistry.findByCoord}) — the exact served coord the
 *   notice was decided for, covered by its signature. A node serving several sibling cohorts for one
 *   `(topic, tier)` applies the notice to the cohort that produced it, never a first-match `(topic, tier)`
 *   scan; a coord this node does not serve is dropped.
 * - **High-water** (`gate.highWater`, keyed per served `cohortCoord`) drops a notice whose `effectiveAt` is
 *   at or below the last *applied* one — a replay / out-of-order frame — before `verifyMessage`. It is
 *   advanced **only** on an `"applied"` outcome, so a forged frame (which never verifies) cannot poison it.
 *   Keying by coord (not `(topic, tier)`) keeps two sibling cohorts on one node from sharing a water.
 * - The receiver-side `cohortEpoch` is intentionally **not** gated on: the epoch rotates on every
 *   membership change, so a legitimately in-flight notice can briefly carry the prior epoch right after a
 *   rotation — making an epoch check a brittle, false-positive-prone filter. The rate limiter + high-water
 *   are the load-bearing defenses; the bounded refetch (in {@link verifyAndApplyNotice}) caps the network
 *   amplification on the verify itself.
 *
 * `from` is the dialing peer's substrate bytes ({@link peerIdToBytes}); the node handler converts the
 * libp2p `PeerId` before calling. One-way contract: the caller sends no ack regardless of outcome.
 */
export async function handleInboundNotice(
	frame: Uint8Array,
	from: Uint8Array,
	registry: CoordRegistry,
	verifier: MembershipVerifier,
	gate: PromoteGate,
	now: number,
	maxBytes?: number,
): Promise<InboundNoticeResult> {
	const inbound = decodeInboundNotice(frame, maxBytes);
	if (inbound === undefined) {
		log("promote: dropped an undecodable notice frame");
		return "undecodable";
	}
	const tier = inbound.kind === "promotion" ? inbound.notice.fromTier : inbound.notice.tier;
	const topicId = b64urlToBytes(inbound.notice.topicId);

	// Per-(peer, topic) rate limit — before the coord lookup and the verify.
	if (gate.rateLimiter.check(from, topicId, now).ok === false) {
		log("promote: rate-limited %s notice for topic %s tier %d", inbound.kind, inbound.notice.topicId, tier);
		return "rate-limited";
	}

	// Route by the notice's signed `cohortCoord` — the exact served coord the deciding cohort sits at. A node
	// serving several sibling cohorts for one `(topic, tier)` (possible at `d ≥ 1`) thus applies the notice to
	// the cohort that produced it, and `verifyAndApplyNotice` verifies against that same coord's cert. The coord
	// is covered by the threshold signature, so it cannot be rewritten to hijack a sibling. A coord this node
	// does not serve → dropped (e.g. a demotion fanned to a parent-only node — see `noticeBroadcastCoords`).
	const target = registry.findByCoord(b64urlToBytes(inbound.notice.cohortCoord));
	if (target === undefined) {
		log("promote: dropped %s notice for topic %s tier %d (no engine at coord %s)", inbound.kind, inbound.notice.topicId, tier, inbound.notice.cohortCoord);
		return "dropped";
	}

	// Freshness / replay gate: drop an at-or-below-high-water notice before the expensive verify. Keyed by the
	// served coord (which uniquely identifies the cohort) so two sibling cohorts on one node do not share a
	// high-water — an applied notice for cohort A must not stale-drop a legitimate cohort-B notice. `tier` is
	// kept in the key only for readability.
	const waterKey = `${inbound.notice.cohortCoord}|${tier}`;
	const water = gate.highWater.get(waterKey);
	if (water !== undefined && inbound.notice.effectiveAt <= water) {
		log("promote: stale %s notice for topic %s tier %d (effectiveAt %d <= high-water %d)", inbound.kind, inbound.notice.topicId, tier, inbound.notice.effectiveAt, water);
		return "stale";
	}

	const outcome = await verifyAndApplyNotice(inbound, target, verifier, now);
	if (outcome === "applied") {
		// Advance the high-water only on a *verified-and-applied* notice, so a forged frame cannot poison it.
		gate.highWater.set(waterKey, inbound.notice.effectiveAt);
	} else {
		log("promote: %s %s notice for topic %s tier %d", outcome, inbound.kind, inbound.notice.topicId, tier);
	}
	return outcome;
}

/**
 * The cohort coords a notice is broadcast to over the `promote` protocol: always the cohort around
 * `servedCoord` (siblings adopt the state); for a demotion, additionally the parent cohort coord (so the
 * parent's `childCohortCount` bookkeeping converges). Pure — exported for testing the fan-out targets.
 */
export function noticeBroadcastCoords(notice: PromotionNoticeV1 | DemotionNoticeV1, servedCoord: RingCoord): RingCoord[] {
	if ("parentCohortCoord" in notice) {
		return [servedCoord, b64urlToBytes(notice.parentCohortCoord)];
	}
	return [servedCoord];
}

// --- helpers ---

/**
 * Cross-check the cohort FRET routed the activity to against the locally recomputed assembly around
 * `servedCoord`. A mismatch (a slightly stale routing table) is logged; the recomputed assembly is
 * trusted, so renewal / gossip / signing — which run outside the activity callback — stay consistent.
 */
function crossCheckCohort(fret: FretService, wantK: number, servedCoord: RingCoord, fretCohort: readonly string[]): void {
	const assembled = fret.assembleCohort(servedCoord, wantK);
	if (!sameMemberSet(fretCohort, assembled)) {
		log(
			"cohort cross-check mismatch at coord %s: FRET-routed=%o assembled=%o; trusting the recomputed assembly",
			bytesToB64url(servedCoord),
			fretCohort,
			assembled,
		);
	}
}

/** Positional equality over two string lists (the first-`k − x` rotation-change check). */
function sameStringOrder(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/** Set equality over two peer-id-string lists (order-independent). */
function sameMemberSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	const seen = new Set(a);
	return b.every((m) => seen.has(m));
}

/** Count topics this member is currently `primary` for at `tier` (the willingness budget input). */
function countPrimaryTopics(store: ReturnType<typeof createRegistrationStore>, self: Uint8Array, tier: Tier): number {
	const seen = new Set<string>();
	for (const rec of store.listAll()) {
		if (rec.tier === tier && bytesToB64url(rec.primary) === bytesToB64url(self)) {
			seen.add(bytesToB64url(rec.topicId));
		}
	}
	return seen.size;
}

/** Resolve a topic's op tier from any held record (0 if none yet). */
function tierOfTopic(store: ReturnType<typeof createRegistrationStore>, topicId: Uint8Array): Tier {
	const recs = store.listByTopic(topicId);
	return (recs.length > 0 ? recs[0]!.tier : 0) as Tier;
}

async function registerProtocolHandlers(
	node: Libp2p,
	protocols: CohortTopicProtocols,
	registry: CoordRegistry,
	dispatchRegister: (reg: RegisterV1, fretCohort: readonly string[] | undefined, now: number) => Promise<RegisterReplyV1>,
	signEndorse: (request: SignRequestV1, fromPeerStr: string) => Promise<SignReplyV1>,
	verifier: MembershipVerifier,
	promoteGate: PromoteGate,
	gossipTransport: FretCohortGossipTransport,
	/** Instantiate a cold sibling's coord engine off a verified co-member frame (§Cold-start instantiation). */
	maybeInstantiateColdSibling: (frame: Uint8Array) => void,
	publishSink: FretMembershipPublishSink,
	membershipSource: FretMembershipSource,
	selfCoord: RingCoord,
	maxBytes: number,
): Promise<void> {
	await Promise.all([
		// register: a direct dial carries either a RegisterV1 (re-attach walk fallback) or a RenewV1 (ping).
		node.handle(protocols.register, makeFrameHandler(async (frame): Promise<Uint8Array | undefined> => {
			const decoded = decodeCohortMessage(frame, maxBytes);
			const renew = tryValidate(() => validateRenewV1(decoded));
			if (renew !== undefined) {
				return encodeCohortMessage(resolveRenew(registry, renew, Date.now()), maxBytes);
			}
			const reg = validateRegisterV1(decoded);
			// Direct dial (not FRET-routed): no cohort member list to cross-check against.
			const reply = await dispatchRegister(reg, undefined, Date.now());
			return encodeCohortMessage(reply, maxBytes);
		}, maxBytes)),

		// cohort-gossip: feed inbound gossip into the shared transport (one-way). It fans the frame to
		// every coord engine's bus; per-bus epoch matching governs which engine merges the record deltas.
		// First, if this is a verified co-member frame for a coord we hold no engine for, instantiate that
		// engine (§Cold-start instantiation) so its freshly-subscribed bus merges this very frame on `deliver`.
		node.handle(protocols.gossip, makeFrameHandler(async (frame, from): Promise<Uint8Array | undefined> => {
			maybeInstantiateColdSibling(frame);
			gossipTransport.deliver(from.toString(), frame);
			return undefined;
		}, maxBytes)),

		// promote: threshold-signed promotion/demotion notices (one-way, gossip-style fan-out). The dialing
		// peer arrives as `from`, so the handler can gate per-(peer, topic) before any expensive work. The
		// full pipeline (rate limit → findServing → effectiveAt high-water → verify+apply, bounded
		// refetch) lives in the exported `handleInboundNotice`; it logs and never throws on the stream.
		node.handle(protocols.promote, makeFrameHandler(async (frame, from): Promise<Uint8Array | undefined> => {
			await handleInboundNotice(frame, peerIdToBytes(from), registry, verifier, promoteGate, Date.now(), maxBytes);
			return undefined; // one-way: match the gossip-style fan-out (no ack frame)
		}, maxBytes)),

		// membership: serve this node's latest published cert; cache any cert the requester returns.
		node.handle(protocols.membership, makeFrameHandler(async (frame): Promise<Uint8Array | undefined> => {
			void frame; // request frame is the raw coord; this node serves its own cohort cert
			const latest = publishSink.latest();
			if (latest !== undefined) {
				membershipSource.cache(selfCoord, latest);
			}
			return latest ?? new Uint8Array(0);
		}, maxBytes)),

		// sign: per-member endorsement for threshold-signature assembly. Validate the request, run the
		// endorsement policy, and reply with this node's peer-key signature over the request payload (or a
		// refusal). One Ed25519 sign and nothing more — the cohort + epoch gate bounds who we sign for.
		node.handle(protocols.sign, makeFrameHandler(async (frame, from): Promise<Uint8Array | undefined> => {
			const request = validateSignRequestV1(decodeCohortMessage(frame, maxBytes));
			const reply = await signEndorse(request, from.toString());
			return encodeCohortMessage(reply, maxBytes);
		}, maxBytes)),
	]);
}

/** Wrap a frame handler in the read-one / reply-one libp2p stream lifecycle. */
function makeFrameHandler(
	handle: (frame: Uint8Array, from: PeerId) => Promise<Uint8Array | undefined>,
	maxBytes: number,
): (stream: Stream, connection: Connection) => void {
	return (stream: Stream, connection: Connection): void => {
		void (async (): Promise<void> => {
			try {
				const frame = await readAllBounded(stream, maxBytes);
				const reply = await handle(frame, connection.remotePeer);
				if (reply !== undefined) {
					stream.send(reply);
				}
				await stream.close();
			} catch {
				try {
					stream.abort(new Error("cohort-topic handler error"));
				} catch {
					/* already aborted */
				}
			}
		})();
	};
}

/** Run `fn`, returning `undefined` if it throws (used to try one validator then fall through). */
function tryValidate<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}
