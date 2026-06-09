/**
 * Matchmaking — stable topic anchor.
 *
 * Transcribed from `docs/matchmaking.md` §Anchor:
 *
 * ```
 * topicId(kind, label) = H(kind ‖ label ‖ "match")
 * ```
 *
 * Unlike reactivity, matchmaking topics do **not** rotate — a task or capability label has a stable
 * identity over its useful lifetime, so the anchor is a pure function of `(kind, label)`.
 *
 * `kind` namespaces the topic so unrelated label spaces never collide; `label` is application-defined
 * (capability name, proposal hash, task-type id). The resulting `topicId` is fed verbatim into
 * cohort-topic tier addressing (`coord_d(self, topicId)`), so it is derived with the **same** hash
 * primitive cohort-topic uses for `coord_d` input — db-core's own {@link IRingHash} (SHA-256 truncated
 * to the ring width), **not** a FRET import. At the default `ringBits = 256` the anchor is a 32-byte
 * value, matching the cohort-topic `topicId` width.
 *
 * Concatenation is delimiter-free, exactly as the spec writes it. This is unambiguous because `kind`
 * is drawn from a closed set ({@link MATCH_TOPIC_KINDS}) in which no member is a prefix of another, so
 * `kind ‖ label` can never alias a different `(kind, label)` pair. The trailing `"match"` literal
 * domain-separates matchmaking anchors from any other application that might hash the same label.
 */

import { createRingHash } from "../cohort-topic/ring-hash.js";
import type { IRingHash } from "../cohort-topic/ports.js";

/**
 * The category of a matchmaking topic. Namespaces the `label` space so unrelated topics never
 * collide on the ring (`docs/matchmaking.md` §Anchor).
 *
 * - `task` — a work-task type id; long-lived, matures a deep tree.
 * - `capability` — a capability name (storage class, region, hardware feature); long-lived.
 * - `quorum` — a voting-proposal hash; short-lived, forms a shallow tree that demotes once closed.
 * - `capacity-class` — a capacity bucket for capacity gossip.
 */
export type MatchTopicKind = "task" | "capability" | "quorum" | "capacity-class";

/** Every matchmaking topic kind. Validated against on the seeker/provider build path. */
export const MATCH_TOPIC_KINDS: readonly MatchTopicKind[] = ["task", "capability", "quorum", "capacity-class"];

/** Domain-separation suffix mixed into every matchmaking anchor. */
const MATCH_SUFFIX = "match";

const utf8 = new TextEncoder();

/** Derives the stable `topicId` for a matchmaking `(kind, label)` pair. */
export interface MatchTopicAnchor {
	/** `H(kind ‖ label ‖ "match")` — the cohort-topic `topicId` for this matchmaking topic. */
	topicId(kind: MatchTopicKind, label: string): Uint8Array;
}

/** True iff `kind` is one of the closed {@link MATCH_TOPIC_KINDS}. */
export function isMatchTopicKind(kind: string): kind is MatchTopicKind {
	return (MATCH_TOPIC_KINDS as readonly string[]).includes(kind);
}

class HashMatchTopicAnchor implements MatchTopicAnchor {
	constructor(private readonly hash: IRingHash) {}

	topicId(kind: MatchTopicKind, label: string): Uint8Array {
		if (!isMatchTopicKind(kind)) {
			throw new RangeError(`matchmaking topicId: unknown kind ${JSON.stringify(kind)}`);
		}
		const kindBytes = utf8.encode(kind);
		const labelBytes = utf8.encode(label);
		const suffixBytes = utf8.encode(MATCH_SUFFIX);
		const input = new Uint8Array(kindBytes.length + labelBytes.length + suffixBytes.length);
		input.set(kindBytes, 0);
		input.set(labelBytes, kindBytes.length);
		input.set(suffixBytes, kindBytes.length + labelBytes.length);
		return this.hash.H(input);
	}
}

/**
 * Build a {@link MatchTopicAnchor} over the injected hash. db-p2p passes the same {@link IRingHash}
 * instance it binds to FRET's `RING_BITS`, so the anchor and cohort-topic routing keys line up; the
 * default constructs db-core's own {@link createRingHash} (256-bit SHA-256), which is byte-identical
 * to what the cohort-topic host uses.
 */
export function createMatchTopicAnchor(hash: IRingHash = createRingHash()): MatchTopicAnchor {
	return new HashMatchTopicAnchor(hash);
}

/** One-shot convenience: `H(kind ‖ label ‖ "match")` over the default db-core ring hash. */
export function matchTopicId(kind: MatchTopicKind, label: string, hash: IRingHash = createRingHash()): Uint8Array {
	return createMatchTopicAnchor(hash).topicId(kind, label);
}
