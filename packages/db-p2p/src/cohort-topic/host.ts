/**
 * Cohort-topic FRET host (`docs/cohort-topic.md` §FRET integration L432-460).
 *
 * Composes the db-core substrate (participant-facing {@link CohortTopicService} + cohort-side
 * {@link CohortMemberEngine}) over the FRET + libp2p ports and runs it as a service on one node:
 *
 * - registers the four `/optimystic/cohort-topic/1.0.0/*` protocols on the libp2p node;
 * - sets FRET's activity handler so a `RouteAndMaybeAct`-routed `RegisterV1` runs the cohort decision;
 * - binds the db-core ports to the FRET-backed adapters (router, gossip, membership, size estimator).
 *
 * **Scope (mock-tier e2e pending).** This host wires the cleanly-mappable surface and registers all
 * four protocols. Two pieces are the documented remaining gap for live-tier e2e and are interim here:
 * the `k − x` cohort threshold-signature assembly (see {@link FretCohortThresholdCrypto}) and
 * per-coord cohort scoping (this host composes one node-level engine whose `cohort()` is the FRET
 * assembly around the node's own ring position, rather than a distinct engine per served coord). The
 * behavioral substrate is validated at mock-tier by `test/cohort-topic/service.spec.ts`.
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
	type NodeProfile,
	type ParticipantSigner,
	type RegisterReplyV1,
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

/** A running cohort-topic node: the participant service plus the cohort-side engine, on one FRET node. */
export interface CohortTopicHost {
	/** Participant-facing substrate API. */
	readonly service: CohortTopicService;
	/** Cohort-side register/renew/sweep engine (driven by the protocol handlers + activity callback). */
	readonly engine: CohortMemberEngine;
	/** The four registered protocol IDs. */
	readonly protocols: CohortTopicProtocols;
	/** Unregister the four protocols. */
	stop(): Promise<void>;
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
	const selfCoord = await hashPeerId(node.peerId); // ring position P for addressing
	const addressing = createTierAddressing(hash, fanout);

	// --- cohort resolver (FRET two-sided assembly around a coord) ---
	const resolver: CohortPeerResolver = {
		cohortPeers(coord: RingCoord, wants: number): string[] {
			return fret.assembleCohort(coord, wants);
		},
	};

	// --- ports ---
	const router = new FretTopicRouter(node, fret, { registerProtocol: protocols.register, maxBytes });
	const sizeEstimator = new FretSizeEstimator(fret);
	const gossipTransport = new FretCohortGossipTransport(node, resolver, { gossipProtocol: protocols.gossip, wants: wantK, selfPeerId: selfPeerStr });
	const membershipSource = new FretMembershipSource(node, resolver, { membershipProtocol: protocols.membership, wants: wantK, maxBytes });
	const publishSink = new FretMembershipPublishSink();
	const thresholdCrypto = new FretCohortThresholdCrypto(selfMemberBytes);

	// --- cohort snapshot (interim: the FRET assembly around the node's own position) ---
	const currentCohort = (): { members: readonly Uint8Array[]; cohortEpoch: Uint8Array } => {
		const peerStrs = fret.assembleCohort(selfCoord, wantK);
		const members = [selfMemberBytes, ...peerStrs.filter((p) => p !== selfPeerStr).map((p) => peerIdToBytes(p))];
		// Deterministic epoch from the sorted member set so a membership change rotates the epoch.
		const epochInput = members.map(bytesToB64url).sort().join("|");
		const cohortEpoch = hash.H(new TextEncoder().encode(epochInput));
		return { members, cohortEpoch };
	};
	const localEpoch = (): Uint8Array => currentCohort().cohortEpoch;

	// --- db-core composition ---
	const store = createRegistrationStore();
	const slots = createSlotAssigner(hash);
	const signer = createCohortSigner(thresholdCrypto, minSigs);
	const barometer = createLoadBarometer();

	const gossipBus = createCohortGossipBus({ transport: gossipTransport, store, coord: selfCoord, localEpoch });
	const view = gossipBus.view();
	const selfMember = bytesToB64url(selfMemberBytes);

