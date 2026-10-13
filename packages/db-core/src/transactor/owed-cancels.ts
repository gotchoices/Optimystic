import type { ActionBlocks } from "../network/struct.js";
import type { ActionId } from "../collection/action.js";
import type { BlockId } from "../blocks/structs.js";
import { jitteredBackoffMs } from "../utility/backoff.js";
import { armUnrefTimer } from "../utility/unref-timer.js";
import { createLogger } from "../logger.js";

const log = createLogger('network-transactor');

export type OwedCancelTimerCancel = () => void;

/**
 * Optional injection seam for deterministic time, the shape `ClusterCoordinatorClock` in
 * `packages/db-p2p/src/repo/cluster-coordinator.ts` gives its retry timer. Production leaves both
 * undefined and gets `Date.now` plus an unref'd `setTimeout`, so an owed cancel never keeps an
 * otherwise-idle process alive.
 */
export interface OwedCancelClock {
	/** Clock (Unix ms). Defaults to `Date.now`. */
	now?: () => number;
	/** Schedule a one-shot timer, returning its cancel. Defaults to an unref'd `setTimeout`. */
	setTimer?: (fn: () => void, delayMs: number) => OwedCancelTimerCancel;
}

export interface OwedCancelsInit {
	/**
	 * One bounded cancel attempt for `actionRef`, resolving with the blocks some peer ANSWERED for —
	 * the same discharged set the transactor's own cancel loop judges by. A throw counts as nothing
	 * answered.
	 */
	attempt: (actionRef: ActionBlocks) => Promise<ReadonlySet<BlockId>>;
	clock?: OwedCancelClock;
	/** Most actions remembered at once. Default {@link DEFAULT_MAX_OWED_ACTIONS}. */
	maxActions?: number;
}

/**
 * Bounds the memory a writer spends on cancels it cannot land. Evicting an entry re-opens the wedge
 * that entry was kept to close, so it is logged; a writer that owes this many is cut off from its
 * cohorts, and its records are the node-side backstop's (backlog
 * `debt-unpromotable-pending-records-need-a-sweep`).
 */
const DEFAULT_MAX_OWED_ACTIONS = 256;

/** The backoff between re-sends of one owed cancel: a second at first, doubling to half a minute. */
const RETRY_BACKOFF = { baseMs: 1_000, capMs: 30_000 };

interface OwedEntry {
	readonly blockIds: Set<BlockId>;
	/** When the cancel first fell short, for the discharge log. */
	readonly since: number;
	/** Re-sends made so far — the backoff's exponent. */
	attempts: number;
	nextAttemptAt: number;
}

/**
 * The cancels a writer could not discharge, kept and re-sent until they land.
 *
 * A cancel whose rounds all fall short — every one of them is a cluster transaction, so the member
 * whose silence sank the commit sinks the cancel too — leaves pending records standing that make the
 * members refuse every later write to those blocks, from any writer. Nothing else removes them while
 * their slot is unreached (docs/repository.md, "A pending record's lifetime is bounded by its
 * writer"), so the writer keeps the cancel and sends it again:
 *
 *  - **before its own next pend of any of those blocks** ({@link beforePend}), which is what clears
 *    the leftover in front of the writer's next write to the block;
 *  - **on a backoff timer** while anything is owed, so other machines' writes, which the records also
 *    refuse, are freed without this writer writing the block again.
 *
 * Re-sending is safe whenever it arrives: a cancel deletes only the cancelled action's pending records
 * and never moves a revision, so it commutes with every other action. The one exception is a re-pend
 * of the SAME action id, whose new record a late cancel would delete — so a pend of an owed action
 * supersedes the owed cancel for every block it names, and waits out any re-send of it already in
 * flight before it goes out.
 */
