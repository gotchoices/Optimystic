/**
 * Reactivity — tail-rotation re-registration timer host seam (`docs/reactivity.md` §Tail rotation step 3).
 *
 * The {@link import("./subscription-manager.js").ReactivitySubscriptionManager} surfaces a
 * {@link import("./subscription-manager.js").RotationNotice} **once per successor tail** (both the
 * notify-driven pre-announce and the recover-driven `RotationRedirectError` converge on the same
 * `surfaceRotation` seam), but it neither schedules the timer nor performs the move. This host component
 * does: it consumes a notice, schedules a one-shot timer for `max(0, plan.fireAt - now())`, and on fire
 * invokes an injected `reRegister(plan)` seam that re-subscribes the watcher at the rotated tree. The node
 * composition that constructs the manager + binds this scheduler to its `onRotation` observer lives in
 * `reactivity-rotation-host-wiring-e2e`; this module is the standalone, unit-testable piece.
 *
 * **Where the stagger lives.** The spread that keeps the new tail from being flooded is entirely in
 * `plan.fireAt`, drawn by the **manager's** `rejoinJitter`. This scheduler only *consumes* `plan.fireAt`; it
 * never sees the jitter. The manager uses the *single*-subscriber planner `planReRegistration` →
 * `RejoinJitter.scheduleRejoin`, which draws a **uniform** offset `now + ⌊U[0, T_rejoin_jitter)⌋` — so the
 * load-bearing knob for this path is the **window** `T_rejoin_jitter` (default 30 s), not a `capPromote`. Each
 * subscriber jitters independently, giving the new tail an inbound rate of ≈ `subscribers / T_rejoin_jitter`
 * in expectation; the burst is absorbed on the *receiving* side by the new tail cohort's `cap_promote_fast`
 * fast-promotion (a cohort-topic promotion mechanism — see `docs/reactivity.md` §Tail rotation rotation-cost
 * and the Worked scenario), which is independent of the jitter's `capPromote`.
 *
 * Note that `RejoinJitter`'s `capPromote` is consulted **only** by the *wave* planner
 * `scheduleWave` / `planReRegistrationWave` (a single host staggering a whole wave with a hard per-window
 * ceiling — used by the mesh harness, not by the production manager). If the composing site
 * (`reactivity-rotation-host-wiring-e2e`) ever switches the manager onto the wave planner, *then* it must
 * build the jitter as `createRejoinJitter({ capPromote: DEFAULT_CAP_PROMOTE_FAST })` (= 32), since the default
 * `createRejoinJitter()` cap is the cohort-failure `cap_promote = 64`. For the current single-planner path,
 * setting `capPromote` has **no effect** on `fireAt`.
 *
 * **Determinism.** An injected `setTimer(fn, delayMs) => cancel` and `now()` clock make the scheduler
 * testable with a fake clock (no wall clock). They default to a production binding: an **unref'd**
 * `setTimeout`/`clearTimeout` and `Date.now`. The unref is load-bearing — an idle re-registration timer must
 * not pin an otherwise-idle process, mirroring the push-state-gossip driver's unref'd timer
 * ({@link import("./push-state-gossip.js").ReactivityPushStateGossipDriver}).
 *
 * **Idempotence.** De-duped by successor `newTopicId` (base64url): a second notice for a successor already
 * scheduled or fired is ignored. The manager already fires once per successor (its `rotationHandledFor`
 * guard), but a redirect and a pre-announce can surface the **same** successor near-simultaneously, so the
 * scheduler is independently idempotent.
 *
 * **Chained rotation OLD→A→B** before A's timer fires → A and B are distinct successors → two independent
 * timers; **both may fire**. Re-registering at A and then immediately rotating A→B is self-correcting via the
 * manager's `rotationHandledFor` guard, so a superseded timer is intentionally **not** cancelled (a
 * superseded re-register is harmless and rare).
 */

import { bytesToB64url, type ReRegistrationPlan } from "@optimystic/db-core";
import type { RotationNotice } from "./subscription-manager.js";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-rotation-rereg");

/** Cancel handle returned by an injected timer; cancels a not-yet-fired timer (safe no-op after fire/cancel). */
export type RotationTimerCancel = () => void;

/**
 * Production timer binding: a one-shot `setTimeout` whose handle is **unref'd** so a pending re-registration
 * never keeps an otherwise-idle process alive. The returned handle clears the timeout (idempotent — clearing
 * an already-fired/cleared timeout is a no-op).
 */
function defaultSetTimer(fn: () => void, delayMs: number): RotationTimerCancel {
	const handle = setTimeout(fn, delayMs);
	// Node timers keep the event loop alive; an idle rotation timer must not pin a process (mirror push-state gossip).
	(handle as { unref?: () => void }).unref?.();
	return (): void => clearTimeout(handle);
}

/** Construction inputs for a {@link RotationReRegistrationScheduler}. */
export interface RotationReRegistrationSchedulerOptions {
	/**
	 * Perform the actual move: re-subscribe the watcher at the rotated tree (the new `topicId`, carrying the
	 * plan's `lastRevision`). A rejection is isolated + logged — a failed move must never throw out of the
	 * timer callback. Not retried this pass (see the class doc).
	 */
	readonly reRegister: (plan: ReRegistrationPlan) => Promise<void>;
	/**
	 * Schedule a one-shot timer; returns a cancel handle. Defaults to an **unref'd** `setTimeout`. Tests inject
	 * a fake timer queue for determinism.
	 */
	readonly setTimer?: (fn: () => void, delayMs: number) => RotationTimerCancel;
	/** Clock (Unix ms). Defaults to `Date.now`; tests inject a fake clock. */
	readonly now?: () => number;
}

