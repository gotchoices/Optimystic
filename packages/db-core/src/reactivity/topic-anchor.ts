/**
 * Reactivity — rotating, tail-anchored topic.
 *
 * Transcribed from `docs/reactivity.md` §Anchor:
 *
 * ```
 * topicId(collection C, tail T) = H(T.blockId ‖ "reactivity")
 * ```
 *
 * Unlike matchmaking (whose anchor is a stable `(kind, label)`), the reactivity anchor **rotates** with
 * the collection's tail block: when the tail fills and a new tail block is born, `topicId` changes and
 * the cohort-topic layer treats it as an entirely new topic. The whole-tree migration that follows is
 * the rotation ticket's concern; this module owns only the pure derivation.
 *
 * The resulting `topicId` is fed verbatim into cohort-topic tier addressing (`coord_d(self, topicId)`),
 * so it is derived with the **same** {@link IRingHash} primitive cohort-topic uses for `coord_d` input —
 * db-core's own SHA-256 truncated to the ring width, **not** a FRET import. The trailing `"reactivity"`
 * literal domain-separates the reactivity tree from any other application anchoring on the same tail id.
 *
 * Concatenation is delimiter-free, exactly as the spec writes it; the constant suffix is unambiguous
 * because no tail-id byte string can alias a `(tailId, "reactivity")` pair of a different length.
 *
 * `reactivityTopicId` is the small pure helper the ticket asks for once and the rotation ticket
 * ([reactivity-rotation-backpressure-policy]) reuses per-emission — define it here, not at the call site.
 *
 * **The root is placed at the tail, not at the topic** (`docs/reactivity.md` §Origination point). The topic
 * id above addresses tiers `d ≥ 1`; the tree's root (announcing) group is the tail block's own storage
 * group, so the root coordinate is `H(tailBytes)` — the ring position the key network derives for the
 * tail's routing key — not `H(0x00 ‖ topicId)`. {@link reactivityRootCoord} is that derivation, shared by
 * the notification verifier, the mock-tier harness and every db-p2p site that needs the root group.
 */

import { createRingHash } from "../cohort-topic/ring-hash.js";
import { createTierAddressing } from "../cohort-topic/addressing.js";
import type { IRingHash, RingCoord } from "../cohort-topic/ports.js";

/** Domain-separation suffix mixed into every reactivity anchor. */
const REACTIVITY_SUFFIX = "reactivity";

const utf8 = new TextEncoder();

/**
 * `H(tailId ‖ "reactivity")` over the injected ring hash — the cohort-topic `topicId` for the
 * reactivity tree anchored on `tailId` (the collection's current tail block id, as raw bytes).
 *
 * The shared helper consumed by subscriber attachment, origination, and (per-emission) the rotation
 * ticket. `hash` defaults to db-core's own 256-bit SHA-256, byte-identical to the cohort-topic host's.
 */
export function reactivityTopicId(tailId: Uint8Array, hash: IRingHash = createRingHash()): Uint8Array {
	const suffixBytes = utf8.encode(REACTIVITY_SUFFIX);
	const input = new Uint8Array(tailId.length + suffixBytes.length);
	input.set(tailId, 0);
	input.set(suffixBytes, tailId.length);
	return hash.H(input);
}

/**
 * The reactivity root coordinate for a tail: `H(tailId)` over the injected ring hash — the tail block's
 * own ring position, where its storage group sits. `tailId` is the tail's routing key bytes (the raw utf8
 * of the block id, `reactivityTailBytes` on a node), so at the default 256-bit ring width this equals the
 * key network's `hashKey(routingKeyForBlock(tail))` byte for byte; the `topic-bytes-encoding` spec in
 * db-p2p pins that equality. Every party that derives the root group — the notification verifier, the
 * subscriber walk's root step, the forwarder's gossip and recover reads — must start from this one value.
 */
export function reactivityRootCoord(tailId: Uint8Array, hash: IRingHash = createRingHash()): RingCoord {
	return createTierAddressing(hash).rootCoord(tailId);
}

/** Derives the rotating `topicId` for a collection's current tail. */
export interface ReactivityTopicAnchor {
	/** `H(tailId ‖ "reactivity")` for the given tail block id (bytes). */
	topicId(tailId: Uint8Array): Uint8Array;
}

class HashReactivityTopicAnchor implements ReactivityTopicAnchor {
	constructor(private readonly hash: IRingHash) {}

	topicId(tailId: Uint8Array): Uint8Array {
		return reactivityTopicId(tailId, this.hash);
	}
}

/**
 * Build a {@link ReactivityTopicAnchor} over the injected hash. db-p2p passes the same {@link IRingHash}
 * it binds to FRET's `RING_BITS` so the anchor and cohort-topic routing keys line up; the default
 * constructs db-core's own {@link createRingHash} (256-bit SHA-256).
 */
export function createReactivityTopicAnchor(hash: IRingHash = createRingHash()): ReactivityTopicAnchor {
	return new HashReactivityTopicAnchor(hash);
}
