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
	deltaMaxForProfile,
	createNotificationVerifier,
	createReactivitySubscriber,
	createBackfillRequester,
	createStickyCohortHintCache,
	createRejoinJitter,
	applyResumeReply,
	detectRotation,
	planReRegistration,
	bytesToB64url,
	type CohortTopicService,
	type NodeProfile,
	type NotificationV1,
	type DeliveryOutcome,
	type ReactivitySubscriber,
	type NotificationVerifier,
	type RegistrationHandle,
	type BackfillV1,
	type BackfillReplyV1,
	type BackfillTransport,
	type ResumeV1,
	type ResumeReplyV1,
	type ResumeApplyOutcome,
	type StickyCohortHintCache,
	type CheckpointSummary,
	type RejoinJitter,
	type ReRegistrationPlan,
} from "@optimystic/db-core";

/** Sends a {@link ResumeV1} to the serving cohort and awaits its classified {@link ResumeReplyV1}. */
export type ResumeTransport = (req: ResumeV1) => Promise<ResumeReplyV1>;

/**
 * A detected tail rotation surfaced to the host so it can schedule the jittered re-registration timer
 * (`docs/reactivity.md` §Tail rotation). The manager has already invalidated the sticky cohort-hint cache
 * (the cached primary is under the old tree).
 */
