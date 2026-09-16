import type { BlockId } from "@optimystic/db-core";
import type { IKVStore } from "../storage/i-kv-store.js";
import type { IUnderReplicationLedger, ShortfallQuorum, UnderReplicatedEntry } from "./i-under-replication-ledger.js";
import { createLogger } from "../logger.js";

const log = createLogger('under-replication-ledger');

/**
 * Key namespace: `under-replicated/<blockId>` → JSON(UnderReplicatedEntry). A fixed literal first
 * segment, which is what keeps this store safe to share a base path with `FileRawStorage` — see
 * the NOTE on `FileKVStore.keyToPath` for the condition sharing would break under.
 */
export const UNDER_REPLICATED_KEY_PREFIX = 'under-replicated/';

/**
 * The backstop cap. Generous on purpose: the drain's give-up counter is what retires entries, and
 * this only stops a node whose partner never returns from growing the ledger without limit.
 * NOTE: every entry is one small file under `FileKVStore` and one block id held in memory by the
 * eviction index; if a deployment ever sits at this cap, measure both before raising it.
 */
export const DEFAULT_UNDER_REPLICATION_MAX_ENTRIES = 100_000;

export type KvUnderReplicationLedgerOptions = {
	/** Hard cap on outstanding entries; the oldest-recorded entry is evicted beyond it. Default
	 *  {@link DEFAULT_UNDER_REPLICATION_MAX_ENTRIES}. Must be at least 1. */
	maxEntries?: number;
};

const SHORTFALL_QUORUMS: readonly ShortfallQuorum[] = ['majority', 'local', 'unrouted'];

/**
 * {@link IUnderReplicationLedger} over the portable {@link IKVStore}, the same shape
 * `PersistentTransactionStateStore` uses for its node-local state.
 *
 * Two pieces of in-memory state sit beside the store, neither authoritative:
 * - a per-block operation queue, so each read-compare-write is atomic against the others for the
 *   same block (`IKVStore` has no compare-and-set);
 * - an eviction index of recorded block ids in oldest-first order, loaded lazily from the store on
 *   the first mutation, so enforcing `maxEntries` costs neither a directory listing nor a read per
 *   record. It is only as good as this instance's ownership of the key prefix — the reason the
 *   interface scopes its guarantees to one instance per store.
 */
export class KvUnderReplicationLedger implements IUnderReplicationLedger {
	private readonly maxEntries: number;
	private readonly queues = new Map<BlockId, Promise<void>>();
	private indexLoad: Promise<Set<BlockId>> | undefined;

