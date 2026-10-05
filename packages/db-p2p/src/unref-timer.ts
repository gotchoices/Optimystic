/**
 * Keep a pending timer from holding a Node process open. Browsers and React Native return a number
 * from `setTimeout` / `setInterval`, which has no `unref`, so the call is guarded. Every first-party
 * `unref` goes through here; the `NO_TIMER_UNREF` lint rule in `eslint.config.js` enforces that.
 */
export function unrefTimer<T>(handle: T): T {
	(handle as { unref?: () => void }).unref?.();
	return handle;
}
