/**
 * Reactivity — subscription manager (db-p2p, wires to the cohort-topic substrate).
 *
 * Drives one collection subscription's lifecycle against the participant-facing {@link CohortTopicService}
 * for the subscription's whole life: register at cohort-topic tier **T3 (luxury)** with the reactivity
 * `appPayload`, renew to keep the registration alive within its TTL (Edge 60 s / Core 90 s), follow the
 * collection's log tail as it moves ({@link ReactivitySubscriptionManager.followTail}), and withdraw by
 * ceasing renewal — all the cohort-topic standard (`docs/reactivity.md` §Subscription). The
 * reactivity-specific shape lives in db-core: the collection topic `topicId = H(collectionId ‖
 * "reactivity")` (stable), the {@link SubscribeAppPayloadV1}, and the subscriber-side verify/deliver path
 * ({@link ReactivitySubscriber}).
 *
 * **The topic's root is the tail's storage group, and it moves** (`docs/reactivity.md` §Origination point,
 * §Tail rotation): the register walk names the tail's routing key as the topic's `rootKey`, so its root step
 * reaches the group of peers that store the tail block — the machines that apply, and so announce, the
 * collection's commits — and notifications are verified against that group's membership under the root
 * placement threshold `ceil(|group| × quorumRatio)`, the formula the commit certificate they reuse was
 * captured under. When the log starts a new tail block only the root moves: a registration at the root
 * registers again under the new root key, one below the root keeps its place and updates the key a later
 * re-walk would use. The manager holds the **latest tail it has followed**, which is what a resume names as
 * `latestKnownTailId`, what rotation detection compares against, and what the recover transports target.
 *
 * Inbound notifications are handed to {@link ReactivitySubscriptionManager.onNotification}, which runs
 * the db-core delivery path (verify against the cached root-group `MembershipCertV1` with one
 * fetch-and-retry, revision-contiguity, gap → backfill seam, `(collectionId, revision)` dedupe, surface).
 * The notification transport (the reactivity application protocol that delivers `NotificationV1` frames
 * to a subscriber's primary) is the forwarder host's; this manager owns attach + follow + delivery logic.
 */

