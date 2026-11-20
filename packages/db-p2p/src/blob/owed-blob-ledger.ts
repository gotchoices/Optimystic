import { parseBlobRef, type BlobRef, type BlobScope } from '@optimystic/db-core';
import { KeyedSerialQueue } from '../keyed-serial-queue.js';
import { createLogger } from '../logger.js';
import type { IKVStore } from '../storage/i-kv-store.js';

const log = createLogger('blob:store');

/**
 * Key namespace: `owed-blobs/<ref>` → JSON(OwedBlobEntry). A fixed literal first segment, as
 * `UNDER_REPLICATED_KEY_PREFIX` is and for the same reason — see the NOTE on `FileKVStore.keyToPath`
 * for the condition sharing a base path with block storage would break under.
 */
export const OWED_BLOB_KEY_PREFIX = 'owed-blobs/';

/** One blob this node announced and whose cohort does not fully hold yet (docs/blobs.md §Placement, copying and durability). */
export type OwedBlobEntry = {
	readonly ref: BlobRef;
	/** The reference tree the receivers verify against. The latest `announce` replaces it; any listing scope authorizes. */
	readonly scope: BlobScope;
	/** Peers confirmed to hold the whole blob — answered `whole`, or sent `held` — by peer-id string, never this node. */
	readonly holders: readonly string[];
	/** Milliseconds since the epoch; `list` orders oldest first. */
	readonly recordedAt: number;
};

export type OwedBlobLedgerOptions = {
	/** Default Date.now. */
	now?: () => number;
};

/**
 * The durable half of "whose copy of this blob is still owed" (docs/blobs.md §Placement, copying and
 * durability, *Copying*), over the portable {@link IKVStore}, shaped after `KvUnderReplicationLedger`
 * so the two read alike.
 *
 * **The entry stores the holders, not the missing members.** The owed members are derived afresh from
 * the cohort on every pass (`owed = accepting cohort members − holders − this node`), which is how an
 * entry follows the cohort. A holder that leaves the cohort stays listed — a copy is a copy — and
 * simply stops counting, since durability is counted over current members.
 *
 * An in-memory index of the recorded refs sits beside the store, not authoritative, loaded lazily so
 * that `size` costs no scan. It is only as good as this instance's ownership of the key prefix, so one
 * instance per store.
 *
 * NOTE: no size cap, unlike the under-replication ledger's. Entries are bounded by the blobs this node
 * announced, and `feat-unreferenced-blobs-are-reclaimed` drops the entry of a blob whose scope stopped
 * listing it. If a deployment ever accumulates entries a reclaim pass does not clear, that pass is
 * what to look at before adding a cap here.
 */
export class OwedBlobLedger {
	private readonly queue = new KeyedSerialQueue();
	private readonly now: () => number;
	private indexLoad: Promise<Set<BlobRef>> | undefined;

	constructor(private readonly kv: IKVStore, options?: OwedBlobLedgerOptions) {
		this.now = options?.now ?? Date.now;
	}

	/** Create the entry, or replace an existing entry's scope keeping its holders and `recordedAt`. */
	async record(ref: BlobRef, scope: BlobScope): Promise<OwedBlobEntry> {
		const key = keyFor(ref);
		const entry = await this.queue.run(ref, async () => {
			const index = await this.index();
			const existing = await this.read(ref);
			const stored: OwedBlobEntry = existing === undefined
				? { ref, scope, holders: [], recordedAt: this.now() }
				: { ...existing, scope };
			await this.kv.set(key, JSON.stringify(stored));
			index.add(ref);
			return stored;
		});
		await this.flushWrites();
		return entry;
	}

	/** Add confirmed holders, each once; never creates an entry (an entry deleted meanwhile stays deleted). */
	async addHolders(ref: BlobRef, peerIds: readonly string[]): Promise<OwedBlobEntry | undefined> {
		const key = keyFor(ref);
		let wrote = false;
		const entry = await this.queue.run(ref, async () => {
			const existing = await this.read(ref);
			if (existing === undefined) return undefined;
			const held = new Set(existing.holders);
			const added = peerIds.filter(peerId => !held.has(peerId));
			if (added.length === 0) return existing;
			const stored: OwedBlobEntry = { ...existing, holders: [...existing.holders, ...new Set(added)] };
			await this.kv.set(key, JSON.stringify(stored));
			wrote = true;
			return stored;
		});
		if (wrote) await this.flushWrites();
		return entry;
	}

