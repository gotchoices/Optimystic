/**
 * Matchmaking — cohort-side `QueryV1` handler (db-p2p, wires the substrate store to the query reply).
 *
 * `docs/matchmaking.md` §Seeker query / §Capability filter. When a seeker dials a cohort with a
 * {@link QueryV1}, the cohort returns its **locally-known direct registrations** for the topic, with the
 * capability filter applied. This handler is the thin db-p2p binding: it reads the cohort's local
 * {@link RegistrationRecord}s, decodes each one's `appState` into a provider/seeker payload, and hands
 * them to the pure db-core {@link evaluateQuery} (filter + truncation + entry building). It then
 * attaches the substrate's `topicTraffic` snapshot, the `cohortEpoch`, and the cohort **primary's**
 * single-member reply signature (NOT a threshold signature — the reply is advisory; the seeker
 * re-validates each entry's `registrationSig` via `verifyProviderEntry`).
 *
 * The handler is transport-light on purpose: the records, traffic, epoch, and signer are all injected,
 * so it unit-tests without a live libp2p stack (mock-tier e2e is a documented follow-on). The FRET host
 * supplies `records = store.listByTopic(topicId)`, `topicTraffic` from the cohort `TrafficCounters`,
 * the current `cohortEpoch`, and a `sign` bound to this node's peer key.
 */

import {
	bytesToB64url,
	decodeMatchAppPayload,
	evaluateQuery,
	queryReplySigningPayload,
	type LocalProviderRegistration,
	type LocalSeekerRegistration,
	type QueryReplyV1,
	type QueryV1,
	type RegistrationRecord,
	type TopicTrafficV1,
} from "@optimystic/db-core";
import { bytesToPeerIdString } from "../cohort-topic/peer-codec.js";

/** Everything the {@link handleMatchmakingQuery} needs from the cohort substrate, all injected. */
export interface CohortQueryContext {
	/** The cohort's local registration records for the queried topic (e.g. `store.listByTopic(topicId)`). */
	readonly records: readonly RegistrationRecord[];
	/** The substrate's current traffic barometer for the topic (from the cohort `TrafficCounters`). */
	readonly topicTraffic: TopicTrafficV1;
	/** The current cohort epoch (32 bytes). */
	readonly cohortEpoch: Uint8Array;
	/** Sign the canonical reply image with the cohort primary's peer key; resolves the base64url signature. */
	readonly sign: (payload: Uint8Array) => Promise<string>;
	/** Optional logger for records whose `appState` fails to decode (skipped, not fatal). */
	readonly log?: (formatter: string, ...args: unknown[]) => void;
}

/** Build the advisory {@link QueryReplyV1} for `query` from the cohort's local registrations. */
export async function handleMatchmakingQuery(query: QueryV1, ctx: CohortQueryContext): Promise<QueryReplyV1> {
	const providers: LocalProviderRegistration[] = [];
	const seekers: LocalSeekerRegistration[] = [];

	for (const rec of ctx.records) {
		if (rec.appState === undefined) {
			continue;
		}
		const participantId = bytesToPeerIdString(rec.participantId);
		let payload;
		try {
			payload = decodeMatchAppPayload(rec.appState);
		} catch (err) {
			// A record whose appState isn't a matchmaking payload (or is malformed) is not ours to serve;
			// skip it rather than fail the whole reply. Logged so it is never silently swallowed.
			ctx.log?.("matchmaking query handler: skipping undecodable record for %s: %o", participantId, err);
			continue;
		}
		if (payload.kind === "match-provider") {
			providers.push({ participantId, attachedAt: rec.attachedAt, payload });
		} else {
			seekers.push({ participantId, attachedAt: rec.attachedAt, payload });
		}
	}

	const evaluated = evaluateQuery(query, providers, seekers);
	const unsigned: Omit<QueryReplyV1, "signature"> = {
		v: 1,
		truncated: evaluated.truncated,
		cohortEpoch: bytesToB64url(ctx.cohortEpoch),
		topicTraffic: ctx.topicTraffic,
	};
	if (evaluated.providers !== undefined) {
		unsigned.providers = evaluated.providers;
	}
	if (evaluated.seekers !== undefined) {
		unsigned.seekers = evaluated.seekers;
	}
	const signature = await ctx.sign(queryReplySigningPayload(unsigned));
	return { ...unsigned, signature };
}