import {
	Tier,
	reactivityCollectionTopicId,
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
 * A detected tail rotation surfaced to the host so it can schedule the jittered follow timer
 * (`docs/reactivity.md` §Tail rotation). The manager has already invalidated the sticky cohort-hint cache
 * (the cached primary is at the old root).
 */
export interface RotationNotice {
	/** The new tail block id the root moved to, base64url. */
	readonly newTailId: string;
	/** True iff this was a pre-announce (`rotationHint` on a still-current-tail notification). */
	readonly preAnnounced: boolean;
	/** The jittered follow plan (new tail + `fireAt` + carried `lastRevision`) for the host to schedule. */
	readonly plan: ReRegistrationPlan;
}

/** Construction inputs for a {@link ReactivitySubscriptionManager}. */
export interface ReactivitySubscriptionManagerOptions {
	/** Participant-facing cohort-topic substrate API. */
	readonly service: CohortTopicService;
	/**
	 * Stable collection identity, raw bytes. The topic is derived from them, and inbound notifications are
	 * matched against their base64url, so these MUST be the bytes origination encodes onto a notification:
	 * `reactivityCollectionIdBytes(id)` (`reactivity/topic-bytes.ts`) on a node.
	 */
	readonly collectionId: Uint8Array;
	/**
	 * The collection's tail block id at construction (raw bytes): the topic's root key the first registration
	 * names (the walk's root step goes to the tail's storage group). {@link ReactivitySubscriptionManager.followTail}
	 * replaces it as the log moves; {@link ReactivitySubscriptionManager.tail} is the latest.
	 *
	 * **Load-bearing encoding contract.** A host converting a `BlockId` tail to these bytes (the node's
	 * `ReactivityCollectionWatch` does) MUST use `reactivityTailBytes(tailId)` (`reactivity/topic-bytes.ts`) —
	 * the tail's routing key, the bytes the key network places the block by — never a pre-hashed digest of
	 * the id. The root group is the serving cohort at `H(these bytes)`; a differently-encoded tail registers
	 * at a different ring position, with a group that announces nothing for this collection (the
	 * `topic-bytes-encoding` spec pins the equality with the key network's placement).
	 */
	readonly tail: Uint8Array;
	/**
	 * The ratio the root group's commit certificates are signed under — the node's consensus
	 * `superMajorityThreshold`. A notification verifies when its signers are root-group members numbering at
	 * least `ceil(|group| × quorumRatio)`; the value is this node's own, never read from a notification.
	 */
	readonly quorumRatio: number;
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
	 * replaying the reply through the delivery path. Requires {@link signBackfill}. A transport that targets
	 * the root group should resolve the root from {@link ReactivitySubscriptionManager.tail} per request, so
	 * it follows the root after a rotation.
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
	 * stream, so this is not used for reply routing today; still, a host should source it correctly so the
	 * signed field is meaningful and a future out-of-band reply path is unblocked. Absent ⇒
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
	/** Follow the moved root (tail_rotated); also invalidates the sticky cohort-hint cache. */
	readonly onTailRotated?: (newTailId: string, newRevisionAtRotation: number) => void;
	/** Escalation when a backfill's `available` window fell past the gap's low edge (escalate to resume/chain). */
	readonly onBackfillUnderflow?: (requested: { from: number; to: number }, available: { fromRevision: number; toRevision: number }) => void;
	/** Sticky cohort-hint cache for one-RT resume after a flap; defaults to a fresh per-manager cache (Edge). */
	readonly cohortHintCache?: StickyCohortHintCache;
	/**
	 * Tail-rotation observer (`docs/reactivity.md` §Tail rotation). Fired once per successor tail when an
	 * inbound notification reveals a rotation (delivered `tailId` differs, or a `rotationHint` pre-announce):
	 * the manager invalidates the sticky cohort-hint cache and hands the host a jittered follow plan to
	 * schedule. Absent ⇒ rotation is detected and the cache invalidated, but no plan is surfaced.
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

/** Wires one collection's reactivity subscription to the cohort-topic substrate at tier T3, for its whole life. */
export class ReactivitySubscriptionManager {
	private readonly service: CohortTopicService;
	private readonly collectionIdB64: string;
	private readonly topicId: Uint8Array;
	private readonly ttlMs: number;
	private readonly deltaMaxBytes: number;
	private readonly lastKnownRev: number;
	private readonly subscriber: ReactivitySubscriber;
	private readonly verifier: NotificationVerifier;
	private readonly options: ReactivitySubscriptionManagerOptions;
	private readonly cohortHintCache: StickyCohortHintCache;
	private readonly clock: () => number;
	private readonly rejoinJitter: RejoinJitter;
	/** Resolved ring coordinate signed into a {@link ResumeV1} (real coord, or the collectionId placeholder). */
	private readonly subscriberCoord: string;
	/** True iff {@link subscriberCoord} fell back to the collectionId placeholder (no real coord supplied). */
	private readonly subscriberCoordIsFallback: boolean;
	/** The latest tail this subscription has followed — the topic's current root key (see {@link tail}). */
	private latestTail: Uint8Array;
	private latestTailB64: string;
	/**
	 * The newest revision a verified notification has carried, whether delivered, a duplicate or ahead of the
	 * contiguity head. With {@link lastRevision} (which backfill and resume replays advance) it is what tells a
	 * late delivery announced at a tail already left from a rotation (see {@link checkRotation}).
	 */
	private newestNotified: number;
	/** The successor tail a rotation has already been surfaced for, so the notice fires once per rotation. */
	private rotationHandledFor?: string;
	/** Memoized db-core backfill driver (built on first gap, once `this.subscriber` is assigned). */
	private backfillRequester?: (from: number, to: number) => Promise<BackfillReplyV1>;
	private handle?: RegistrationHandle;

	constructor(options: ReactivitySubscriptionManagerOptions) {
		this.options = options;
		this.service = options.service;
		this.collectionIdB64 = bytesToB64url(options.collectionId);
		this.topicId = reactivityCollectionTopicId(options.collectionId);
		this.latestTail = options.tail;
		this.latestTailB64 = bytesToB64url(options.tail);
		this.ttlMs = options.ttlMs ?? (options.profile !== undefined ? subscriberTtlForProfile(options.profile) : undefined) ?? DEFAULT_SUBSCRIBER_TTL_MS;
		this.deltaMaxBytes = options.deltaMaxBytes ?? (options.profile !== undefined ? deltaMaxForProfile(options.profile) : DEFAULT_EDGE_SAFE_DELTA_MAX);
		this.lastKnownRev = options.lastKnownRev ?? 0;
		this.newestNotified = this.lastKnownRev;
		this.cohortHintCache = options.cohortHintCache ?? createStickyCohortHintCache();
		this.clock = options.clock ?? ((): number => Date.now());
		this.rejoinJitter = options.rejoinJitter ?? createRejoinJitter();
		this.subscriberCoordIsFallback = options.subscriberCoord === undefined;
		this.subscriberCoord = options.subscriberCoord ?? this.collectionIdB64;
		// Verify against the root group's membership cert under the placement rule (the verifier owns the one
		// fetch-and-retry; the root coordinate is derived from each notification's own tail).
		this.verifier = createNotificationVerifier({ verifier: this.service.verifier(), tier: Tier.T3, quorumRatio: options.quorumRatio });
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
					// The serving cohort's outgoing root rotated: follow the new root (no chain-read fallback).
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

	/**
	 * The latest tail this subscription has followed (raw bytes, `reactivityTailBytes` encoding): the topic's
	 * current root key. A resume names it as `latestKnownTailId`, rotation detection compares against it, and
	 * a recover transport that targets the root group resolves the group from it per request.
	 */
	get tail(): Uint8Array {
		return this.latestTail;
	}

	/** Last contiguously-delivered revision. */
	get lastRevision(): number {
		return this.subscriber.lastRevision;
	}

	/**
	 * Advance the contiguity head to `revision` because the host read the collection's committed log up to
	 * it (the chain-read fallback). The next notification the manager delivers is then `revision + 1`, so a
	 * gap the serving cohort could not backfill stops re-requesting a backfill on every later notification.
	 * Only advances; a notification at or below `revision` that arrives afterwards is a duplicate.
	 */
	rebaseline(revision: number): void {
		this.subscriber.rebaseline(revision);
		this.newestNotified = Math.max(this.newestNotified, revision);
	}

	/**
	 * Register the subscriber at tier T3 with the reactivity `appPayload`, under the current {@link tail} as the
	 * topic's root key: the walk's root step goes to the tail's storage group (`ITopicRouter.routeToRoot`), not
	 * to the FRET cohort around a hash of the topic id, so the subscriber lands on the machines that announce.
	 * A second registration for the same topic displaces the first at the service (its renewals stop; no
	 * tombstone is sent, the old record expires by TTL at the old root — see the `NOTE:` at `startRenewal` in
	 * db-core's cohort-topic service). The payload's `tailIdAtAttach` is the tail at this registration.
	 */
	async register(): Promise<RegistrationHandle> {
		const appPayload = subscribeAppPayloadBytes({
			collectionId: this.collectionIdB64,
			tailIdAtAttach: this.latestTailB64,
			lastKnownRev: this.lastKnownRev,
			deltaMaxBytes: this.deltaMaxBytes,
		});
		this.handle = await this.service.register({
			topicId: this.topicId,
			tier: Tier.T3,
			appPayload,
			ttl: this.ttlMs,
			rootKey: this.latestTail,
		});
		return this.handle;
	}

	/**
	 * Follow the collection's log to `tail` (raw bytes, `reactivityTailBytes` encoding): record it as the
	 * latest tail, then put the registration where the moved root wants it. Resolves `true` iff a registration
	 * landed on this call.
	 *
	 * - No registration yet → {@link register}.
	 * - A registration **at the root** (`treeTier` 0) whose root key is not `tail` → {@link register} again
	 *   under the new root key; the service displaces the old registration, which expires by TTL at the old
	 *   root. A failure throws and leaves the old registration renewing; the same condition re-fires on the
	 *   next call (the handle's root key still differs from the tail), so a deferred first registration at a
	 *   cold new root is retried by the host's next tick.
	 * - A registration **below the root** (`treeTier ≥ 1`) whose root key is not `tail` → `service.moveRoot`:
	 *   nothing is sent and nothing re-registers; its cohort sits at `coord_d(P, topicId)`, which the rotation
	 *   does not move, and a later renewal failover re-walks with the new root key.
	 * - A registration already naming `tail` as its root key, at either tier → nothing (the host's tick calls
	 *   this for every tail read, most of which find the tail unchanged).
	 *
	 * The tail is recorded first, whatever the registration does: the data a resume or backfill asks for now
	 * lives at the new root, and a notification announced there is not a rotation.
	 *
	 * The handle's `treeTier` is the tier the registration last landed at: a renewal failover that re-walks
	 * updates it, so a registration the re-walk moved to the root is re-registered on the next move.
	 */
	async followTail(tail: Uint8Array): Promise<boolean> {
		this.latestTail = tail;
		this.latestTailB64 = bytesToB64url(tail);
		const handle = this.handle;
		if (handle === undefined) {
			await this.register();
			return true;
		}
		if (handle.rootKey !== undefined && bytesToB64url(handle.rootKey) === this.latestTailB64) {
			return false; // the registration already names this root
		}
		if (handle.treeTier === 0) {
			await this.register();
			return true;
		}
		this.service.moveRoot(handle, tail);
		return false;
	}

	/** Run one renewal cycle (keep-alive touch). No-op before the first {@link register}. */
	async renew(): Promise<void> {
		if (this.handle === undefined) {
			return;
		}
		await this.service.renew(this.handle);
	}

	/** Withdraw: stop renewing and send a best-effort signed tombstone so the cohort frees the
	 * registration immediately (TTL expiry remains the fallback if the primary is unreachable). */
	async withdraw(): Promise<void> {
		if (this.handle !== undefined) {
			await this.service.withdraw(this.handle);
		}
	}

	/**
	 * Resume after a sleep/flap (`docs/reactivity.md` §Resume). Sends one {@link ResumeV1} from
	 * `lastRevision + 1`, naming the latest followed {@link tail} as `latestKnownTailId`, to the serving cohort
	 * over the injected {@link ResumeTransport} and applies the classified reply via the db-core
	 * {@link applyResumeReply}: a `backfill` / `checkpoint_window` reply replays its entries through the
	 * delivery path (verified, deduped); `out_of_window` and an untrusted checkpoint escalate to
	 * {@link ReactivitySubscriptionManagerOptions.onChainRead}; `tail_rotated` escalates to
	 * {@link ReactivitySubscriptionManagerOptions.onTailRotated} and invalidates the sticky cohort-hint cache
	 * (the cached primary is at the old root). Throws if no resume transport/signer was configured.
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
			latestKnownTailId: this.latestTailB64,
			subscriberCoord: this.subscriberCoord,
			timestamp: this.clock(),
		};
		const req: ResumeV1 = { ...unsigned, signature: signResume(unsigned) };
		let reply: ResumeReplyV1;
		try {
			reply = await resumeTransport(req);
		} catch (err) {
			if (err instanceof RotationRedirectError) {
				// The resume reached the serving cohort's outgoing (draining) root: honor the redirect (surface
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
				// The cached primary is at the now-stale root; drop it so the follow re-walks.
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
	 * (`docs/reactivity.md` §Tail rotation): a delivered `tailId` that differs from the latest followed
	 * {@link tail} at a revision above any this subscription has seen, or a `rotationHint` pre-announce,
	 * invalidates the sticky cohort-hint cache (the cached primary is at the old root) and surfaces a jittered
	 * follow plan via {@link ReactivitySubscriptionManagerOptions.onRotation}. Fired at most once per successor
	 * tail, and only for a notification that verified: `tailId` is not covered by the threshold signature, but
	 * a frame nobody in a root group signed must not be able to send this subscription walking to a root key
	 * of the sender's choosing.
	 */
	async onNotification(n: NotificationV1): Promise<DeliveryOutcome> {
		// Read before delivery: a contiguous `n` advances the subscriber's head to its own revision, and `n` must
		// be judged against what came before it.
		const newestBefore = this.newestRevision();
		const outcome = await this.subscriber.onNotification(n);
		if (outcome === "untrusted" || outcome === "foreign") {
			return outcome;
		}
		this.checkRotation(n, newestBefore);
		this.newestNotified = Math.max(this.newestNotified, n.revision);
		return outcome;
	}

	/** The newest revision this subscription knows of: notified, replayed by a backfill or resume, or read by its host. */
	private newestRevision(): number {
		return Math.max(this.newestNotified, this.subscriber.lastRevision);
	}

	/** Detect a tail rotation from a verified inbound notification and surface it once per successor tail. */
	private checkRotation(n: NotificationV1, newestRevision: number): void {
		const detection = detectRotation({ tailId: this.latestTailB64, newestRevision }, n);
		if (!detection.rotated || detection.newTailId === undefined) {
			return;
		}
		this.surfaceRotation(detection.newTailId, detection.preAnnounced);
	}

	/**
	 * Surface a rotation to the host **once per successor tail** (`docs/reactivity.md` §Tail rotation):
	 * invalidate the sticky cohort-hint cache (the cached primary is at the now-stale root, so a later
	 * resume re-walks) and — when an {@link ReactivitySubscriptionManagerOptions.onRotation} observer is
	 * configured — hand it a jittered follow plan carrying `lastRevision` (continuous across the rotation).
	 * The single seam both the notification-driven detection ({@link checkRotation}) and the recover-driven
	 * {@link RotationRedirectError} ({@link honorRotationRedirect}) end in; the {@link rotationHandledFor}
	 * guard self-corrects across a chained OLD→A→B rotation.
	 */
	private surfaceRotation(newTailId: string, preAnnounced: boolean): void {
		if (newTailId === this.rotationHandledFor) {
			return; // already surfaced this successor
		}
		this.rotationHandledFor = newTailId;
		// The cached primary is at the now-stale root; drop it so the follow re-walks.
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
	 * Honor a recover-surfaced {@link RotationRedirectError}: the serving cohort's outgoing root rotated and
	 * bounced this request to the new root. Route it through the **same** {@link surfaceRotation} seam a
	 * delivered pre-announce uses (`preAnnounced: false`), so both the notify-driven and recover-driven
	 * rotation paths converge on one `RotationNotice` for the host's follow scheduler to consume.
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
