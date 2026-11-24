/**
 * The durable record of which blocks this node has **released** — handed to other machines through a
 * confirmed handoff, and stopped serving — and whose local bytes it may therefore delete.
 *
 * It is the one gate on `IBlockStorage.deleteBlock`: a block's bytes are deleted only after a release
 * that confirmed at least the replication floor of other serving holders hold a current replica of it
 * (`docs/arachnode-ring-handoff.md` § Part 2). Two code paths may write an entry — a ring shift's
 * Phase C and the confirmed rebalance release — and **nothing else may**. In particular
 * {@link ReleasedBlockSweep} derives no eligibility of its own: a block that merely looks outside this
 * node's current slice may be one whose handoff rolled back, and is still being served.
 *
 * Durable for two reasons, and both matter. A restart must not lose the knowledge that bytes are free
 * to go — before this ledger the eligibility lived in a `Set<string>` in the node factory, so a node
 * that shed its way from ring 3 to ring 6 forgot which seven eighths of its data it had given away.
 * And an entry is what makes a half-finished delete resumable: `deleteBlock` is ordered and idempotent
 * (`packages/db-p2p/docs/storage.md` § Deleting a block) precisely so that the entry can be removed
 * *after* the delete rather than before.
 */

import type { ActionRev, BlockId } from '@optimystic/db-core';
import { KeyedSerialQueue } from '../keyed-serial-queue.js';
import { createLogger } from '../logger.js';
import type { IKVStore } from './i-kv-store.js';

const log = createLogger('storage:released');

/**
 * Key namespace: `optimystic-released/<blockId>` → JSON({@link ReleasedBlockEntry}). A fixed literal
 * first segment, as `OWED_BLOB_KEY_PREFIX` and `UNDER_REPLICATED_KEY_PREFIX` are and for the same
 * reason — see the NOTE on `FileKVStore.keyToPath` for the condition sharing a base path with block
 * storage would break under. Declared in `NODE_KV_NAMESPACES`
 * (`packages/db-p2p/src/storage/node-kv-namespaces.ts`), which is what keeps `listBlockIds` on such a
 * store from walking these keys as if they were block directories.
 *
 * A block id is used raw as the key's remainder, so an id with `/` in it nests exactly as it does in
 * the block store's own layout.
 */
export const RELEASED_BLOCK_KEY_PREFIX = 'optimystic-released/';

// NOTE: a block id is used raw in the key, and `FileKVStore.keyToPath` joins a key's segments onto its
// base path — so an id containing `..` segments would address a file outside this namespace, the class
// the backlog ticket `bug-a-block-id-is-used-as-a-file-path-without-validation` owns. No guard is added
// here on purpose: `FileBatchBackend.blockPath` already refuses such an id at the storage boundary, so
// a block with one cannot be stored, cannot be owned, and so cannot be released. Validate at that one
// boundary when the ticket lands rather than growing a second ad-hoc check here.

/** Which confirmed release wrote the entry — for an operator reading the ledger, and for the run log. */
export type ReleaseSource =
	/** Phase C of a ring shift: the node narrowed its range and shed this block with it. */
	| 'ring-shift'
	/** The confirmed rebalance release: this block's cohort moved on without this node. */
	| 'rebalance';

/** One block this node released and has not yet deleted. */
export type ReleasedBlockEntry = {
	readonly blockId: BlockId;
	/** Milliseconds since the epoch; {@link ReleasedBlockLedger.list} orders oldest first. */
	readonly releasedAt: number;
	readonly source: ReleaseSource;
	/**
	 * The committed revision this node held when it released the block. The sweep re-reads the block's
	 * `latest` under its write latch and declines to delete a block that has advanced past this, which
	 * is how a replica pushed back to this node between the release and the sweep survives: the node
	 * accepted it, so someone is using it again, and the entry is dropped instead of taken.
	 *
	 * Absent when the node held no committed revision at release (a block seeded by a pending record
	 * alone), and also when its metadata could not be read then — `StorageRepo.heldRevisions` leaves
	 * such a block out of its answer. Both read as "no revision was held", under which the sweep
	 * declines a block that holds one now.
	 */
	readonly releasedRev?: number;
	/**
	 * How many sweep runs have tried to delete this block and failed. Absent means none have. At
	 * {@link RELEASED_BLOCK_DELETE_ATTEMPTS} the sweep stops retrying it (see
	 * {@link hasExhaustedAttempts}); the entry stays, so an operator can still see that the block was
	 * released and not deleted.
	 */
	readonly attempts?: number;
};

