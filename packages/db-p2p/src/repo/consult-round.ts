import type { ActionContext, ActionRev, BlockId } from "@optimystic/db-core";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { MAX_CONSULT_BATCH_BLOCKS } from "../protocol-limits.js";
import type { Logger } from "../logger.js";
import type { ClusterLatestAnswer, ClusterLatestCallback } from "./coordinator-repo.js";

/** One block a consult asks a peer about, with what this node holds of it, when it holds anything. */
export interface ConsultAsk {
	blockId: BlockId;
	held?: ActionRev;
}

/**
 * One peer's answers for the blocks it was asked about: a claim, or `undefined` for "holds nothing".
 * A block absent from the map was not answered — the peer answered malformed, or is on an older
 * build and answered only the first block (see {@link unbatched}).
 */
export interface ConsultBatchAnswer {
	answers: ReadonlyMap<BlockId, ClusterLatestAnswer | undefined>;
	/**
	 * True when the peer answered in the original single-block form (a build that predates
	 * `SyncRequest.held`): only the first block was answered, and the rest must be asked one at a time.
	 */
	unbatched?: boolean;
}

/**
 * Ask one cohort peer about several blocks in one request. Per block, the three-way contract of
 * `ClusterLatestCallback` (`coordinator-repo.ts`) holds: a claim is the peer holding the block at that
 * revision, `undefined` is the peer answering that it holds nothing, and silence is never either —
 * so the callback REJECTS when the peer could not be asked at all (dial failure, protocol error),
 * which silences every block of the request, and leaves out of `answers` a block the peer did not
 * answer, which silences that block alone. Never called for this node itself: the round asks self
 * through the single-block callback, which reads local storage.
 */
export type ClusterLatestBatchCallback = (
	peerId: PeerId,
	asks: ReadonlyArray<ConsultAsk>,
	context?: ActionContext
) => Promise<ConsultBatchAnswer>;

/** One pass's place in a {@link ConsultRound}. */
export interface ConsultSeat {
	/**
	 * Register one question; the promise settles when the round sends, under the three-way contract
	 * per question. Throws once this seat is ready or the round has sent.
	 */
	ask(peerId: string, blockId: BlockId, held?: ActionRev): Promise<ClusterLatestAnswer | undefined>;
	/** This seat has registered everything it will ask. Idempotent, so a pass can call it from `finally` too. */
	ready(): void;
}

export interface ConsultRoundDeps {
	batch: ClusterLatestBatchCallback;
	/** Asks self, and the blocks an older peer did not answer in its batch. */
	single: ClusterLatestCallback;
	selfId?: string;
	context?: ActionContext;
	log: Logger;
}

interface Waiter {
	resolve(answer: ClusterLatestAnswer | undefined): void;
	reject(error: unknown): void;
}

/** One (peer, block) question waiting on the round's send, with every seat that asked it. */
interface PendingAsk {
	held?: ActionRev;
	waiters: Waiter[];
}

type AskEntry = [BlockId, PendingAsk];

/**
 * The per-peer questions of one `CoordinatorRepo.get`, sent together: the passes that read starts —
 * one per block that consults the cohort — each join, register their (peer, block) questions instead
 * of sending them, and once every seat has registered its questions or left without asking, the round
 * sends ONE request per peer naming every block registered for it, chunked at
 * {@link MAX_CONSULT_BATCH_BLOCKS}. So a read of a table's header and log tail costs one request per
 * peer, not two.
 *
 * A barrier rather than a coalescing timer: the passes reach their questions after an asynchronous
 * cohort lookup, so no fixed tick is sure to catch them all, and a timer would add latency to every
 * one-block read. The barrier adds none — a round of one seat sends the moment that seat is ready.
 *
 * Every question settles: from the peer's answer, as silence when the request failed or left its
 * block out, or from the single-block callback for self and for the blocks an older peer did not
 * answer.
 */
export class ConsultRound {
	private readonly byPeer = new Map<string, Map<BlockId, PendingAsk>>();
	private seats = 0;
	private readySeats = 0;
	private closed = false;
	private sent = false;

	constructor(private readonly deps: ConsultRoundDeps) {}

