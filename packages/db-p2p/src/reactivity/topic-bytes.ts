/**
 * Reactivity — the one pinned `BlockId` → raw tail-bytes encoding, shared by origination and subscription.
 *
 * `reactivityTopicId` (db-core) hashes `H(tailBytes ‖ "reactivity")` to derive the topic's `coord_0`
 * cohort. Origination (the cohort-change membership gate, {@link
 * import("../cohort-topic/reactivity-membership-gate.js").createReactivitySelfMembershipGate}) and the
 * subscriber side (the production subscribe factory that converts a `BlockId` `tailIdAtAttach` to the bytes
 * {@link import("./subscription-manager.js").ReactivitySubscriptionManager} feeds `reactivityTopicId`) MUST
 * feed it the **same** bytes for a given tail, or they resolve different coords and origination silently
 * never reaches subscribers (green tests, dead feature).
 *
 * This module is that single source of truth: `reactivityTailBytes(tailId)` is the tail's routing key
 * (db-core's `routingKeyForBlock`, the raw utf8 of the id) — the same bytes every cohort lookup for that
 * block is keyed on. It must stay raw: a pre-hashed digest would double-hash relative to the spec's
 * `H(tailId ‖ "reactivity")`.
 *
 * It lives in the reactivity surface (not buried in the gate) so the subscribe path and the gate import the
 * exact same function rather than re-deriving the encoding independently. The
 * `cohort-topic/reactivity-membership-gate.ts` module re-exports it for its existing callers.
 */

import type { BlockId } from "@optimystic/db-core";
import { routingKeyForBlock } from "@optimystic/db-core";

/**
 * The pinned `BlockId` → raw tail bytes encoding fed into `reactivityTopicId`: the tail's routing key, i.e.
 * the **raw** utf8 bytes of the tail block-id string (never a pre-hashed digest).
 *
 * Load-bearing: origination and the subscriber side must call this **same** function for a given tail (see
 * the module doc) — a mismatch resolves different `coord_0`s and origination silently never reaches
 * subscribers. The `topic-bytes-encoding` spec pins the coord-equality both ways.
 */
export function reactivityTailBytes(tailId: BlockId): Uint8Array {
	return routingKeyForBlock(tailId);
}
