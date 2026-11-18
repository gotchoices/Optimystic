/**
 * One caller's fetch of one blob, run by `BlobFetcher` (docs/blobs.md §Moving pieces between
 * machines). A session walks the tree for the pieces the range lacks here, asks holders for them in
 * batches, checks and stores each piece, and settles `done` once every piece the range needs is here
 * or a round of asking leaves one that nobody could supply.
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import { peerIdFromString } from '@libp2p/peer-id';
import {
	BlobCorruptError,
	BlobUnavailableError,
	checkPiece,
	pieceKind,
	rootPieceId,
	walkBlobPieces,
	type BlobRef,
	type PieceId,
	type PieceSource,
} from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import { BLOB_WAIT_RETRY_INITIAL_MS, BLOB_WAIT_RETRY_MAX_MS, MAX_BLOB_GET_PIECES } from '../protocol-limits.js';
import { PenaltyReason, type IPeerReputation } from '../reputation/types.js';
import type { BlobFetchRequest, BlobFetchSession, PieceStoredEvent } from './blob-fetcher.js';
import type { BlobGetSlots } from './blob-get-slots.js';
import { blobHolderCandidates, unavailableOutcome, type BlobHolderDeps, type PieceOutcome } from './blob-holders.js';
import type { PieceTraffic, PieceWaiter } from './blob-piece-traffic.js';
import type { BlobProtocolClient } from './blob-protocol-client.js';
import type { BlobFetchStore } from './local-blob-service.js';

const log = createLogger('blob:fetch');

/** What every session of one fetcher shares. */
export interface SessionContext {
	readonly client: Pick<BlobProtocolClient, 'get'>;
	readonly holders: BlobHolderDeps;
	readonly reputation: Pick<IPeerReputation, 'reportPeer'>;
	readonly store: BlobFetchStore;
	readonly slots: BlobGetSlots;
	readonly now: () => number;
	readonly setTimer: (fn: () => void, ms: number) => () => void;
	/** The fetcher's stop signal: the only one that aborts a batch already sent. */
	readonly stopSignal: AbortSignal;
	readonly traffic: PieceTraffic;
	pieceStored(event: PieceStoredEvent): void;
}

/** A walk of the range over this node's pieces. */
interface Plan {
	/** The absent pieces whose parent is present (or the root, when it is absent), in tree order, each once. */
	readonly missing: readonly PieceId[];
	/** The blob's size, when the root is a present list piece. */
	readonly listSize?: number;
}

type Outcome = { readonly kind: 'succeeded' } | { readonly kind: 'failed'; readonly error: unknown };

/** What became of one piece a holder sent; a store fault is the session's, not the holder's. */
type Receipt = { readonly kind: 'stored' } | { readonly kind: 'corrupt' } | { readonly kind: 'fault'; readonly error: unknown };

/** The end of another session's attempt at a piece this session needs. */
interface ElsewhereOutcome {
	readonly id: PieceId;
	readonly stored: boolean;
}

/** How a candidate answered for a piece in a round, short of sending it. */
type RoundAnswer = 'not-held' | 'no-answer';

export class FetchSession implements BlobFetchSession {
	readonly done: Promise<void>;
	/** Resolves once the session's work has unwound, however it ended; never rejects. */
	readonly ended: Promise<void>;
	private readonly controller = new AbortController();
	private readonly detachAborts: () => void;
	private readonly waiters = new Set<PieceWaiter>();
	private readonly corrupt = new CorruptServers();
	private readonly startedAt: number;
	private lastProgressAt: number;
	private retryDelayMs = BLOB_WAIT_RETRY_INITIAL_MS;
	private piecesStored = 0;
	private bytesStored = 0;
	private outcome: Outcome | undefined;
	private resolveDone!: () => void;
	private rejectDone!: (reason: unknown) => void;

