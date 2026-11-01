import { LruMap, type BlockId } from "@optimystic/db-core";

/** How many blocks, and how many peers, the holds remember — the bound the repo's other per-block state uses. */
const SILENT_CONSULT_HOLDS_CAPACITY = 1000;

/** One block's hold: what its consecutive silent consults have added up to. */
interface SilentConsultHold {
	/** Silent consults in a row since the block's last clean consult, or since a silent peer last answered. */
	consecutive: number;
	/** When the hold ends: a window-demanded consult of the block waits until then. */
	heldUntil: number;
	/** When the consult that set this hold ended — the moment an answer from a silent peer starts to count. */
	since: number;
	/** The peers that consult found silent. Any one of them answering releases the hold. */
	silent: readonly string[];
}

/** A hold just placed, as the caller logs it (`cluster-fetch:consult-held`). */
export interface PlacedSilentConsultHold {
	holdMs: number;
	consecutive: number;
	silent: readonly string[];
}

/**
 * How long a held block waits before the read-repair window may ask the cohort about it again, after
 * a consult that left the window unarmed because some cohort peer did not answer.
 *
 * **Why such a consult needs a wait of its own.** The window stays unarmed after it on purpose: the
 * silent peer may recover, and may hold a newer revision, so re-asking can learn something
 * (`CoordinatorRepo.fetchBlockFromCluster`). Unarmed, though, the next read starts the next consult
 * as soon as the previous one ends. On a slow link the previous one ends only when the silent peer's
 * per-peer deadline does, and each new request queues behind the one that went unanswered: measured
 * in Sereus (gotchoices/sereus#48), one block re-asked about every 8.2 s, 224 times in the 180 s after
 * the workload, every one finding the other member silent. The hold spaces those consults out without
 * arming the window: it starts at one declared link round trip and doubles with each consecutive
 * silent consult, up to a cap.
 *
 * **What ends a hold early.** Any peer that was silent in the consult answering a request this node
 * made at or after that consult ended, for any block or a vote on any write ({@link noteAnswered}).
 * One recovered peer is the whole reason the window stayed unarmed, so one is enough. A released hold
 * is forgotten, so the next silent consult starts again at one round trip. A consult that ends any
 * other way forgets the hold too ({@link clear}).
 *
 * **What it gates.** Only the consults the window asks for, which is the one question the caller asks
 * here ({@link holds}). It changes when a consult is sent, never what a read reports: a read served
 * during a hold is served from the local copy exactly as a read inside the window is.
 *
 * A base of 0 disables it entirely, which is today's behaviour: a node that declares no link round
 * trip re-asks on the next read.
 *
 * LRU-bounded at {@link SILENT_CONSULT_HOLDS_CAPACITY} blocks and as many peers. Losing a block's hold
 * costs one early consult; losing a peer's answer time costs a hold that runs to its end instead of
 * being released.
 */
export class SilentConsultHolds {
	private readonly baseMs: number;
	private readonly capMs: number;
	private readonly now: () => number;
	private readonly holdsByBlock = new LruMap<BlockId, SilentConsultHold>(SILENT_CONSULT_HOLDS_CAPACITY);
	private readonly lastAnsweredAt = new LruMap<string, number>(SILENT_CONSULT_HOLDS_CAPACITY);

	constructor(options: {
		/** First hold in ms; 0 (or anything not above 0) disables holds entirely. */
		baseMs: number;
		/** Longest hold in ms. */
		capMs: number;
		now: () => number;
	}) {
		this.baseMs = options.baseMs > 0 ? options.baseMs : 0;
		this.capMs = options.capMs;
		this.now = options.now;
	}

	/**
	 * A consult of `blockId` ended without arming the window because `silent` peers did not answer.
	 * Places the next hold — double the last one, or one base when there was none or it was released —
	 * and returns it for the caller to log once. Returns undefined, and stores nothing, when holds are
	 * disabled.
	 */
	noteSilentConsult(blockId: BlockId, silent: readonly string[]): PlacedSilentConsultHold | undefined {
		if (this.baseMs === 0) return undefined;
		const prior = this.holdsByBlock.get(blockId);
		const consecutive = prior === undefined || this.released(prior) ? 1 : prior.consecutive + 1;
		const holdMs = Math.min(this.capMs, this.baseMs * 2 ** (consecutive - 1));
		const since = this.now();
		this.holdsByBlock.set(blockId, { consecutive, heldUntil: since + holdMs, since, silent: [...silent] });
		return { holdMs, consecutive, silent };
	}

	/** A consult of `blockId` ended any other way: forget its hold, so a later silence starts at one base again. */
	clear(blockId: BlockId): void {
		this.holdsByBlock.delete(blockId);
	}

	/** `peerId` answered a request this node made. */
	noteAnswered(peerId: string): void {
		if (this.baseMs === 0) return;
		this.lastAnsweredAt.set(peerId, this.now());
	}

	/** Whether a window-demanded consult of `blockId` must wait. */
	holds(blockId: BlockId): boolean {
		const hold = this.holdsByBlock.peek(blockId);
		if (hold === undefined) return false;
		if (this.released(hold)) {
			this.holdsByBlock.delete(blockId);
			return false;
		}
		return this.now() < hold.heldUntil;
	}

	private released(hold: SilentConsultHold): boolean {
		return hold.silent.some(peerId => (this.lastAnsweredAt.peek(peerId) ?? -Infinity) >= hold.since);
	}
}
