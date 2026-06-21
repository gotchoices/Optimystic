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
 * well-behaved peer is never permanently penalized. Each key's accept history is trimmed to the live
 * window whenever that key is checked, so a key's footprint stays `O(ratePerWindow)`.
 *
 * The `states` map is bounded two complementary ways so a long-running host cannot leak memory and a
 * flood of attacker-chosen keys cannot exhaust it:
 *
 * - **Hard LRU cap (`maxKeys`)** — enforced inline in {@link SlidingWindowRateLimiter.check}. Every
 *   check moves its key to the most-recently-checked end (the {@link import("../../utility/lru-map.js").LruMap}
 *   delete-then-set trick over `Map` insertion order); when a *new* key would exceed `maxKeys` the
 *   least-recently-checked keys are evicted until within cap. Recency is refreshed on **every** check,
 *   rejects included, so a source mid-attack (accumulated `strikes` driving back-off) stays at the hot
 *   end and is never the eviction victim — only genuinely idle keys age to the cold end.
 * - **Idle-TTL sweep (`idleTtlMs`)** — {@link SlidingWindowRateLimiter.sweep} drops keys not checked
 *   within `idleTtlMs`. Driver-called on the host's gossip cadence, it reclaims steady-state footprint
 *   proportional to *active* keys.
 *
 * Eviction is penalty-free when a key is dropped only after a full window of quiet: the window logic
 * already forgives a source quiet for a full window (its accepts age out and `strikes` resets), so
 * dropping such a key and re-allocating a fresh `{ accepts:[now], strikes:0 }` on its return is
 * observationally identical to keeping it — just an earlier reclaim. This holds for the LRU cap (a
 * mid-attack key is refreshed to the hot end on every check, so only genuinely idle keys are evicted)
 * and for the default `idleTtlMs` (`== windowMs`). A configured `idleTtlMs < windowMs` reclaims more
 * aggressively: `sweep` may then drop a key whose accepts have *not* fully aged out, forgiving its
 * accumulated `strikes` sooner than the window alone would — an accepted footprint/strike-accounting
 * tradeoff, not an identity. The substrate does not defend against unbounded Sybil key creation (that is FRET's /
 * the reputation subsystem's concern; see §Anti-DoS closing note).
 */

import { recordKey } from "../registration/bytes.js";
import { backoffRetryMs, type BackoffConfig, DEFAULT_BACKOFF_CONFIG } from "../willingness.js";
import { createLogger } from "../../logger.js";

const log = createLogger("cohort-topic:antidos");

/** Default per-peer-per-topic acceptance ceiling per window — `register_rate_per_peer` (4 / min). */
export const DEFAULT_REGISTER_RATE_PER_PEER = 4;
/** Default sliding window the ceiling applies over (ms). */
export const DEFAULT_RATE_WINDOW_MS = 60_000;
/** Default hard cap on tracked `(peer, topic)` keys; the least-recently-checked are evicted beyond this. */
export const DEFAULT_RATE_LIMITER_MAX_KEYS = 100_000;
/** Default idle threshold for {@link RegisterRateLimiter.sweep} — one quiet window makes a key evictable. */
export const DEFAULT_RATE_LIMITER_IDLE_TTL_MS = DEFAULT_RATE_WINDOW_MS;

export interface RegisterRateLimiterConfig {
	/** Accepts permitted per window per `(peer, topic)`. Default {@link DEFAULT_REGISTER_RATE_PER_PEER}. */
	ratePerWindow?: number;
	/** Sliding-window length (ms). Default {@link DEFAULT_RATE_WINDOW_MS}. */
	windowMs?: number;
	/** Exponential `retryAfter` curve for over-rate sources. Default {@link DEFAULT_BACKOFF_CONFIG}. */
	backoff?: BackoffConfig;
	/** Hard cap on tracked `(peer, topic)` keys; least-recently-checked evicted beyond this. Default {@link DEFAULT_RATE_LIMITER_MAX_KEYS}. */
	maxKeys?: number;
	/**
	 * A key not checked within this many ms is evictable by {@link RegisterRateLimiter.sweep}. Default
	 * {@link DEFAULT_RATE_LIMITER_IDLE_TTL_MS} (`== windowMs`). Keep `>= windowMs` to preserve the
	 * penalty-free invariant; a smaller value reclaims sooner but may forgive an idle source's strikes
	 * before its window would (see the class doc comment).
	 */
	idleTtlMs?: number;
}

/** Outcome of a rate check: admitted, or refused with the back-off the caller puts in `UnwillingCohort`. */
export type RateCheckResult = { ok: true } | { ok: false; retryAfterMs: number };

/** Per-peer-per-topic inbound `RegisterV1` rate limiter. */
export interface RegisterRateLimiter {
	/**
	 * Classify a register from `peerId` for `topicId` at `now`. Records the accept on `{ ok: true }`;
	 * an over-rate source gets `{ ok: false, retryAfterMs }` with exponential back-off and the strike
	 * is *not* recorded as an accept (so back-off cannot itself fill the window). Every call — accept
	 * **or** reject — refreshes the key's recency, so an actively-hammering source is never evicted by
	 * the LRU cap (which would reset its back-off escalation).
	 */
	check(peerId: Uint8Array, topicId: Uint8Array, now: number): RateCheckResult;
	/**
	 * Evict keys idle (not checked) for `>= idleTtlMs`. Returns the number evicted. Driver-called on
	 * the host's gossip cadence to reclaim steady-state footprint; the hard `maxKeys` LRU cap bounds
	 * worst-case footprint even without it.
	 */
	sweep(now: number): number;
	/** Tracked `(peer, topic)` key count (test/diagnostic introspection). */
	readonly size: number;
}

/** Sliding-window state for one `(peer, topic)` key. */
interface WindowState {
	/** Accept timestamps inside the trailing window, ascending. */
	accepts: number[];
	/** Consecutive over-rate strikes since the last accept — indexes the back-off curve. */
	strikes: number;
	/** `now` of the most recent check (accept OR reject) — LRU recency + idle-TTL key for {@link RegisterRateLimiter.sweep}. */
	lastSeen: number;
}

class SlidingWindowRateLimiter implements RegisterRateLimiter {
	private readonly states = new Map<string, WindowState>();
	private readonly ratePerWindow: number;
	private readonly windowMs: number;
	private readonly backoff: BackoffConfig;
	private readonly maxKeys: number;
	private readonly idleTtlMs: number;

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
		this.maxKeys = config.maxKeys ?? DEFAULT_RATE_LIMITER_MAX_KEYS;
		if (!Number.isInteger(this.maxKeys) || this.maxKeys <= 0) {
			throw new RangeError(`maxKeys must be a positive integer, got ${this.maxKeys}`);
		}
		this.idleTtlMs = config.idleTtlMs ?? DEFAULT_RATE_LIMITER_IDLE_TTL_MS;
		if (!(this.idleTtlMs > 0)) {
			throw new RangeError(`idleTtlMs must be > 0, got ${this.idleTtlMs}`);
		}
	}

	check(peerId: Uint8Array, topicId: Uint8Array, now: number): RateCheckResult {
		const key = recordKey(topicId, peerId);
		const state = this.states.get(key);
		const cutoff = now - this.windowMs;

		if (state === undefined) {
			// New key: enforce the hard cap by evicting the least-recently-checked keys (oldest by
			// `Map` insertion order) until this insertion stays within `maxKeys`. The evicted keys
			// are by construction the coldest — an actively-checked key is refreshed to the hot end
			// below and so is never the victim.
			while (this.states.size >= this.maxKeys) {
				const oldest = this.states.keys().next().value;
				if (oldest === undefined) break;
				this.states.delete(oldest);
			}
			this.states.set(key, { accepts: [now], strikes: 0, lastSeen: now });
			return { ok: true };
		}

		// Refresh LRU recency on every check (accept OR reject): delete-then-set moves this key to the
		// most-recently-checked end of the `Map`, and `lastSeen = now` is the idle-TTL key sweep() reads.
		// A source mid-attack stays at the hot end here even on a reject, so the cap never evicts (and
		// thus never resets the back-off of) an active attacker.
		this.states.delete(key);
		this.states.set(key, state);
		state.lastSeen = now;

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

	sweep(now: number): number {
		let evicted = 0;
		// Deleting the current key during `Map` iteration is well-defined and does not skip entries.
		for (const [key, state] of this.states) {
			if (now - state.lastSeen >= this.idleTtlMs) {
				this.states.delete(key);
				evicted++;
			}
		}
		return evicted;
	}

	get size(): number {
		return this.states.size;
	}
}

/** Build a {@link RegisterRateLimiter} over the configured ceiling, window, and back-off curve. */
export function createRegisterRateLimiter(config: RegisterRateLimiterConfig = {}): RegisterRateLimiter {
	return new SlidingWindowRateLimiter(config);
}
