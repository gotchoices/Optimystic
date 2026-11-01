import type { Hlc, HlcClockStore } from "@optimystic/db-core";
import type { IKVStore } from "./i-kv-store.js";

/**
 * Key namespace of the node's HLC state in its `IKVStore`. A fixed literal first segment, listed in
 * `NODE_KV_NAMESPACES`, so a file-backed store sharing a base path with block storage never reads it
 * as a block.
 */
export const HLC_CLOCK_KEY_PREFIX = 'hlc/';

/** Where the node's clock keeps its high-water mark: the JSON of one `Hlc`. */
export const HLC_HIGH_WATER_KEY = `${HLC_CLOCK_KEY_PREFIX}high-water`;

/**
 * {@link HlcClockStore} over the node's portable key-value store, the one the under-replication ledger
 * uses. It only stores and returns the mark. Judging what it returns is `HlcClock.start`'s job: a
 * value without the shape of an HLC is logged and the clock starts from the local clock, which is
 * also what an unparseable record comes to, as a rejected `load`. Hence the unchecked cast below.
 *
 * The save is never flushed, unlike the ledger's `beforeRecord`, on purpose: the clock saves
 * fire-and-forget off its write path, and a mark the store had not made durable when the process
 * stopped is what the restart slack covers (`DEFAULT_HLC_RESTART_SLACK_MS` in
 * `packages/db-core/src/hlc/clock-store.ts` derives the slack from this store's longest flush window).
 */
export class KvHlcClockStore implements HlcClockStore {
	constructor(private readonly kv: IKVStore) {}

	async load(): Promise<Hlc | undefined> {
		const raw = await this.kv.get(HLC_HIGH_WATER_KEY);
		return raw === undefined ? undefined : JSON.parse(raw) as Hlc;
	}

	async save(hlc: Hlc): Promise<void> {
		await this.kv.set(HLC_HIGH_WATER_KEY, JSON.stringify(hlc));
	}
}
