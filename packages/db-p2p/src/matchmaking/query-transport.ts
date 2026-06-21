/**
 * Matchmaking `QueryV1` RPC — cohort serve side over real libp2p (`docs/matchmaking.md` §Seeker query).
 *
 * This file holds BOTH halves of the seeker query transport. **Serve half**
 * ({@link createMatchmakingQueryHandler}): a remote seeker dials a cohort with a
 * {@link QueryV1} and this handler answers with the cohort's locally-held provider/seeker registrations,
 * signed by the node's peer key. It is the production binding that the in-process mock harness
 * (`testing/matchmaking-mesh-harness.ts` `queryCohort`) stubbed — the pure {@link handleMatchmakingQuery}
 * (filter + truncation + entry building + single-member reply signature) is unchanged; this only resolves
 * the serving engine off the live {@link CoordRegistry} and rides the cohort-topic
 * {@link handleRequestResponse} stream lifecycle (read one bounded frame → reply one frame).
 *
 * **Client half** ({@link createLibp2pMatchmakingTransport} / {@link createLibp2pMatchmakingSeekerSession}):
 * the real-socket {@link SeekerWalkTransport} the seeker walk client drives. It dials the FRET-routed
 * primary's cohort-topic `/register` (a signed seeker `RegisterV1`, self-vouched at tier 0) and the
 * matchmaking `/query` directly (the production analogue of the in-process mock harness
 * `buildWalkTransport` + `queryCohort`), maps a no-reply / dial failure to a benign empty advisory reply,
 * and re-validates every forwarded entry's `registrationSig` itself ({@link verifyEntry}) — the cohort
 * vouches only for "what I held", never provider authenticity.
 *
 * **Layering.** Matchmaking sits *above* the cohort-topic substrate (it depends on
 * `decodeMatchAppPayload`), so it owns its own protocol family ({@link MatchmakingProtocols}) and is wired
 * at the composition root (`libp2p-node-base.ts`) using only the host's public surface
 * (`registry.findServing` / `registry.findByCoord`, `engine.records` / `engine.topicTraffic` /
 * `engine.cohort`). Nothing here reaches into `host.ts` internals — it mirrors the reactivity precedent.
 *
 * **Single-tier-0 serve.** Matchmaking serves a single tier-0 cohort (the cohort-topic single-tier-0
 * milestone); a *serving* tier-`d ≥ 1` query is gated on the promotion follow-ons, exactly as the seeker
 * walk is mock-tier-tagged-unimplemented. So this resolves the tier-0 engine for `coord_0(topicId)` only.
 *
 * **No-engine = no reply (anti-DoS).** A query for a topic this node holds no serving engine for produces
 * **no reply frame** — the handler never instantiates a `CoordEngine` from an inbound query (that would be
 * a DoS amplifier). The seeker maps a no-reply to a benign empty advisory result (the seeker ticket owns
 * that mapping).
 *
 * **Per-coord scoping.** The reply is built from exactly the `coord_0(topicId)` engine's store, nothing
 * cross-coord — matching how the register handler recomputes a served coord per frame. The serve side does
 * NOT re-verify each entry's `registrationSig` (that is the seeker's re-validation via `verifyProviderEntry`);
 * it forwards `rec` fields verbatim through `evaluateQuery` and must never fabricate or alter `registrationSig`.
 */

