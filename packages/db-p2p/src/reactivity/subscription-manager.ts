/**
 * Reactivity — subscription manager (db-p2p, wires to the cohort-topic substrate).
 *
 * Drives a subscriber's lifecycle against the participant-facing {@link CohortTopicService}: register at
 * cohort-topic tier **T3 (luxury)** with the reactivity `appPayload`, renew to keep the registration
 * alive within its TTL (Edge 60 s / Core 90 s), and withdraw by ceasing renewal — all the cohort-topic
 * standard (`docs/reactivity.md` §Subscription). The reactivity-specific shape lives in db-core: the
 * tail-anchored `topicId = H(tailId ‖ "reactivity")`, the {@link SubscribeAppPayloadV1}, and the
 * subscriber-side verify/deliver path ({@link ReactivitySubscriber}).
 *
 * Inbound notifications are handed to {@link ReactivitySubscriptionManager.onNotification}, which runs
 * the db-core delivery path (verify against the cached tail-cohort `MembershipCertV1` with one
 * fetch-and-retry, revision-contiguity, gap → backfill seam, `(collectionId, revision)` dedupe, surface).
 * The notification transport (the reactivity application protocol that delivers `NotificationV1` frames
 * to a subscriber's primary) is the sibling tickets' concern; this manager owns attach + delivery logic.
 */

import {
	Tier,
	reactivityTopicId,
	subscribeAppPayloadBytes,
	subscriberTtlForProfile,
	createNotificationVerifier,
	createReactivitySubscriber,
	bytesToB64url,
	type CohortTopicService,
	type NodeProfile,
	type NotificationV1,
	type DeliveryOutcome,
	type ReactivitySubscriber,
	type RegistrationHandle,
} from "@optimystic/db-core";

/** Construction inputs for a {@link ReactivitySubscriptionManager}. */
export interface ReactivitySubscriptionManagerOptions {
	/** Participant-facing cohort-topic substrate API. */
	readonly service: CohortTopicService;
	/** Stable collection identity (the collection's id block id, raw bytes). */
	readonly collectionId: Uint8Array;
	/** Tail block id at attach time (raw bytes); anchors the rotating topic and detects rotation. */
	readonly tailIdAtAttach: Uint8Array;
	/** Surface a verified, contiguous notification to the application. */
	readonly deliver: (n: NotificationV1) => void;
	/** Request a backfill for an inclusive revision gap (sibling ticket fills the `BackfillV1` transport). */
	readonly requestBackfill?: (from: number, to: number) => void;
	/** Last revision already held; `0` (default) for a fresh subscribe. */
	readonly lastKnownRev?: number;
	/** Max delta bytes accepted; defaults to `0` on Edge, `delta_max` on Core via {@link profile}. */
	readonly deltaMaxBytes?: number;
	/** Subscription TTL (ms). Default: derived from {@link profile} (Core 90 s / Edge 60 s). */
	readonly ttlMs?: number;
	/** Node profile used to derive the TTL / delta budget when not given explicitly. */
	readonly profile?: NodeProfile;
}

/** Wires one reactivity subscription to the cohort-topic substrate at tier T3. */
export class ReactivitySubscriptionManager {
	private readonly service: CohortTopicService;
	private readonly collectionId: Uint8Array;
	private readonly tailIdAtAttach: Uint8Array;
	private readonly topicId: Uint8Array;
	private readonly ttlMs: number;
	private readonly deltaMaxBytes: number;
	private readonly lastKnownRev: number;
	private readonly subscriber: ReactivitySubscriber;
	private handle?: RegistrationHandle;

	constructor(options: ReactivitySubscriptionManagerOptions) {
		this.service = options.service;
		this.collectionId = options.collectionId;
		this.tailIdAtAttach = options.tailIdAtAttach;
		this.topicId = reactivityTopicId(options.tailIdAtAttach);
		this.ttlMs = options.ttlMs ?? (options.profile !== undefined ? subscriberTtlForProfile(options.profile) : undefined) ?? DEFAULT_SUBSCRIBER_TTL_MS;
		this.deltaMaxBytes = options.deltaMaxBytes ?? DEFAULT_EDGE_SAFE_DELTA_MAX;
		this.lastKnownRev = options.lastKnownRev ?? 0;
		this.subscriber = createReactivitySubscriber({
			collectionId: bytesToB64url(this.collectionId),
			// Verify against the tail cohort's membership cert (the verifier owns the one fetch-and-retry).
			verifier: createNotificationVerifier({ verifier: this.service.verifier(), tier: Tier.T3 }),
			deliver: options.deliver,
			requestBackfill: options.requestBackfill,
			lastKnownRev: this.lastKnownRev,
		});
	}

	/** The live registration handle, or `undefined` before the first {@link register}. */
	get registration(): RegistrationHandle | undefined {
		return this.handle;
	}

	/** Last contiguously-delivered revision. */
	get lastRevision(): number {
		return this.subscriber.lastRevision;
	}

	/** Register the subscriber at tier T3 with the reactivity `appPayload`. */
	async register(): Promise<RegistrationHandle> {
		const appPayload = subscribeAppPayloadBytes({
			collectionId: bytesToB64url(this.collectionId),
			tailIdAtAttach: bytesToB64url(this.tailIdAtAttach),
			lastKnownRev: this.lastKnownRev,
			deltaMaxBytes: this.deltaMaxBytes,
		});
		this.handle = await this.service.register({
			topicId: this.topicId,
			tier: Tier.T3,
			appPayload,
			ttl: this.ttlMs,
		});
		return this.handle;
	}

	/** Run one renewal cycle (keep-alive touch). No-op before the first {@link register}. */
	async renew(): Promise<void> {
		if (this.handle === undefined) {
			return;
		}
		await this.service.renew(this.handle);
	}

	/** Withdraw: stop renewing so the registration TTL-expires. */
	async withdraw(): Promise<void> {
		if (this.handle !== undefined) {
			await this.service.withdraw(this.handle);
		}
	}

	/** Run the db-core delivery path for one inbound notification. */
	onNotification(n: NotificationV1): Promise<DeliveryOutcome> {
		return this.subscriber.onNotification(n);
	}
}

/** Fallback subscriber TTL when neither `ttlMs` nor `profile` is supplied (Core default). */
const DEFAULT_SUBSCRIBER_TTL_MS = 90_000;
/** Edge-safe delta budget when neither `deltaMaxBytes` nor `profile` is supplied: decline deltas. */
const DEFAULT_EDGE_SAFE_DELTA_MAX = 0;