	constructor(private readonly ctx: SessionContext, private readonly ref: BlobRef, private readonly request: BlobFetchRequest) {
		this.done = new Promise<void>((resolve, reject) => {
			this.resolveDone = resolve;
			this.rejectDone = reject;
		});
		// A reader that follows pieces through `stored` may never await `done`. Every failure is logged
		// (`fail`) and reaches each of the session's waiters, so this only stops an unawaited `done` from
		// being reported as an unhandled rejection.
		this.done.catch(() => undefined);
		this.startedAt = this.lastProgressAt = ctx.now();
		const signal = this.controller.signal;
		this.detachAborts = forwardAborts(this.controller, [request.signal, ctx.stopSignal]);
		signal.addEventListener('abort', () => this.fail(signal.reason), { once: true });
		this.ended = this.run().then(() => this.succeed(), error => this.fail(error));
	}

	stored(id: PieceId): Promise<void> {
		if (this.outcome?.kind === 'failed') {
			return Promise.reject(this.outcome.error);
		}
		// Registered before the presence check, so a piece stored during the check still resolves it.
		const waiter = this.ctx.traffic.wait(id, settled => this.waiters.delete(settled));
		this.waiters.add(waiter);
		void this.resolveIfHere(waiter);
		return waiter.promise;
	}

	private async run(): Promise<void> {
		this.checkAborted();
		// Unheld: when nothing is missing no hold is taken, no cohort is looked up and no peer is asked.
		if ((await this.plan()).missing.length === 0) {
			return;
		}
		await this.ctx.store.holdCached(this.ref);
		// Planned again under the hold: a sweep may have removed pieces the unheld walk saw present, and
		// the hold protects whatever this walk sees.
		let plan = await this.plan();
		for (let first = true; plan.missing.length > 0; first = false) {
			this.checkAborted();
			const round = await this.openRound(plan, first);
			plan = await this.runRound(round);
			if (plan.missing.length > 0) {
				await this.retryOrFail(round, plan.missing[0]!);
			}
		}
		await this.finish(plan);
	}

	private async openRound(plan: Plan, first: boolean): Promise<Round> {
		// Recomputed every round, so a holder that connects during a `waitMs` wait is found.
		const candidates = (await blobHolderCandidates(this.ctx.holders, this.ref, this.request.knownHolders))
			.filter(peer => !this.corrupt.excludes(peer));
		if (first) {
			log('fetch:start ref=%s priority=%s range=%s missing=%d candidates=%d',
				this.ref, this.request.priority, describeRange(this.request), plan.missing.length, candidates.length);
		}
		return new Round(candidates, plan.missing);
	}

	/**
	 * Asks candidates until every frontier piece no other session has in flight has an answer from
	 * every candidate still open this round; returns the walk that confirmed it.
	 */
	private async runRound(round: Round): Promise<Plan> {
		for (;;) {
			this.checkAborted();
			this.noteElsewhere(round);
			const peer = this.nextPeer(round);
			if (peer !== undefined) {
				await this.askPeer(round, peer);
			} else if (round.elsewhere.size > 0) {
				await this.awaitElsewhere(round);
			} else {
				// Walked again before the round ends: a piece removed since the session believed it present
				// joins the frontier, and the round goes on for it.
				const confirmed = await this.plan();
				round.frontier = confirmed.missing;
				this.noteElsewhere(round);
				if (this.nextPeer(round) === undefined && round.elsewhere.size === 0) {
					return confirmed;
				}
			}
		}
	}

	/** Frontier pieces another session has in flight are awaited rather than requested a second time. */
	private noteElsewhere(round: Round): void {
		if (this.ctx.traffic.piecesInFlight === 0) {
			return;
		}
		for (const id of round.frontier) {
			const attempt = round.elsewhere.has(id) ? undefined : this.ctx.traffic.attemptFor(id);
			if (attempt !== undefined) {
				round.elsewhere.set(id, attempt.then(stored => ({ id, stored })));
			}
		}
	}

	/** The first candidate still open this round that has not answered some frontier piece no other session is fetching. */
	private nextPeer(round: Round): string | undefined {
		return round.candidates.find(peer => !round.failed.has(peer) && !this.corrupt.excludes(peer)
			&& round.frontier.some(id => !round.elsewhere.has(id) && round.answer(peer, id) === undefined));
	}

