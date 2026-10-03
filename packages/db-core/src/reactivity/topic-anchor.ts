/**
 * Reactivity — the collection anchor: one topic per collection, a root that follows the tail.
 *
 * Transcribed from `docs/reactivity.md` §Anchor:
 *
 * ```
 * topicId(C)   = H(utf8(C.collectionId) ‖ "reactivity")   (stable for the collection's life)
 * coord_0      = H(tailId)                                 (the root: the tail block's storage group; moves on rotation)
 * coord_d(P)   = H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)    (d ≥ 1; never moves)
 * ```
 *
 * Like matchmaking's `(kind, label)` anchor, the reactivity topic is **stable**: it is a function of the
 * collection id alone, so the tiers below the root sit at fixed positions for the collection's life. What
 * moves is the **root**. The root (announcing) group is the tail block's own storage group — the machines
 * that apply, and so announce, the collection's commits — at `H(tailId)`, the ring position the key network
 * places the tail by. When the tail block fills and a new one is born, the root moves to the new tail's
 * storage group and nothing else does: a rotation is "same topic, the root moved"
 * (`docs/reactivity.md` §Tail rotation).
 *
 * Both derivations use the **same** {@link IRingHash} primitive cohort-topic uses for `coord_d` input —
 * db-core's own SHA-256 truncated to the ring width, **not** a FRET import — because the topic id is fed
 * verbatim into cohort-topic tier addressing (`coord_d(self, topicId)`) and the root coordinate must equal the
 * key network's placement of the tail block byte for byte. The trailing `"reactivity"` literal domain-separates
 * the topic from any other application anchoring on the same collection id, and from the root coordinate,
 * which hashes the bare tail bytes. Concatenation is delimiter-free, exactly as the spec writes it; the
 * constant suffix is unambiguous because no collection-id byte string can alias a `(collectionId, "reactivity")`
 * pair of a different length.
 *
 * `collectionId` is the UTF-8 of the id exactly as blocks carry it (`header.collectionId`, e.g. `app/users`) —
 * the same bytes a notification's `collectionId` encodes (`reactivityCollectionIdBytes` in db-p2p's
 * `reactivity/topic-bytes.ts`). Origination and every subscriber derive the topic from those bytes, so a
 * notification routes to exactly the managers watching its collection.
 */

import { createRingHash } from "../cohort-topic/ring-hash.js";
import { createTierAddressing } from "../cohort-topic/addressing.js";
import type { IRingHash, RingCoord } from "../cohort-topic/ports.js";

/** Domain-separation suffix mixed into the reactivity topic. */
const REACTIVITY_SUFFIX = "reactivity";

const utf8 = new TextEncoder();

/**
 * `H(collectionId ‖ "reactivity")` over the injected ring hash — the cohort-topic `topicId` of a collection's
 * reactivity tree, stable for the collection's life. `collectionId` is the UTF-8 of the id as blocks carry it.
 * `hash` defaults to db-core's own 256-bit SHA-256, byte-identical to the cohort-topic host's.
 */
export function reactivityCollectionTopicId(collectionId: Uint8Array, hash: IRingHash = createRingHash()): Uint8Array {
	const suffixBytes = utf8.encode(REACTIVITY_SUFFIX);
	const input = new Uint8Array(collectionId.length + suffixBytes.length);
	input.set(collectionId, 0);
	input.set(suffixBytes, collectionId.length);
	return hash.H(input);
}

/**
 * The reactivity root coordinate for a tail: `H(tailId)` over the injected ring hash — the tail block's
 * own ring position, where its storage group sits. `tailId` is the tail's routing key bytes (the raw utf8
 * of the block id, `reactivityTailBytes` on a node), so at the default 256-bit ring width this equals the
 * key network's `hashKey(routingKeyForBlock(tail))` byte for byte; the `topic-bytes-encoding` spec in
 * db-p2p pins that equality. Every party that derives the root group — the notification verifier, the
 * subscriber walk's root step, the forwarder's gossip and recover reads — must start from this one value.
 * It is the one coordinate of a collection's tree that changes when the tail rotates.
 */
export function reactivityRootCoord(tailId: Uint8Array, hash: IRingHash = createRingHash()): RingCoord {
	return createTierAddressing(hash).rootCoord(tailId);
}
