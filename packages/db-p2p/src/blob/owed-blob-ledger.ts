import { isBlobRef, parseBlobRef, type BlobRef, type BlobScope } from '@optimystic/db-core';
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
	/**
	 * When the first counting reclaim pass that found this entry's scope no longer listing the blob
	 * started, ms since the epoch (docs/blobs.md §Lifetime). Every call that creates or re-records an
	 * entry drops it, because such a call is the writer saying the reference is live; `addHolders`
	 * keeps it.
	 */
	readonly unlistedSince?: number;
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

	/**
	 * Create the entry, or replace an existing entry's scope keeping its holders and `recordedAt` —
	 * and dropping `unlistedSince`, so the reclaim grace period starts again. An `announce` for a
	 * reference already owed is the writer saying the reference is live, which is why a re-record with
	 * the same scope clears the mark too.
	 */
	async record(ref: BlobRef, scope: BlobScope): Promise<OwedBlobEntry> {
		const key = keyFor(ref);
		const entry = await this.queue.run(ref, async () => {
			const index = await this.index();
			const existing = await this.read(ref);
			const stored: OwedBlobEntry = existing === undefined
				? { ref, scope, holders: [], recordedAt: this.now() }
				// Built field by field rather than spread, so that the four fields a re-record keeps are
				// stated and `unlistedSince` is dropped by construction. Not `{ ...existing, scope,
				// unlistedSince: undefined }`: this package has `exactOptionalPropertyTypes` off (backlog
				// `debt-tsconfig-exact-optional-property-types`), so that shape type-checks and then
				// leans on `JSON.stringify` discarding the property to be correct.
				: { ref, scope, holders: existing.holders, recordedAt: existing.recordedAt };
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
			// Spread, so `unlistedSince` survives: a peer confirming it holds a copy is not evidence that
			// any committed row references the blob, so it must not restart the reclaim grace period.
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
	 * Drop the reclaim mark; no entry, or no mark, is a no-op.
	 *
	 * **Flushed when it dropped one**, unlike {@link markUnlisted}: losing a mark and losing a clear
	 * are not equally cheap. A mark a crash loses the next pass makes again, costing a delay; a *clear*
	 * a crash loses leaves a mark already older than the grace period on an entry whose scope lists
	 * the blob again, so the first later pass that finds it unlisted drops the entry — and with it the
	 * `owed` hold — having given no grace period at all. Only the write that actually drops a mark
	 * flushes, once per entry per mark, so this keeps the class's rule for every write that changed
	 * something.
	 */
	async clearUnlisted(ref: BlobRef): Promise<void> {
		const key = keyFor(ref);
		const wrote = await this.queue.run(ref, async () => {
			const existing = await this.read(ref);
			if (existing === undefined || existing.unlistedSince === undefined) return false;
			await this.kv.set(key, JSON.stringify(withoutUnlistedSince(existing)));
			return true;
		});
		if (wrote) await this.flushWrites();
	}

	/**
	 * Set the reclaim mark to `at` while the entry exists; answers whether it wrote. Never creates an
	 * entry (an entry deleted meanwhile stays deleted).
	 *
	 * **Not flushed**, the one exception to this class's rule that every public write is durable before
	 * it returns. A mark is advisory in this direction: one a crash loses costs a delay of one grace
	 * period and never a lost copy, while flushing here would cost one store flush per entry in the
	 * pass that first marks them, thousands at once on a node whose scopes were all emptied together.
	 * What the rule exists for is unchanged — every call that creates or deletes an entry still
	 * flushes, because an entry a restart forgets is a copy nobody will ever send, and so does
	 * {@link clearUnlisted}.
	 */
	async markUnlisted(ref: BlobRef, at: number): Promise<boolean> {
		const key = keyFor(ref);
		return this.queue.run(ref, async () => {
			const existing = await this.read(ref);
			if (existing === undefined || existing.unlistedSince === at) return false;
			await this.kv.set(key, JSON.stringify({ ...existing, unlistedSince: at }));
			return true;
		});
	}

	/**
	 * Delete the entry, but only while its reclaim mark is still exactly `mark`; answers whether it
	 * wrote. An entry the drain deleted meanwhile reads as absent, so this answers `false` and the
	 * pass leaves the `owed` hold to the drain, which released it with the entry.
	 *
	 * **Flushed**, unlike {@link markUnlisted}. The pass deletes the entry and then releases the
	 * `owed` hold, in that order, because a crash between the two leaves a hold with no entry —
	 * storage kept, nothing lost — while the reverse leaves an entry whose drain announces a blob this
	 * node no longer holds. That ordering only holds if the delete is durable before the release
	 * writes, and `LocalBlobService.releaseOwed` flushes.
	 */
	async deleteIfUnlisted(ref: BlobRef, mark: number): Promise<boolean> {
		const key = keyFor(ref);
		const wrote = await this.queue.run(ref, async () => {
			const existing = await this.read(ref);
			if (existing?.unlistedSince !== mark) return false;
			await this.remove(ref, key);
			return true;
		});
		await this.flushWrites();
		return wrote;
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
			const suffix = key.slice(OWED_BLOB_KEY_PREFIX.length);
			// Skipped rather than parsed, as `BlobRecordStore.listRefs` skips a bad key: `read` would
			// throw BlobRefError on it, and one stray key under the prefix would then fail every scan —
			// so `list` and `size`, and with them every drain pass, for as long as the key is there.
			if (!isBlobRef(suffix)) {
				log('entry:bad-key key=%s', key);
				continue;
			}
			const entry = await this.read(suffix);
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
		const load = scan.then(entries => new Set(entries.map(entry => entry.ref)));
		// The stored chain carries its own handler, so a `list` whose caller handles the scan's failure
		// itself does not also leave this promise rejected with nobody listening.
		void load.catch(() => { this.indexLoad = undefined; });
		return load;
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
		&& typeof entry.recordedAt === 'number' && Number.isFinite(entry.recordedAt)
		// A mark nothing can interpret would decide a deletion, so it is checked beside `recordedAt`
		// rather than kept as found. Malformed means the whole entry is read as absent, never deleted
		// by a read — the rule above, unchanged — and the next `record` for the ref overwrites it.
		&& (entry.unlistedSince === undefined || (typeof entry.unlistedSince === 'number' && Number.isFinite(entry.unlistedSince)));
}

/** The entry without its reclaim mark: the property omitted, not set to `undefined`, so it encodes and compares as one that never carried it. */
function withoutUnlistedSince(entry: OwedBlobEntry): OwedBlobEntry {
	const { unlistedSince: _dropped, ...rest } = entry;
	return rest;
}
