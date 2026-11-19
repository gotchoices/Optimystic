/**
 * The two bounds a node puts on the work an announcement can make it do (docs/blobs.md §Who may fetch
 * and who may store): how many announcements one peer may send in a minute, and how many reads of
 * committed state the node runs at once for all of them together.
 *
 * Imports here are pure: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import {
	BLOB_ANNOUNCE_PEERS_TRACKED,
	BLOB_ANNOUNCES_PER_PEER_PER_MINUTE,
	BLOB_REFERENCE_READS_IN_FLIGHT,
} from '../protocol-limits.js';

/** The length of one peer's allowance window. */
const WINDOW_MS = 60_000;

/** One peer's fixed window: when it started and how many announcements have been counted in it. */
interface PeerWindow {
	startedAt: number;
	count: number;
}

export interface AnnounceLimiterOptions {
	/** Default {@link BLOB_ANNOUNCES_PER_PEER_PER_MINUTE}. */
	perPeerPerMinute?: number;
	/** Default {@link BLOB_REFERENCE_READS_IN_FLIGHT}. */
	readsInFlight?: number;
	/** Default {@link BLOB_ANNOUNCE_PEERS_TRACKED}. */
	maxPeers?: number;
	/** Default Date.now. */
	now?: () => number;
}

/**
 * What one node's announcement receiver is allowed to spend. One instance per node, shared by every
 * peer's announcements and by reader repair, so no number of peers raises the node's read work.
 */
export class AnnounceLimiter {
	private readonly perPeerPerMinute: number;
	private readonly readsInFlight: number;
	private readonly maxPeers: number;
	private readonly now: () => number;
	private readonly windows = new Map<string, PeerWindow>();
	/** Reads running now, counted against {@link readsInFlight}. */
	private reading = 0;
	/** Each waiting read's `takeSlot` resolver, oldest first. */
	private readonly waiting: (() => void)[] = [];

	constructor(options: AnnounceLimiterOptions = {}) {
		this.perPeerPerMinute = options.perPeerPerMinute ?? BLOB_ANNOUNCES_PER_PEER_PER_MINUTE;
		this.readsInFlight = options.readsInFlight ?? BLOB_REFERENCE_READS_IN_FLIGHT;
		this.maxPeers = options.maxPeers ?? BLOB_ANNOUNCE_PEERS_TRACKED;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Counts one announcement from `peer` in its current one-minute window; false once that window is
	 * full. A window older than a minute is started again on this call, so a quiet peer is never
	 * refused for traffic it sent long ago.
	 */
	admit(peer: string): boolean {
		const window = this.windowOf(peer);
		if (window.count >= this.perPeerPerMinute) {
			return false;
		}
		window.count++;
		return true;
	}

	/**
	 * Runs `read` once fewer than the node's limit of reads are running, waiting its turn otherwise
	 * (first come, first served); never refuses. Resolves or rejects with `read`'s own outcome, and
	 * gives the slot back either way — so a read the caller has stopped waiting for still holds its
	 * slot until it finishes, which is what keeps a slow read counting against the node's read work.
	 */
	async readSlot<T>(read: () => Promise<T>): Promise<T> {
		await this.takeSlot();
		try {
			return await read();
		} finally {
			this.releaseSlot();
		}
	}

	/** The peer's live window, reset when it has passed and created (evicting if need be) when there is none. */
	private windowOf(peer: string): PeerWindow {
		const at = this.now();
		const window = this.windows.get(peer);
		if (window !== undefined) {
			if (at - window.startedAt >= WINDOW_MS) {
				window.startedAt = at;
				window.count = 0;
			}
			return window;
		}
		// NOTE: a flood of fresh peer ids can evict a real peer's window, which starts its count again
		// early and so lets it send more than its allowance for a minute. The node's read work is
		// bounded by `readSlot` regardless, which no number of peer ids can raise.
		if (this.windows.size >= this.maxPeers) {
			this.evictOldest();
		}
		const fresh: PeerWindow = { startedAt: at, count: 0 };
		this.windows.set(peer, fresh);
		return fresh;
	}

	/** The entry whose window started longest ago, which is the one closest to being reset anyway. */
	private evictOldest(): void {
		let oldest: string | undefined;
		let startedAt = Infinity;
		for (const [peer, window] of this.windows) {
			if (window.startedAt < startedAt) {
				startedAt = window.startedAt;
				oldest = peer;
			}
		}
		if (oldest !== undefined) {
			this.windows.delete(oldest);
		}
	}

	private takeSlot(): Promise<void> {
		if (this.reading < this.readsInFlight) {
			this.reading++;
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			this.waiting.push(resolve);
		});
	}

	/** The slot passes straight to the oldest waiter, so `reading` stays at the cap while any waits. */
	private releaseSlot(): void {
		const next = this.waiting.shift();
		if (next === undefined) {
			this.reading--;
		} else {
			next();
		}
	}
}
