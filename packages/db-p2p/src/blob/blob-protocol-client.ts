/**
 * The client side of the blob protocol: asks a peer what it holds of some blobs (`stat`), and for
 * pieces by id (`get`), handing the caller each piece's bytes as its frame completes (docs/blobs.md
 * §Moving pieces between machines). Nothing here verifies or stores a piece; the fetcher does.
 *
 * One instance per node; per-peer state lives in callers.
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import type { Stream } from '@libp2p/interface';
import type { BlobRef, IPeerNetwork, PeerId, PieceId } from '@optimystic/db-core';
import type { Uint8ArrayList } from 'uint8arraylist';
import { createLogger } from '../logger.js';
import { openStreamWithin } from '../protocol-client.js';
import { MAX_BLOB_GET_PIECES, MAX_BLOB_HEADER_BYTES, MAX_BLOB_STAT_REFS } from '../protocol-limits.js';
import type { LinkDeadlines } from '../rpc-deadline.js';
import { abortStreamOnStall, closeBlobStream, readBlobFrames, releaseBlobFrames, sendBlobFrame, type BlobFrameSource } from './blob-frames.js';
import {
	BlobPeerRefusedError,
	BlobProtocolError,
	BlobTransferStalledError,
	buildBlobProtocol,
	checkAnswerFits,
	decodeBlobAnswer,
	encodeBlobHeader,
	type BlobAnswer,
	type BlobLocalHolding,
	type BlobRequest,
} from './blob-protocol.js';
import { ProgressDeadline } from './progress-deadline.js';

const log = createLogger('blob:protocol');

export interface BlobProtocolClientInit {
	/** The node's Libp2pKeyPeerNetwork. */
	peerNetwork: IPeerNetwork;
	protocolPrefix: string;
	deadlines: Pick<LinkDeadlines, 'dialTimeoutMs' | 'responseTimeoutMs'>;
}

export interface BlobGetReply {
	/** In request order. */
	held: PieceId[];
	notHeld: PieceId[];
	/**
	 * Yields each held piece as its frame completes, in `held` order. Must be iterated to the end or
	 * exited early (break/return), which aborts the stream; left unread, the stream is aborted by its
	 * progress deadline. Single-use. Throws BlobTransferStalledError, BlobProtocolError (`truncated`:
	 * the stream ended before the last piece; `extra frame`: a frame after it), or the stream's own error.
	 */
	pieces: AsyncIterable<{ id: PieceId; bytes: Uint8Array }>;
}

export interface BlobRequestOptions {
	/** The caller's cancellation: aborts the stream with `signal.reason`, which the call then throws. */
	signal?: AbortSignal;
}

/** The running byte counts behind {@link BlobProtocolClient.wireBytes}. */
interface WireCount {
	sent: number;
	received: number;
}

export class BlobProtocolClient {
	private readonly protocol: string;
	private readonly wire: WireCount = { sent: 0, received: 0 };

	constructor(private readonly init: BlobProtocolClientInit) {
		this.protocol = buildBlobProtocol(init.protocolPrefix);
	}

	/** What `peer` holds of each of `refs`, positionally. Throws RangeError, locally, for an empty list or one over `MAX_BLOB_STAT_REFS`. */
	async stat(peer: PeerId, refs: readonly BlobRef[], options: BlobRequestOptions = {}): Promise<BlobLocalHolding[]> {
		requireRequestList('refs', refs, MAX_BLOB_STAT_REFS);
		const request = { kind: 'stat', refs: [...refs] } satisfies BlobRequest;
		const exchange = await this.open(peer, request, options.signal);
		try {
			const answer = await exchange.readAnswer(request);
			await exchange.requireEnd();
			log('client:stat peer=%s refs=%d ms=%d', exchange.peer, refs.length, exchange.elapsed());
			return answer.holdings;
		} catch (err) {
			throw exchange.fail(err);
		} finally {
			exchange.finish();
		}
	}