import type { Libp2p } from "libp2p";
import type { PeerId, PrivateKey } from "@libp2p/interface";
import type { FretService } from "p2p-fret";
import { peerIdFromString } from "@libp2p/peer-id";
import { randomBytes } from "@noble/hashes/utils.js";
import {
	b64urlToBytes,
	bytesToB64url,
	createTierAddressing,
	decodeCohortMessage,
	decodeQueryReplyV1,
	decodeQueryV1,
	encodeCohortMessage,
	encodeQueryReplyV1,
	encodeQueryV1,
	makeDMaxComputer,
	registerSigningPayload,
	bootstrapBoundImage,
	serializeBootstrapEvidenceEnvelope,
	validateRegisterReplyV1,
	MatchmakingSeeker,
	RingHash,
	Tier,
	DEFAULT_FANOUT,
	QUERY_LIMIT_MAX,
	SEEKER_TTL_MS,
	type CapabilityFilter,
	type EntrySigVerifier,
	type HangOutConfig,
	type MatchTopicAnchor,
	type QueryReplyV1,
	type QueryV1,
	type RegisterReplyV1,
	type RegisterV1,
	type TierAddressing,
} from "@optimystic/db-core";
import type { CoordRegistry } from "../cohort-topic/host.js";
import { peerIdToBytes } from "../cohort-topic/peer-codec.js";
import { signPeer, verifyPeerSig } from "../cohort-topic/peer-sig.js";
import { FretSizeEstimator } from "../cohort-topic/size-estimator.js";
import { handleRequestResponse, requestResponse, DEFAULT_STREAM_MAX_BYTES } from "../cohort-topic/stream-util.js";
import { DEFAULT_COHORT_TOPIC_PROTOCOLS } from "../cohort-topic/protocols.js";
import { handleMatchmakingQuery } from "./query-handler.js";
import { PROTOCOL_MATCHMAKING_QUERY, DEFAULT_MATCHMAKING_PROTOCOLS } from "./protocols.js";
import { MatchmakingSeekerSession, type MatchmakingSeekerSessionDeps } from "./module.js";
import type { SeekerWalkTransport, SeekerProbeReply } from "./seeker-walk-client.js";
import { createLogger } from "../logger.js";

const log = createLogger("matchmaking-query");