export class OwedCancels {
	private readonly entries = new Map<ActionId, OwedEntry>();
	private readonly inFlight = new Map<ActionId, Promise<void>>();
	private readonly attempt: OwedCancelsInit['attempt'];
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, delayMs: number) => OwedCancelTimerCancel;
	private readonly maxActions: number;
	private timer: { cancel: OwedCancelTimerCancel; dueAt: number } | undefined;
	private stopped = false;

	constructor(init: OwedCancelsInit) {
		this.attempt = init.attempt;
		this.now = init.clock?.now ?? ((): number => Date.now());
		this.setTimer = init.clock?.setTimer ?? armUnrefTimer;
		this.maxActions = init.maxActions ?? DEFAULT_MAX_OWED_ACTIONS;
	}

	/** Every owed action with the blocks it still owes a cancel for. A snapshot. */
	snapshot(): Map<ActionId, BlockId[]> {
		return new Map(Array.from(this.entries, ([actionId, entry]) => [actionId, Array.from(entry.blockIds)]));
	}

	/** A cancel for `actionId` ran out of budget with `blockIds` still unanswered. */
	record(actionId: ActionId, blockIds: readonly BlockId[], why: string | undefined): void {
		if (blockIds.length === 0) return;
		if (this.stopped) {
			log('cancel:owed-abandoned actionId=%s blocks=%o why=stopped', actionId, blockIds);
			return;
		}
		const existing = this.entries.get(actionId);
		if (existing) {
			for (const bid of blockIds) existing.blockIds.add(bid);
			existing.nextAttemptAt = this.now() + this.backoffMs(existing.attempts);
		} else {
			const now = this.now();
			this.entries.set(actionId, { blockIds: new Set(blockIds), since: now, attempts: 0, nextAttemptAt: now + this.backoffMs(0) });
			this.evictOverflow();
		}
		log('cancel:owed actionId=%s blocks=%o why=%s', actionId, blockIds, why ?? 'unknown');
		this.arm();
	}

	/** A cancel for `actionId` was answered for `blockIds` — whoever sent it, they are owed no longer. */
	discharged(actionId: ActionId, blockIds: Iterable<BlockId>): void {
		const settled = this.remove(actionId, blockIds);
		if (settled) {
			log('cancel:owed-discharged actionId=%s attempts=%d stoodMs=%d', actionId, settled.attempts, this.now() - settled.since);
		}
	}

	/**
	 * Re-sends nothing from here on: the timer is disarmed and every cancel still owed is logged
	 * (`cancel:owed-abandoned`) and forgotten, its records left to the node-side backstop. For when the
	 * node the re-sends go through stops — they could never land, and the timer would otherwise keep
	 * the transactor, and everything it reaches, alive for the life of the process.
	 */
	stop(): void {
		this.stopped = true;
		this.timer?.cancel();
		this.timer = undefined;
		for (const [actionId, entry] of this.entries) {
			log('cancel:owed-abandoned actionId=%s blocks=%o stoodMs=%d', actionId, Array.from(entry.blockIds), this.now() - entry.since);
		}
		this.entries.clear();
	}

	/**
	 * Runs ahead of every pend of `actionId` over `blockIds`: supersedes this action's own owed cancel
	 * for those blocks, then makes one attempt at every OTHER owed cancel that names any of them. A
	 * failed attempt stays owed and the pend proceeds; a cohort still unable to approve the cancel
	 * cannot approve the pend either, so one attempt — not a loop — is what the pend should wait for.
	 */
	async beforePend(actionId: ActionId, blockIds: readonly BlockId[]): Promise<void> {
		if (this.entries.size === 0 && this.inFlight.size === 0) return;
		await this.supersede(actionId, blockIds);
		const named = new Set(blockIds);
		const overlapping = Array.from(this.entries)
			.filter(([owedId, entry]) => owedId !== actionId && Array.from(entry.blockIds).some(bid => named.has(bid)))
			.map(([owedId]) => owedId);
		await Promise.all(overlapping.map(owedId => this.attemptOnce(owedId)));
	}

	/**
	 * A pend of `actionId` writes a fresh record on every block it names, which a late cancel for the
	 * same action id would delete. So those blocks leave the owed entry first — synchronously, so no
	 * re-send started from here on can carry them — and a re-send already in flight is waited out, so
	 * it lands before the pend rather than after it.
	 */
	private async supersede(actionId: ActionId, blockIds: readonly BlockId[]): Promise<void> {
		const entry = this.entries.get(actionId);
		const superseded = entry ? blockIds.filter(bid => entry.blockIds.has(bid)) : [];
		if (superseded.length > 0) {
			log('cancel:owed-superseded actionId=%s blocks=%o', actionId, superseded);
			this.remove(actionId, superseded);
		}
		await this.inFlight.get(actionId);
	}

	/** Takes `blockIds` off `actionId`'s entry, returning the entry when that emptied — and so removed — it. */
	private remove(actionId: ActionId, blockIds: Iterable<BlockId>): OwedEntry | undefined {
		const entry = this.entries.get(actionId);
		if (!entry) return undefined;
		for (const bid of blockIds) entry.blockIds.delete(bid);
		if (entry.blockIds.size > 0) return undefined;
		this.entries.delete(actionId);
		this.arm();
		return entry;
	}

	/** One re-send of `actionId`'s owed cancel, joining the one already in flight if there is one. */
	private attemptOnce(actionId: ActionId): Promise<void> {
		const running = this.inFlight.get(actionId);
		if (running) return running;
		const entry = this.entries.get(actionId);
		if (!entry) return Promise.resolve();
		++entry.attempts;
		const run = this.resend(actionId, Array.from(entry.blockIds))
			.finally(() => {
				if (this.inFlight.get(actionId) === run) this.inFlight.delete(actionId);
				this.arm();
			});
		this.inFlight.set(actionId, run);
		return run;
	}

	private async resend(actionId: ActionId, blockIds: BlockId[]): Promise<void> {
		let answered: ReadonlySet<BlockId>;
		try {
			answered = await this.attempt({ actionId, blockIds });
		} catch (error) {
			log('cancel:owed-retry-failed actionId=%s blocks=%d error=%s', actionId, blockIds.length, (error as Error)?.message ?? String(error));
			answered = new Set();
		}
		this.discharged(actionId, answered);
		const entry = this.entries.get(actionId);
		if (entry) {
			entry.nextAttemptAt = this.now() + this.backoffMs(entry.attempts);
		}
	}

	/** Arms the one timer at the earliest re-send due among the entries not already being re-sent, or disarms it. */
	private arm(): void {
		let dueAt: number | undefined;
		for (const [actionId, entry] of this.entries) {
			if (this.inFlight.has(actionId)) continue;
			if (dueAt === undefined || entry.nextAttemptAt < dueAt) dueAt = entry.nextAttemptAt;
		}
		if (this.timer && (dueAt === undefined || this.timer.dueAt > dueAt)) {
			this.timer.cancel();
			this.timer = undefined;
		}
		if (dueAt === undefined || this.timer) return;
		this.timer = { cancel: this.setTimer(() => this.fire(), Math.max(0, dueAt - this.now())), dueAt };
	}

	private fire(): void {
		this.timer = undefined;
		const now = this.now();
		for (const [actionId, entry] of this.entries) {
			if (entry.nextAttemptAt <= now) void this.attemptOnce(actionId);
		}
		this.arm();
	}

	private backoffMs(attempts: number): number {
		return jitteredBackoffMs(attempts, RETRY_BACKOFF);
	}

	private evictOverflow(): void {
		while (this.entries.size > this.maxActions) {
			const [oldestId, oldest] = this.entries.entries().next().value as [ActionId, OwedEntry];
			this.entries.delete(oldestId);
			log('cancel:owed-evicted actionId=%s blocks=%o stoodMs=%d', oldestId, Array.from(oldest.blockIds), this.now() - oldest.since);
		}
	}
}
