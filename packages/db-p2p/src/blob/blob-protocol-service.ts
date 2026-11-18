/**
 * The server side of the blob protocol: answers `stat` and `get` from this node's own holdings, and
 * `announce` and `held` with placeholders until copying is built (docs/blobs.md §Moving pieces between
 * machines). Registered on serving and client nodes alike, since the machine a blob was put on holds
 * its only copy until a row referencing it commits.
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import type { Connection, Startable, Stream } from '@libp2p/interface';
import type { BlobRef, PieceId } from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import { createInboundStreamAuthorization, type InboundStreamAuthorization, type InboundStreamAuthorizationInit } from '../inbound-authorization.js';
import { registerProtocolHandler, type ProtocolRegistrar } from '../network/register-protocol-handler.js';
import { MAX_BLOB_HEADER_BYTES, MAX_BLOB_INBOUND_GETS, MAX_BLOB_INBOUND_GETS_PER_PEER, MAX_BLOB_PIECE_FRAME_BYTES } from '../protocol-limits.js';
import { abortStreamOnStall, closeBlobStream, readBlobFrames, releaseBlobFrames, sendBlobFrame } from './blob-frames.js';
import {
	BlobProtocolError,
	buildBlobProtocol,
	decodeBlobRequest,
	encodeBlobHeader,
	type BlobAnnounceAnswer,
	type BlobAnswer,
	type BlobLocalHolding,
	type BlobRefusalReason,
	type BlobRequest,
} from './blob-protocol.js';
import type { LocalBlobService } from './local-blob-service.js';
import type { IPieceStore } from './piece-store.js';
import { ProgressDeadline } from './progress-deadline.js';

const log = createLogger('blob:protocol');

/** Who the requester is in logs and errors when its connection names no peer (the gate, when set, refuses such a stream first). */
const UNIDENTIFIED_PEER = '<unidentified>';

export interface BlobProtocolServiceInit extends InboundStreamAuthorizationInit {
	protocolPrefix?: string;
	/** Local holdings only: never probes. */
	blobs: Pick<LocalBlobService, 'stat'>;
	pieces: Pick<IPieceStore, 'has' | 'get'>;
	/** LinkDeadlines.responseTimeoutMs of this node. */
	progressTimeoutMs: number;
	/** Set by feat-a-referenced-blob-is-copied-to-its-cohort. Absent: every announce is answered 'declined', as a node that takes no blobs would. */
	onAnnounce?: (fromPeer: string, ref: BlobRef, scope: string) => Promise<BlobAnnounceAnswer>;
	/** Set by the same ticket. Absent: a `held` is acknowledged and ignored. */
	onHeld?: (fromPeer: string, ref: BlobRef) => void;
}

export interface BlobProtocolServiceComponents {
	registrar: ProtocolRegistrar & { unhandle(protocol: string): Promise<void> };
}

/** One inbound stream being answered. */
interface ServedExchange {
	readonly stream: Stream;
	readonly peer: string;
	readonly deadline: ProgressDeadline;
	readonly startedAt: number;
	/** Gives back this stream's `get` slot; set once one is taken, called when the stream ends. */
	releaseSlot?: () => void;
}

/**
 * Libp2p service answering the blob protocol. Per inbound stream: the authorization gate, then one
 * request read under a {@link ProgressDeadline}, answered and closed. The answer is sent as soon as the
 * request frame is read, never after the requester's end of stream (the deadlock
 * `BlockTransferService.handleRequest` documents), and a second frame on the stream is never read.
 *
 * No reputation report: the server judges nothing it receives except the request's shape.
 */
export class BlobProtocolService implements Startable {
	private running = false;
	private readonly protocol: string;
	private readonly registrar: BlobProtocolServiceComponents['registrar'];
	/** Optional embedder authorization gate; `undefined` (the default) means no check runs. */
	private readonly authorization: InboundStreamAuthorization | undefined;
	private readonly allowance = new InboundGetAllowance(MAX_BLOB_INBOUND_GETS_PER_PEER, MAX_BLOB_INBOUND_GETS);

	constructor(components: BlobProtocolServiceComponents, private readonly init: BlobProtocolServiceInit) {
		this.protocol = buildBlobProtocol(init.protocolPrefix ?? '');
		this.registrar = components.registrar;
		// Denials go to this module's `:error` child channel, as BlockTransferService's do.
		this.authorization = createInboundStreamAuthorization(init, this.protocol,
			(msg, ...args) => log.error(msg, ...args));
	}