	async get(ref: BlobRef): Promise<OwedBlobEntry | undefined> {
		return this.read(ref);
	}

	/**
	 * Every entry, oldest `recordedAt` first. A full scan; the FIRST scan after start also becomes the
	 * index's load, so the drain's start pass warms it for free.
	 */
	async list(): Promise<OwedBlobEntry[]> {
		if (this.indexLoad === undefined) {
			const scan = this.scan();
			this.indexLoad = this.indexFrom(scan);
			return scan;
		}
		return this.scan();
	}

	/** Answered from the in-memory index after the first load. It exists so the drain's re-check decision costs no scan. */
	async size(): Promise<number> {
		return (await this.index()).size;
	}

	async delete(ref: BlobRef): Promise<void> {
		const key = keyFor(ref);
		await this.queue.run(ref, () => this.remove(ref, key));
		await this.flushWrites();
	}

	/**
	 * Make a public call's writes durable before it returns (`IKVStore.flush`, absent on a store whose
	 * writes are already as durable as they get). Once per call, after the ref's queue is released. The
	 * ledger exists so an owed copy outlives a restart, so no call may report what a restart would forget.
	 */
	private async flushWrites(): Promise<void> {
		await this.kv.flush?.();
	}

	/** Delete from the store and the index. Callers hold the ref's queue. */
	private async remove(ref: BlobRef, key: string): Promise<void> {
		const index = await this.index();
		await this.kv.delete(key);
		index.delete(ref);
	}

	private async scan(): Promise<OwedBlobEntry[]> {
		const keys = await this.kv.list(OWED_BLOB_KEY_PREFIX);
		const entries: OwedBlobEntry[] = [];
		// Sequential on purpose, as the under-replication ledger's scan is: one entry is one small file
		// under `FileKVStore`, and opening them all at once would trade a slower scan for
		// file-descriptor exhaustion.
		for (const key of keys) {
			const entry = await this.read(key.slice(OWED_BLOB_KEY_PREFIX.length) as BlobRef);
			if (entry !== undefined) entries.push(entry);
		}
		return entries.sort((a, b) => a.recordedAt - b.recordedAt);
	}

	/**
	 * The index of recorded refs, loaded once from the store. A failed load is not cached, so the next
	 * call retries it instead of the ledger failing for the life of the process.
	 */
	private index(): Promise<Set<BlobRef>> {
		if (this.indexLoad === undefined) {
			this.indexLoad = this.indexFrom(this.scan());
		}
		return this.indexLoad;
	}

	private indexFrom(scan: Promise<OwedBlobEntry[]>): Promise<Set<BlobRef>> {
		return scan
			.then(entries => new Set(entries.map(entry => entry.ref)))
			.catch((err: unknown) => {
				this.indexLoad = undefined;
				throw err;
			});
	}

	private async read(ref: BlobRef): Promise<OwedBlobEntry | undefined> {
		const raw = await this.kv.get(keyFor(ref));
		return raw === undefined ? undefined : parseEntry(ref, raw);
	}
}

/**
 * The entry key of `ref`, refusing a string that is not a canonical reference: a key `list` would then
 * skip, so nothing would ever read the entry written under it.
 */
function keyFor(ref: BlobRef): string {
	return `${OWED_BLOB_KEY_PREFIX}${parseBlobRef(ref)}`;
}

/**
 * An entry as stored, or `undefined` for one that is not a well-formed entry for `ref`. Stored bytes
 * are this class's own output, but they outlive the process that wrote them, so they are checked
 * rather than cast. A malformed entry is logged and read as absent — never deleted by a read — and the
 * next `record` for the ref overwrites it.
 */
function parseEntry(ref: BlobRef, raw: string): OwedBlobEntry | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		log('read:malformed %o', { ref, raw });
		return undefined;
	}
	if (!isEntryFor(ref, value)) {
		log('read:malformed %o', { ref, raw });
		return undefined;
	}
	return value;
}

function isEntryFor(ref: BlobRef, value: unknown): value is OwedBlobEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Record<string, unknown>;
	return entry.ref === ref
		&& typeof entry.scope === 'string' && entry.scope !== ''
		&& Array.isArray(entry.holders) && entry.holders.every(peerId => typeof peerId === 'string')
		&& typeof entry.recordedAt === 'number' && Number.isFinite(entry.recordedAt);
}