/** Everything the matchmaking `QueryV1` serve handler needs from the live node, all injected. */
export interface MatchmakingQueryServeDeps {
	/** The host's per-served-coord cohort registry (`host.registry`) — read-only lookups, never `forCoord`. */
	readonly registry: CoordRegistry;
	/**
	 * Tier addressing used to derive `coord_0(topicId)` for the fallback engine lookup. Build one from
	 * `createTierAddressing(createRingHash())` — byte-identical to the host's internal addressing for the
	 * tier-0 coord (which is peer- and fanout-independent), exactly as the reactivity wiring does.
	 */
	readonly addressing: ReturnType<typeof createTierAddressing>;
	/**
	 * Sign the canonical {@link import("@optimystic/db-core").queryReplySigningPayload} with the node's peer
	 * key; resolves the base64url signature (e.g. `async p => bytesToB64url(await signPeer(nodeKey, p))`).
	 */
	readonly sign: (payload: Uint8Array) => Promise<string>;
	/**
	 * Anti-DoS rate-limit seam (owned by backlog `matchmaking-query-rate-limit`). Default-allow when
	 * omitted. Gate on **`from`** — the connection's verified `remotePeer` — NOT the self-asserted
	 * `query.requesterId`. Return `false` to drop the query with no reply.
	 */
	readonly gate?: (from: PeerId, topicId: Uint8Array) => boolean;
	/** Per-frame ceiling for encode/decode; default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
}

/**
 * Build the matchmaking query serve callback for {@link handleRequestResponse}: decode (bounded) → resolve
 * the serving tier-0 engine → build + sign the reply, or `undefined` for **no reply** (a decode failure, a
 * gate rejection, no serving engine, or any build/sign/encode error). It never throws out of the stream
 * handler — every failure is logged and dropped to a clean no-reply, mirroring the cohort-topic / reactivity
 * serve handlers (which wrap the whole serve body, not just the decode).
 */
export function createMatchmakingQueryHandler(
	deps: MatchmakingQueryServeDeps,
): (frame: Uint8Array, from: PeerId) => Promise<Uint8Array | undefined> {
	const maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	return async (frame: Uint8Array, from: PeerId): Promise<Uint8Array | undefined> => {
		try {
			// `decodeQueryV1` = `validateQueryV1(decodeCohortMessage(...))` — bounds `limit` to QUERY_LIMIT_MAX,
			// so the handler passes `query` through unchanged (never re-clamps `limit`).
			const query = decodeQueryV1(frame, maxBytes);
			const topicId = b64urlToBytes(query.topicId);

			// Anti-DoS rate-limit seam (matchmaking-query-rate-limit). Default-allow; gate on the connection's
			// verified `from` peer, never the self-asserted `query.requesterId`.
			if (deps.gate !== undefined && !deps.gate(from, topicId)) {
				log("matchmaking query serve: rate-limited query from %s (no reply)", from.toString());
				return undefined;
			}

			// Resolve the serving tier-0 engine. `findServing(topicId, 0)` keys on `treeTier === 0 &&
			// servesTopic(topicId)` (true on the routed primary once it has admitted/replicated a registration);
			// `findByCoord(coord_0)` is the fallback for an instantiated-but-currently-recordless engine. We never
			// `forCoord` here — instantiating a CoordEngine from an inbound query would be a DoS amplifier.
			const coord0 = deps.addressing.coord0(topicId);
			const engine = deps.registry.findServing(topicId, 0) ?? deps.registry.findByCoord(coord0);
			if (engine === undefined) {
				// No serving engine on this node (seeker dialed a non-primary / pre-replication). No reply; the
				// seeker side treats this as an empty advisory result.
				return undefined;
			}

			// Build the reply from a single synchronous read (records + traffic + epoch) so a concurrent gossip
			// round cannot tear the snapshot between read and sign. `handleMatchmakingQuery` forwards each record's
			// fields verbatim through the pure `evaluateQuery` (capability filter + limit truncation + entry
			// building, including each provider's `registrationSig`) and single-member-signs the canonical reply.
			const reply = await handleMatchmakingQuery(query, {
				records: engine.records(topicId),
				topicTraffic: engine.topicTraffic(topicId),
				cohortEpoch: engine.cohort().cohortEpoch,
				sign: deps.sign,
				log,
			});
			return encodeQueryReplyV1(reply, maxBytes);
		} catch (err) {
			// Any failure — a malformed/foreign query (decode), an oversize reply (encode), or a transient
			// `sign` rejection — must never throw out of the stream handler: log + no reply. The outer
			// `handleRequestResponse` would otherwise abort the stream; a clean no-reply lets the seeker treat
			// it as a benign empty advisory result. Mirrors the reactivity recover serve handler exactly.
			log("matchmaking query serve: dropping query (no reply): %o", err);
			return undefined;
		}
	};
}

/**
 * Register the inbound matchmaking query protocol handler on `node` (request-reply: one {@link QueryV1}
 * frame in, one {@link import("@optimystic/db-core").QueryReplyV1} frame back, or no reply).
 */
export function registerMatchmakingQueryHandler(
	node: Libp2p,
	protocol: string = PROTOCOL_MATCHMAKING_QUERY,
	deps: MatchmakingQueryServeDeps,
): void {
	const maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	handleRequestResponse(node, protocol, createMatchmakingQueryHandler(deps), maxBytes);
}

// =================================================================================================
// Client side: the real-libp2p SeekerWalkTransport + one-shot query + d_max estimate + entry verifier.
// =================================================================================================

/**
 * A self-routed-primary local-serve hook. `fret.assembleCohort(coord, k)[0]` may resolve to the seeker
 * itself; libp2p cannot dial self, so when the routed primary is `selfPeerId` the transport routes the
 * register/query here instead. Absent ⇒ a self-primary register/query throws a clear error (the gap is
 * loud, not a silent hang). The gated e2e seeker is deliberately a remote node, so its happy path never
 * self-dials; the production factory must still not hang on a self-primary.
 */
export interface MatchmakingSelfServe {
	/** Serve a seeker register whose FRET-routed primary is this node. */
	register?(reg: RegisterV1): Promise<RegisterReplyV1>;
	/** Serve a query whose FRET-routed primary is this node; `undefined` ⇒ treated as an empty reply. */
	query?(q: QueryV1): Promise<QueryReplyV1 | undefined>;
}

/** Construction inputs for {@link createLibp2pMatchmakingTransport}. */
export interface Libp2pMatchmakingTransportDeps {
	/** The live libp2p node the seeker dials cohorts from. */
	readonly node: Libp2p;
	/**
	 * FRET engine: routes the cohort primary (`assembleCohort`) and feeds the `d_max` size estimate
	 * (`getNetworkSizeEstimate`). The libp2p `node.services.fret` *wrapper* is accepted directly — it
	 * keeps the size-estimate engine behind a lazy `ensure()`, which this factory unwraps internally.
	 */
	readonly fret: FretService;
	/** This node's peer-id string — the query `requesterId`, the seeker `participantCoord`, the self-dial guard. */
	readonly selfPeerId: string;
	/** The seeker's node key — signs its own register frames + the tier-0 self-vouch reputation endorsement. */
	readonly key: PrivateKey;
	/** Cohort size `k` (FRET `assembleCohort` wants). */
	readonly wantK: number;
	/** Tier addressing; default {@link createTierAddressing}`(new RingHash())` — byte-identical to the host. */
	readonly addressing?: TierAddressing;
	/** Fan-out `F` for the `d_max` computer; default {@link DEFAULT_FANOUT}. */
	readonly fanout?: number;
	/** Per-frame ceiling; default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
	/** Protocol id overrides; default the cohort-topic `register` + matchmaking `query` canonical ids. */
	readonly protocols?: { readonly register?: string; readonly query?: string };
	/** Seeker registration TTL carried on the walk's register frames (ms); default {@link SEEKER_TTL_MS}. */
	readonly seekerTtlMs?: number;
	/** Advertised demand carried in the seeker register payload (advisory; distinct from the walk's wantCount). Default 1. */
	readonly seekerWantCount?: number;
	/** Contact hint carried in the seeker register payload; default {@link Libp2pMatchmakingTransportDeps.selfPeerId}. */
	readonly contactHint?: string;
	/** Optional capability filter applied to the seeker register payload + the walk's `/query` frames. */
	readonly filter?: CapabilityFilter;
	/** Local-serve hook for a self-routed primary; absent ⇒ a self-primary register/query throws (loud, not silent). */
	readonly selfServe?: MatchmakingSelfServe;
}

/** The seeker-side seams a {@link MatchmakingSeekerSession} / the seeker walk client consume over a live node. */
export interface Libp2pMatchmakingTransport {
	/** Build the walk transport (register/query/renew/withdraw at a tree tier) for a topic. */
	walkTransport(topicId: Uint8Array): SeekerWalkTransport;
	/** Issue a one-shot `QueryV1` (resolves the cohort from `q.topicId`'s tier-0 coord). */
	queryCohort(q: QueryV1): Promise<QueryReplyV1>;
	/** Estimate `d_max` for a topic (FRET size estimate → the db-core `d_max` computer). */
	estimateDMax(topicId: Uint8Array): Promise<number>;
	/** Per-entry signature verifier (`verifyPeerSig` over the participant's Ed25519 peer key). */
	readonly verifyEntry: EntrySigVerifier;
}

/**
 * Unwrap the libp2p `node.services.fret` wrapper (which exposes `assembleCohort` / `routeAct` but keeps
 * the size-estimate engine behind a lazy `ensure()`) to the full FRET engine the `d_max` estimator needs.
 * A raw engine (no `ensure`, e.g. an injected test double) is returned as-is. Mirrors the node-base
 * `resolveFretEngine`; both observe the same underlying routing store, so `assembleCohort` agrees.
 */
function resolveFretEngine(fret: FretService): FretService {
	const candidate = fret as unknown as { ensure?: () => FretService };
	return typeof candidate.ensure === "function" ? candidate.ensure() : fret;
}

/**
 * Build the real-libp2p seeker query transport: the production analogue of the in-process mock harness's
 * `buildWalkTransport` + `queryCohort`. Routing model — dial the FRET-routed primary directly: for a tier
 * `d`, `coord = d === 0 ? coord0(topicId) : coordD(d, seekerBytes, topicId)` and the primary is
 * `assembleCohort(coord, wantK)[0]` (the same primary the host's direct-dial `/register` path serves).
 */
export function createLibp2pMatchmakingTransport(deps: Libp2pMatchmakingTransportDeps): Libp2pMatchmakingTransport {
	const { node, selfPeerId, key, wantK } = deps;
	const fret = resolveFretEngine(deps.fret);
	const addressing = deps.addressing ?? createTierAddressing(new RingHash());
	const fanout = deps.fanout ?? DEFAULT_FANOUT;
	const maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	const registerProtocol = deps.protocols?.register ?? DEFAULT_COHORT_TOPIC_PROTOCOLS.register;
	const queryProtocol = deps.protocols?.query ?? DEFAULT_MATCHMAKING_PROTOCOLS.query;
	const seekerTtlMs = deps.seekerTtlMs ?? SEEKER_TTL_MS;
	const seekerWantCount = deps.seekerWantCount ?? 1;
	const contactHint = deps.contactHint ?? selfPeerId;
	const filter = deps.filter;
	const selfServe = deps.selfServe;
	const seekerBytes = peerIdToBytes(peerIdFromString(selfPeerId));
	const signImage = async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(key, payload));
	const dMaxComputer = makeDMaxComputer({ estimator: new FretSizeEstimator(fret), F: fanout });