	/**
	 * Asks `peer` for `pieces`; resolves once the answer header is read, with the pieces still to come.
	 * Throws RangeError, locally, for an empty list, one over `MAX_BLOB_GET_PIECES`, or one naming a
	 * piece twice; BlobPeerRefusedError when the peer refuses.
	 */
	async get(peer: PeerId, pieces: readonly PieceId[], options: BlobRequestOptions = {}): Promise<BlobGetReply> {
		requireRequestList('pieces', pieces, MAX_BLOB_GET_PIECES);
		if (new Set(pieces).size !== pieces.length) throw new RangeError('A blob get names a piece more than once');
		const request = { kind: 'get', pieces: [...pieces] } satisfies BlobRequest;
		const exchange = await this.open(peer, request, options.signal);
		let answer: Extract<BlobAnswer, { kind: 'get' }>;
		try {
			answer = await exchange.readAnswer(request);
		} catch (err) {
			const reason = exchange.fail(err);
			exchange.finish();
			throw reason;
		}
		const held = request.pieces.filter((_, i) => answer.held[i]);
		const notHeld = request.pieces.filter((_, i) => !answer.held[i]);
		const received = receivePieces(exchange, held, request.pieces.length);
		// Nothing held: a caller has no reason to read the pieces, so the end of stream is required and
		// the exchange finished here, rather than left open until its deadline fires.
		if (held.length === 0) await received.next();
		return { held, notHeld, pieces: received };
	}

	/**
	 * Cumulative bytes this client sent and received on blob streams: each sent frame with its length
	 * prefix, and every chunk of bytes received, counted as it arrives (so a frame cut off part way counts
	 * the part that arrived). Read by diagnostics and the transfer measurement.
	 */
	wireBytes(): { sent: number; received: number } {
		return { sent: this.wire.sent, received: this.wire.received };
	}

	/** A stream to `peer` carrying `request`, its write side closed once the request is flushed; reading continues. */
	private async open(peer: PeerId, request: BlobRequest, signal: AbortSignal | undefined): Promise<ClientExchange> {
		const stream = await openStreamWithin(this.init.peerNetwork, peer, this.protocol, {
			signal,
			dialTimeoutMs: this.init.deadlines.dialTimeoutMs,
		});
		const exchange = new ClientExchange(stream, peer.toString(), this.init.deadlines.responseTimeoutMs, signal, this.wire);
		try {
			// Not `+= await`: that reads the count before the await, losing a concurrent request's bytes.
			const sent = await sendBlobFrame(stream, encodeBlobHeader(request), exchange.deadline, MAX_BLOB_HEADER_BYTES);
			this.wire.sent += sent;
			// libp2p 3 closes the write side only: it resolves once the request is flushed.
			await closeBlobStream(stream, exchange.deadline);
			return exchange;
		} catch (err) {
			const reason = exchange.fail(err);
			exchange.finish();
			throw reason;
		}
	}
}

/** Reads exactly `held.length` piece frames, then requires end of stream. */
async function* receivePieces(exchange: ClientExchange, held: readonly PieceId[], asked: number): AsyncGenerator<{ id: PieceId; bytes: Uint8Array }> {
	let received = 0;
	let bytes = 0;
	let completed = false;
	try {
		for (const id of held) {
			const frame = await exchange.nextFrame();
			if (frame === undefined) {
				throw new BlobProtocolError(exchange.peer, `truncated: the stream ended after ${received} of ${held.length} pieces`);
			}
			received++;
			bytes += frame.byteLength;
			yield { id, bytes: frame };
		}
		await exchange.requireEnd();
		completed = true;
	} catch (err) {
		throw exchange.fail(err);
	} finally {
		if (!completed && !exchange.failed) {
			// The caller left the loop early: abort rather than leave the stream half-read.
			exchange.abort(new Error(`blob get: the reader stopped after ${received} of ${held.length} pieces`));
		}
		log('client:get peer=%s asked=%d held=%d received=%d bytes=%d ms=%d', exchange.peer, asked, held.length, received, bytes, exchange.elapsed());
		exchange.finish();
	}
}

/** One outbound blob stream: its deadline, its frames, and the two ways it is aborted. */
class ClientExchange {
	readonly deadline: ProgressDeadline;
	/** Set once an error ended the exchange; the stream has been aborted with it. */
	failed = false;
	private readonly frames: AsyncIterator<Uint8Array>;
	private readonly startedAt = Date.now();
	private readonly detachStall: () => void;
	private readonly onCallerAbort = (): void => this.abort(this.signal!.reason);
	private finished = false;

