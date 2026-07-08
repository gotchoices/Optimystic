import { randomBytes } from '@noble/hashes/utils.js';

/**
 * Jittered exponential backoff shared by the retry loops in db-core
 * ({@link Collection.sync} and {@link TransactionCoordinator.commit}).
 *
 * The point of the jitter is fairness under contention: when many clients lose the SAME
 * optimistic-concurrency race at t=0, a bare exponential curve makes them all re-attempt at the
 * identical next tick — a thundering herd that just re-collides. Multiplying the exponential value
 * by a random factor spreads those re-attempts across a window so offered load per tick sheds
 * instead of cascading. This is the same shape as `cohort-topic`'s `backoffRetryMs`, with the
 * proportional-jitter term added.
 */

/** A source of uniform randomness in [0, 1). Injected in tests so a deterministic sequence can be
 * asserted; production uses {@link cryptoRand}. */
export type RandFn = () => number;

/** Uniform value in [0, 1) drawn from the same CSPRNG (`@noble/hashes` `randomBytes`) the rest of
 * db-core uses — deliberately NOT `Math.random`, so backoff jitter shares the package's randomness
 * source rather than introducing a second, weaker one. */
export function cryptoRand(): number {
	const b = randomBytes(4);
	// Assemble a uint32 (>>> 0 clears the sign bit the shifts would otherwise set), then normalise.
	const u = (((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0);
	return u / 0x1_0000_0000;
}

export interface JitteredBackoffConfig {
	/** Base delay (ms) for attempt 0, before jitter. */
	baseMs: number;
	/** Hard ceiling (ms) on the pre-jitter exponential value. */
	capMs: number;
	/** Geometric growth per attempt. Default 2 (doubling). */
	factor?: number;
	/** Fraction of the exponential value that jitter may subtract, in [0, 1]. Default 0.5, so the
	 * returned delay lands uniformly in `((1 - jitterFraction) · exp, exp]` — i.e. `(0.5·exp, exp]`. */
	jitterFraction?: number;
}

/**
 * Delay (ms) for retry `attempt` (0-based):
 *
 *   exp   = min(baseMs · factor^attempt, capMs)
 *   delay = exp · (1 - jitterFraction · rand())     // rand() ∈ [0, 1)
 *
 * With the defaults (factor 2, jitterFraction 0.5) the delay is uniform in `(0.5·exp, exp]`: never
 * zero (as long as `baseMs > 0`) and never above `capMs`. `attempt` must be a non-negative integer
 * — pass `consecutiveFailures - 1` so the first retry backs off by ~`baseMs`.
 */
export function jitteredBackoffMs(
	attempt: number,
	config: JitteredBackoffConfig,
	rand: RandFn = cryptoRand,
): number {
	if (!Number.isInteger(attempt) || attempt < 0) {
		throw new RangeError(`attempt must be a non-negative integer, got ${attempt}`);
	}
	const factor = config.factor ?? 2;
	const jitterFraction = config.jitterFraction ?? 0.5;
	const exp = Math.min(config.baseMs * factor ** attempt, config.capMs);
	return exp * (1 - jitterFraction * rand());
}

/** Build an AbortError for a cooperatively-aborted wait. Prefers the signal's own reason when it is
 * an Error (so callers who passed a custom abort reason see it), otherwise a `name='AbortError'`
 * Error. */
export function makeAbortError(signal?: AbortSignal): Error {
	if (signal && signal.reason instanceof Error) {
		return signal.reason;
	}
	const err = new Error('The operation was aborted');
	err.name = 'AbortError';
	return err;
}

/** Sleep for `ms`, resolving early (rejecting with an AbortError) if `signal` aborts — so a retry
 * loop waiting out a backoff rejects promptly instead of finishing the sleep. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(makeAbortError(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(makeAbortError(signal!));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