	const verifyEntry: EntrySigVerifier = (signerId, payload, signature) => verifyPeerSig(signerId, payload, signature);

	/** A benign empty advisory reply. Client-internal (never encoded/validated); the walk reads only `.providers`. */
	const emptyReply = (): QueryReplyV1 => ({
		v: 1,
		providers: [],
		truncated: false,
		cohortEpoch: "",
		topicTraffic: { windowSeconds: 0, arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: 0, childCohortCount: 0 },
		signature: "",
	});

	/** The FRET-routed primary peer-id for a cohort coord (`assembleCohort(coord, k)[0]`), or `undefined`. */
	const primaryFor = (coord: Uint8Array): string | undefined => fret.assembleCohort(coord, wantK)[0];

	/** Build a `QueryV1` for `topicId` carrying the transport's advisory filter. */
	const buildQuery = (topicId: Uint8Array): QueryV1 => ({
		v: 1,
		topicId: bytesToB64url(topicId),
		includeProviders: true,
		includeSeekers: false,
		limit: QUERY_LIMIT_MAX,
		requesterId: selfPeerId,
		timestamp: Date.now(),
		signature: "AA",
		...(filter !== undefined ? { filter } : {}),
	});

	/** Dial the tier-0 primary for `q.topicId`'s cohort and decode the reply; benign empty reply on no-frame/failure. */
	const dialQuery = async (q: QueryV1): Promise<QueryReplyV1> => {
		const topicId = b64urlToBytes(q.topicId);
		const primary = primaryFor(addressing.coord0(topicId));
		if (primary === undefined) {
			return emptyReply();
		}
		if (primary === selfPeerId) {
			if (selfServe?.query !== undefined) {
				return (await selfServe.query(q)) ?? emptyReply();
			}
			throw new Error("matchmaking query: FRET routed the cohort primary to self; provide deps.selfServe.query");
		}
		try {
			const frame = await requestResponse(node, peerIdFromString(primary), queryProtocol, encodeQueryV1(q, maxBytes), maxBytes);
			// The serve handler returns no frame for a topic it does not serve; map it (and any decode/dial
			// failure) to a benign empty reply so SeekerWalkClient.collect keeps walking rather than throwing.
			return frame.length === 0 ? emptyReply() : decodeQueryReplyV1(frame, maxBytes);
		} catch (err) {
			log("matchmaking query: dial/decode failed for primary %s (empty reply): %o", primary, err);
			return emptyReply();
		}
	};

