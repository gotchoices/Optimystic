/**
 * `node.blobs`: the node's blob service over the network (docs/blobs.md §The node's blob service).
 * A read fetches the pieces this node lacks as it reaches them, `fetch` brings a whole blob here, a
 * `stat` with `probe` asks the blob's cohort whether anyone holds what this node does not know of, and
 * `onProgress` reports the pieces and bytes the fetches it starts have stored. Everything that touches
 * only this machine is the `LocalBlobService` underneath.
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import { peerIdFromString } from '@libp2p/peer-id';
import {
	readBlobSize,
	rootPieceId,
	type BlobDurabilityEvent,
	type BlobFetchOptions,
	type BlobProgressEvent,
	type BlobPutOptions,
	type BlobPutResult,
	type BlobReadOptions,
	type BlobRef,
	type BlobScope,
	type BlobService,
	type BlobStat,
	type PieceId,
} from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import { armUnrefTimer } from '../unref-timer.js';
import type { BlobFetcher, BlobFetchRequest, BlobFetchSession, PieceStoredEvent } from './blob-fetcher.js';
import { blobHolderCandidates, type BlobHolderDeps } from './blob-holders.js';
import type { BlobLocalHolding } from './blob-protocol.js';
import type { BlobProtocolClient } from './blob-protocol-client.js';
import type { LocalBlobService, MissingPiece } from './local-blob-service.js';

const log = createLogger('blob:service');

export interface NodeBlobServiceDeps {
	local: LocalBlobService;
	fetcher: Pick<BlobFetcher, 'start' | 'onPieceStored'>;
	client: Pick<BlobProtocolClient, 'stat' | 'wireBytes'>;
	/** The same object the fetcher's candidate rule uses. */
	holders: BlobHolderDeps;
	/** LinkDeadlines.responseTimeoutMs: the per-peer budget of a stat probe. */
	probeTimeoutMs: number;
	/** Default Date.now (probe timing in the log line). */
	now?: () => number;
}

/** What the sessions this service started for one reference have stored, while any of them runs. */
interface ProgressCount {
	sessions: number;
	pieces: number;
	bytes: number;
	size?: number;
	/** Set once a size lookup threw, so it is not tried again for this entry. */
	sizeFailed: boolean;
	/** The end of the last event's counting; each event is counted after the one before it. */
	counted: Promise<void>;
}

/** How a probe went: how many peers answered before it settled, and the one that holds the blob. */
interface ProbeResult {
	readonly answered: number;
	readonly held?: string;
}

export class NodeBlobService implements BlobService {
	/** The single-machine service underneath; the blob protocol service answers from it, and tests reach its fetch door through it. */
	readonly local: LocalBlobService;
	private readonly fetcher: Pick<BlobFetcher, 'start' | 'onPieceStored'>;
	private readonly client: Pick<BlobProtocolClient, 'stat' | 'wireBytes'>;
	private readonly holders: BlobHolderDeps;
	private readonly probeTimeoutMs: number;
	private readonly now: () => number;
	private readonly progress = new Map<BlobRef, ProgressCount>();
	private readonly progressListeners = new Set<(event: BlobProgressEvent) => void>();

	constructor(deps: NodeBlobServiceDeps) {
		this.local = deps.local;
		this.fetcher = deps.fetcher;
		this.client = deps.client;
		this.holders = deps.holders;
		this.probeTimeoutMs = deps.probeTimeoutMs;
		this.now = deps.now ?? Date.now;
		// Never unsubscribed: the fetcher lives exactly as long as the node, and so does this service.
		this.fetcher.onPieceStored(event => this.pieceStored(event));
	}

	put(source: AsyncIterable<Uint8Array>, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.local.put(source, options);
	}

	/**
	 * What this node holds of the blob (`LocalBlobService.stat`). With `probe`, a blob this node knows
	 * nothing of is asked of its cohort, in parallel, each peer within one response timeout: the first
	 * that holds it whole or in part makes the answer `elsewhere`, and the others are no longer waited
	 * for. Silence, failures and no candidates leave `unknown`. A local `partial` stays `partial`, since
	 * asking could not change it; `size`, `heldBytes` and `durability` are always this node's.
	 */
	async stat(ref: BlobRef, options: { probe?: boolean } = {}): Promise<BlobStat> {
		const here = await this.local.stat(ref);
		if (options.probe !== true || here.locality !== 'unknown') {
			return here;
		}
		return (await this.probe(ref)) ? { ...here, locality: 'elsewhere' } : here;
	}

