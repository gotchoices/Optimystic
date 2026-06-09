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
 * **Scope (mock-tier e2e pending).** `followOn` derivation for a promoted-redirect arrival is parked in
 * backlog (`cohort-topic-followon-derivation`); this milestone serves a **single tier-0 cohort**, so
 * `followOn` stays `false` and tier-0 bootstrap instantiation goes through the `bootstrap: true` path.
 * The behavioral substrate is validated at mock-tier by `test/cohort-topic/service.spec.ts`.
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
	coreProfile,
	DEFAULT_MIN_SIGS,
	DEFAULT_TRAFFIC_WINDOW_SECONDS,
	bytesToB64url,
	b64urlToBytes,
	bytesEqual,
	encodeCohortMessage,
	decodeCohortMessage,
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
	type CohortGossipV1,
	type CohortGossipSignable,
	type CohortTopicService,
	type CohortMemberEngine,
	type CohortSnapshot,
	type CohortSnapshotView,
	type CohortSigner,
	type CohortView,
	type DemotionNoticeV1,
	type MembershipCertPublisher,
	type MembershipCertV1,
	type MembershipVerifier,
	type NodeProfile,
	type ParticipantSigner,
	type PromotionNoticeV1,
	type RegisterReplyV1,
	type RegisterV1,
	type RenewReplyV1,
	type RenewV1,
	type RingCoord,
	type SignKind,
	type SignReplyV1,
	type SignRequestV1,
	type Tier,
	type IMembershipSource,
} from "@optimystic/db-core";
import { peerIdFromString } from "@libp2p/peer-id";
import { FretTopicRouter } from "./topic-router.js";
import { FretCohortGossipTransport, type CohortPeerResolver } from "./cohort-gossip-transport.js";
import { buildCohortGossip, createPendingDeltas, DEFAULT_GOSSIP_INTERVAL_MS } from "./cohort-gossip-driver.js";
import { FretMembershipSource } from "./membership-source.js";
import { FretMembershipPublishSink } from "./membership-publish-sink.js";
import { FretCohortThresholdCrypto, createVerifyOnlyThresholdCrypto } from "./threshold-crypto.js";
import { FretSizeEstimator } from "./size-estimator.js";
import { peerIdToBytes, bytesToPeerIdString } from "./peer-codec.js";
import { signPeer, verifyPeerSig } from "./peer-sig.js";
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
	 * The node's libp2p Ed25519 private key. Required for the live participant signer: register/renew
	 * bodies are peer-key-signed over their canonical image, and inbound register/`reattach` signatures
	 * are verified against the participant's claimed peer id. libp2p does not expose the key off
	 * `node.peerId`, so it is threaded explicitly (mirrors `clusterMember` / `DisputeService`, sourced
	 * from `options.privateKey ?? generateKeyPair('Ed25519')` in `libp2p-node-base.ts`). When omitted,
	 * the host falls back to the interim empty-string signer (one-time warn) and does **not** enforce
	 * inbound participant-signature verification, so unit tests compose without a key.
	 */
	readonly privateKey?: PrivateKey;
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
	/** True iff this engine currently holds any registration record (a cold probe leaves it empty). */
	hasState(): boolean;
	/** True iff this engine holds the record for `(topicId, participantId)` — the renewal lookup key. */
	holds(topicId: Uint8Array, participantId: Uint8Array): boolean;
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
	 * The engine serving `topicId` at `treeTier`, or `undefined` (inbound promote/demote notice dispatch).
	 * A served coord embeds `(tier, topic)`, so at most one engine matches — the cohort the notice's
	 * signers belong to. `undefined` means this node serves no such cohort (e.g. a demotion arriving at a
	 * parent that does not track the child), so the notice is dropped rather than applied.
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
	/** Membership-cert sink the per-coord publisher serves through (node-wide; serves this node's cohort). */
	readonly publishSink: FretMembershipPublishSink;
	/**
	 * The node's libp2p key, threaded so each coord engine's threshold signer can add self's own chunk.
	 * Absent → key-less interim mode: the per-coord signer cannot assemble (the publisher/promotion paths
	 * are not driven in that mode), so threshold signing is unavailable until a key is supplied.
	 */
	readonly privateKey?: PrivateKey;
	/** Dial a cohort member's `/sign` RPC (the threshold-assembly collection seam). */
	readonly dialSign: (peerIdStr: string, request: SignRequestV1) => Promise<SignReplyV1>;
	/** FRET two-sided assembly around `coord`, self prepended + deduped, with a deterministic epoch. */
	readonly cohortAround: (coord: RingCoord) => CohortSnapshotView;
	/** Verify an inbound `RegisterV1`'s participant peer-key signature (live-signer mode only). */
	readonly verifyRegisterSig?: (reg: RegisterV1) => boolean;
	/** Verify an inbound `reattach` `RenewV1`'s participant peer-key signature (live-signer mode only). */
	readonly verifyReattachSig?: (renew: RenewV1) => boolean;
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
	const verifyReattachSig = options.privateKey === undefined
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
		for (const coord of noticeBroadcastCoords(notice, servedCoord)) {
			gossipTransport.broadcastOver(protocols.promote, coord, frame);
		}
	};

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
		publishSink,
		privateKey: options.privateKey,
		dialSign,
		cohortAround,
		verifyRegisterSig,
		verifyReattachSig,
		signGossip,
		verifyGossip,
		broadcastNotice,
		// Cache this node's own freshly-published cohort cert into the verifier, so an inbound notice
		// signed by this node's cohort verifies locally without a network refetch. `verifier` is declared
		// just below; the closure only runs on a (later) publish, after it is initialized.
		onCertPublished: (cert: MembershipCertV1): void => verifier.cache(cert),
	};
	const registry = createCoordRegistry(ctx);

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
	const verifier = createMembershipVerifier({ signer: verifyingSigner, router: membershipRouter, minSigs });
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
	await registerProtocolHandlers(node, protocols, registry, dispatchRegister, signEndorse, verifier, gossipTransport, publishSink, membershipSource, selfCoord, maxBytes);
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
 * Compose one {@link CoordEngine} bound to `servedCoord`. The cohort it threshold-signs / shards with
 * is the FRET assembly around `servedCoord` (not the node's own ring position). The promotion tier
 * inputs are coord-derived: `treeTier` is fixed at instantiation; `parentCoord` is
 * `coord_{d-1}(participantCoord, topicId)` (the shard's parent shares the prefix, so any participant
 * routed here yields the same parent); `childCohortCount` is `0` for the single-cohort milestone.
 */
function createCoordEngine(ctx: CoordEngineContext, servedCoord: RingCoord, treeTier: number, participantCoord: Uint8Array): CoordEngine {
	const store = createRegistrationStore();
	const cohort = (): CohortSnapshotView => ctx.cohortAround(servedCoord);
	const localEpoch = (): Uint8Array => cohort().cohortEpoch;

	// Inbound gossip is routed to this bus by its `coord`; the optional auth gate (live-signer mode) drops
	// a frame whose `fromMember` signature is bad or who is not a member of the cohort around THIS coord.
	const bus = createCohortGossipBus({
		transport: ctx.transport,
		store,
		coord: servedCoord,
		localEpoch,
		verifyInbound: ctx.verifyGossip === undefined ? undefined : (g): boolean => ctx.verifyGossip!(g, servedCoord),
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
		cohortEpoch: localEpoch,
		signer: noticeSigner,
		config: { capPromote: undefined },
	});
	const coldStart = createColdStartManager({
		parentRegistrar: {
			registerWithParent: async (topicId: Uint8Array, parentCoord: Uint8Array, tier: number): Promise<void> => {
				// Interim: forwarder→parent registration over the router is the multi-tier promotion ticket's
				// job. A tier-0 (root) forwarder has no parent and serves immediately, so this is a no-op for
				// the single-cohort milestone.
				void topicId;
				void parentCoord;
				void tier;
			},
		},
	});
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
		verifyReattachSig: ctx.verifyReattachSig,
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
		verifyRegisterSig: ctx.verifyRegisterSig,
		// A promotion notice signed on an arrival is broadcast to the cohort around this served coord
		// (and the parent for a demotion). The engine only knows the notice; the host adds the coord.
		onNotice: (notice): void => ctx.broadcastNotice?.(notice, servedCoord),
		log,
	});

	// Publish + cache: feed each freshly-published cert into the verifier so inbound notices signed by
	// this cohort verify without a network refetch. Both hooks no-op in key-less interim mode (the
	// verify-only per-coord signer cannot assemble — see the `canPublish` contract).
	const publishAndCache = async (cert: Promise<MembershipCertV1 | undefined>): Promise<MembershipCertV1 | undefined> => {
		const published = await cert;
		if (published !== undefined) {
			ctx.onCertPublished?.(published);
		}
		return published;
	};

	/** Distinct topics this engine currently holds state for (the gossip-summary / demotion iteration set). */
	const residentTopics = (): Uint8Array[] => {
		const byKey = new Map<string, Uint8Array>();
		for (const rec of store.listAll()) {
			byKey.set(bytesToB64url(rec.topicId), rec.topicId);
		}
		return [...byKey.values()];
	};

	// One gossip round: sweep stale records (firing the `evicted` deltas), freeze each resident topic's
	// traffic summary, drain the touch/evicted deltas, then assemble + sign + broadcast the frame. Idle
	// empty engines (no topics, no deltas) build no frame and skip the broadcast.
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
		const g = buildCohortGossip({
			fromMember: selfMember,
			coord: bytesToB64url(servedCoord),
			cohortEpoch: bytesToB64url(localEpoch()),
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
		hasState: (): boolean => store.listAll().length > 0,
		holds: (topicId: Uint8Array, participantId: Uint8Array): boolean =>
			store.getByParticipant(topicId, participantId) !== undefined,
		cohortView: (): CohortView => view,
		servesTopic: (topicId: Uint8Array): boolean =>
			store.directParticipants(topicId) > 0 || coldStart.get(topicId) !== undefined,
		isPromoted: (topicId: Uint8Array): boolean => promotion.isPromoted(topicId),
		applyPromotionNotice: (notice, now): void => promotion.applyPromotionNotice(notice, now),
		applyDemotionNotice: (notice, now): void => promotion.applyDemotionNotice(notice, now),
		onStabilized: (now: number): Promise<MembershipCertV1 | undefined> =>
			canPublish ? publishAndCache(membershipPublisher.onStabilized(snapshotAt(now), now)) : Promise.resolve(undefined),
		pumpMembership: (now: number): Promise<MembershipCertV1 | undefined> =>
			canPublish ? publishAndCache(membershipPublisher.tick(snapshotAt(now), now)) : Promise.resolve(undefined),
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
}

/**
 * The `/sign` endorsement policy: decide whether to endorse a {@link SignRequestV1} and, if so, return
 * this node's Ed25519 peer-key signature over the **exact** request payload. A member endorses only when
 * both it and the requester are members of the cohort around `coord` under the request's epoch — so it
 * never signs for outsiders and never re-canonicalizes the bytes (it signs precisely what the assembled
 * signature will later be verified against). One Ed25519 sign and nothing more.
 *
 * The kind-specific refinement for `promotion` / `demotion` (the endorser additionally requiring its own
 * replicated `directParticipants` to be hot / cold) is deferred: it needs the per-topic binding the
 * `(payload, minSigs)` port can't carry and the gossip record replication that is still interim. For the
 * `membership` cert path — this milestone's deliverable — the cohort + epoch gate IS the full policy (the
 * participant verifier independently re-checks `signers ⊆ cert.members`). See the implement handoff.
 */
export async function handleSignRequest(request: SignRequestV1, fromPeerStr: string, deps: SignEndorsementDeps): Promise<SignReplyV1> {
	if (deps.privateKey === undefined) {
		return { v: 1, refused: true, reason: "node has no signing key" };
	}
	const coord = b64urlToBytes(request.coord);
	const members = deps.cohortMembersAround(coord);
	if (!members.includes(bytesToPeerIdString(deps.selfMember))) {
		return { v: 1, refused: true, reason: "not a cohort member for coord" };
	}
	if (!members.includes(fromPeerStr)) {
		return { v: 1, refused: true, reason: "requester not in cohort" };
	}
	if (!bytesEqual(b64urlToBytes(request.cohortEpoch), deps.currentEpoch(coord))) {
		return { v: 1, refused: true, reason: "cohort epoch mismatch" };
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
 * Verify an inbound notice's threshold signature against the cohort `MembershipCertV1` for
 * `target.servedCoord` and, on success, apply it to the target's promotion lifecycle. Returns:
 *
 * - `"dropped"`  — no local engine serves the notice's `(topic, tier)` (e.g. a demotion arriving at a
 *   parent that does not track the child); nothing to apply to.
 * - `"untrusted"` — the `signers` are not a `≥ minSigs` subset of the cohort cert, or the multisig does
 *   not verify (a forged single-signer / short-quorum notice); local state is left unchanged.
 * - `"applied"`  — verified and applied.
 *
 * The payload is rebuilt with the canonical `sig/payloads` image the signer used — never re-canonicalized
 * independently. The verifier owns the cert lookup + single stale-cert refetch; this function never
 * re-verifies inside the apply step (db-core trusts this gate).
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
		const result = await verifier.verifyMessage(signers, target.servedCoord, inbound.notice.fromTier, payload, sig);
		if (result !== "verified") {
			return "untrusted";
		}
		target.applyPromotionNotice(inbound.notice, now);
		return "applied";
	}
	const payload = demotionNoticeSigningPayload(inbound.notice);
	const result = await verifier.verifyMessage(signers, target.servedCoord, inbound.notice.tier, payload, sig);
	if (result !== "verified") {
		return "untrusted";
	}
	target.applyDemotionNotice(inbound.notice, now);
	return "applied";
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
	gossipTransport: FretCohortGossipTransport,
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
		node.handle(protocols.gossip, makeFrameHandler(async (frame, from): Promise<Uint8Array | undefined> => {
			gossipTransport.deliver(from.toString(), frame);
			return undefined;
		}, maxBytes)),

		// promote: threshold-signed promotion/demotion notices (one-way, gossip-style fan-out). Decode the
		// notice, resolve the local engine for its cohort, verify the quorum signature against that cohort's
		// MembershipCertV1, and apply it to the engine's promotion lifecycle. Untrusted / undeliverable
		// notices are dropped (logged) — never throw on the stream.
		node.handle(protocols.promote, makeFrameHandler(async (frame): Promise<Uint8Array | undefined> => {
			const inbound = decodeInboundNotice(frame, maxBytes);
			if (inbound === undefined) {
				log("promote: dropped an undecodable notice frame");
				return undefined;
			}
			const tier = inbound.kind === "promotion" ? inbound.notice.fromTier : inbound.notice.tier;
			const target = registry.findServing(b64urlToBytes(inbound.notice.topicId), tier);
			const outcome = await verifyAndApplyNotice(inbound, target, verifier, Date.now());
			if (outcome !== "applied") {
				log("promote: %s %s notice for topic %s tier %d", outcome, inbound.kind, inbound.notice.topicId, tier);
			}
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
