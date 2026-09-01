import type { Collection } from '../collection/collection.js';

/** Yield the event loop through the MACROTASK queue `turns` times, so a refresh that is free to
 *  proceed gets every chance to run its (await-heavy) course before a gate opens. A microtask
 *  drain would not be enough: `Collection.update()` awaits real transactor reads.
 *
 *  NOTE: the turn count is what gives {@link releaseRefresh}'s `blocked()` assertions their teeth
 *  — an unlatched `Collection.update()` has to be able to run to COMPLETION within these turns,
 *  or "still pending" stops distinguishing "blocked on the latch" from "merely slow". Ten is a
 *  ~10x margin today: with the coordinator's latch reverted locally, the refreshes in
 *  `coordinator-latch-interleaving.spec.ts` completed on macrotask turn 1 against
 *  `TestTransactor`. If `update()` ever grows a deeper await chain — or a caller moves onto a
 *  transactor with real I/O — raise this rather than letting the assertion quietly weaken into a
 *  tautology. */
export async function drainMacrotasks(turns = 10): Promise<void> {
	for (let i = 0; i < turns; i++) {
		await new Promise(r => setTimeout(r, 0));
	}
}

/** The handle {@link releaseRefresh} returns: `blocked()` reports whether the refresh is still
 *  pending, `settle()` awaits it and rethrows whatever it rejected with. */
export type RefreshProbe = {
	/** Await the refresh, rethrowing its failure (captured at start time — see the note there). */
	settle: () => Promise<void>;
	/** True while the refresh has neither resolved nor rejected. */
	blocked: () => boolean;
};

/** Start a refresh on `collection` and report — via the returned `blocked()` — whether it is
 *  STILL pending.
 *
 *  A final-state assertion alone would also pass if the refresh had simply run to completion
 *  harmlessly, so on its own it never proves the latch is what protected the state. This does:
 *  checked after {@link drainMacrotasks} but before a parked commit's gate opens, a still-pending
 *  refresh is a refresh queued behind the commit's held latch. */
export function releaseRefresh<TAction>(collection: Collection<TAction>): RefreshProbe {
	let done = false;
	let failure: unknown;
	// Both handlers attach SYNCHRONOUSLY, and the rethrowing promise is built only when the caller
	// asks for it. The refresh sits unawaited across drainMacrotasks, so a rejection reaching the
	// end of a turn with no handler would be a fatal unhandled rejection — killing the process
	// instead of failing the case. Captured here, rethrown at `settle()`.
	const captured = collection.update().then(
		() => { done = true; },
		(e: unknown) => { done = true; failure = e; },
	);
	return {
		settle: () => captured.then(() => { if (failure !== undefined) throw failure; }),
		blocked: () => !done,
	};
}