	/** Build a signed seeker `RegisterV1` at `treeTier` (tier-0 carries the self-vouch bootstrap evidence). */
	const buildSeekerRegister = async (topicId: Uint8Array, treeTier: number, appPayload: Uint8Array): Promise<RegisterV1> => {
		const baseBody: Omit<RegisterV1, "signature"> = {
			v: 1,
			topicId: bytesToB64url(topicId),
			tier: Tier.T2,
			treeTier,
			participantCoord: bytesToB64url(seekerBytes),
			ttl: seekerTtlMs,
			// A tier-0 probe is the cold-root bootstrap (needs evidence on a configured node); a tier-`d>0`
			// probe is a plain walk step that falls through `no_state` on a cohort that does not serve the topic.
			bootstrap: treeTier === 0,
			timestamp: Date.now(),
			correlationId: bytesToB64url(randomBytes(16)),
			appPayload: bytesToB64url(appPayload),
		};
		// A configured production node gates a T2 `bootstrap: true` register on bootstrap evidence, so the
		// tier-0 register attaches a self-vouch reputation endorsement (the seeker peer-key-signs its own
		// `bootstrapBoundImage` as referee), exactly as the provider/reactivity integration tests do.
		// `bootstrapBoundImage` binds only (topicId, tier, participantCoord, timestamp), so the endorsement is
		// attached to the body BEFORE the final register sign (`registerSigningPayload` covers it).
		const body: Omit<RegisterV1, "signature"> = treeTier === 0
			? {
				...baseBody,
				bootstrapEvidence: serializeBootstrapEvidenceEnvelope({
					v: 1,
					reputation: { referee: bytesToB64url(seekerBytes), sig: bytesToB64url(await signPeer(key, bootstrapBoundImage(baseBody))) },
				}),
			}
			: baseBody;
		return { ...body, signature: bytesToB64url(await signPeer(key, registerSigningPayload(body))) };
	};