	/**
	 * The verified bytes, or a range of them. With `from: 'here'`, exactly `LocalBlobService.read`.
	 * Otherwise the first piece the read finds missing starts one foreground fetch of the read's whole
	 * range, which fetches ahead while the read consumes; a read of a blob entirely here starts none.
	 * A read that throws, or whose consumer stops early, ends that fetch (a request already sent
	 * finishes and what it stores is kept). Fails at the piece that needed it with the fetch's
	 * BlobUnavailableError, BlobCorruptError or RangeError, or with the caller's abort reason.
	 */
	read(ref: BlobRef, options: BlobReadOptions = {}): AsyncIterable<Uint8Array> {
		return options.from === 'here' ? this.local.read(ref, options) : this.readFetching(ref, options);
	}

	/**
	 * Brings the whole blob here, as a foreground fetch; resolves at once for a blob already whole here.
	 * Rejects as the fetch's `done` does.
	 */
	async fetch(ref: BlobRef, options: BlobFetchOptions = {}): Promise<void> {
		await this.startSession(ref, { priority: 'foreground', waitMs: options.waitMs, signal: options.signal }).done;
	}

	pin(ref: BlobRef, owner: string): Promise<void> {
		return this.local.pin(ref, owner);
	}

	unpin(ref: BlobRef, owner: string): Promise<void> {
		return this.local.unpin(ref, owner);
	}

	announce(ref: BlobRef, scope: BlobScope): Promise<void> {
		return this.local.announce(ref, scope);
	}

	/**
	 * Called after each piece a fetch this service started stores, with the counts so far for that
	 * reference across every such fetch still running; a reference's counts start again once its last
	 * fetch has ended. `size` is reported once the root piece is here. A throwing listener is logged and
	 * does not stop the others. Fetches started on the fetcher directly report nothing.
	 */
	onProgress(listener: (event: BlobProgressEvent) => void): () => void {
		this.progressListeners.add(listener);
		return () => {
			this.progressListeners.delete(listener);
		};
	}

	onDurability(listener: (event: BlobDurabilityEvent) => void): () => void {
		return this.local.onDurability(listener);
	}

	/** Diagnostic: cumulative blob-protocol frame bytes this node sent and received (BlobProtocolClient.wireBytes). */
	wireBytes(): { sent: number; received: number } {
		return this.client.wireBytes();
	}

	private async *readFetching(ref: BlobRef, options: BlobReadOptions): AsyncIterable<Uint8Array> {
		const readController = new AbortController();
		const detach = forwardAbort(options.signal, readController);
		let session: BlobFetchSession | undefined;
		const missing: MissingPiece = async id => {
			// `fetcher.start` is synchronous, so a later miss of this read finds the session already set.
			session ??= this.startSession(ref, {
				priority: 'foreground',
				offset: options.offset,
				length: options.length,
				waitMs: options.waitMs,
				signal: readController.signal,
			});
			await session.stored(id);
			return this.storedPiece(ref, id);
		};
		let completed = false;
		try {
			yield* this.local.readThrough(ref, options, missing);
			completed = true;
		} finally {
			// A read that consumed its whole range leaves its fetch nothing to bring, only its confirming
			// walk and, for a whole blob, marking the record whole; aborting would cut those off.
			if (!completed) {
				readController.abort(new Error('blob read ended'));
			}
			detach();
		}
	}

	/** A piece the fetch reported stored. Its absence is an invariant violation, not a retryable condition: nothing may remove a piece under the blob's `cached` hold or a pin. */
	private async storedPiece(ref: BlobRef, id: PieceId): Promise<Uint8Array> {
		const bytes = await this.local.fetchStore().source.get(id);
		if (bytes === undefined) {
			throw new Error(`Blob ${ref}: piece ${id} was reported stored by its fetch but is not in the piece store`);
		}
		return bytes;
	}

	/** The one path for the sessions this service starts, so each is counted for progress until it settles. */
	private startSession(ref: BlobRef, request: BlobFetchRequest): BlobFetchSession {
		const session = this.fetcher.start(ref, request);
		const count = this.progress.get(ref) ?? this.newCount(ref);
		count.sessions++;
		const settled = (): void => this.sessionSettled(ref, count);
		void session.done.then(settled, settled);
		return session;
	}

	private newCount(ref: BlobRef): ProgressCount {
		const count: ProgressCount = { sessions: 0, pieces: 0, bytes: 0, sizeFailed: false, counted: Promise.resolve() };
		this.progress.set(ref, count);
		return count;
	}