	constructor(private readonly kv: IKVStore, options?: KvUnderReplicationLedgerOptions) {
		const maxEntries = options?.maxEntries ?? DEFAULT_UNDER_REPLICATION_MAX_ENTRIES;
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new Error(`KvUnderReplicationLedger: maxEntries must be a positive integer, got ${maxEntries}`);
		}
		this.maxEntries = maxEntries;
	}

	async record(entry: UnderReplicatedEntry): Promise<void> {
		await this.serialized(entry.blockId, async () => {
			const index = await this.index();
			const existing = await this.read(entry.blockId);
			if (existing !== undefined && existing.rev > entry.rev) {
				log('record:skip-lower-rev %o', { blockId: entry.blockId, rev: entry.rev, recordedRev: existing.rev });
				return;
			}
			const sameShortfall = existing !== undefined && existing.rev === entry.rev;
			const stored: UnderReplicatedEntry = sameShortfall
				? { ...entry, recordedAt: existing.recordedAt, attempts: existing.attempts }
				: entry;
			await this.kv.set(keyFor(entry.blockId), JSON.stringify(stored));
			if (!sameShortfall) {
				// A new shortfall is the newest one: move it to the young end of the eviction order.
				index.delete(entry.blockId);
				index.add(entry.blockId);
			}
		});
		await this.evictBeyondCap();
	}

	async settle(blockId: BlockId, rev: number): Promise<void> {
		await this.serialized(blockId, async () => {
			// Every fully replicated commit settles each of its blocks, and almost none has an entry:
			// answer those from the index instead of a store read. An entry missing from the index is
			// one `read` would report absent anyway (malformed), so nothing is skipped that could be settled.
			const index = await this.index();
			if (!index.has(blockId)) return;
			const existing = await this.read(blockId);
			if (existing === undefined) return;
			if (existing.rev > rev) {
				log('settle:keep-higher-rev %o', { blockId, rev, recordedRev: existing.rev });
				return;
			}
			await this.remove(blockId);
		});
	}

	async get(blockId: BlockId): Promise<UnderReplicatedEntry | undefined> {
		return this.read(blockId);
	}

	async list(): Promise<UnderReplicatedEntry[]> {
		const keys = await this.kv.list(UNDER_REPLICATED_KEY_PREFIX);
		const entries: UnderReplicatedEntry[] = [];
		// Sequential on purpose: a ledger at its cap under `FileKVStore` is that many files, and
		// opening them all at once would trade a slower scan for file-descriptor exhaustion.
		for (const key of keys) {
			const entry = await this.read(key.slice(UNDER_REPLICATED_KEY_PREFIX.length) as BlockId);
			if (entry !== undefined) entries.push(entry);
		}
		return entries.sort((a, b) => a.recordedAt - b.recordedAt);
	}

	async satisfy(blockId: BlockId, peerIds: readonly string[]): Promise<UnderReplicatedEntry | undefined> {
		return this.serialized(blockId, async () => {
			const existing = await this.read(blockId);
			if (existing === undefined) return undefined;
			// Unknown is not empty: see `IUnderReplicationLedger.satisfy`.
			if (existing.missingPeerIds.length === 0) return existing;
			const confirmed = new Set(peerIds);
			const remaining = existing.missingPeerIds.filter(peerId => !confirmed.has(peerId));
			if (remaining.length === 0) {
				await this.remove(blockId);
				return undefined;
			}
			if (remaining.length === existing.missingPeerIds.length) return existing;
			const updated: UnderReplicatedEntry = { ...existing, missingPeerIds: remaining };
			await this.kv.set(keyFor(blockId), JSON.stringify(updated));
			return updated;
		});
	}

	async noteAttempt(blockId: BlockId): Promise<void> {
		await this.serialized(blockId, async () => {
			const existing = await this.read(blockId);
			if (existing === undefined) return;
			const updated: UnderReplicatedEntry = { ...existing, attempts: existing.attempts + 1 };
			await this.kv.set(keyFor(blockId), JSON.stringify(updated));
		});
	}

	async delete(blockId: BlockId): Promise<void> {
		await this.serialized(blockId, () => this.remove(blockId));
	}

	/** Delete from the store and the eviction index. Callers hold the block's queue. */
	private async remove(blockId: BlockId): Promise<void> {
		const index = await this.index();
		await this.kv.delete(keyFor(blockId));
		index.delete(blockId);
	}

	/**
	 * Evict oldest-recorded entries until the ledger is back within `maxEntries`. Runs AFTER the
	 * recording block's queue is released and takes each victim's own queue, so no call ever holds
	 * two blocks' queues at once and two recordings evicting each other cannot deadlock. A victim a
	 * concurrent operation already removed is skipped, and the loop re-measures, so concurrent
	 * recordings at the cap never evict more than the overflow.
	 *
	 * An eviction failure is logged and ends the pass rather than failing the recording that
	 * triggered it: that entry is already written, and the next recording tries again.
	 */
	private async evictBeyondCap(): Promise<void> {
		const index = await this.index();
		while (index.size > this.maxEntries) {
			const victim = index.values().next().value;
			if (victim === undefined) return;
			try {
				await this.serialized(victim, async () => {
					if (!index.has(victim)) return;
					await this.remove(victim);
					log('evict:over-cap %o', { blockId: victim, maxEntries: this.maxEntries });
				});
			} catch (err) {
				log.error('evict:failed %o', { blockId: victim, error: (err as Error).message });
				return;
			}
		}
	}

	/**
	 * The eviction index, loaded once from the store: every entry's block id, oldest `recordedAt`
	 * first. A failed load is not cached, so the next mutation retries it instead of the ledger
	 * failing every write for the life of the process.
	 */
	private index(): Promise<Set<BlockId>> {
		if (this.indexLoad === undefined) {
			this.indexLoad = this.list()
				.then(entries => new Set(entries.map(entry => entry.blockId)))
				.catch((err: unknown) => {
					this.indexLoad = undefined;
					throw err;
				});
		}
		return this.indexLoad;
	}

	private async read(blockId: BlockId): Promise<UnderReplicatedEntry | undefined> {
		const raw = await this.kv.get(keyFor(blockId));
		return raw === undefined ? undefined : parseEntry(blockId, raw);
	}

	/**
	 * Run `operation` after every earlier operation queued for `blockId`, whatever their outcome.
	 * The queue entry is dropped once nothing is waiting behind it, so the map holds only blocks with
	 * work in flight.
	 */
	private async serialized<T>(blockId: BlockId, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(blockId) ?? Promise.resolve();
		const run = previous.then(operation);
		const tail = run.then(() => undefined, () => undefined);
		this.queues.set(blockId, tail);
		try {
			return await run;
		} finally {
			if (this.queues.get(blockId) === tail) this.queues.delete(blockId);
		}
	}
}

function keyFor(blockId: BlockId): string {
	return `${UNDER_REPLICATED_KEY_PREFIX}${blockId}`;
}

/**
 * An entry as stored, or `undefined` for one that is not a well-formed entry for `blockId`. Stored
 * bytes are this class's own output, but they outlive the process that wrote them, so they are
 * checked rather than cast. A malformed entry is logged and read as absent — never deleted by a
 * read — and the next recording for the block overwrites it.
 */
function parseEntry(blockId: BlockId, raw: string): UnderReplicatedEntry | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (err) {
		log.error('read:unparseable %o', { blockId, error: (err as Error).message });
		return undefined;
	}
	if (!isEntryFor(blockId, value)) {
		log.error('read:malformed %o', { blockId, raw });
		return undefined;
	}
	return value;
}

function isEntryFor(blockId: BlockId, value: unknown): value is UnderReplicatedEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Record<string, unknown>;
	return entry.blockId === blockId
		&& Number.isInteger(entry.rev)
		&& typeof entry.actionId === 'string'
		&& SHORTFALL_QUORUMS.includes(entry.quorum as ShortfallQuorum)
		&& Array.isArray(entry.missingPeerIds) && entry.missingPeerIds.every(peerId => typeof peerId === 'string')
		&& typeof entry.recordedAt === 'number'
		&& Number.isInteger(entry.attempts);
}