	/** Dial the routed primary's `/register` with the signed seeker frame and decode the `RegisterReplyV1`. */
	const dialRegister = async (primary: string, reg: RegisterV1): Promise<RegisterReplyV1> => {
		if (primary === selfPeerId) {
			if (selfServe?.register !== undefined) {
				return selfServe.register(reg);
			}
			throw new Error("matchmaking register: FRET routed the cohort primary to self; provide deps.selfServe.register");
		}
		const frame = await requestResponse(node, peerIdFromString(primary), registerProtocol, encodeCohortMessage(reg, maxBytes), maxBytes);
		return validateRegisterReplyV1(decodeCohortMessage(frame, maxBytes));
	};

	/** Map a `RegisterReplyV1` to the walk's {@link SeekerProbeReply} (pass `result`; copy traffic/targetTier). */
	const toProbeReply = (reply: RegisterReplyV1): SeekerProbeReply => {
		const out: { result: SeekerProbeReply["result"]; topicTraffic?: QueryReplyV1["topicTraffic"]; targetTier?: number } = {
			result: reply.result,
		};
		if ((reply.result === "accepted" || reply.result === "promoted") && reply.topicTraffic !== undefined) {
			out.topicTraffic = reply.topicTraffic;
		}
		if (reply.targetTier !== undefined) {
			out.targetTier = reply.targetTier;
		}
		return out;
	};