	/**
	 * The slot is acquired before the pieces are chosen, so a session waiting for a slot claims no
	 * pieces another session could be fetching.
	 */
	private async askPeer(round: Round, peer: string): Promise<void> {
		const release = await this.ctx.slots.acquire(peer, this.request.priority, this.controller.signal);
		let stored: PieceId[] = [];
		try {
			this.checkAborted();
			// Filtered again with no await before `fetchBatch` claims it: another session may have claimed
			// one of these pieces while `batchFor` checked which are here.
			const batch = (await this.batchFor(round, peer)).filter(id => !this.ctx.traffic.isInFlight(id));
			if (batch.length > 0) {
				stored = await this.fetchBatch(round, peer, batch);
			}
		} finally {
			release();
		}
		await this.dropArrived(round, stored);
	}

	/**
	 * Frontier pieces, in tree order, that `peer` has not answered and no session had in flight when the
	 * choice began, up to one request. Pieces that arrived while this session waited for the slot
	 * (another session's batch ended in that time) are dropped rather than requested again. The caller
	 * drops what was claimed during the presence check.
	 */
	private async batchFor(round: Round, peer: string): Promise<PieceId[]> {
		const wanted: PieceId[] = [];
		for (const id of round.frontier) {
			if (wanted.length === MAX_BLOB_GET_PIECES) {
				break;
			}
			if (!round.elsewhere.has(id) && !this.ctx.traffic.isInFlight(id) && round.answer(peer, id) === undefined) {
				wanted.push(id);
			}
		}
		const here = await this.presentAmong(wanted);
		await this.dropArrived(round, here);
		return wanted.filter(id => !here.includes(id));
	}

	/** Returns the ids stored. A holder's fault is recorded against it; a store fault rejects the session. */
	private async fetchBatch(round: Round, peer: string, batch: readonly PieceId[]): Promise<PieceId[]> {
		const claim = this.ctx.traffic.claim(batch);
		const startedAt = this.ctx.now();
		const stored: PieceId[] = [];
		let held = 0;
		let fault: { readonly error: unknown } | undefined;
		try {
			// The fetcher's stop signal, not the session's: a batch already sent is left to finish, since
			// another session may be waiting on its pieces and what it stores is kept anyway.
			const reply = await this.ctx.client.get(peerIdFromString(peer), batch, { signal: this.ctx.stopSignal });
			held = reply.held.length;
			round.record(peer, reply.notHeld, 'not-held');
			for await (const piece of reply.pieces) {
				const receipt = await this.receive(peer, piece);
				if (receipt.kind === 'stored') {
					claim.stored(piece.id);
					stored.push(piece.id);
					continue;
				}
				// Leaving the loop aborts the stream. The peer is not asked again this session, so the rest
				// of its batch counts as unanswered.
				if (receipt.kind === 'corrupt') {
					round.recordUnanswered(peer, batch, 'no-answer');
				} else {
					fault = receipt;
				}
				break;
			}
		} catch (error) {
			if (this.ctx.stopSignal.aborted) {
				throw this.ctx.stopSignal.reason;
			}
			this.holderFailed(round, peer, error);
		} finally {
			claim.release();
			log('fetch:batch ref=%s peer=%s asked=%d held=%d stored=%d ms=%d', this.ref, peer, batch.length, held, stored.length, this.ctx.now() - startedAt);
		}
		if (fault !== undefined) {
			throw fault.error;
		}
		return stored;
	}

	/** Checks a piece against the id that named it before storing it. */
	private async receive(peer: string, piece: { id: PieceId; bytes: Uint8Array }): Promise<Receipt> {
		try {
			await checkPiece(piece.id, piece.bytes, this.ctx.store.digest, this.ref);
		} catch (error) {
			if (!(error instanceof BlobCorruptError)) {
				// The digest port failed: nothing is known about the bytes or the peer.
				return { kind: 'fault', error };
			}
			this.penalize(peer, piece.id);
			return { kind: 'corrupt' };
		}
		try {
			await this.ctx.store.storePiece(this.ref, piece.id, piece.bytes);
		} catch (error) {
			return { kind: 'fault', error };
		}
		this.piecesStored++;
		this.bytesStored += piece.bytes.byteLength;
		this.noteProgress();
		this.ctx.pieceStored({ ref: this.ref, id: piece.id, bytes: piece.bytes.byteLength, peer });
		return { kind: 'stored' };
	}

