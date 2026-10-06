/**
 * Matchmaking — a cohort's registration record decoded into the matchmaking registration it carries.
 *
 * A {@link RegistrationRecord}'s `appState` is opaque to the cohort-topic substrate; matchmaking puts a
 * provider or seeker payload there. Both cohort-side readers — the `QueryV1` handler (`query-handler.ts`)
 * and the arrival-push driver (`arrival-push-driver.ts`) — decode records the same way, through here.
 */

import {
	decodeMatchAppPayload,
	type LocalProviderRegistration,
	type LocalSeekerRegistration,
	type RegistrationRecord,
} from "@optimystic/db-core";
import { bytesToPeerIdString } from "../cohort-topic/peer-codec.js";

/** A record's matchmaking registration, tagged with the role it registered in. */
export type LocalMatchRegistration =
	| { readonly role: "provider"; readonly registration: LocalProviderRegistration }
	| { readonly role: "seeker"; readonly registration: LocalSeekerRegistration };

/**
 * Decode `rec` into its matchmaking registration, or `undefined` when it carries none: no `appState`, or an
 * `appState` that is not a valid matchmaking payload. The second case is not ours to serve, so it is skipped
 * rather than failing the caller's whole pass — and logged, so it is never silently swallowed.
 */
export function decodeLocalRegistration(
	rec: RegistrationRecord,
	log?: (formatter: string, ...args: unknown[]) => void,
): LocalMatchRegistration | undefined {
	if (rec.appState === undefined) {
		return undefined;
	}
	const participantId = bytesToPeerIdString(rec.participantId);
	let payload;
	try {
		payload = decodeMatchAppPayload(rec.appState);
	} catch (err) {
		log?.("matchmaking: skipping undecodable record for %s: %o", participantId, err);
		return undefined;
	}
	return payload.kind === "match-provider"
		? { role: "provider", registration: { participantId, attachedAt: rec.attachedAt, payload } }
		: { role: "seeker", registration: { participantId, attachedAt: rec.attachedAt, payload } };
}
