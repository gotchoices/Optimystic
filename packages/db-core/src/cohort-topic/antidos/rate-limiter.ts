/**
 * Cohort-topic substrate — per-peer registration rate limiter (anti-DoS).
 *
 * Transcribed from `docs/cohort-topic.md` §Anti-DoS bullet 1. A cohort member tracks inbound
 * `RegisterV1` rate per `(sourcePeerId, topicId)` and refuses a source that exceeds
 * `register_rate_per_peer` (default 4 / min). An over-rate registration draws `UnwillingCohort` with
 * an **exponential** `retryAfter`, so a peer hammering one topic at one cohort backs off geometrically
 * — the same capped-doubling curve the willingness back-off uses ({@link backoffRetryMs}).
 *
 * The limiter is a sliding-window counter: it keeps the accept timestamps inside the trailing
 * `windowMs` for each key, admits while the window holds `< ratePerWindow`, and on rejection advances
 * a per-key strike counter that indexes the back-off curve. A run of strikes decays once the source
 * has been quiet for a full window (its window empties and the strike counter resets), so a
 * well-behaved peer is never permanently penalized. Idle keys are pruned on access to bound memory —
 * the substrate does not defend against unbounded Sybil key creation (that is FRET's / the reputation
 * subsystem's concern; see §Anti-DoS closing note).
 */

import { recordKey } from "../registration/bytes.js";
import { backoffRetryMs, type BackoffConfig, DEFAULT_BACKOFF_CONFIG } from "../willingness.js";
import { createLogger } from "../../logger.js";

const log = createLogger("cohort-topic:antidos");

/** Default per-peer-per-topic acceptance ceiling per window — `register_rate_per_peer` (4 / min). */
export const DEFAULT_REGISTER_RATE_PER_PEER = 4;
/** Default sliding window the ceiling applies over (ms). */
export const DEFAULT_RATE_WINDOW_MS = 60_000;

export interface RegisterRateLimiterConfig {
	/** Accepts permitted per window per `(peer, topic)`. Default {@link DEFAULT_REGISTER_RATE_PER_PEER}. */
	ratePerWindow?: number;
	/** Sliding-window length (ms). Default {@link DEFAULT_RATE_WINDOW_MS}. */
	windowMs?: number;
	/** Exponential `retryAfter` curve for over-rate sources. Default {@link DEFAULT_BACKOFF_CONFIG}. */
	backoff?: BackoffConfig;
}

/** Outcome of a rate check: admitted, or refused with the back-off the caller puts in `UnwillingCohort`. */
export type RateCheckResult = { ok: true } | { ok: false; retryAfterMs: number };

/** Per-peer-per-topic inbound `RegisterV1` rate limiter. */
export interface RegisterRateLimiter {
	/**
	 * Classify a register from `peerId` for `topicId` at `now`. Records the accept on `{ ok: true }`;
	 * an over-rate source gets `{ ok: false, retryAfterMs }` with exponential back-off and the strike
	 * is *not* recorded as an accept (so back-off cannot itself fill the window).
	 */
	check(peerId: Uint8Array, topicId: Uint8Array, now: number): RateCheckResult;
}

/** Sliding-window state for one `(peer, topic)` key. */
interface WindowState {
	/** Accept timestamps inside the trailing window, ascending. */
	accepts: number[];
	/** Consecutive over-rate strikes since the last accept — indexes the back-off curve. */
	strikes: number;
}

class SlidingWindowRateLimiter implements RegisterRateLimiter {
	private readonly states = new Map<string, WindowState>();
	private readonly ratePerWindow: number;
	private readonly windowMs: number;
	private readonly backoff: BackoffConfig;

	constructor(config: RegisterRateLimiterConfig = {}) {
		this.ratePerWindow = config.ratePerWindow ?? DEFAULT_REGISTER_RATE_PER_PEER;
		if (!Number.isInteger(this.ratePerWindow) || this.ratePerWindow <= 0) {
			throw new RangeError(`ratePerWindow must be a positive integer, got ${this.ratePerWindow}`);
		}
		this.windowMs = config.windowMs ?? DEFAULT_RATE_WINDOW_MS;
		if (!(this.windowMs > 0)) {
			throw new RangeError(`windowMs must be > 0, got ${this.windowMs}`);
		}
		this.backoff = config.backoff ?? DEFAULT_BACKOFF_CONFIG;
	}

	check(peerId: Uint8Array, topicId: Uint8Array, now: number): RateCheckResult {
		const key = recordKey(topicId, peerId);
		const state = this.states.get(key);
		const cutoff = now - this.windowMs;

		if (state === undefined) {
			this.states.set(key, { accepts: [now], strikes: 0 });
			return { ok: true };
		}

		// Drop accepts that have aged out of the trailing window.
		let live = 0;
		for (const t of state.accepts) {
			if (t > cutoff) {
				state.accepts[live++] = t;
			}
		}
		state.accepts.length = live;

		if (live === 0) {
			// The source has been quiet for a full window — forgive accumulated strikes.
			state.strikes = 0;
		}

		if (live < this.ratePerWindow) {
			state.accepts.push(now);
			state.strikes = 0;
			return { ok: true };
		}

		// Over rate: exponential back-off indexed by the strike count, then advance the strike.
		const retryAfterMs = backoffRetryMs(state.strikes, this.backoff);
		state.strikes++;
		log("rate-limit reject window=%d/%d strikes=%d retryAfter=%d", live, this.ratePerWindow, state.strikes, retryAfterMs);
		return { ok: false, retryAfterMs };
	}
}

/** Build a {@link RegisterRateLimiter} over the configured ceiling, window, and back-off curve. */
export function createRegisterRateLimiter(config: RegisterRateLimiterConfig = {}): RegisterRateLimiter {
	return new SlidingWindowRateLimiter(config);
}