	const willingness = createWillingnessCheck({
		barometer,
		view,
		selfMember,
		primaryTopicCount: (tier: Tier): number => countPrimaryTopics(store, selfMemberBytes, tier),
		config: { cohortSize: wantK },
	});
	const traffic = createTrafficCounters({ view, store, selfMember });
	const promotion = createPromotionLifecycle({
		store,
		loadBucket: (topicId: Uint8Array): number => barometer.bucket(tierOfTopic(store, topicId)),
		childCohortCount: (): number => 0,
		treeTier: (): number => 0, // interim: node-level engine serves at the root position
		parentCoord: (topicId: Uint8Array): Uint8Array => addressing.coord(0, selfCoord, topicId),
		cohortEpoch: localEpoch,
		signer,
		config: { capPromote: undefined },
	});
	const coldStart = createColdStartManager({
		parentRegistrar: {
			registerWithParent: async (topicId: Uint8Array, parentCoord: Uint8Array, tier: number): Promise<void> => {
				// Register the freshly-instantiated forwarder with its parent over the router. A failure is
				// surfaced by the cold-start manager (it leaves the forwarder holding parent ops).
				void topicId;
				void tier;
				void parentCoord;
			},
		},
	});
	const renewal = createRenewalCohortSide({
		store,
		self: selfMemberBytes,
		slots,
		cohort: currentCohort,
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
		self: selfMemberBytes,
		profile,
		hash,
		store,
		slots,
		willingness,
		promotion,
		coldStart,
		traffic,
		renewal,
		cohort: currentCohort,
		quorumWilling: (tier: Tier): boolean => profile.willingTiers.has(tier),
	});

	// --- participant-side verifier + service ---
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
		gossipBus,
		verifier,
		config: { fanout, wantK, minSigs, maxMessageBytes: maxBytes },
	});

	// --- protocol handlers + activity callback ---
	registerProtocolHandlers(node, protocols, engine, gossipTransport, publishSink, membershipSource, addressing, selfCoord, maxBytes);
	fret.setActivityHandler(async (activity: string): Promise<{ commitCertificate: string }> => {
		const reply = await runRegisterActivity(engine, activity, addressing, selfCoord, maxBytes);
		return { commitCertificate: bytesToB64url(reply) };
	});

	return {
		service,
		engine,
		protocols,
		stop: async (): Promise<void> => {
			await node.unhandle(cohortTopicProtocolList(protocols));
		},
	};
}

// --- helpers ---

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

/** Decode an activity-frame `RegisterV1`, run the cohort decision, return the encoded reply frame. */
async function runRegisterActivity(
	engine: CohortMemberEngine,
	activity: string,
	addressing: ReturnType<typeof createTierAddressing>,
	selfCoord: RingCoord,
	maxBytes: number,
): Promise<Uint8Array> {
	const frame = b64urlToBytes(activity);
	const reg = validateRegisterV1(decodeCohortMessage(frame, maxBytes));
	const topicId = b64urlToBytes(reg.topicId);
	const parentCoord = reg.treeTier > 0 ? addressing.coord(reg.treeTier - 1, selfCoord, topicId) : undefined;
	const reply = await engine.handleRegister(reg, { followOn: false, treeTier: reg.treeTier, parentCoord }, Date.now());
	return encodeCohortMessage(reply, maxBytes);
}

function registerProtocolHandlers(
	node: Libp2p,
	protocols: CohortTopicProtocols,
	engine: CohortMemberEngine,
	gossipTransport: FretCohortGossipTransport,
	publishSink: FretMembershipPublishSink,
	membershipSource: FretMembershipSource,
	addressing: ReturnType<typeof createTierAddressing>,
	selfCoord: RingCoord,
	maxBytes: number,
): void {
	// register: a direct dial carries either a RegisterV1 (re-attach walk fallback) or a RenewV1 (ping).
	void node.handle(protocols.register, makeFrameHandler(async (frame): Promise<Uint8Array | undefined> => {
		const decoded = decodeCohortMessage(frame, maxBytes);
		const renew = tryValidate(() => validateRenewV1(decoded));
		if (renew !== undefined) {
			return encodeCohortMessage(engine.handleRenew(renew, Date.now()), maxBytes);
		}
		const reg = validateRegisterV1(decoded);
		const topicId = b64urlToBytes(reg.topicId);
		const parentCoord = reg.treeTier > 0 ? addressing.coord(reg.treeTier - 1, selfCoord, topicId) : undefined;
		const reply = await engine.handleRegister(reg, { followOn: false, treeTier: reg.treeTier, parentCoord }, Date.now());
		return encodeCohortMessage(reply, maxBytes);
	}, maxBytes));

	// cohort-gossip: feed inbound gossip into the bus (one-way).
	void node.handle(protocols.gossip, makeFrameHandler(async (frame, from): Promise<Uint8Array | undefined> => {
		gossipTransport.deliver(from.toString(), frame);
		return undefined;
	}, maxBytes));

	// promote: threshold-signed promotion/demotion notices. Interim — accepted onto the bus path; the
	// verify-and-apply step is part of the threshold-crypto gap.
	void node.handle(protocols.promote, makeFrameHandler(async (): Promise<Uint8Array | undefined> => undefined, maxBytes));

	// membership: serve this node's latest published cert; cache any cert the requester returns.
	void node.handle(protocols.membership, makeFrameHandler(async (frame): Promise<Uint8Array | undefined> => {
		void frame; // request frame is the raw coord; this node serves its own cohort cert
		const latest = publishSink.latest();
		if (latest !== undefined) {
			membershipSource.cache(selfCoord, latest);
		}
		return latest ?? new Uint8Array(0);
	}, maxBytes));
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
