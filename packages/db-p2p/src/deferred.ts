/** A promise with its settlement in hand. */
export interface Deferred {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (err: unknown) => void;
}

const noop = (): void => undefined;

/**
 * A {@link Deferred} whose rejection is never unhandled: a settlement nobody awaits — a write
 * batch's durability that no strict flush or `whenDurable()` is waiting on — must not surface as an
 * unhandled rejection, while every awaiter still sees it.
 */
export function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
	promise.catch(noop);
	return { promise, resolve, reject };
}
