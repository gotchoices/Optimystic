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
import { RotationRedirectError } from "./recover-transport.js";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-subscription");

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
	/**
	 * Tail block id at attach time (raw bytes); anchors the rotating topic (`reactivityTopicId` is applied to
	 * it) and detects rotation.
	 *
	 * **Load-bearing encoding contract.** When a production subscribe factory converts a `BlockId` tail to
	 * these bytes it MUST use `reactivityTailBytes(tailId)` (`reactivity/topic-bytes.ts`) — the SAME function
	 * origination's membership gate uses — NOT db-core's `blockIdToBytes` (which `sha256`s first → a double
	 * hash). Origination derives the topic's `coord_0` cohort from `reactivityTopicId(reactivityTailBytes(
	 * tailId))`; if this side feeds differently-encoded bytes it subscribes to a *different* coord and
	 * origination silently never reaches it (the `topic-bytes-encoding` spec pins the coord-equality).
	 */
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
	/**
	 * The subscriber's **real ring coordinate**, base64url (the `participantCoord` it registers under at the
	 * cohort-topic tier), carried in the signed {@link ResumeV1}. The recover transport replies on the same
	 * stream, so this is not used for reply routing today; still, the production factory should source it
	 * correctly so the signed field is meaningful and a future out-of-band reply path is unblocked. Absent ⇒
	 * the manager falls back to the collection id as a placeholder and logs (the signed field is then merely
	 * a stable per-collection token, not the ring coord).
	 */
	readonly subscriberCoord?: string;
	/**
	 * Application-level re-attempts the backfill escalation makes after a **transport failure** before giving
	 * up to a resume/chain-read (the sticky-hint dial + one cohort-walk fallback already live in the
	 * transport, so this is a small outer retry). Default `1`. Distinct from the `available`-window underflow
	 * path ({@link onBackfillUnderflow}), which escalates immediately without retrying.
	 */
	readonly backfillMaxRetries?: number;
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
	/** Resolved ring coordinate signed into a {@link ResumeV1} (real coord, or the collectionId placeholder). */
	private readonly subscriberCoord: string;
	/** True iff {@link subscriberCoord} fell back to the collectionId placeholder (no real coord supplied). */
	private readonly subscriberCoordIsFallback: boolean;
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
		this.subscriberCoordIsFallback = options.subscriberCoord === undefined;
		this.subscriberCoord = options.subscriberCoord ?? this.collectionIdB64;
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
					clock: this.clock,
					onUnderflow: this.options.onBackfillUnderflow,
				});
			}
			// Fire-and-forget off the gap seam (NOT the deliver path — backfill is hint-only and must never
			// block or fault commit/delivery). The driver resolves (no throw) on an `available`-window
			// underflow — that path is handled by `onBackfillUnderflow`; only a genuine **transport failure**
			// rejects, which escalates here. `escalateBackfill` never rejects, so nothing leaks as an
			// unhandled rejection.
			void this.backfillRequester(from, to).catch(() => { void this.escalateBackfill(from, to); });
			return;
		}
		this.options.requestBackfill?.(from, to);
	}

	/**
	 * A backfill RPC failed at the transport (the sticky-hint dial + cohort-walk fallback inside the
	 * transport were already exhausted). Re-attempt up to {@link ReactivitySubscriptionManagerOptions.backfillMaxRetries}
	 * times, then escalate to {@link resume} (when a resume transport is configured) and finally to
	 * {@link ReactivitySubscriptionManagerOptions.onChainRead}. Never rejects (it runs detached off the gap
	 * seam) and never touches the commit/delivery path.
	 */
	private async escalateBackfill(from: number, to: number): Promise<void> {
		const max = this.options.backfillMaxRetries ?? DEFAULT_BACKFILL_MAX_RETRIES;
		for (let attempt = 1; attempt <= max; attempt++) {
			try {
				await this.backfillRequester!(from, to);
				return; // a re-attempt closed (or underflow-escalated) the gap
			} catch (err) {
				if (err instanceof RotationRedirectError) {
					// The serving cohort's outgoing tail rotated: move to the new tree (no chain-read fallback).
					this.honorRotationRedirect(err);
					return;
				}
				log("backfill retry %d/%d for [%d,%d] failed: %o", attempt, max, from, to, err);
			}
		}
		// Still failing after the bounded retries: fall back to a resume (a wider recovery window) when one is
		// wired, else signal a chain read. Distinct from the underflow seam, which carries the held window.
		if (this.options.resumeTransport !== undefined && this.options.signResume !== undefined) {
			try {
				await this.resume();
				return;
			} catch (err) {
				log("backfill escalation to resume() failed for [%d,%d]: %o", from, to, err);
			}
		}
		this.options.onChainRead?.(undefined, undefined);
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
		if (this.subscriberCoordIsFallback) {
			log("resume: no real ring coordinate supplied; signing ResumeV1 with the collectionId as a placeholder subscriberCoord (collection=%s)", this.collectionIdB64);
		}
		const unsigned: Omit<ResumeV1, "signature"> = {
			v: 1,
			collectionId: this.collectionIdB64,
			fromRevision: this.subscriber.lastRevision + 1,
			latestKnownTailId: bytesToB64url(this.tailIdAtAttach),
			subscriberCoord: this.subscriberCoord,
			timestamp: this.clock(),
		};
		const req: ResumeV1 = { ...unsigned, signature: signResume(unsigned) };
		let reply: ResumeReplyV1;
		try {
			reply = await resumeTransport(req);
		} catch (err) {
			if (err instanceof RotationRedirectError) {
				// The resume reached the serving cohort's outgoing (draining) tail: honor the redirect (surface
				// the rotation through onRotation, invalidate the sticky cache) and resolve as a tail rotation —
				// never throw the redirect out to the caller / the gap seam's commit-delivery path.
				this.honorRotationRedirect(err);
				return "tail_rotated";
			}
			throw err;
		}
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
		if (!detection.rotated || detection.newTailId === undefined) {
			return;
		}
		this.surfaceRotation(detection.newTailId, detection.preAnnounced);
	}

	/**
	 * Surface a rotation to the host **once per successor tail** (`docs/reactivity.md` §Tail rotation):
	 * invalidate the sticky cohort-hint cache (the cached primary is under the now-stale tree, so a later
	 * resume re-walks) and — when an {@link ReactivitySubscriptionManagerOptions.onRotation} observer is
	 * configured — hand it a jittered re-registration plan carrying `lastRevision` (continuous across the
	 * rotation). The single seam both the notification-driven detection ({@link checkRotation}) and the
	 * recover-driven {@link RotationRedirectError} ({@link honorRotationRedirect}) end in; the
	 * {@link rotationHandledFor} guard self-corrects across a chained OLD→A→B rotation.
	 */
	private surfaceRotation(newTailId: string, preAnnounced: boolean): void {
		if (newTailId === this.rotationHandledFor) {
			return; // already surfaced this successor
		}
		this.rotationHandledFor = newTailId;
		// The cached primary is under the now-stale tree; drop it so the re-registration re-walks.
		this.cohortHintCache.invalidate(this.collectionIdB64);
		if (this.options.onRotation === undefined) {
			return;
		}
		const plan = planReRegistration({
			hint: { newTailId },
			lastRevision: this.subscriber.lastRevision,
			now: this.clock(),
			jitter: this.rejoinJitter,
		});
		this.options.onRotation({ newTailId, preAnnounced, plan });
	}

	/**
	 * Honor a recover-surfaced {@link RotationRedirectError}: the serving cohort's outgoing tail rotated and
	 * bounced this request to the new tree. Route it through the **same** {@link surfaceRotation} seam a
	 * delivered pre-announce uses (`preAnnounced: false`), so both the notify-driven and recover-driven
	 * rotation paths converge on one `RotationNotice` for the host's re-registration scheduler to consume.
	 */
	private honorRotationRedirect(err: RotationRedirectError): void {
		this.surfaceRotation(err.redirect.newTailId, false);
	}
}

/** Default application-level backfill re-attempts after a transport failure before escalating to resume/chain. */
const DEFAULT_BACKFILL_MAX_RETRIES = 1;
/** Fallback subscriber TTL when neither `ttlMs` nor `profile` is supplied (Core default). */
const DEFAULT_SUBSCRIBER_TTL_MS = 90_000;
/** Edge-safe delta budget when neither `deltaMaxBytes` nor `profile` is supplied: decline deltas. */
const DEFAULT_EDGE_SAFE_DELTA_MAX = 0;
