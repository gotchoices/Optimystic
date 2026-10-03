/**
 * Reactivity — subscriber-side subscription state (`docs/reactivity.md` §Subscription).
 *
 * Subscribing to a collection is an **ordinary cohort-topic registration** at tier T3 with a reactivity
 * `appPayload`: `topicId = H(collectionId ‖ "reactivity")` (stable for the collection's life), the tail
 * block's routing key as the topic's `rootKey`, the configured TTL (Edge 60 s / Core 90 s), and the
 * cohort-topic walk-toward-root / willingness / promotion / TTL-renewal all reused unchanged. This module
 * owns only the subscriber-side bookkeeping struct and the `appPayload` builder; the db-p2p subscription
 * manager drives the cohort-topic `RegisterV1`.
 *
 * The payload's `tailIdAtAttach` is the tail at *that registration*; the subscriber itself keeps the latest
 * tail it has followed (`tail` below), which is what detects a rotation (a delivered `tailId` or a
 * `rotationHint` naming another tail) and what a resume names as `latestKnownTailId`. `cohortEpoch` detects
 * membership drift within the topic.
 */

import { encodeSubscribeAppPayload, type SubscribeAppPayloadV1 } from "./wire.js";

/** Subscriber-side live state for one active subscription (`docs/reactivity.md` §Subscriber-side state). */
export interface ActiveSubscription {
	/** Stable collection identity. */
	readonly collectionId: Uint8Array;
	/** The collection's topic id — `H(collectionId ‖ "reactivity")`, stable for the collection's life. */
	readonly topicId: Uint8Array;
	/** The latest tail block the subscription has followed: the topic's current root key, and what detects a rotation. */
	tail: Uint8Array;
	/** Serving cohort member. */
	primary: Uint8Array;
	/** Warm-failover cohort members. */
	backups: Uint8Array[];
	/** Cohort member hint set for fast re-attach. */
	cohortHint: Uint8Array[];
	/** Cohort epoch for membership-drift detection. */
	cohortEpoch: Uint8Array;
	/** Last contiguously-delivered revision. */
	lastRevision: number;
	/** Unix ms of the last delivery. */
	lastDeliveredAt: number;
	/** Unix ms the subscription attached. */
	attachedAt: number;
}

/** Parameters for building a subscribe `appPayload`. */
export interface SubscribeParams {
	/** Collection id, base64url. */
	readonly collectionId: string;
	/** Tail block id at attach time, base64url. */
	readonly tailIdAtAttach: string;
	/** Last revision already held; `0` for a fresh subscribe. */
	readonly lastKnownRev?: number;
	/** Max delta bytes accepted; `0` declines deltas (Edge). */
	readonly deltaMaxBytes: number;
}

/** Build the validated {@link SubscribeAppPayloadV1} for a subscription. */
export function buildSubscribeAppPayload(params: SubscribeParams): SubscribeAppPayloadV1 {
	return {
		kind: "reactivity",
		collectionId: params.collectionId,
		tailIdAtAttach: params.tailIdAtAttach,
		lastKnownRev: params.lastKnownRev ?? 0,
		deltaMaxBytes: params.deltaMaxBytes,
	};
}

/** Build the opaque `RegisterV1.appPayload` bytes for a subscription. */
export function subscribeAppPayloadBytes(params: SubscribeParams): Uint8Array {
	return encodeSubscribeAppPayload(buildSubscribeAppPayload(params));
}
