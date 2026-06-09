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
	bytesToB64url,
	b64urlToBytes,
	bytesEqual,
	encodeCohortMessage,
	decodeCohortMessage,
	validateRegisterV1,
	validateRenewV1,
	validateSignRequestV1,
	validateSignReplyV1,
	registerSigningPayload,
	renewSigningPayload,
	type CohortTopicService,
	type CohortMemberEngine,
	type CohortSnapshot,
	type CohortSnapshotView,
	type CohortSigner,
	type MembershipCertPublisher,
	type MembershipCertV1,
	type NodeProfile,
	type ParticipantSigner,
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
	// Await registration so the host is not returned (and dialed) before the four handlers are live.
	await registerProtocolHandlers(node, protocols, registry, dispatchRegister, signEndorse, gossipTransport, publishSink, membershipSource, selfCoord, maxBytes);
	fret.setActivityHandler(async (activity: string, cohort: string[]): Promise<{ commitCertificate: string }> => {
		const reg = validateRegisterV1(decodeCohortMessage(b64urlToBytes(activity), maxBytes));
		const reply = await dispatchRegister(reg, cohort, Date.now());
		return { commitCertificate: bytesToB64url(encodeCohortMessage(reply, maxBytes)) };
	});

	return {
		service,
		registry,
		protocols,
		stop: async (): Promise<void> => {
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

	const bus = createCohortGossipBus({ transport: ctx.transport, store, coord: servedCoord, localEpoch });
	const view = bus.view();
	const selfMember = bytesToB64url(ctx.selfMemberBytes);

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
			touch: (): void => {
				/* interim: explicit gossip rounds publish records; per-touch replication is the gossip-layer gap */
			},
			evicted: (): void => {
				/* interim: see touch */
			},
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
	});

	return {
		servedCoord,
		treeTier,
		engine,
		cohort,
		hasState: (): boolean => store.listAll().length > 0,
		holds: (topicId: Uint8Array, participantId: Uint8Array): boolean =>
			store.getByParticipant(topicId, participantId) !== undefined,
		onStabilized: (now: number): Promise<MembershipCertV1 | undefined> =>
			canPublish ? membershipPublisher.onStabilized(snapshotAt(now), now) : Promise.resolve(undefined),
		pumpMembership: (now: number): Promise<MembershipCertV1 | undefined> =>
			canPublish ? membershipPublisher.tick(snapshotAt(now), now) : Promise.resolve(undefined),
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

		// promote: threshold-signed promotion/demotion notices. Interim — accepted onto the bus path; the
		// verify-and-apply step is part of the threshold-crypto gap.
		node.handle(protocols.promote, makeFrameHandler(async (): Promise<Uint8Array | undefined> => undefined, maxBytes)),

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
