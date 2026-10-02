/**
 * Reactivity — the pinned byte encodings origination and subscription must share: a tail `BlockId` → raw
 * tail bytes ({@link reactivityTailBytes}, described below) and a collection id → raw bytes
 * ({@link reactivityCollectionIdBytes}).
 *
 * The tail bytes are the topic's **root key**: `reactivityRootCoord(tailBytes)` (db-core) is `H(tailBytes)`,
 * the ring position the key network stores the tail block at, so the topic's root group is that block's
 * storage group (`docs/reactivity.md` §Origination point). `reactivityTopicId` hashes
 * `H(tailBytes ‖ "reactivity")` for the tiers below the root. The subscriber side (the watch service, which
 * converts a `BlockId` tail to the bytes {@link import("./subscription-manager.js").ReactivitySubscriptionManager}
 * registers under), the notification verifier and every forwarder-side root-group read MUST use the **same**
 * bytes for a given tail, or they land on a different ring position than the announcing group.
 *
 * This module is that single source of truth: `reactivityTailBytes(tailId)` is the tail's routing key
 * (db-core's `routingKeyForBlock`, the raw utf8 of the id) — the exact bytes `findCluster` places the block
 * by, which is what makes `reactivityRootCoord(reactivityTailBytes(tail))` equal `hashKey(routingKeyForBlock(tail))`.
 * It must stay raw: a pre-hashed digest would land the root somewhere no storage group sits.
 */

import type { BlockId } from "@optimystic/db-core";
import { routingKeyForBlock } from "@optimystic/db-core";

/**
 * The pinned `BlockId` → raw tail bytes encoding fed into `reactivityRootCoord` and `reactivityTopicId`: the
 * tail's routing key, i.e. the **raw** utf8 bytes of the tail block-id string (never a pre-hashed digest).
 *
 * Load-bearing: the subscriber side, the verifier and the forwarder reads must call this **same** function
 * for a given tail (see the module doc) — a mismatch puts the root at a ring position where no storage
 * group announces. The `topic-bytes-encoding` spec pins the equality with the key network's placement.
 */
export function reactivityTailBytes(tailId: BlockId): Uint8Array {
	return routingKeyForBlock(tailId);
}

const utf8 = new TextEncoder();

/**
 * The pinned collection-id → raw bytes encoding: the utf8 of the id exactly as blocks carry it
 * (`header.collectionId`, e.g. `app/users`). A notification names its collection by the base64url of these
 * bytes, and a subscriber registers under, and matches inbound notifications against, the same bytes.
 *
 * Load-bearing: origination and the subscriber side must call this **same** function for a given
 * collection. A collection id is a path, not base64url, so putting it on the wire unencoded fails the
 * notification's wire validation on the receiving node, and encoding it differently on the two sides makes
 * every notification read as another collection's. Either way the subscriber silently never delivers. The
 * `topic-bytes-encoding` spec pins the equality.
 */
export function reactivityCollectionIdBytes(collectionId: string): Uint8Array {
	return utf8.encode(collectionId);
}
