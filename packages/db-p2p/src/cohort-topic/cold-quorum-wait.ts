/**
 * Cohort-topic cold-start quorum wait (`docs/cohort-topic.md` §Cold-start instantiation).
 *
 * A cohort that has just started serving a topic would decline the registration that woke it: the routed
 * member counts willing members from gossip it has not received yet. This is the host side of db-core's
 * {@link QuorumWait} port, which holds such a register instead — one shared wait per coord engine, opened by
 * asking the members to gossip their willingness now, and settled as their frames merge or at a deadline.
 */

import type { QuorumWait } from "@optimystic/db-core";
import { unrefTimer } from "../unref-timer.js";

/**
 * Default `T_cold_quorum_wait` (ms): how long a register is held for the cohort's members to answer. It has
 * to stay well under the 5 s a participant waits for the reply (p2p-fret's `RPC_TIMEOUT_MS`), with room for a
 * FRET-routed hop or the root-group dial loop in front of it.
 */
export const DEFAULT_COLD_QUORUM_WAIT_MS = 2_000;

// NOTE: caps the register streams one engine holds open at a time; a register past it is declined at once, as
// every such register was before the wait existed. Each waiter costs one closure and one willingness
// evaluation per inbound gossip frame. If a cold start ever sees more simultaneous first registrations, raise it.
export const MAX_COLD_QUORUM_WAITERS = 64;

export interface ColdQuorumWaitDeps {
	/** How long a wait stays open (ms), from the moment the members were asked. */
	readonly waitMs: number;
	/**
	 * Ask the cohort's members to gossip their willingness now. Returns false when they were not asked — the
	 * engine is closed, asked too recently, or has nothing it may send — and then no wait opens, because
	 * nothing would answer it. This is what keeps a member that never answers from turning every register on
	 * the engine into a full-length hold.
	 */
	readonly solicit: (now: number) => boolean;
}

export interface ColdQuorumWait extends QuorumWait {
	/** Settle every waiter whose condition now holds. The host calls it after each inbound gossip merge. */
	recheck(): void;
	/** Settle every waiter now and drop the deadline (the engine is closing). */
	close(): void;
}

interface Waiter {
	readonly ready: () => boolean;
	readonly settle: () => void;
}

/** Build the one shared {@link ColdQuorumWait} of a coord engine. */
export function createColdQuorumWait(deps: ColdQuorumWaitDeps): ColdQuorumWait {
	const waiters = new Set<Waiter>();
	// Set exactly while a wait is open.
	let deadline: ReturnType<typeof setTimeout> | undefined;

	const closeWait = (): void => {
		clearTimeout(deadline);
		deadline = undefined;
	};
	/** Settle the waiters `which` selects; a wait nobody is left in is closed. */
	const settle = (which: (waiter: Waiter) => boolean): void => {
		for (const waiter of [...waiters]) {
			if (which(waiter)) {
				waiters.delete(waiter);
				waiter.settle();
			}
		}
		if (waiters.size === 0) {
			closeWait();
		}
	};
	const openWait = (now: number): boolean => {
		if (!deps.solicit(now)) {
			return false;
		}
		deadline = setTimeout((): void => settle((): boolean => true), deps.waitMs);
		// A held register must not keep an otherwise idle process alive.
		unrefTimer(deadline);
		return true;
	};

	return {
		until(ready: () => boolean, now: number): Promise<number> {
			if (deadline === undefined && !openWait(now)) {
				return Promise.resolve(now);
			}
			if (waiters.size >= MAX_COLD_QUORUM_WAITERS) {
				return Promise.resolve(now);
			}
			// The caller's clock, advanced by the time actually spent waiting: a caller driving the engine on a
			// clock of its own gets a settle time on that clock.
			const startedAt = Date.now();
			return new Promise<number>((resolve) => {
				waiters.add({ ready, settle: (): void => resolve(now + (Date.now() - startedAt)) });
			});
		},
		recheck(): void {
			settle((waiter): boolean => waiter.ready());
		},
		close(): void {
			settle((): boolean => true);
		},
	};
}
