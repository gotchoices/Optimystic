export interface WaitForOptions {
	// NOTE: default is tuned for in-process settles; integration callers over real libp2p
	// pass explicit 10k–90k bounds. A new caller that omits timeoutMs gets 2s — fine for
	// fast local conditions, but if a slow CI machine flakes on a legitimately-slow wait,
	// give that call site an explicit timeoutMs rather than raising this default.
	/** Upper bound before the poll gives up. Default 2_000. */
	timeoutMs?: number;
	/** Poll cadence. Default 10. */
	intervalMs?: number;
	/** Included in the thrown message so a failure says WHAT never became true. */
	description?: string;
}

/** Real-time sleep. Retain ONLY for residual cases a condition poll cannot cover. */
export const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `predicate` until it returns true or `timeoutMs` elapses; throws on timeout.
 * `predicate` may be sync or async; a thrown/rejected predicate propagates immediately.
 * `undefined` is treated as `false` (not ready yet).
 */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	opts?: WaitForOptions,
): Promise<void> {
	const { timeoutMs = 2_000, intervalMs = 10, description } = opts ?? {};
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) {
			throw new Error(
				description
					? `waitFor timed out after ${timeoutMs}ms: ${description}`
					: `waitFor timed out after ${timeoutMs}ms`,
			);
		}
		await delay(intervalMs);
	}
}

/**
 * Poll `fn` until it returns a non-undefined value or `timeoutMs` elapses; throws on timeout.
 * `undefined` means "not ready yet" — callers needing to wait for an actual `undefined`
 * should use `waitFor` on a separate flag.
 */
export async function waitForValue<T>(
	fn: () => T | undefined | Promise<T | undefined>,
	opts?: WaitForOptions,
): Promise<T> {
	const { timeoutMs = 2_000, intervalMs = 10, description } = opts ?? {};
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await fn();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) {
			throw new Error(
				description
					? `waitForValue timed out after ${timeoutMs}ms: ${description}`
					: `waitForValue timed out after ${timeoutMs}ms`,
			);
		}
		await delay(intervalMs);
	}
}
