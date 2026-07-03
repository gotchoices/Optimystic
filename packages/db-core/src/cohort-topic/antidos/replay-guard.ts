/**
 * Cohort-topic substrate — correlation-id replay guard (anti-DoS).
 *
 * Transcribed from `docs/cohort-topic.md` §Anti-DoS bullet 3. Every `RegisterV1` carries a
 * `correlationId` (16 random bytes) and a signature over `(topicId, tier, correlationId, timestamp)`.
 * The signature (verified elsewhere — the participant-key check) proves authorship; this guard adds
 * **freshness**: it drops a registration whose `timestamp` is outside the accepted skew window
 * (stale, or implausibly far in the future) and drops a `correlationId` it has already seen inside the
 * window (a captured-and-replayed registration).
 *
 * Because a stale registration is rejected outright, the guard only needs to remember correlation ids
 * for one `maxAgeMs` window: an id older than that would be rejected on timestamp alone, so its record
 * can be pruned. Pruning runs on access, bounding memory to the live window's worth of registrations.
 *
 * On top of the age-based prune, the map carries a **hard LRU `maxKeys` cap** (mirroring the sibling
 * {@link import("./rate-limiter.js").RegisterRateLimiter}) so a flood of genuinely-fresh, admitted
 * correlationIds cannot grow `seen` without bound before the age prune fires. When a new id would
 * exceed the cap, the **oldest-inserted** entries are evicted until within cap. That victim is the
 * least-bad one: replay entries are inserted once and never refreshed, so `Map` insertion order tracks
 * timestamp order — the oldest entry is the one nearest to aging out of the window and being pruned as
 * stale anyway. Evicting it forgives at most that entry's remaining replay-protection window: a bounded,
 * documented tradeoff (unlike the rate limiter's fully penalty-free eviction), and one that only
 * triggers under a flood of admitted ids — which, in the register pipeline, must also have passed the
 * signature, rate, and bootstrap gates before ever reaching this guard.
 */

import { bytesKey } from "../registration/bytes.js";
import { createLogger } from "../../logger.js";

const log = createLogger("cohort-topic:antidos");

/** Default acceptance window: a registration timestamped older than this (relative to `now`) is stale. */
export const DEFAULT_REPLAY_MAX_AGE_MS = 60_000;
/** Default tolerated forward clock skew: a timestamp this far past `now` is rejected as implausible. */
export const DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS = 5_000;
/** Default hard cap on remembered correlationIds; the oldest-inserted are evicted beyond this. */
export const DEFAULT_REPLAY_GUARD_MAX_KEYS = 100_000;

export interface CorrelationReplayGuardConfig {
	/** A timestamp older than `now − maxAgeMs` is stale. Default {@link DEFAULT_REPLAY_MAX_AGE_MS}. */
	maxAgeMs?: number;
	/** A timestamp newer than `now + maxFutureSkewMs` is rejected. Default {@link DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS}. */
	maxFutureSkewMs?: number;
	/** Hard LRU cap on remembered correlationIds; oldest-inserted (≈ oldest-timestamp) evicted beyond this. Default {@link DEFAULT_REPLAY_GUARD_MAX_KEYS}. */
	maxKeys?: number;
}

/** Freshness + anti-replay gate over registration `correlationId`s and timestamps. */
export interface CorrelationReplayGuard {
	/**
	 * Accept `correlationId` (from `peerId`, stamped `timestamp`) evaluated at `now`. Returns `false`
	 * — and records nothing — when the timestamp is stale or implausibly future, or when this
	 * `correlationId` was already accepted inside the window (replay). Returns `true` and remembers the
	 * id on first sight of a fresh registration.
	 */
	accept(correlationId: Uint8Array, peerId: Uint8Array, timestamp: number, now: number): boolean;
	/** Remembered correlationId count (test/diagnostic introspection). */
	readonly size: number;
}