	async start(): Promise<void> {
		if (this.running) return;
		await registerProtocolHandler(this.registrar, this.protocol, async (data: unknown, connection?: Connection) => {
			// libp2p 3 passes the stream positionally; an older shape passed `{ stream }`.
			const stream = (data as { stream?: Stream } | undefined)?.stream ?? (data as Stream);
			await this.handleStream(stream, connection);
		});
		this.running = true;
		log('started on %s', this.protocol);
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		await this.registrar.unhandle(this.protocol);
		this.running = false;
		log('stopped');
	}

	private async handleStream(stream: Stream, connection?: Connection): Promise<void> {
		const remotePeerId = connection?.remotePeer?.toString();
		// Before anything is read: a denied peer's stream is reset with no frame decoded.
		if (this.authorization && await this.authorization.deny(stream, remotePeerId)) return;
		const peer = remotePeerId ?? UNIDENTIFIED_PEER;
		const deadline = new ProgressDeadline(peer, this.init.progressTimeoutMs);
		const detach = abortStreamOnStall(stream, deadline);
		const exchange: ServedExchange = { stream, peer, deadline, startedAt: Date.now() };
		try {
			await this.answer(exchange);
			await closeBlobStream(stream, deadline);
		} catch (err) {
			abandon(exchange, err);
		} finally {
			exchange.releaseSlot?.();
			detach();
			deadline.stop();
		}
	}

	private async answer(exchange: ServedExchange): Promise<void> {
		const request = await this.readRequest(exchange);
		if (request === undefined) return;
		switch (request.kind) {
			case 'stat': return this.serveStat(exchange, request.refs);
			case 'get': return this.serveGet(exchange, request.pieces);
			case 'announce': return this.answerAnnounce(exchange, request.ref, request.scope);
			case 'held': return this.answerHeld(exchange, request.ref);
		}
	}

	/** The request, or `undefined` once a malformed one has been refused. Reads exactly one frame. */
	private async readRequest(exchange: ServedExchange): Promise<BlobRequest | undefined> {
		const frames = readBlobFrames(exchange.stream, exchange.deadline, exchange.peer);
		try {
			const first = await frames.next();
			if (first.done) throw new BlobProtocolError(exchange.peer, 'stream ended before a request');
			return decodeBlobRequest(first.value, exchange.peer);
		} catch (err) {
			if (!(err instanceof BlobProtocolError)) throw err;
			await refuse(exchange, 'malformed', err.detail);
			return undefined;
		} finally {
			// Nothing more is read, so whatever else arrives is held by the stream under its read-buffer cap.
			releaseBlobFrames(frames, exchange.peer);
		}
	}

	private async serveStat(exchange: ServedExchange, refs: readonly BlobRef[]): Promise<void> {
		const holdings: BlobLocalHolding[] = [];
		// One at a time: a partial blob's stat walks its tree, and 64 walks at once is work a peer chose.
		for (const ref of refs) {
			holdings.push(await this.holdingOf(ref, exchange.peer));
		}
		await sendAnswer(exchange, { kind: 'stat', holdings });
		log('serve:stat peer=%s refs=%d whole=%d partial=%d none=%d ms=%d', exchange.peer, refs.length,
			countOf(holdings, 'whole'), countOf(holdings, 'partial'), countOf(holdings, 'none'), elapsed(exchange));
	}

	/** A local stat that throws (a corrupt tree) is answered `none`: this node cannot serve that blob. */
	private async holdingOf(ref: BlobRef, peer: string): Promise<BlobLocalHolding> {
		try {
			const { locality } = await this.init.blobs.stat(ref);
			return locality === 'here' ? 'whole' : locality === 'partial' ? 'partial' : 'none';
		} catch (err) {
			log.error('serve:stat-failed peer=%s ref=%s err=%s', peer, ref, describe(err));
			return 'none';
		}
	}

	private async serveGet(exchange: ServedExchange, pieces: readonly PieceId[]): Promise<void> {
		const release = this.allowance.take(exchange.peer);
		if (release === undefined) {
			await refuse(exchange, 'busy', 'over the inbound get allowance');
			return;
		}
		exchange.releaseSlot = release;
		const held = await Promise.all(pieces.map(id => this.init.pieces.has(id)));
		await sendAnswer(exchange, { kind: 'get', held });
		let bytes = 0;
		for (let i = 0; i < pieces.length; i++) {
			if (held[i]) bytes += await this.sendPiece(exchange, pieces[i]!);
		}
		log('serve:get peer=%s asked=%d held=%d bytes=%d ms=%d', exchange.peer, pieces.length,
			held.filter(Boolean).length, bytes, elapsed(exchange));
	}