	/** The bytes were discarded; the stream is authenticated, so the fault is the peer's. */
	private penalize(peer: string, id: PieceId): void {
		this.ctx.reputation.reportPeer(peer, PenaltyReason.InvalidRestoration, `blob-piece ${id}`);
		this.corrupt.note(peer, id);
		log('fetch:penalized ref=%s peer=%s piece=%s', this.ref, peer, id);
	}

	/** A dial failure, stall, refusal (busy included), protocol error or reset: no answer from the peer for the rest of the round. */
	private holderFailed(round: Round, peer: string, error: unknown): void {
		log('fetch:holder-failed ref=%s peer=%s err=%s', this.ref, peer, describe(error));
		round.failed.add(peer);
		round.recordUnanswered(peer, round.frontier, 'no-answer');
	}

	private async awaitElsewhere(round: Round): Promise<void> {
		const { id, stored } = await unlessAborted(Promise.race(round.elsewhere.values()), this.controller.signal);
		round.elsewhere.delete(id);
		// Not stored: the piece is back in this session's frontier, with no answer recorded, and is asked for.
		if (stored) {
			await this.dropArrived(round, [id]);
		}
	}

	/** Takes pieces that arrived off the frontier; a list piece's children are known only once it is here, so they join by walking again. */
	private async dropArrived(round: Round, ids: readonly PieceId[]): Promise<void> {
		if (ids.length === 0) {
			return;
		}
		this.noteProgress();
		if (ids.some(id => pieceKind(id) === 'list')) {
			round.frontier = (await this.plan()).missing;
			return;
		}
		const arrived = new Set(ids);
		round.frontier = round.frontier.filter(id => !arrived.has(id));
	}

	private async presentAmong(ids: readonly PieceId[]): Promise<PieceId[]> {
		const present = await Promise.all(ids.map(id => isHere(this.ctx.store.source, id)));
		return ids.filter((_, index) => present[index]);
	}

	/** Waits and returns when `waitMs` still allows another round; otherwise throws what the round amounts to. */
	private async retryOrFail(round: Round, piece: PieceId): Promise<void> {
		const failure = this.failureFor(round, piece);
		const retryInMs = this.nextRetryDelay();
		if (retryInMs === undefined) {
			throw failure;
		}
		log('fetch:wait ref=%s reason=%s retryInMs=%d', this.ref, failure instanceof BlobUnavailableError ? failure.reason : 'corrupt', retryInMs);
		await delay(retryInMs, this.controller.signal, this.ctx.setTimer);
	}

	/** What the round's attempts at the first absent piece amount to (`unavailableOutcome`). */
	private failureFor(round: Round, piece: PieceId): BlobUnavailableError | BlobCorruptError {
		const outcome = unavailableOutcome(round.attempts(piece, this.corrupt.of(piece)));
		return outcome.error === 'corrupt'
			? new BlobCorruptError('digest-mismatch', piece, this.ref, 'every holder that had it served bytes that do not match')
			: new BlobUnavailableError(this.ref, outcome.reason, piece);
	}

	/** Undefined once `waitMs` has passed with no piece arriving; otherwise the next backoff, capped by the time left. */
	private nextRetryDelay(): number | undefined {
		const left = (this.request.waitMs ?? 0) - (this.ctx.now() - this.lastProgressAt);
		if (left <= 0) {
			return undefined;
		}
		const retryInMs = Math.min(this.retryDelayMs, left);
		this.retryDelayMs = Math.min(this.retryDelayMs * 2, BLOB_WAIT_RETRY_MAX_MS);
		return retryInMs;
	}