/**
 * How many failed deletes one entry gets before the sweep leaves it alone. Three, the small explicit
 * bound `SlotHoldAfterLosses` is: a storage fault on one block must not make every later run retry it
 * at the head of the queue for ever, and nothing silently drops the entry — that would leak the bytes
 * *and* the record of them.
 */
export const RELEASED_BLOCK_DELETE_ATTEMPTS = 3;

/** Whether `entry` has used up its {@link RELEASED_BLOCK_DELETE_ATTEMPTS} and the sweep should pass over it. */
export function hasExhaustedAttempts(entry: ReleasedBlockEntry): boolean {
	return (entry.attempts ?? 0) >= RELEASED_BLOCK_DELETE_ATTEMPTS;
}

export type ReleasedBlockLedgerDeps = {
	/**
	 * What this node's metadata says each block's committed latest is — `StorageRepo.heldRevisions`
	 * (`IHeldRevisionReader`), read once per {@link ReleasedBlockLedger.record} call so an entry
	 * carries the revision the release happened at. Unlatched, as that reader is: a commit landing
	 * meanwhile only makes the recorded revision early, which makes the sweep decline the block rather
	 * than take it — the safe direction.
	 */
	readonly heldRevisions: (blockIds: BlockId[]) => Promise<Record<BlockId, ActionRev | null>>;
	/** Default `Date.now`. */
	readonly now?: () => number;
};

/**
 * The released-block ledger over the portable {@link IKVStore}, shaped after `OwedBlobLedger` so the
 * two read alike. One instance per store: it owns its key prefix.
 */
export class ReleasedBlockLedger {
	private readonly queue = new KeyedSerialQueue();
	private readonly heldRevisions: ReleasedBlockLedgerDeps['heldRevisions'];
	private readonly now: () => number;

	constructor(private readonly kv: IKVStore, deps: ReleasedBlockLedgerDeps) {
		this.heldRevisions = deps.heldRevisions;
		this.now = deps.now ?? Date.now;
	}

	/**
	 * Record every block of `blockIds` as released, and answer the entries written. **Only a release
	 * that followed a confirmation may call this** — see this module's header for why nothing else may.
	 *
	 * A block already in the ledger is **refreshed** rather than left: the release moment, the source
	 * and the held revision are rewritten and the attempt count starts again. Refreshing is what keeps
	 * a block that was pushed back and then released a second time sweepable — an entry still carrying
	 * the first release's revision would make the sweep decline it for ever — and it is what makes a
	 * double release idempotent.
	 *
	 * Durable before it resolves: the ledger exists so that a restart does not forget which bytes are
	 * free to go, so no call may report what a restart would forget.
	 */
	async record(blockIds: readonly BlockId[], source: ReleaseSource): Promise<ReleasedBlockEntry[]> {
		const ids = [...new Set(blockIds)];
		if (ids.length === 0) {
			return [];
		}
		// One read for the whole release rather than one per block: `heldRevisions` reads each block's
		// metadata and nothing more, and it already answers for a set.
		const held = await this.heldRevisions(ids);
		const releasedAt = this.now();
		const entries: ReleasedBlockEntry[] = [];
		// Sequential on purpose, as the other ledgers' scans are: one entry is one small file under
		// `FileKVStore`, and writing them all at once would trade a faster release for file-descriptor
		// exhaustion on a node shedding tens of thousands of blocks.
		for (const blockId of ids) {
			const entry = await this.queue.run(blockId, async () => {
				// Built field by field rather than spread over any existing entry, so that a refresh keeps
				// nothing from the previous release — `attempts` above all, which a fresh release resets.
				const stored: ReleasedBlockEntry = {
					blockId,
					releasedAt,
					source,
					...(held[blockId] ? { releasedRev: held[blockId]!.rev } : {})
				};
				await this.kv.set(keyFor(blockId), JSON.stringify(stored));
				return stored;
			});
			entries.push(entry);
		}
		await this.flushWrites();
		log('ledger:recorded source=%s blocks=%d', source, entries.length);
		return entries;
	}