	/** Read just before sending, so this node holds one piece plus what the transport buffers. */
	private async sendPiece(exchange: ServedExchange, id: PieceId): Promise<number> {
		const bytes = await this.init.pieces.get(id);
		if (bytes === undefined) {
			// A sweep removed it after `has`: the header's promise is broken, and the requester keeps what it received.
			throw new BlobProtocolError(exchange.peer, `piece ${id} left this node's store after the header said it was held`);
		}
		return sendBlobFrame(exchange.stream, bytes, exchange.deadline, MAX_BLOB_PIECE_FRAME_BYTES);
	}

	private async answerAnnounce(exchange: ServedExchange, ref: BlobRef, scope: string): Promise<void> {
		const answer = this.init.onAnnounce ? await this.init.onAnnounce(exchange.peer, ref, scope) : 'declined';
		await sendAnswer(exchange, { kind: 'announce', answer });
		log('serve:announce peer=%s ref=%s answer=%s ms=%d', exchange.peer, ref, answer, elapsed(exchange));
	}

	private async answerHeld(exchange: ServedExchange, ref: BlobRef): Promise<void> {
		this.init.onHeld?.(exchange.peer, ref);
		await sendAnswer(exchange, { kind: 'held' });
		log('serve:held peer=%s ref=%s ms=%d', exchange.peer, ref, elapsed(exchange));
	}
}

/** Factory for creating BlobProtocolService following the libp2p service pattern. */
export const blobProtocolService = (init: BlobProtocolServiceInit) =>
	(components: BlobProtocolServiceComponents) => new BlobProtocolService(components, init);

/**
 * The `get` streams being served, per peer and in all, so one peer cannot take every slot and no
 * more streams read pieces at once than the node allows (docs/blobs.md §Moving pieces between machines).
 */
export class InboundGetAllowance {
	private readonly byPeer = new Map<string, number>();
	private total = 0;

	constructor(private readonly perPeer: number, private readonly overall: number) { }

	/** A slot for one more `get` from `peer`, or `undefined` when either count is at its cap. The returned release is idempotent. */
	take(peer: string): (() => void) | undefined {
		const held = this.byPeer.get(peer) ?? 0;
		if (held >= this.perPeer || this.total >= this.overall) return undefined;
		this.byPeer.set(peer, held + 1);
		this.total++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.total--;
			const left = (this.byPeer.get(peer) ?? 1) - 1;
			if (left === 0) this.byPeer.delete(peer);
			else this.byPeer.set(peer, left);
		};
	}
}

function sendAnswer(exchange: ServedExchange, answer: BlobAnswer): Promise<number> {
	return sendBlobFrame(exchange.stream, encodeBlobHeader(answer), exchange.deadline, MAX_BLOB_HEADER_BYTES);
}

async function refuse(exchange: ServedExchange, reason: BlobRefusalReason, detail: string): Promise<void> {
	log('serve:refused peer=%s reason=%s detail=%s', exchange.peer, reason, detail);
	await sendAnswer(exchange, { kind: 'refused', reason });
}

/** Ends a stream whose answer failed: with the stall when the deadline fired, else with the failure. */
function abandon(exchange: ServedExchange, err: unknown): void {
	const { stream, deadline } = exchange;
	if (deadline.signal.aborted) {
		log('serve:stalled peer=%s ms=%d', exchange.peer, elapsed(exchange));
		abortStream(stream, deadline.signal.reason, exchange.peer);
		return;
	}
	log('serve:aborted peer=%s err=%s', exchange.peer, describe(err));
	abortStream(stream, err, exchange.peer);
}

function abortStream(stream: Stream, reason: unknown, peer: string): void {
	try {
		stream.abort(reason instanceof Error ? reason : new Error(String(reason)));
	} catch (err) {
		log.error('serve:abort-failed peer=%s err=%s', peer, describe(err));
	}
}

function countOf(holdings: readonly BlobLocalHolding[], holding: BlobLocalHolding): number {
	return holdings.filter(h => h === holding).length;
}

function elapsed(exchange: ServedExchange): number {
	return Date.now() - exchange.startedAt;
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
