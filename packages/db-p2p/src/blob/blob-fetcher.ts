/**
 * Brings the pieces of a blob, or of a byte range of it, that this node lacks from the machines that
 * hold them (docs/blobs.md §Moving pieces between machines). The one code path that receives pieces:
 * every piece is checked against the id that named it before it is stored, a peer that sends wrong
 * bytes is penalized and not asked again, an interrupted fetch keeps what it stored and asks only for
 * the rest, concurrent sessions request each piece once, and background copying never takes a stream
 * a read is waiting for.
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import { parseBlobRef, type BlobRef, type PieceId } from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import type { IPeerReputation } from '../reputation/types.js';
import { armUnrefTimer } from '../unref-timer.js';
import { FetchSession, type SessionContext } from './blob-fetch-session.js';
import { BlobGetSlots, type FetchPriority } from './blob-get-slots.js';
import type { BlobHolderDeps } from './blob-holders.js';
import { PieceTraffic } from './blob-piece-traffic.js';
import type { BlobProtocolClient } from './blob-protocol-client.js';
import type { BlobFetchStore } from './local-blob-service.js';

export type { FetchPriority } from './blob-get-slots.js';

const log = createLogger('blob:fetch');

export interface BlobFetchRequest {
	priority: FetchPriority;
	/** Byte range; absent means the whole blob. Same meaning as BlobReadOptions. */
	offset?: number;
	length?: number;
	/** Peers known to hold the blob (an announcer, a peer that answered a stat); asked first, in this order, still filtered like every candidate. */
	knownHolders?: readonly string[];
	/** Keep retrying while no reachable holder can supply a missing piece, until no piece has arrived for this long. Absent or 0: fail after the first round that leaves a piece unavailable. */
	waitMs?: number;
	signal?: AbortSignal;
}

export interface PieceStoredEvent {
	readonly ref: BlobRef;
	readonly id: PieceId;
	readonly bytes: number;
	readonly peer: string;
}

/** One caller's fetch of one blob. */
export interface BlobFetchSession {
	/** Resolves when every piece the range needs is here; rejects with BlobUnavailableError, BlobCorruptError, RangeError (offset past the end), the signal's reason, or a local store fault. */
	readonly done: Promise<void>;
	/** Resolves when `id` is here (at once when it already is). Rejects when `done` rejects first, or, if `done` resolves with `id` still absent (an id outside the range), with RangeError. For a reader that consumes pieces as they arrive. */
	stored(id: PieceId): Promise<void>;
}

export interface BlobFetcherDeps {
	client: Pick<BlobProtocolClient, 'get'>;
	/** The candidate rule's inputs, passed through to blobHolderCandidates. */
	holders: BlobHolderDeps;
	reputation: Pick<IPeerReputation, 'reportPeer'>;
	/** The node's blob store; its `digest` is the one every fetched piece is checked with. */
	store: BlobFetchStore;
	/** Default: a BlobGetSlots with the protocol-limits defaults. One per node. */
	slots?: BlobGetSlots;
	/** Default Date.now. */
	now?: () => number;
	/** Default armUnrefTimer. */
	setTimer?: (fn: () => void, ms: number) => () => void;
}

export class BlobFetcher {
	private readonly stopController = new AbortController();
	private readonly context: SessionContext;
	/** Each running session's end, which never rejects. */
	private readonly running = new Set<Promise<void>>();
	private readonly listeners = new Set<(event: PieceStoredEvent) => void>();

	constructor(deps: BlobFetcherDeps) {
		this.context = {
			client: deps.client,
			holders: deps.holders,
			reputation: deps.reputation,
			store: deps.store,
			slots: deps.slots ?? new BlobGetSlots(),
			now: deps.now ?? Date.now,
			setTimer: deps.setTimer ?? armUnrefTimer,
			stopSignal: this.stopController.signal,
			traffic: new PieceTraffic(),
			pieceStored: event => this.pieceStored(event),
		};
	}

	/**
	 * Starts fetching what `ref` (or the requested range of it) lacks here and returns at once; the
	 * work runs in the background and settles `done`. A string that is not a canonical reference throws
	 * BlobRefError here, since it is the caller's bug. After `stop`, the session's `done` rejects at once.
	 */
	start(ref: BlobRef, request: BlobFetchRequest): BlobFetchSession {
		parseBlobRef(ref);
		const session = new FetchSession(this.context, ref, request);
		const ended = session.ended;
		this.running.add(ended);
		void ended.then(() => this.running.delete(ended));
		return session;
	}

	/** Called once per piece any session stores, after it is stored. A throwing listener is logged and does not stop the others. */
	onPieceStored(listener: (event: PieceStoredEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Rejects every running session and every later start with Error('blob fetcher stopped'), aborts the
	 * streams in flight, cancels retry timers; resolves once every session has settled.
	 */
	async stop(): Promise<void> {
		if (!this.stopController.signal.aborted) {
			this.stopController.abort(new Error('blob fetcher stopped'));
		}
		await Promise.all([...this.running]);
	}

	private pieceStored(event: PieceStoredEvent): void {
		this.context.traffic.arrived(event.id);
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch (error) {
				log('fetch:listener-threw err=%s', error instanceof Error ? error.message : String(error));
			}
		}
	}
}