/** A remembered acceptance, kept until its timestamp ages out of the window. */
interface SeenEntry {
	timestamp: number;
	peer: string;
}

class WindowedReplayGuard implements CorrelationReplayGuard {
	private readonly seen = new Map<string, SeenEntry>();
	private readonly maxAgeMs: number;
	private readonly maxFutureSkewMs: number;
	private readonly maxKeys: number;
	/** `now` of the last prune, so pruning amortizes rather than scanning on every call. */
	private lastPruneAt = -Infinity;

	constructor(config: CorrelationReplayGuardConfig = {}) {
		this.maxAgeMs = config.maxAgeMs ?? DEFAULT_REPLAY_MAX_AGE_MS;
		if (!(this.maxAgeMs > 0)) {
			throw new RangeError(`maxAgeMs must be > 0, got ${this.maxAgeMs}`);
		}
		this.maxFutureSkewMs = config.maxFutureSkewMs ?? DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS;
		if (!(this.maxFutureSkewMs >= 0)) {
			throw new RangeError(`maxFutureSkewMs must be >= 0, got ${this.maxFutureSkewMs}`);
		}
		this.maxKeys = config.maxKeys ?? DEFAULT_REPLAY_GUARD_MAX_KEYS;
		if (!Number.isInteger(this.maxKeys) || this.maxKeys <= 0) {
			throw new RangeError(`maxKeys must be a positive integer, got ${this.maxKeys}`);
		}
	}

	accept(correlationId: Uint8Array, peerId: Uint8Array, timestamp: number, now: number): boolean {
		if (timestamp < now - this.maxAgeMs) {
			log("replay-guard reject: stale timestamp age=%d > maxAge=%d", now - timestamp, this.maxAgeMs);
			return false; // stale
		}
		if (timestamp > now + this.maxFutureSkewMs) {
			log("replay-guard reject: future timestamp skew=%d > maxSkew=%d", timestamp - now, this.maxFutureSkewMs);
			return false; // implausibly future
		}
		this.maybePrune(now);
		const key = bytesKey(correlationId);
		const prior = this.seen.get(key);
		if (prior !== undefined) {
			// Attribute the replay to the *original* accepter: the correlationId (not the peer id) is the
			// anti-replay key, so a replayer that spoofs a different source id is still caught here.
			log("replay-guard reject: replayed correlationId (first seen from peer=%s)", prior.peer);
			return false; // replay
		}
		// New id: enforce the hard cap by evicting the oldest-inserted entries (oldest by `Map` insertion
		// order) until this insertion stays within `maxKeys`. Since entries are inserted once and never
		// refreshed, insertion order closely tracks timestamp order, so the victim is ≈ the oldest-timestamp
		// — nearest to aging out as stale. (It is only ≈: ids from distinct peers can arrive out of
		// timestamp order within the skew window, so a victim may retain slightly more window than a
		// strictly-oldest pick. The forgiveness bound — at most one entry's remaining window — holds either way.)
		while (this.seen.size >= this.maxKeys) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			this.seen.delete(oldest);
		}
		this.seen.set(key, { timestamp, peer: bytesKey(peerId) });
		return true;
	}

	/** Forget ids whose timestamp has aged past the window — they would be rejected as stale anyway. */
	private maybePrune(now: number): void {
		// Amortize: prune at most once per window rather than scanning on every accept.
		if (now - this.lastPruneAt < this.maxAgeMs) {
			return;
		}
		this.lastPruneAt = now;
		const cutoff = now - this.maxAgeMs;
		for (const [key, entry] of this.seen) {
			if (entry.timestamp < cutoff) {
				this.seen.delete(key);
			}
		}
	}

	get size(): number {
		return this.seen.size;
	}
}

/** Build a {@link CorrelationReplayGuard} over the configured staleness window and forward skew. */
export function createCorrelationReplayGuard(config: CorrelationReplayGuardConfig = {}): CorrelationReplayGuard {
	return new WindowedReplayGuard(config);
}