	constructor(
		private readonly stream: Stream,
		readonly peer: string,
		progressTimeoutMs: number,
		private readonly signal: AbortSignal | undefined,
		wire: WireCount,
	) {
		this.deadline = new ProgressDeadline(peer, progressTimeoutMs);
		this.detachStall = abortStreamOnStall(stream, this.deadline);
		if (signal?.aborted) this.abort(signal.reason);
		else signal?.addEventListener('abort', this.onCallerAbort, { once: true });
		this.frames = readBlobFrames(countingReceived(stream, wire), this.deadline, peer);
	}

	/** The answer header, of the request's own kind; a refusal throws BlobPeerRefusedError. */
	async readAnswer<R extends Extract<BlobRequest, { kind: 'stat' | 'get' }>>(request: R): Promise<Extract<BlobAnswer, { kind: R['kind'] }>> {
		const frame = await this.nextFrame();
		if (frame === undefined) throw new BlobProtocolError(this.peer, 'the stream ended before an answer');
		const answer = decodeBlobAnswer(frame, this.peer);
		if (answer.kind === 'refused') throw new BlobPeerRefusedError(this.peer, answer.reason);
		checkAnswerFits(request, answer, this.peer);
		// checkAnswerFits has refused every answer of another kind.
		return answer as Extract<BlobAnswer, { kind: R['kind'] }>;
	}

	/** The next frame, or `undefined` at end of stream. */
	async nextFrame(): Promise<Uint8Array | undefined> {
		const next = await this.frames.next();
		return next.done ? undefined : next.value;
	}

	async requireEnd(): Promise<void> {
		if (await this.nextFrame() !== undefined) throw new BlobProtocolError(this.peer, 'extra frame after the last one the answer named');
	}

	/**
	 * `err` as the caller should see it, logged once, with the stream aborted: the caller's own reason
	 * when it cancelled, the stall when the deadline fired, else `err`.
	 */
	fail(err: unknown): unknown {
		const reason = this.signal?.aborted ? this.signal.reason
			: this.deadline.signal.aborted ? this.deadline.signal.reason
			: err;
		if (!this.failed) {
			this.failed = true;
			logFailure(this.peer, reason, this.elapsed());
			this.abort(reason);
		}
		return reason;
	}

	abort(reason: unknown): void {
		try {
			this.stream.abort(reason instanceof Error ? reason : new Error(String(reason)));
		} catch (err) {
			log.error('client:abort-failed peer=%s err=%s', this.peer, describe(err));
		}
	}

	/** Stops the deadline, removes the caller's listener and stops reading. Idempotent. */
	finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.deadline.stop();
		this.detachStall();
		this.signal?.removeEventListener('abort', this.onCallerAbort);
		releaseBlobFrames(this.frames, this.peer);
	}

	elapsed(): number {
		return Date.now() - this.startedAt;
	}
}

function logFailure(peer: string, reason: unknown, ms: number): void {
	if (reason instanceof BlobTransferStalledError) log('client:stalled peer=%s ms=%d', peer, ms);
	else if (reason instanceof BlobPeerRefusedError) log('client:refused peer=%s reason=%s', peer, reason.reason);
	else if (reason instanceof BlobProtocolError) log('client:protocol-error peer=%s detail=%s', peer, reason.detail);
	else log('client:aborted peer=%s err=%s', peer, describe(reason));
}

/** Refused locally, before any stream is opened: the peer would refuse it as malformed. */
function requireRequestList(name: string, list: readonly unknown[], cap: number): void {
	if (list.length === 0) throw new RangeError(`A blob request's '${name}' list is empty`);
	if (list.length > cap) throw new RangeError(`A blob request names ${list.length} '${name}', over the cap of ${cap}`);
}

async function* countingReceived(source: BlobFrameSource, wire: WireCount): AsyncGenerator<Uint8Array | Uint8ArrayList> {
	for await (const chunk of source) {
		wire.received += chunk.byteLength;
		yield chunk;
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
