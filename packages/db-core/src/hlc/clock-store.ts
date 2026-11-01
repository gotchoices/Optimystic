import type { Hlc } from './hlc.js';

/**
 * Where an `HlcClock` keeps its high-water mark across restarts, so a node whose wall clock is
 * behind at restart does not issue an HLC below ones it issued before.
 *
 * A binding only stores and returns the value. When to save, and what to make of the loaded value,
 * is the clock's policy, so every binding behaves the same way: the clock saves on a jump and at
 * most once per {@link DEFAULT_HLC_PERSIST_INTERVAL_MS} otherwise, never awaits a save on its write
 * path, and resumes from {@link restartFloor}.
 */
export interface HlcClockStore {
	/** The mark last saved, or `undefined` when none was ever saved. */
	load(): Promise<Hlc | undefined>;
	/** Replace the mark. The clock has at most one call in flight; a rejection is logged by the clock and retried on its next qualifying advance. */
	save(hlc: Hlc): Promise<void>;
}

/**
 * How far `wallMs` must have moved past the last saved mark before the clock saves again: a node
 * issuing on its own wall clock writes at most once a second under load and nothing while idle,
 * while an observed HLC far ahead of local time moves it past this at once and is saved at once.
 * It is also the larger part of what {@link DEFAULT_HLC_RESTART_SLACK_MS} has to cover.
 */
export const DEFAULT_HLC_PERSIST_INTERVAL_MS = 1000;

/**
 * How far above the stored mark a restarted clock resumes when its local clock has not already
 * passed that point. It covers the HLCs issued after the stored mark: at most
 * {@link DEFAULT_HLC_PERSIST_INTERVAL_MS} of wall time before the next save, plus whatever the
 * binding's store had not yet made durable when the process stopped.
 *
 * The second part, for a db-p2p node: the clock never flushes, so its mark is durable once some
 * flush of the store covers it. The longest any of a node's stores may defer that is the relaxed
 * flush window's cap, `maxWindowMs`, 5000 ms by default (`resolveDurabilityWindowPolicy` in
 * `packages/db-p2p/src/storage/durability-window.ts`, packages/db-p2p/docs/storage.md §6); a write
 * no flush covers is synced by the write group's idle timer, one second after it. So at the defaults
 * the durable mark trails what the clock issued by at most 1000 + 5000 = 6000 ms, and 10 s leaves
 * 4 s of margin. A deployment that raises `maxWindowMs` past 9 s should raise this with it
 * (`HlcClockStartOptions.restartSlackMs`).
 *
 * In the ordinary case a real restart takes longer than this and the local clock wins, so the floor
 * costs nothing; it matters for a fast restart or a clock that went backwards, where the node's HLCs
 * then sit up to this far ahead of its wall clock until wall time catches up.
 *
 * NOTE: the slack covers an unsaved stretch only while the mark tracked wall time. A mark that
 * jumped — to an observed HLC far ahead, or to the restart floor itself — is saved at once but not
 * flushed, so a crash inside the store's durability window loses the jump, and the next start can
 * issue HLCs at or below ones the lost run issued (a crash loop faster than that window repeats one
 * floor). Harmless while HLCs are observational (Stage 1 of docs/crdt-sync.md); once anything orders
 * by them, the save after a jump must be durable before the clock issues past it.
 *
 * NOTE: the floor is saved, so each restart that comes faster than the slack resumes a further
 * slack above the last one: a crash loop restarting every few seconds moves the node's HLCs ahead
 * of its wall clock by about the slack less the restart interval, per restart, without bound. Fine
 * while HLCs are observational; if HLCs start deciding order (Stage 2), a remedy is to wait out the
 * floor at start rather than resume above it.
 */
export const DEFAULT_HLC_RESTART_SLACK_MS = 10_000;

/**
 * The HLC a clock restarted over `stored` treats as already observed: `slackMs` above the stored
 * `wallMs`, logical 0, in this node's name. The clock only ever raises its mark, so a local clock
 * already past this point simply wins.
 */
export function restartFloor(stored: Hlc, slackMs: number, nodeId: string): Hlc {
	return { wallMs: stored.wallMs + slackMs, logical: 0, nodeId };
}