	/** A piece arriving resets the `waitMs` clock and the backoff. */
	private noteProgress(): void {
		this.lastProgressAt = this.ctx.now();
		this.retryDelayMs = BLOB_WAIT_RETRY_INITIAL_MS;
	}

	private async finish(plan: Plan): Promise<void> {
		if (this.request.offset === undefined && this.request.length === undefined) {
			// NOTE: neither the pieces nor the record are flushed, so a crash can lose both; the next read
			// fetches them again and a sweep removes orphans. `feat-a-referenced-blob-is-copied-to-its-cohort`
			// flushes before reporting `held`, since that tells another machine the copy is here.
			const size = plan.listSize ?? (await this.ctx.store.source.get(rootPieceId(this.ref)))?.byteLength;
			if (size !== undefined) {
				await this.ctx.store.markWhole(this.ref, size);
			}
		}
		log('fetch:done ref=%s pieces=%d bytes=%d ms=%d', this.ref, this.piecesStored, this.bytesStored, this.ctx.now() - this.startedAt);
	}

	/** Walks the range over this node's pieces. Throws BlobCorruptError for a malformed list piece and RangeError for an offset past the end, as a read would. */
	private async plan(): Promise<Plan> {
		const rootId = rootPieceId(this.ref);
		const missing = new Set<PieceId>();
		let listSize: number | undefined;
		const range = { offset: this.request.offset, length: this.request.length, digest: this.ctx.store.digest };
		for await (const entry of walkBlobPieces(this.ref, this.ctx.store.source, range)) {
			if (!entry.present) {
				missing.add(entry.id);
			} else if (entry.id === rootId && entry.kind === 'list') {
				listSize = entry.fileBytes;
			}
		}
		return { missing: [...missing], listSize };
	}

	private async succeed(): Promise<void> {
		if (this.outcome !== undefined) {
			return;
		}
		this.outcome = { kind: 'succeeded' };
		this.detachAborts();
		this.resolveDone();
		// A waiter still open names a piece the range did not need, unless it arrived by a path no session saw (a local put).
		await Promise.all([...this.waiters].map(waiter => this.resolveIfHere(waiter)));
	}

	private fail(error: unknown): void {
		if (this.outcome !== undefined) {
			return;
		}
		this.outcome = { kind: 'failed', error };
		this.detachAborts();
		logFailure(this.ref, error);
		this.rejectDone(error);
		for (const waiter of [...this.waiters]) {
			waiter.reject(error);
		}
	}

	/** Resolves the waiter when its piece is here; rejects it with RangeError when absent after the session succeeded. Never throws. */
	private async resolveIfHere(waiter: PieceWaiter): Promise<void> {
		try {
			if (await isHere(this.ctx.store.source, waiter.id)) {
				waiter.resolve();
			} else if (this.outcome?.kind === 'succeeded') {
				waiter.reject(new RangeError(`Blob ${this.ref}: piece ${waiter.id} is outside the fetched range`));
			}
		} catch (error) {
			waiter.reject(error);
		}
	}

	private checkAborted(): void {
		const { signal } = this.controller;
		if (signal.aborted) {
			throw signal.reason;
		}
	}
}

/** One round of asking: its candidates, how each answered, and which failed. */
class Round {
	readonly failed = new Set<string>();
	/** Frontier pieces another session has in flight, each with that attempt's end. */
	readonly elsewhere = new Map<PieceId, Promise<ElsewhereOutcome>>();
	private readonly answers = new Map<PieceId, Map<string, RoundAnswer>>();

	// NOTE: the frontier is scanned linearly for each batch (the peer choice, the batch and the drop of
	// what arrived), so a fetch costs about frontier² / MAX_BLOB_GET_PIECES steps: nothing for the blobs
	// of tens of megabytes this is built for, seconds at tens of gigabytes. If blobs that large are
	// fetched, keep the frontier as a queue with each peer's unanswered pieces indexed.
	constructor(readonly candidates: readonly string[], public frontier: readonly PieceId[]) {}