/**
 * Hosts the per-successor one-shot timers that move a subscriber to the rotated tree. Construct one per
 * subscription manager and bind {@link schedule} to the manager's
 * {@link import("./subscription-manager.js").ReactivitySubscriptionManagerOptions.onRotation} observer.
 *
 * See the module doc for where the re-registration stagger actually lives (the manager's `rejoinJitter`; this
 * scheduler only consumes `plan.fireAt`, it does not draw it).
 */
export class RotationReRegistrationScheduler {
	private readonly reRegister: (plan: ReRegistrationPlan) => Promise<void>;
	private readonly setTimer: (fn: () => void, delayMs: number) => RotationTimerCancel;
	private readonly now: () => number;

	/** Successors with a still-pending timer, keyed by base64url `newTopicId` → its cancel handle. */
	private readonly pending = new Map<string, RotationTimerCancel>();
	/** Successors ever scheduled (pending **or** already fired) — the idempotence ledger that survives fire. */
	private readonly seen = new Set<string>();
	private stopped = false;

	constructor(options: RotationReRegistrationSchedulerOptions) {
		this.reRegister = options.reRegister;
		this.setTimer = options.setTimer ?? defaultSetTimer;
		this.now = options.now ?? ((): number => Date.now());
	}

	/** Successors with a timer still pending (not yet fired/cancelled). Diagnostic / test seam. */
	get pendingCount(): number {
		return this.pending.size;
	}

	/**
	 * Schedule the re-registration timer for a rotation notice. De-duped by successor `newTopicId`: a second
	 * notice for an already-scheduled-or-fired successor is a no-op (a redirect and a pre-announce can surface
	 * the same successor). The delay is `max(0, plan.fireAt - now())`, so a `fireAt` already in the past fires
	 * on the next tick (clamped to 0, never negative). A no-op once {@link stop} has run.
	 */
	schedule(notice: RotationNotice): void {
		if (this.stopped) {
			return;
		}
		const key = bytesToB64url(notice.plan.newTopicId);
		if (this.seen.has(key)) {
			log("rotation re-registration already scheduled/fired for successor topic=%s — ignoring duplicate notice (preAnnounced=%s)", key, notice.preAnnounced);
			return;
		}
		this.seen.add(key);
		const delayMs = Math.max(0, notice.plan.fireAt - this.now());
		const plan = notice.plan;
		const cancel = this.setTimer((): void => {
			this.fire(key, plan);
		}, delayMs);
		this.pending.set(key, cancel);
		log("scheduled rotation re-registration for successor topic=%s in %dms (preAnnounced=%s)", key, delayMs, notice.preAnnounced);
	}

	/**
	 * Cancel a single pending timer (by successor `newTopicId`) or, when called with no argument, **all**
	 * pending timers (teardown). Cancelling an already-fired or unknown successor is a safe no-op. A cancelled
	 * successor is forgotten (dropped from the idempotence ledger), so a later notice for it would reschedule;
	 * use {@link stop} for permanent teardown.
	 */
	cancel(newTopicId?: Uint8Array): void {
		if (newTopicId === undefined) {
			for (const cancelTimer of this.pending.values()) {
				cancelTimer();
			}
			this.pending.clear();
			this.seen.clear();
			return;
		}
		const key = bytesToB64url(newTopicId);
		const cancelTimer = this.pending.get(key);
		if (cancelTimer !== undefined) {
			cancelTimer();
			this.pending.delete(key);
		}
		this.seen.delete(key);
	}

	/**
	 * Stop the scheduler permanently (teardown): cancel every pending timer and refuse all further scheduling
	 * and firing. A timer that races `stop` (its callback already queued) finds the `stopped` gate and never
	 * invokes `reRegister`. Idempotent.
	 */
	stop(): void {
		this.stopped = true;
		for (const cancelTimer of this.pending.values()) {
			cancelTimer();
		}
		this.pending.clear();
		this.seen.clear();
	}

	/** Timer callback: drop the pending entry, then invoke the isolated re-registration (unless stopped). */
	private fire(key: string, plan: ReRegistrationPlan): void {
		this.pending.delete(key);
		if (this.stopped) {
			return; // stop() raced the timer callback — no move after teardown.
		}
		// A failed move must never throw out of the timer callback — an escaping throw / unhandled rejection
		// would surface on the host event loop. Guard BOTH a rejected promise and a (mis-implemented) seam that
		// throws synchronously. `seen` retains the key so a duplicate notice still no-ops. No retry this pass —
		// and because `seen` keeps the key, a re-notice for this *same* successor is deduped (the manager's
		// `rotationHandledFor` already holds it too), so the recovery backstop for a failed move is the
		// subscriber's normal recover/re-walk path, not a re-detected rotation to the same tail.
		try {
			void this.reRegister(plan).catch((err: unknown) => {
				log("rotation re-registration rejected for successor topic=%s (isolated, not retried): %o", key, err);
			});
		} catch (err) {
			log("rotation re-registration threw synchronously for successor topic=%s (isolated): %o", key, err);
		}
	}
}
