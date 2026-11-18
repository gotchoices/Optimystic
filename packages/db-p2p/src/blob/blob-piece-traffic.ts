/**
 * The pieces a blob fetcher's sessions are fetching, and the readers waiting for pieces, shared by
 * every session of one fetcher (docs/blobs.md §Moving pieces between machines).
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import type { PieceId } from '@optimystic/db-core';

interface Attempt {
	readonly stored: Promise<boolean>;
	settle(stored: boolean): void;
}

/**
 * Keyed by piece id alone: a piece is named by its content, so one request serves every blob whose
 * tree names it, and a piece stored for one blob is here for every other.
 */
export class PieceTraffic {
	// NOTE: a foreground session that needs a piece already in a background session's batch waits for
	// that batch rather than asking again, which bounds the wait by one batch of MAX_BLOB_GET_PIECES
	// pieces and the progress deadline. If reads are measured waiting on background batches, request
	// such a piece in parallel at foreground priority instead.
	private readonly inFlight = new Map<PieceId, Attempt>();
	private readonly waiters = new Map<PieceId, Set<PieceWaiter>>();

	/** The attempt some session has in flight for `id`: resolves `true` once the piece is stored, `false` once the attempt ends without it. Never rejects. */
	attemptFor(id: PieceId): Promise<boolean> | undefined {
		return this.inFlight.get(id)?.stored;
	}

	isInFlight(id: PieceId): boolean {
		return this.inFlight.has(id);
	}

	get piecesInFlight(): number {
		return this.inFlight.size;
	}

	/**
	 * Marks `ids` in flight for one batch. Throws if any already is: two requests for one piece mean a
	 * session chose a piece another session holds, which the batch choice rules out.
	 */
	claim(ids: readonly PieceId[]): PieceClaim {
		const taken = ids.filter(id => this.inFlight.has(id));
		if (taken.length > 0) {
			throw new Error(`blob fetcher: pieces already in flight were claimed again: ${taken.join(', ')}`);
		}
		for (const id of ids) {
			this.inFlight.set(id, newAttempt());
		}
		return new PieceClaim(ids, (id, stored) => this.settle(id, stored));
	}

	/** A waiter for `id`, resolved by {@link arrived}; it leaves the registry once settled, by any path. */
	wait(id: PieceId, onSettled: (waiter: PieceWaiter) => void): PieceWaiter {
		const waiter = new PieceWaiter(id, settled => {
			this.forget(settled);
			onSettled(settled);
		});
		let forId = this.waiters.get(id);
		if (forId === undefined) {
			forId = new Set();
			this.waiters.set(id, forId);
		}
		forId.add(waiter);
		return waiter;
	}

	/** `id` is stored here: every waiter for it resolves. */
	arrived(id: PieceId): void {
		for (const waiter of [...(this.waiters.get(id) ?? [])]) {
			waiter.resolve();
		}
	}

	private settle(id: PieceId, stored: boolean): void {
		const attempt = this.inFlight.get(id);
		this.inFlight.delete(id);
		attempt?.settle(stored);
	}

	private forget(waiter: PieceWaiter): void {
		const forId = this.waiters.get(waiter.id);
		forId?.delete(waiter);
		if (forId?.size === 0) {
			this.waiters.delete(waiter.id);
		}
	}
}

/** One batch's hold on its pieces; each piece is settled once, as stored or not. */
export class PieceClaim {
	private readonly open: Set<PieceId>;

	constructor(ids: readonly PieceId[], private readonly onSettle: (id: PieceId, stored: boolean) => void) {
		this.open = new Set(ids);
	}

	stored(id: PieceId): void {
		this.settle(id, true);
	}

	/** Every piece not yet stored is given up on; the sessions waiting on it ask for it themselves. */
	release(): void {
		for (const id of [...this.open]) {
			this.settle(id, false);
		}
	}

	private settle(id: PieceId, stored: boolean): void {
		if (this.open.delete(id)) {
			this.onSettle(id, stored);
		}
	}
}

/** A reader's wait for one piece. Settles once; later calls do nothing. */
export class PieceWaiter {
	readonly promise: Promise<void>;
	private settled = false;
	private resolvePromise!: () => void;
	private rejectPromise!: (reason: unknown) => void;

	constructor(readonly id: PieceId, private readonly onSettled: (waiter: PieceWaiter) => void) {
		this.promise = new Promise<void>((resolve, reject) => {
			this.resolvePromise = resolve;
			this.rejectPromise = reject;
		});
	}

	resolve(): void {
		if (this.markSettled()) {
			this.resolvePromise();
		}
	}

	reject(reason: unknown): void {
		if (this.markSettled()) {
			this.rejectPromise(reason);
		}
	}

	private markSettled(): boolean {
		if (this.settled) {
			return false;
		}
		this.settled = true;
		this.onSettled(this);
		return true;
	}
}

function newAttempt(): Attempt {
	let settle!: (stored: boolean) => void;
	const stored = new Promise<boolean>(resolve => {
		settle = resolve;
	});
	return { stored, settle };
}