	answer(peer: string, id: PieceId): RoundAnswer | undefined {
		return this.answers.get(id)?.get(peer);
	}

	record(peer: string, ids: readonly PieceId[], answer: RoundAnswer): void {
		for (const id of ids) {
			let byPeer = this.answers.get(id);
			if (byPeer === undefined) {
				byPeer = new Map();
				this.answers.set(id, byPeer);
			}
			byPeer.set(peer, answer);
		}
	}

	recordUnanswered(peer: string, ids: readonly PieceId[], answer: RoundAnswer): void {
		this.record(peer, ids.filter(id => this.answer(peer, id) === undefined), answer);
	}

	/**
	 * One entry per candidate (`no-answer` when it recorded nothing for the piece), except a candidate
	 * that served the piece wrong, which counts once, as `corrupt`, with every other peer that did.
	 */
	attempts(piece: PieceId, corruptPeers: ReadonlySet<string>): PieceOutcome[] {
		const asked = this.candidates
			.filter(peer => !corruptPeers.has(peer))
			.map((peer): PieceOutcome => ({ peer, answer: this.answer(peer, piece) ?? 'no-answer' }));
		return [...asked, ...[...corruptPeers].map((peer): PieceOutcome => ({ peer, answer: 'corrupt' }))];
	}
}

/** Peers that served wrong bytes in a session, and the pieces they served them for. */
class CorruptServers {
	private readonly peers = new Set<string>();
	private readonly byPiece = new Map<PieceId, Set<string>>();

	note(peer: string, piece: PieceId): void {
		this.peers.add(peer);
		let servers = this.byPiece.get(piece);
		if (servers === undefined) {
			servers = new Set();
			this.byPiece.set(piece, servers);
		}
		servers.add(peer);
	}

	excludes(peer: string): boolean {
		return this.peers.has(peer);
	}

	of(piece: PieceId): ReadonlySet<string> {
		return this.byPiece.get(piece) ?? new Set();
	}
}

/**
 * Aborts `target` with the reason of whichever source aborts first; returns the detach. Combined by
 * hand because Hermes has no `AbortSignal.any` (`RepoClient.get` says why `any-signal` is not used).
 */
function forwardAborts(target: AbortController, sources: readonly (AbortSignal | undefined)[]): () => void {
	const present = sources.filter((source): source is AbortSignal => source !== undefined);
	const already = present.find(source => source.aborted);
	if (already !== undefined) {
		target.abort(already.reason);
		return () => undefined;
	}
	const forwarded = present.map(source => {
		const listener = (): void => target.abort(source.reason);
		source.addEventListener('abort', listener, { once: true });
		return { source, listener };
	});
	return () => {
		for (const { source, listener } of forwarded) {
			source.removeEventListener('abort', listener);
		}
	};
}

/** `promise`, or the signal's reason if it aborts first; the abort listener is removed either way. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(value => {
			signal.removeEventListener('abort', onAbort);
			resolve(value);
		}, error => {
			signal.removeEventListener('abort', onAbort);
			reject(error);
		});
	});
}

function delay(ms: number, signal: AbortSignal, setTimer: (fn: () => void, ms: number) => () => void): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = (): void => {
			cancel();
			reject(signal.reason);
		};
		const cancel = setTimer(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

async function isHere(source: PieceSource, id: PieceId): Promise<boolean> {
	return source.has !== undefined ? source.has(id) : (await source.get(id)) !== undefined;
}

function describeRange({ offset, length }: BlobFetchRequest): string {
	const start = offset ?? 0;
	return `${start}-${length === undefined ? 'end' : start + length}`;
}

function logFailure(ref: BlobRef, error: unknown): void {
	if (error instanceof BlobUnavailableError) {
		log('fetch:unavailable ref=%s reason=%s piece=%s', ref, error.reason, error.pieceId);
	} else if (error instanceof BlobCorruptError) {
		log('fetch:corrupt ref=%s piece=%s reason=%s', ref, error.pieceId, error.reason);
	} else {
		log('fetch:failed ref=%s err=%s', ref, describe(error));
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