	/**
	 * Every entry, oldest `releasedAt` first — which is the order the sweep deletes in, so a run that
	 * hits its per-run cap always makes progress on the oldest release.
	 *
	 * A full scan. Entries whose attempts are exhausted are included: they are what an operator looks
	 * for, and the sweep passes over them itself ({@link hasExhaustedAttempts}).
	 */
	async list(): Promise<ReleasedBlockEntry[]> {
		const keys = await this.kv.list(RELEASED_BLOCK_KEY_PREFIX);
		const entries: ReleasedBlockEntry[] = [];
		// Sequential for the reason the writes above are.
		for (const key of keys) {
			const blockId = key.slice(RELEASED_BLOCK_KEY_PREFIX.length);
			if (blockId === '') {
				// Nothing this class writes keys the bare prefix; a stray key there is not an entry, and
				// parsing it as one would make every scan — and so every sweep — carry it.
				log('entry:bad-key key=%s', key);
				continue;
			}
			const entry = await this.read(blockId);
			if (entry !== undefined) entries.push(entry);
		}
		return entries.sort((a, b) => a.releasedAt - b.releasedAt);
	}

	async get(blockId: BlockId): Promise<ReleasedBlockEntry | undefined> {
		return this.read(blockId);
	}

	/**
	 * Drop the entry; no entry is a no-op.
	 *
	 * Called **after** the delete it records, never before: a crash between the two leaves an entry for
	 * a block already (perhaps partly) deleted, and the next run's `deleteBlock` finishes it and drops
	 * the entry then. The reverse order would lose the knowledge that the bytes are free the moment a
	 * crash caught the delete half-done.
	 *
	 * Durable before it resolves, as {@link record} is: an entry a restart resurrects costs another
	 * pass over an already-deleted block, which is harmless but pointless.
	 */
	async remove(blockId: BlockId): Promise<void> {
		await this.queue.run(blockId, () => this.kv.delete(keyFor(blockId)));
		await this.flushWrites();
	}

	/**
	 * Count one failed delete against the entry and answer the attempts it now carries, or 0 when the
	 * entry is gone (deleted meanwhile — nothing is recreated).
	 *
	 * **Not flushed**, the one exception to this class's rule that every write is durable before it
	 * returns, and the exception `OwedBlobLedger.markUnlisted` already makes. The count bounds retries
	 * of a block whose delete keeps failing; a count a crash loses costs the next run three more
	 * attempts at one block, while flushing here would cost one store flush per failing entry in a run
	 * where storage is already faulting.
	 */
	async noteFailure(blockId: BlockId): Promise<number> {
		return this.queue.run(blockId, async () => {
			const existing = await this.read(blockId);
			if (existing === undefined) return 0;
			const attempts = (existing.attempts ?? 0) + 1;
			await this.kv.set(keyFor(blockId), JSON.stringify({ ...existing, attempts }));
			return attempts;
		});
	}

	/** `IKVStore.flush`, absent on a store whose writes are already as durable as they get. */
	private async flushWrites(): Promise<void> {
		await this.kv.flush?.();
	}

	private async read(blockId: BlockId): Promise<ReleasedBlockEntry | undefined> {
		const raw = await this.kv.get(keyFor(blockId));
		return raw === undefined ? undefined : parseEntry(blockId, raw);
	}
}

function keyFor(blockId: BlockId): string {
	return `${RELEASED_BLOCK_KEY_PREFIX}${blockId}`;
}

/**
 * An entry as stored, or `undefined` for one that is not a well-formed entry for `blockId`. Stored
 * bytes are this class's own output, but they outlive the process that wrote them, so they are checked
 * rather than cast. A malformed entry is logged and read as absent — never deleted by a read, and
 * never acted on: an entry nothing can interpret is not evidence that a release happened, and this is
 * the one record standing between a block's bytes and `deleteBlock`. The next release of the block
 * overwrites it.
 */
function parseEntry(blockId: BlockId, raw: string): ReleasedBlockEntry | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		log('read:malformed %o', { blockId, raw });
		return undefined;
	}
	if (!isEntryFor(blockId, value)) {
		log('read:malformed %o', { blockId, raw });
		return undefined;
	}
	return value;
}

function isEntryFor(blockId: BlockId, value: unknown): value is ReleasedBlockEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Record<string, unknown>;
	return entry.blockId === blockId
		&& typeof entry.releasedAt === 'number' && Number.isFinite(entry.releasedAt)
		&& (entry.source === 'ring-shift' || entry.source === 'rebalance')
		// Both optional fields decide something — the first whether the block is taken at all, the
		// second whether it is tried again — so neither is kept as found.
		&& (entry.releasedRev === undefined || (typeof entry.releasedRev === 'number' && Number.isFinite(entry.releasedRev)))
		&& (entry.attempts === undefined || (typeof entry.attempts === 'number' && Number.isFinite(entry.attempts)));
}