	/** An entry is created only when none exists and deleted only at zero, so `count` is the reference's entry here. */
	private sessionSettled(ref: BlobRef, count: ProgressCount): void {
		if (--count.sessions === 0) {
			this.progress.delete(ref);
		}
	}

	/** Counted in arrival order per reference: a size lookup in flight holds back the events after it. */
	private pieceStored(event: PieceStoredEvent): void {
		const count = this.progress.get(event.ref);
		if (count === undefined) {
			return;
		}
		count.counted = count.counted.then(() => this.countPiece(count, event));
	}

	/** Never rejects. */
	private async countPiece(count: ProgressCount, event: PieceStoredEvent): Promise<void> {
		if (count.size === undefined && !count.sizeFailed) {
			count.size = await this.sizeOf(count, event.ref);
		}
		count.pieces++;
		count.bytes += event.bytes;
		this.emitProgress({ ref: event.ref, piecesFetched: count.pieces, bytesFetched: count.bytes, size: count.size });
	}

	/**
	 * The blob's size from its root piece, or undefined while the root is not here (the root is the
	 * first piece a fetch stores when it lacks it, so this is read at most once more). A lookup that
	 * throws is logged and not tried again for this entry.
	 */
	private async sizeOf(count: ProgressCount, ref: BlobRef): Promise<number | undefined> {
		const store = this.local.fetchStore();
		try {
			return await readBlobSize(ref, store.source, { digest: store.digest });
		} catch (error) {
			count.sizeFailed = true;
			log('progress:size-failed ref=%s root=%s err=%s', ref, rootPieceId(ref), describe(error));
			return undefined;
		}
	}

	private emitProgress(event: BlobProgressEvent): void {
		for (const listener of [...this.progressListeners]) {
			try {
				listener(event);
			} catch (error) {
				log('progress:listener-threw err=%s', describe(error));
			}
		}
	}

	/** Whether some candidate holds `ref` whole or in part. Logged once when anyone was asked. */
	private async probe(ref: BlobRef): Promise<boolean> {
		const peers = await blobHolderCandidates(this.holders, ref);
		if (peers.length === 0) {
			return false;
		}
		const startedAt = this.now();
		const result = await this.askAll(ref, peers);
		log('stat:probe ref=%s asked=%d answered=%d held=%s ms=%d', ref, peers.length, result.answered, result.held ?? 'none', this.now() - startedAt);
		return result.held !== undefined;
	}

	/** Asks every peer at once; settles on the first that holds the blob, or once every peer has answered, failed or timed out. */
	private askAll(ref: BlobRef, peers: readonly string[]): Promise<ProbeResult> {
		const settle = new AbortController();
		return new Promise<ProbeResult>(resolve => {
			let answered = 0;
			let outstanding = peers.length;
			const finish = (held?: string): void => {
				if (!settle.signal.aborted) {
					settle.abort(new Error('blob stat probe settled'));
					resolve({ answered, held });
				}
			};
			for (const peer of peers) {
				void this.askOne(ref, peer, settle.signal).then(holding => {
					if (holding !== undefined && !settle.signal.aborted) {
						answered++;
						if (holding !== 'none') {
							finish(peer);
						}
					}
					if (--outstanding === 0) {
						finish();
					}
				});
			}
		});
	}

	/** One peer's holding of `ref`, or undefined when it did not answer within the probe budget, failed, or the probe settled first. Never rejects. */
	private async askOne(ref: BlobRef, peer: string, settled: AbortSignal): Promise<BlobLocalHolding | undefined> {
		const controller = new AbortController();
		const detach = forwardAbort(settled, controller);
		const cancelTimer = armUnrefTimer(() => controller.abort(new Error(`no stat answer within ${this.probeTimeoutMs} ms`)), this.probeTimeoutMs);
		try {
			const [holding] = await this.client.stat(peerIdFromString(peer), [ref], { signal: controller.signal });
			return holding;
		} catch (error) {
			if (!settled.aborted) {
				log('stat:probe-peer-failed ref=%s peer=%s err=%s', ref, peer, describe(error));
			}
			return undefined;
		} finally {
			cancelTimer();
			detach();
		}
	}
}

/**
 * Aborts `target` with `source`'s reason when it aborts (at once when it already has); returns the
 * detach. By hand because Hermes has no `AbortSignal.any`.
 */
function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
	if (source === undefined) {
		return () => undefined;
	}
	if (source.aborted) {
		target.abort(source.reason);
		return () => undefined;
	}
	const listener = (): void => target.abort(source.reason);
	source.addEventListener('abort', listener, { once: true });
	return () => source.removeEventListener('abort', listener);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
