/**
 * Cohort-topic substrate — the signer-subset rule both direct trust anchors (`FretTrustAnchor`,
 * `CommitLogTrustAnchor`) apply once they hold the set a certificate's signers are expected to come from.
 *
 * A certificate's `signers` are the quorum that actually signed, which a forger cannot populate with real
 * members without their keys, so they are what is judged rather than the self-declared `members`. That
 * reasoning covers a forger holding NO member key. A root-placed certificate's own threshold is a ratio of
 * its own `members`, so a forger holding ONE member key can list itself as the only member and be a full
 * quorum of that list; `minQuorum` is the answer to that: the quorum is counted against the expected set
 * the anchor holds, never against the list the certificate brought.
 */

import type { RootPlacement, TrustAnchorVerdict } from "@optimystic/db-core";
import { rootPlacedMinSigs } from "@optimystic/db-core";

/**
 * Every signer in `expected`, and at least `minQuorum` distinct ones → `"anchored"`; no signer in it →
 * `"rejected"`; anything between → `"unknown"` (membership churned, or too few of the expected set signed
 * to speak for it — never a rejection, since the signers that are in the set are real members).
 */
export function judgeSigners(signers: readonly string[], expected: ReadonlySet<string>, minQuorum = 1): TrustAnchorVerdict {
	const distinct = new Set(signers);
	let inSet = 0;
	for (const signer of distinct) {
		if (expected.has(signer)) {
			inSet++;
		}
	}
	if (inSet === 0) {
		return "rejected";
	}
	return inSet === distinct.size && inSet >= minQuorum ? "anchored" : "unknown";
}

/** The quorum a root-placed certificate's signers must reach over the group an anchor judges it against. */
export function rootGroupQuorum(expected: ReadonlySet<string>, placement: RootPlacement): number {
	return rootPlacedMinSigs(expected.size, placement);
}
