/**
 * Matchmaking libp2p protocol IDs (`docs/matchmaking.md` §Seeker query).
 *
 * Matchmaking is an application layered **above** the cohort-topic substrate, so it owns its own protocol
 * family rather than riding the cohort-topic protocols (which carry only substrate concerns — register,
 * gossip, promote, membership, sign). Exactly one protocol lives here today:
 *
 * - `query` — `QueryV1` → `QueryReplyV1`, the seeker's request-reply RPC against a cohort for the
 *             providers/seekers it locally holds (the serve side is `query-transport.ts`; the seeker
 *             walk client is the follow-on `matchmaking-query-rpc-seeker-walk`).
 *
 * The default (network-agnostic) ID omits the network segment; {@link makeMatchmakingProtocols} mirrors
 * FRET's `makeProtocols(networkName)` so a named network namespaces its matchmaking protocols the same way
 * FRET namespaces its routing protocols (and the cohort-topic / reactivity families namespace via their own
 * `make*Protocols`). Production wires the network-agnostic default, matching the cohort-topic + reactivity
 * families' production default.
 */

/** Base path for the matchmaking protocol family. */
export const MATCHMAKING_BASE = "/optimystic/matchmaking/1.0.0" as const;

/** `QueryV1` / `QueryReplyV1` — a seeker's query for a cohort's locally-held provider/seeker registrations. */
export const PROTOCOL_MATCHMAKING_QUERY = `${MATCHMAKING_BASE}/query` as const;

/** The matchmaking protocol IDs in registration order. */
export interface MatchmakingProtocols {
	readonly query: string;
}

/** Default (network-agnostic) protocol IDs, matching `docs/matchmaking.md`. */
export const DEFAULT_MATCHMAKING_PROTOCOLS: MatchmakingProtocols = {
	query: PROTOCOL_MATCHMAKING_QUERY,
};

/**
 * Namespaced matchmaking protocol IDs for `networkName` (mirrors FRET's `makeProtocols`, which inserts the
 * network segment even for `"default"` → `/optimystic/default/...`). Note this does NOT equal
 * {@link DEFAULT_MATCHMAKING_PROTOCOLS}: the canonical, network-agnostic IDs omit the segment entirely
 * (`/optimystic/matchmaking/1.0.0/...`); use those unless you need per-network namespacing.
 */
export function makeMatchmakingProtocols(networkName = "default"): MatchmakingProtocols {
	const base = `/optimystic/${networkName}/matchmaking/1.0.0`;
	return {
		query: `${base}/query`,
	};
}

/** All matchmaking protocol IDs as an array (for `node.handle` / `unhandle` over the set). */
export function matchmakingProtocolList(p: MatchmakingProtocols): string[] {
	return [p.query];
}