	const walkTransport = (topicId: Uint8Array): SeekerWalkTransport => {
		const seekerState = new MatchmakingSeeker({
			topicId,
			wantCount: seekerWantCount,
			contactHint,
			sign: signImage,
			...(filter !== undefined ? { filter } : {}),
		});
		return {
			register: async (treeTier: number): Promise<SeekerProbeReply> => {
				const coord = addressing.coord(treeTier, seekerBytes, topicId);
				const primary = primaryFor(coord);
				if (primary === undefined) {
					// FRET has not assembled a cohort for this coord yet: treat as cold (the walk steps on).
					return { result: "no_state" };
				}
				const reg = await buildSeekerRegister(topicId, treeTier, await seekerState.appPayloadBytes());
				return toProbeReply(await dialRegister(primary, reg));
			},
			// The serve handler resolves the tier-0 engine only (single-tier-0 milestone), so the query always
			// targets the topic's tier-0 cohort regardless of the walk tier — matching the mock harness + one-shot.
			query: async (_treeTier: number): Promise<QueryReplyV1> => dialQuery(buildQuery(topicId)),
			// Hang-out keep-alive: the seeker's own query does not depend on its seeker record, and the brief
			// record lives in the cohort store for the walk's duration, so a re-touch is unnecessary for the
			// single-tier-0 milestone (mirrors the mock harness). A real renew would re-send a `RenewV1` ping.
			renew: async (): Promise<void> => { /* no-op (documented) */ },
			// Single-tier-0 walks reach the root and never escalate past it, so withdraw is effectively unreached;
			// the brief seeker record otherwise ages out by TTL (mirrors the mock harness).
			withdraw: async (): Promise<void> => { /* no-op (documented) */ },
		};
	};

	const queryCohort = async (q: QueryV1): Promise<QueryReplyV1> => dialQuery(q);
	const estimateDMax = async (_topicId: Uint8Array): Promise<number> => dMaxComputer.dMax();

	return { walkTransport, queryCohort, estimateDMax, verifyEntry };
}

/** Construction inputs for {@link createLibp2pMatchmakingSeekerSession} (transport deps + session knobs). */
export interface Libp2pMatchmakingSeekerSessionDeps extends Libp2pMatchmakingTransportDeps {
	/** Participant-facing cohort-topic substrate API (the seeker's brief T2 registration via `session.register`). */
	readonly service: MatchmakingSeekerSessionDeps["service"];
	/** Topic anchor; defaults to db-core's ring-hash anchor. */
	readonly anchor?: MatchTopicAnchor;
	/** Hang-out decision config (passed to the walk). */
	readonly config?: HangOutConfig;
	/** Assumed competing-seeker mean `wantCount` (passed to the walk). */
	readonly meanWantCount?: number;
	/** Wall clock (unix ms); injectable for tests. */
	readonly clock?: () => number;
	/** Sleep for the requery cadence; injectable for tests. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** TTL for `session.register`'s brief seeker registration (ms); default the manager's seeker TTL. */
	readonly registrationTtlMs?: number;
}

/**
 * Build a {@link MatchmakingSeekerSession} driveable over a live node: wires
 * {@link createLibp2pMatchmakingTransport} into the session's injected substrate seams, so the public
 * session layer (not just the lower-level walk client) runs over real sockets. `sweepPorts` stays
 * UNBOUND — the multi-cohort sweep needs the promoted-tree aggregate-count RPC (a separate follow-on) —
 * so `session.walk` is walk-only, the correct single-tier-0 behavior. The seeker register image is signed
 * with the node key (the same key the transport signs its walk frames with).
 */
export function createLibp2pMatchmakingSeekerSession(deps: Libp2pMatchmakingSeekerSessionDeps): MatchmakingSeekerSession {
	const transport = createLibp2pMatchmakingTransport(deps);
	const sign = async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(deps.key, payload));
	const sessionDeps: MatchmakingSeekerSessionDeps = {
		service: deps.service,
		sign,
		verifyEntry: transport.verifyEntry,
		walkTransport: (topicId) => transport.walkTransport(topicId),
		queryCohort: (q) => transport.queryCohort(q),
		estimateDMax: (topicId) => transport.estimateDMax(topicId),
		...(deps.anchor !== undefined ? { anchor: deps.anchor } : {}),
		...(deps.config !== undefined ? { config: deps.config } : {}),
		...(deps.meanWantCount !== undefined ? { meanWantCount: deps.meanWantCount } : {}),
		...(deps.clock !== undefined ? { clock: deps.clock } : {}),
		...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
		...(deps.registrationTtlMs !== undefined ? { ttlMs: deps.registrationTtlMs } : {}),
	};
	return new MatchmakingSeekerSession(sessionDeps);
}
