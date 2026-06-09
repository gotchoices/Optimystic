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
 * {@link PromotionLifecycle} with coord-derived tier inputs, and a {@link CohortMemberEngine}) and
 * threshold-signs with the FRET cohort *around the served coord*. The node-wide collaborators
 * (`hash`, `slots`, `barometer`, the threshold signer, the FRET ports, and the participant-facing
 * service) stay singletons and are injected into each engine. The host recomputes the served coord
 * from each decoded `RegisterV1` (`addressing.coord(treeTier, participantCoord, topicId)`), so both
 * the activity callback and the direct `register` protocol handler dispatch to the right cohort.
 *
 * **Scope (mock-tier e2e pending).** The one documented remaining interim is the `k − x` cohort
 * threshold-signature assembly (see {@link FretCohortThresholdCrypto}). `followOn` derivation for a
 * promoted-redirect arrival is parked in backlog (`cohort-topic-followon-derivation`); this milestone
 * serves a **single tier-0 cohort**, so `followOn` stays `false` and tier-0 bootstrap instantiation
 * goes through the `bootstrap: true` path. The behavioral substrate is validated at mock-tier by
 * `test/cohort-topic/service.spec.ts`.
 */

import type { Libp2p } from "libp2p";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
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
	createCohortSigner,
	createCohortMemberEngine,
	createCohortTopicService,
	createLoadBarometer,
	createTierAddressing,
	coreProfile,
	DEFAULT_MIN_SIGS,
	bytesToB64url,
	b64urlToBytes,
	encodeCohortMessage,
	decodeCohortMessage,
	validateRegisterV1,
	validateRenewV1,
	type CohortTopicService,
	type CohortMemberEngine,
	type CohortSnapshotView,
	type NodeProfile,
	type ParticipantSigner,
	type RegisterReplyV1,
	type RegisterV1,
	type RenewReplyV1,
	type RenewV1,
	type RingCoord,
	type Tier,
	type IMembershipSource,
} from "@optimystic/db-core";
import { FretTopicRouter } from "./topic-router.js";
import { FretCohortGossipTransport, type CohortPeerResolver } from "./cohort-gossip-transport.js";
import { FretMembershipSource } from "./membership-source.js";
import { FretMembershipPublishSink } from "./membership-publish-sink.js";
import { FretCohortThresholdCrypto } from "./threshold-crypto.js";
import { FretSizeEstimator } from "./size-estimator.js";
import { peerIdToBytes } from "./peer-codec.js";
import { DEFAULT_COHORT_TOPIC_PROTOCOLS, cohortTopicProtocolList, type CohortTopicProtocols } from "./protocols.js";
import { DEFAULT_STREAM_MAX_BYTES } from "./stream-util.js";
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
	readonly signer: ReturnType<typeof createCohortSigner>;
	readonly transport: FretCohortGossipTransport;
	readonly profile: NodeProfile;
	readonly selfMemberBytes: Uint8Array;
	readonly wantK: number;
	/** FRET two-sided assembly around `coord`, self prepended + deduped, with a deterministic epoch. */
	readonly cohortAround: (coord: RingCoord) => CohortSnapshotView;
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
	const thresholdCrypto = new FretCohortThresholdCrypto(selfMemberBytes);

	const slots = createSlotAssigner(hash);
	const signer = createCohortSigner(thresholdCrypto, minSigs);
	const barometer = createLoadBarometer();

	/** FRET assembly around `coord`: self prepended + deduped; epoch = H(sorted member join). */
	const cohortAround = (coord: RingCoord): CohortSnapshotView => {
		const peerStrs = fret.assembleCohort(coord, wantK);
		const members = [selfMemberBytes, ...peerStrs.filter((p) => p !== selfPeerStr).map((p) => peerIdToBytes(p))];
		// Deterministic epoch from the sorted member set so a membership change rotates the epoch.
		const epochInput = members.map(bytesToB64url).sort().join("|");
		const cohortEpoch = hash.H(new TextEncoder().encode(epochInput));
		return { members, cohortEpoch };
	};

	const ctx: CoordEngineContext = {
		hash,
		addressing,
		slots,
		barometer,
		signer,
		transport: gossipTransport,
		profile,
		selfMemberBytes,
		wantK,
		cohortAround,
	};
	const registry = createCoordRegistry(ctx);

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
	const verifier = createMembershipVerifier({ signer, router: membershipRouter, minSigs });
	const participantSigner: ParticipantSigner = {
		// Interim: the peer-key signature binding is the threshold-crypto gap's sibling; a content-addressed
		// stamp keeps the body well-formed for mock-tier flows.
		signRegister: (): string => "",
		signRenew: (): string => "",
	};
	const service = createCohortTopicService({
		self: selfCoord,
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
	await registerProtocolHandlers(node, protocols, registry, dispatchRegister, gossipTransport, publishSink, membershipSource, selfCoord, maxBytes);
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
		signer: ctx.signer,
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
	});

	return {
		servedCoord,
		treeTier,
		engine,
		cohort,
		hasState: (): boolean => store.listAll().length > 0,
		holds: (topicId: Uint8Array, participantId: Uint8Array): boolean =>
			store.getByParticipant(topicId, participantId) !== undefined,
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