export interface RotationNotice {
	/** The new tail block id the topic rotated to, base64url. */
	readonly newTailId: string;
	/** True iff this was a pre-announce (`rotationHint` on a still-current-tail notification). */
	readonly preAnnounced: boolean;
	/** The jittered re-registration plan (new topicId + `fireAt` + carried `lastRevision`) for the host to schedule. */
	readonly plan: ReRegistrationPlan;
}

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
	/**
	 * Explicit backfill seam — used only when {@link backfillTransport} is **not** supplied. When a
	 * transport is given, the manager builds the db-core {@link createBackfillRequester} driver instead and
	 * this is ignored.
	 */
	readonly requestBackfill?: (from: number, to: number) => void;
	/**
	 * Backfill RPC transport (the reactivity application protocol dialing the serving cohort). When
	 * supplied, the manager wires the subscriber's gap-detection seam to the {@link BackfillV1} RPC,
	 * replaying the reply through the delivery path. Requires {@link signBackfill}.
	 */
	readonly backfillTransport?: BackfillTransport;
	/** Sign a {@link BackfillV1} over its unsigned image (subscriber peer key); base64url. */
	readonly signBackfill?: (req: Omit<BackfillV1, "signature">) => string;
	/** Resume RPC transport (mobile wake). When supplied, {@link resume} is available. Requires {@link signResume}. */
	readonly resumeTransport?: ResumeTransport;
	/** Sign a {@link ResumeV1} over its unsigned image (subscriber peer key); base64url. */
	readonly signResume?: (req: Omit<ResumeV1, "signature">) => string;
	/** The subscriber's ring coordinate, base64url (carried in {@link ResumeV1} so the cohort routes the reply). */
	readonly subscriberCoord?: string;
	/** Apply a verified checkpoint's merged digest on a `checkpoint_window` resume. */
	readonly onCheckpointDigest?: (summary: CheckpointSummary) => void;
	/** Chain-read + fresh subscribe fallback (out_of_window, or an untrusted checkpoint). */
	readonly onChainRead?: (currentTailId: string | undefined, currentRevision: number | undefined) => void;
	/** Re-register under the rotated tail (tail_rotated); also invalidates the sticky cohort-hint cache. */
	readonly onTailRotated?: (newTailId: string, newRevisionAtRotation: number) => void;
	/** Escalation when a backfill's `available` window fell past the gap's low edge (escalate to resume/chain). */
	readonly onBackfillUnderflow?: (requested: { from: number; to: number }, available: { fromRevision: number; toRevision: number }) => void;
	/** Sticky cohort-hint cache for one-RT resume after a flap; defaults to a fresh per-manager cache (Edge). */
	readonly cohortHintCache?: StickyCohortHintCache;
	/**
	 * Tail-rotation observer (`docs/reactivity.md` §Tail rotation). Fired once per successor tail when an
	 * inbound notification reveals a rotation (delivered `tailId` differs, or a `rotationHint` pre-announce):
	 * the manager invalidates the sticky cohort-hint cache and hands the host a jittered re-registration plan
	 * to schedule. Absent ⇒ rotation is detected and the cache invalidated, but no plan is surfaced.
	 */
	readonly onRotation?: (notice: RotationNotice) => void;
	/** Re-registration jitter for the rotation plan's `fireAt`; defaults to the `T_rejoin_jitter` curve. */
	readonly rejoinJitter?: RejoinJitter;
	/** Unix-ms clock for resume timestamps (injected for deterministic tests). Default `Date.now`. */
	readonly clock?: () => number;
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
	private readonly collectionIdB64: string;
	private readonly tailIdAtAttach: Uint8Array;
	private readonly topicId: Uint8Array;
	private readonly ttlMs: number;
	private readonly deltaMaxBytes: number;
	private readonly lastKnownRev: number;
	private readonly subscriber: ReactivitySubscriber;
	private readonly verifier: NotificationVerifier;
	private readonly options: ReactivitySubscriptionManagerOptions;
	private readonly cohortHintCache: StickyCohortHintCache;
	private readonly clock: () => number;
	private readonly tailIdAtAttachB64: string;
	private readonly rejoinJitter: RejoinJitter;
	/** The successor tail a rotation has already been surfaced for, so the notice fires once per rotation. */
	private rotationHandledFor?: string;
	/** Memoized db-core backfill driver (built on first gap, once `this.subscriber` is assigned). */
	private backfillRequester?: (from: number, to: number) => Promise<BackfillReplyV1>;
	private handle?: RegistrationHandle;

	constructor(options: ReactivitySubscriptionManagerOptions) {
		this.options = options;
		this.service = options.service;
		this.collectionId = options.collectionId;
		this.collectionIdB64 = bytesToB64url(options.collectionId);
		this.tailIdAtAttach = options.tailIdAtAttach;
		this.topicId = reactivityTopicId(options.tailIdAtAttach);
		this.ttlMs = options.ttlMs ?? (options.profile !== undefined ? subscriberTtlForProfile(options.profile) : undefined) ?? DEFAULT_SUBSCRIBER_TTL_MS;
		this.deltaMaxBytes = options.deltaMaxBytes ?? (options.profile !== undefined ? deltaMaxForProfile(options.profile) : DEFAULT_EDGE_SAFE_DELTA_MAX);
		this.lastKnownRev = options.lastKnownRev ?? 0;
		this.cohortHintCache = options.cohortHintCache ?? createStickyCohortHintCache();
		this.clock = options.clock ?? ((): number => Date.now());
		this.tailIdAtAttachB64 = bytesToB64url(options.tailIdAtAttach);
		this.rejoinJitter = options.rejoinJitter ?? createRejoinJitter();
		// Verify against the tail cohort's membership cert (the verifier owns the one fetch-and-retry).
		this.verifier = createNotificationVerifier({ verifier: this.service.verifier(), tier: Tier.T3 });
		this.subscriber = createReactivitySubscriber({
			collectionId: this.collectionIdB64,
			verifier: this.verifier,
			deliver: options.deliver,
			// Bind the seam to a method so it resolves the (possibly transport-backed) driver lazily —
			// `this.subscriber` is not yet assigned during this very call.
			requestBackfill: (from, to): void => this.onBackfillGap(from, to),
			lastKnownRev: this.lastKnownRev,
		});
	}

	/**
	 * The subscriber detected a revision gap. When a {@link ReactivitySubscriptionManagerOptions.backfillTransport}
	 * + signer are configured, drive the db-core {@link createBackfillRequester} (build → sign → send →
	 * replay reply through delivery → underflow escalation, built lazily once); otherwise fall back to the
	 * explicit {@link ReactivitySubscriptionManagerOptions.requestBackfill} callback (or no-op).
	 */
	private onBackfillGap(from: number, to: number): void {
		const { backfillTransport, signBackfill } = this.options;
		if (backfillTransport !== undefined && signBackfill !== undefined) {
			if (this.backfillRequester === undefined) {
				this.backfillRequester = createBackfillRequester({
					collectionId: this.collectionIdB64,
					sign: signBackfill,
					transport: backfillTransport,
					subscriber: this.subscriber,
					onUnderflow: this.options.onBackfillUnderflow,
				});
			}
			// Fire-and-forget seam; a transport failure surfaces via the unhandled-rejection path rather
			// than being swallowed (an exception is exceptional — AGENTS.md).
			void this.backfillRequester(from, to);
			return;
		}
		this.options.requestBackfill?.(from, to);
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

	/**
	 * Resume after a sleep/flap (`docs/reactivity.md` §Resume). Sends one {@link ResumeV1} from
	 * `lastRevision + 1` to the serving cohort over the injected {@link ResumeTransport} and applies the
	 * classified reply via the db-core {@link applyResumeReply}: a `backfill` / `checkpoint_window` reply
	 * replays its entries through the delivery path (verified, deduped); `out_of_window` and an untrusted
	 * checkpoint escalate to {@link ReactivitySubscriptionManagerOptions.onChainRead}; `tail_rotated`
	 * escalates to {@link ReactivitySubscriptionManagerOptions.onTailRotated} and invalidates the sticky
	 * cohort-hint cache (the cached primary is under the old tree). Throws if no resume transport/signer
	 * was configured.
	 *
	 * The sticky cohort-hint cache (Edge) lets a resume after a brief flap dial the cached primary directly
	 * for a one-RT recovery instead of re-walking from `d_max`; it is the transport's to consult via
	 * {@link cohortHint}.
	 */
	async resume(): Promise<ResumeApplyOutcome> {
		const { resumeTransport, signResume } = this.options;
		if (resumeTransport === undefined || signResume === undefined) {
			throw new Error("ReactivitySubscriptionManager.resume: no resumeTransport/signResume configured");
		}
		const unsigned: Omit<ResumeV1, "signature"> = {
			v: 1,
			collectionId: this.collectionIdB64,
			fromRevision: this.subscriber.lastRevision + 1,
			latestKnownTailId: bytesToB64url(this.tailIdAtAttach),
			subscriberCoord: this.options.subscriberCoord ?? this.collectionIdB64,
			timestamp: this.clock(),
		};
		const req: ResumeV1 = { ...unsigned, signature: signResume(unsigned) };
		const reply = await resumeTransport(req);
		return applyResumeReply(reply, {
			subscriber: this.subscriber,
			verifier: this.verifier,
			onCheckpointDigest: this.options.onCheckpointDigest,
			onChainRead: this.options.onChainRead,
			onTailRotated: (newTailId, newRevisionAtRotation): void => {
				// The cached primary is under the now-stale tree; drop it so the re-registration re-walks.
				this.cohortHintCache.invalidate(this.collectionIdB64);
				this.options.onTailRotated?.(newTailId, newRevisionAtRotation);
			},
		});
	}

	/** The sticky cohort-hint cache backing one-RT resume after a flap (Edge). */
	get cohortHint(): StickyCohortHintCache {
		return this.cohortHintCache;
	}

	/**
	 * Run the db-core delivery path for one inbound notification, then check for tail rotation
	 * (`docs/reactivity.md` §Tail rotation): a delivered `tailId` that differs from `tailIdAtAttach`, or a
	 * `rotationHint` pre-announce, invalidates the sticky cohort-hint cache (the cached primary is under the
	 * old tree) and surfaces a jittered re-registration plan via {@link ReactivitySubscriptionManagerOptions.onRotation}.
	 * Fired at most once per successor tail.
	 */
	async onNotification(n: NotificationV1): Promise<DeliveryOutcome> {
		const outcome = await this.subscriber.onNotification(n);
		this.checkRotation(n);
		return outcome;
	}

	/** Detect a tail rotation from an inbound notification and surface it once per successor tail. */
	private checkRotation(n: NotificationV1): void {
		const detection = detectRotation(this.tailIdAtAttachB64, n);
		if (!detection.rotated || detection.newTailId === undefined || detection.newTailId === this.rotationHandledFor) {
			return;
		}
		this.rotationHandledFor = detection.newTailId;
		// The cached primary is under the now-stale tree; drop it so the re-registration re-walks.
		this.cohortHintCache.invalidate(this.collectionIdB64);
		if (this.options.onRotation === undefined) {
			return;
		}
		const plan = planReRegistration({
			hint: { newTailId: detection.newTailId },
			lastRevision: this.subscriber.lastRevision,
			now: this.clock(),
			jitter: this.rejoinJitter,
		});
		this.options.onRotation({ newTailId: detection.newTailId, preAnnounced: detection.preAnnounced, plan });
	}
}

/** Fallback subscriber TTL when neither `ttlMs` nor `profile` is supplied (Core default). */
const DEFAULT_SUBSCRIBER_TTL_MS = 90_000;
/** Edge-safe delta budget when neither `deltaMaxBytes` nor `profile` is supplied: decline deltas. */
const DEFAULT_EDGE_SAFE_DELTA_MAX = 0;
