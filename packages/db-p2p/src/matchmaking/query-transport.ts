/**
 * Matchmaking `QueryV1` RPC — cohort serve side over real libp2p (`docs/matchmaking.md` §Seeker query).
 *
 * This is the **server half** of the seeker query transport: a remote seeker dials a cohort with a
 * {@link QueryV1} and this handler answers with the cohort's locally-held provider/seeker registrations,
 * signed by the node's peer key. It is the production binding that the in-process mock harness
 * (`testing/matchmaking-mesh-harness.ts` `queryCohort`) stubbed — the pure {@link handleMatchmakingQuery}
 * (filter + truncation + entry building + single-member reply signature) is unchanged; this only resolves
 * the serving engine off the live {@link CoordRegistry} and rides the cohort-topic
 * {@link handleRequestResponse} stream lifecycle (read one bounded frame → reply one frame).
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
import type { PeerId } from "@libp2p/interface";
import {
	b64urlToBytes,
	decodeQueryV1,
	encodeQueryReplyV1,
	createTierAddressing,
} from "@optimystic/db-core";
import type { CoordRegistry } from "../cohort-topic/host.js";
import { handleRequestResponse, DEFAULT_STREAM_MAX_BYTES } from "../cohort-topic/stream-util.js";
import { handleMatchmakingQuery } from "./query-handler.js";
import { PROTOCOL_MATCHMAKING_QUERY } from "./protocols.js";
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