	/** A pass that will (or may) consult joins synchronously, before its first await. */
	join(): ConsultSeat {
		if (this.closed) throw new Error('ConsultRound: a seat joined after the round was closed');
		this.seats++;
		let isReady = false;
		return {
			ask: (peerId, blockId, held) => {
				if (isReady || this.sent) throw new Error(`ConsultRound: block ${blockId} was asked of ${peerId} after its seat was ready`);
				return this.register(peerId, blockId, held);
			},
			ready: () => {
				if (isReady) return;
				isReady = true;
				this.readySeats++;
				this.sendWhenSettled();
			}
		};
	}

	/** No more seats will join; the round sends once every joined seat is ready. */
	close(): void {
		this.closed = true;
		this.sendWhenSettled();
	}

	private register(peerId: string, blockId: BlockId, held: ActionRev | undefined): Promise<ClusterLatestAnswer | undefined> {
		return new Promise((resolve, reject) => {
			let asks = this.byPeer.get(peerId);
			if (!asks) this.byPeer.set(peerId, asks = new Map());
			const pending = asks.get(blockId);
			if (pending) pending.waiters.push({ resolve, reject });
			else asks.set(blockId, { held, waiters: [{ resolve, reject }] });
		});
	}

	private sendWhenSettled(): void {
		if (!this.closed || this.sent || this.readySeats < this.seats) return;
		this.sent = true;
		for (const [peerId, asks] of this.byPeer) {
			const entries = [...asks];
			if (peerId === this.deps.selfId) {
				this.askEachSingly(peerId, entries);
				continue;
			}
			for (let at = 0; at < entries.length; at += MAX_CONSULT_BATCH_BLOCKS) {
				void this.askInOne(peerId, entries.slice(at, at + MAX_CONSULT_BATCH_BLOCKS));
			}
		}
		this.byPeer.clear();
	}

	/** One request to `peerId` for every block of `chunk`. Never rejects: every outcome settles the chunk's questions. */
	private async askInOne(peerId: string, chunk: AskEntry[]): Promise<void> {
		let reply: ConsultBatchAnswer;
		try {
			const asks = chunk.map(([blockId, { held }]): ConsultAsk => held ? { blockId, held } : { blockId });
			reply = await this.deps.batch(peerIdFromString(peerId), asks, this.deps.context);
		} catch (error) {
			// The peer could not be asked: silent for every block it was asked about.
			for (const [, pending] of chunk) void settle(pending, Promise.reject(error));
			return;
		}
		if (!reply.unbatched) {
			for (const entry of chunk) settleFromReply(peerId, entry, reply);
			return;
		}
		// An older peer answered the first block the original way; the rest cost it what they did before.
		this.deps.log('cluster-fetch:consult-unbatched', { peer: peerId, blocks: chunk.length });
		settleFromReply(peerId, chunk[0]!, reply);
		this.askEachSingly(peerId, chunk.slice(1));
	}

	/** Ask `peerId` about each block of `entries` on its own request, all at once. */
	private askEachSingly(peerId: string, entries: AskEntry[]): void {
		for (const [blockId, pending] of entries) {
			void settle(pending, (async () => this.deps.single(peerIdFromString(peerId), blockId, this.deps.context, pending.held))());
		}
	}
}

/** Settle one question from a batched reply: its answer, or silence when the reply left it out. */
function settleFromReply(peerId: string, [blockId, pending]: AskEntry, reply: ConsultBatchAnswer): void {
	void settle(pending, reply.answers.has(blockId)
		? Promise.resolve(reply.answers.get(blockId))
		: Promise.reject(new Error(`consult answer from ${peerId} omits block ${blockId}`)));
}

/** Hand `outcome` to every seat waiting on `pending`. Never rejects. */
async function settle(pending: PendingAsk, outcome: Promise<ClusterLatestAnswer | undefined>): Promise<void> {
	try {
		const answer = await outcome;
		for (const waiter of pending.waiters) waiter.resolve(answer);
	} catch (error) {
		for (const waiter of pending.waiters) waiter.reject(error);
	}
}

/**
 * Settle `pass`, then leave `seat` however the pass ended. A pass registers its questions and readies
 * its seat itself when it consults; this covers every exit that asks nobody — an empty cohort, a
 * cohort of this node alone, a cohort lookup that throws — so the round still sends for the others.
 */
export async function leavingSeat<T>(seat: ConsultSeat | undefined, pass: Promise<T>): Promise<T> {
	try {
		return await pass;
	} finally {
		seat?.ready();
	}
}
