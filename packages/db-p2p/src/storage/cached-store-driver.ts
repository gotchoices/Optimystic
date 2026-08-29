import type { BlockId, ActionId } from "@optimystic/db-core";
import type { RawStoreDriver } from "./raw-store-driver.js";
import type { StoreIdentity } from "./store-identity.js";
import {
	defaultCachePool,
	SharedCachePool,
	CacheStoreHandle,
	type CacheEntryClass,
	type PoolEntry,
	type PoolEntryOwner,
} from "./shared-cache-pool.js";

/**
 * A cached value at the byte layer. `null` records a PROVEN absence — a confirmed miss read
 * through this wrapper, or a delete that went through it. A plain map miss (`undefined`)
 * means "unknown": the wrapper has never observed this key, so the inner driver must be
 * consulted. The distinction is load-bearing for the absence/unavailability logic one layer
 * up: a cached `null` may only ever mean "provably absent", never "could not confirm".
 */
type CachedBytes = Uint8Array | null;

/**
 * Inclusive integer interval `[lo, hi]`. Distinct from `RevisionRange` (inclusive-exclusive,
 * open-ended) on purpose: coverage tracking wants closed integer intervals with adjacency
 * merging, and reusing the metadata range type here would invite confusing the two.
 */
type CoveredInterval = [lo: number, hi: number];

/** True when `[lo, hi]` is entirely inside one covered interval. `covered` is sorted and disjoint. */
function coversRange(covered: CoveredInterval[], lo: number, hi: number): boolean {
	for (const [a, b] of covered) {
		if (lo >= a && hi <= b) return true;
		if (a > lo) break;
	}
	return false;
}

/**
 * Add `[lo, hi]` to the sorted disjoint interval list, merging overlaps AND integer
 * adjacency (`[1,3]` + `[4,6]` → `[1,6]`), so contiguous point coverage from successive
 * `putRevision` calls collapses into one interval instead of accumulating per-rev entries.
 */
function addCovered(covered: CoveredInterval[], lo: number, hi: number): CoveredInterval[] {
	const merged: CoveredInterval[] = [];
	let newLo = lo;
	let newHi = hi;
	let inserted = false;
	for (const [a, b] of covered) {
		if (b < newLo - 1) {
			merged.push([a, b]);
		} else if (a > newHi + 1) {
			if (!inserted) {
				merged.push([newLo, newHi]);
				inserted = true;
			}
			merged.push([a, b]);
		} else {
			newLo = Math.min(newLo, a);
			newHi = Math.max(newHi, b);
		}
	}
	if (!inserted) {
		merged.push([newLo, newHi]);
	}
	return merged;
}

/**
 * Per-block revision map: point values plus the intervals over which the cache's knowledge
 * is COMPLETE. A rev inside `covered` with no `byRev` entry is provably absent; a rev
 * outside `covered` is unknown. `gen` increments on every mutation so an in-flight
 * enumeration can detect that a write landed during its inner drain and decline to claim
 * coverage it can no longer prove.
 */
interface RevMapState {
	byRev: Map<number, Uint8Array>;
	covered: CoveredInterval[];
	gen: number;
}

/**
 * Per-block pending-id set. `complete` is true only when the set is known to equal the
 * inner driver's set — either seeded by one full enumeration, or maintained from that point
 * by the funnelled writes. The flag lives INSIDE the same entry as the set it describes, so
 * dropping the entry (clear / write-error invalidation / POOL EVICTION) can never strand a
 * half-true completeness claim — an evicted list takes its flag with it, and a fresh entry
 * starts incomplete. `gen` serves the same in-flight-enumeration guard as {@link RevMapState}.
 */
interface PendListState {
	ids: Set<ActionId>;
	complete: boolean;
	gen: number;
}

/**
 * All cached state for one block. Every field holds (or maps to) a {@link PoolEntry} — the
 * value lives ON the pool entry, so residency, byte accounting and eviction are the shared
 * pool's problem while coherence stays here. Entry classes are keyed in the pool as
 * `(storeId, class, key…)`; block ids alone are NOT globally unique (header block ids are
 * name-derived, so two stores running the same schema collide), which is why the store id
 * leads the key.
 */
interface BlockCacheState {
	meta?: PoolEntry<CachedBytes>;
	revs?: PoolEntry<RevMapState>;
	pendList?: PoolEntry<PendListState>;
	pending: Map<ActionId, PoolEntry<CachedBytes>>;
	transactions: Map<ActionId, PoolEntry<CachedBytes>>;
	materialized: Map<ActionId, PoolEntry<CachedBytes>>;
}

/** Approximate bytes for JS-object bookkeeping, charged so tiny/negative entries are not free. */
const CHAR_BYTES = 2;
/** Fixed cost of one pool entry: entry object + owner map slot + queue map slot (key string charged separately). */
const ENTRY_BASE = 256;
/** Per-revision cost inside a revision map: map slot + boxed rev + Uint8Array header. */
const REV_SLOT = 56;
/** Per-interval cost of the coverage list. */
const INTERVAL_SLOT = 56;
/** Per-id cost inside a pending-id set (id characters charged separately). */
const ID_SLOT = 40;

function idsContent(ids: Set<ActionId>): number {
	let sum = 0;
	for (const id of ids) sum += ID_SLOT + id.length * CHAR_BYTES;
	return sum;
}

/**
 * Write-through coherent cache over any {@link RawStoreDriver}, bounded by a shared
 * {@link SharedCachePool}. Wrap a backend's driver with this before handing it to
 * `KvRawStorage` and every read the kernel issues is served from memory while the entry
 * stays resident in the pool — the pool's 2Q admission keeps hot per-store entries
 * protected while one-off bulk scans die in probation (see the pool's class doc).
 *
 * **Coherence, not eviction policy.** Every save stores its value INTO the cache as it writes
 * the inner driver, rather than invalidating. The cache therefore always holds the last
 * durable value for resident entries and never needs to re-read a key it has seen while that
 * entry survives. This is what a plain invalidate-on-write memo cannot achieve at this seam:
 * the hot reads exist to observe the writes, so invalidation lands between nearly every read
 * pair (measured: only a 23% cut).
 *
 * **Why this is sound** — the invariants in `packages/db-p2p/docs/storage.md` ("Invariants", 1–5):
 * 1. every backend write funnels through `IRawStorage` (and thus this driver) in-process, so
 *    the cache sees every mutation;
 * 2. every writer of the metadata blob holds the block write latch, and each cache update is
 *    synchronous with its inner write (no `await` between the inner call resolving and the
 *    cache mutation), so latch-protected read-after-write sees the new value exactly as a
 *    driver read would;
 * 3. committed revisions and materializations are append-only.
 *
 * **Precondition: one process owns the store** (Invariant 5). A second process writing the
 * same backend bypasses this wrapper and makes cached values stale in ways that feed
 * consensus decisions. Not enforced in code — see `packages/db-p2p/docs/storage.md`.
 *
 * **The cache is always clean, never dirty.** No write is deferred, reordered, or coalesced;
 * the inner driver's durable state never depends on cache contents. Eviction of ANY entry at
 * ANY instant is therefore correct — the next read falls through — which is precisely what
 * lets the shared pool evict freely, without pins, dirty tracking, or an exhaustion error.
 * Keep it that way: if a change here ever needs a dirty or pinned entry, the design has gone
 * wrong — stop and reconsider.
 *
 * **Pool discipline** (the one rule new code here must follow): mutate this wrapper's own
 * state FIRST, then make the pool call (`admit`/`updated`/`touch`/`drop`) LAST, and never
 * touch cache state after the pool call — pool mutations can synchronously evict any entry,
 * including the one just written. The eviction callback ({@link onPoolEvict}) removes only
 * the wrapper's reference and never calls back into the pool.
 *
 * **Values are cached as bytes**, exactly the encoded value the kernel wrote or the driver
 * returned. The kernel decodes fresh objects from those bytes on every read, so the
 * clone-on-read/clone-on-write discipline stays structural (same argument as the codec
 * boundary itself), and an entry's byte size feeds the pool's budget directly.
 * NOTE: every cache hit still pays one JSON.parse in the kernel; if decode ever shows up hot
 * on large materialized blocks, cache decoded objects plus an explicit clone instead.
 *
 * **Proofs are a passthrough, not a cached store.** The proofs store is read only on repair
 * and archive-serving paths; see the NOTE at {@link getProof}.
 *
 * **Do not wrap `MemoryStoreDriver`.** The memory driver already holds the same byte
 * references in maps; wrapping it duplicates every map entry (the bytes themselves are
 * shared, so no byte copy — but the bookkeeping is pure overhead with nothing to save).
 */
export class CachedStoreDriver implements RawStoreDriver, PoolEntryOwner {
	private readonly blocks = new Map<BlockId, BlockCacheState>();
	private readonly store: CacheStoreHandle;

	/**
	 * Optional passthroughs are wired only when the inner driver provides them, mirroring
	 * `KvRawStorage`'s constructor: feature-detection above this wrapper must observe the
	 * inner driver's true capability. `listBlockIds` deliberately bypasses the cache — it
	 * enumerates the inner metadata keyspace, which funnelled writes keep authoritative.
	 * `close` is the deliberate exception (a real method below): releasing the store's pool
	 * registration is THIS wrapper's own capability, needed whether or not the inner driver
	 * has anything to close. `storeIdentity` passes through unchanged — a cache names the SAME
	 * store as the driver it fronts; it is not a store of its own.
	 */
	listBlockIds?: () => AsyncIterable<BlockId>;
	approximateBytesUsed?: () => Promise<number>;
	storeIdentity?: () => StoreIdentity;

	constructor(
		private readonly inner: RawStoreDriver,
		private readonly pool: SharedCachePool = defaultCachePool(),
		label?: string,
	) {
		this.store = pool.registerStore(label);
		if (inner.storeIdentity) {
			this.storeIdentity = () => inner.storeIdentity!();
		}
		if (inner.listBlockIds) {
			this.listBlockIds = () => inner.listBlockIds!();
		}
		if (inner.approximateBytesUsed) {
			this.approximateBytesUsed = () => inner.approximateBytesUsed!();
		}
	}

	/**
	 * Drop every cached entry (releasing their pool residency) and this store's ghost keys —
	 * pre-clear recency must not fast-track post-clear refills into the protected queue.
	 * Always safe (the cache is clean — see class doc); the next read of each key re-consults
	 * the inner driver. In-flight enumerations notice the identity change of their entry
	 * objects and decline to claim completeness.
	 */
	clear(): void {
		for (const s of this.blocks.values()) {
			if (s.meta) this.pool.drop(s.meta);
			if (s.revs) this.pool.drop(s.revs);
			if (s.pendList) this.pool.drop(s.pendList);
			for (const e of s.pending.values()) this.pool.drop(e);
			for (const e of s.transactions.values()) this.pool.drop(e);
			for (const e of s.materialized.values()) this.pool.drop(e);
		}
		this.blocks.clear();
		this.pool.purgeGhosts(this.store);
	}

	/**
	 * Release this store entirely: drop all entries, unregister from the pool (the store id
	 * is never reused), and close the inner driver if it can be closed. A departed workspace
	 * that skips this leaks only cold entries the pool will evict under pressure — but call
	 * it; on a long-lived provider node the polite release is what keeps occupancy honest.
	 */
	async close(): Promise<void> {
		this.clear();
		this.pool.unregisterStore(this.store);
		await this.inner.close?.();
	}

	/** This store's live pool occupancy; pool-wide numbers come from `SharedCachePool.stats()`. */
	storeStats(): { id: string; label: string | undefined; bytes: number; entries: number } {
		return { id: this.store.id, label: this.store.label, bytes: this.store.bytes, entries: this.store.entries };
	}

	/**
	 * Pool eviction callback: remove OUR reference to the entry (identity-checked, so a stale
	 * callback can never delete a successor) and reap the block state if that emptied it.
	 * Runs synchronously inside a pool mutation — must not call back into the pool.
	 */
	onPoolEvict(entry: PoolEntry): void {
		const s = this.blocks.get(entry.blockId);
		if (s === undefined) return;
		switch (entry.cls) {
			case 'meta': if (s.meta === entry) s.meta = undefined; break;
			case 'revs': if (s.revs === entry) s.revs = undefined; break;
			case 'pendList': if (s.pendList === entry) s.pendList = undefined; break;
			case 'pending': evictFromMap(s.pending, entry); break;
			case 'tx': evictFromMap(s.transactions, entry); break;
			case 'mat': evictFromMap(s.materialized, entry); break;
		}
		this.dropIfEmpty(entry.blockId, s);
	}

	/**
	 * NOTE: this allocates an entry for EVERY block id touched, including ids that turn out
	 * not to exist (the proven-absent negative is the point). The shared pool charges those
	 * negatives — and the bare bookkeeping of empty container entries — against its budget
	 * (`ENTRY_BASE` + key), and {@link dropIfEmpty} reaps block states whose last entry is
	 * gone, so a remote peer streaming probes for nonexistent blocks (`StorageRepo.get` is
	 * reachable with an arbitrary block-id list) churns the probation queue instead of
	 * growing this map without bound.
	 */
	private state(blockId: BlockId): BlockCacheState {
		let s = this.blocks.get(blockId);
		if (!s) {
			s = { pending: new Map(), transactions: new Map(), materialized: new Map() };
			this.blocks.set(blockId, s);
		}
		return s;
	}

	/** Reap a block state holding no entries, so evictions and declined fills leave nothing behind. */
	private dropIfEmpty(blockId: BlockId, s: BlockCacheState): void {
		if (s.meta === undefined && s.revs === undefined && s.pendList === undefined
			&& s.pending.size === 0 && s.transactions.size === 0 && s.materialized.size === 0
			&& this.blocks.get(blockId) === s) {
			this.blocks.delete(blockId);
		}
	}

	/**
	 * An inner read threw after {@link state} allocated: reap the (uncharged) empty state so
	 * a stream of probes against a throwing backend cannot grow `blocks` for free.
	 */
	private reapOnThrow(blockId: BlockId, started: BlockCacheState): void {
		if (this.blocks.get(blockId) === started) this.dropIfEmpty(blockId, started);
	}

	/**
	 * Install or update a point entry (meta / pending / tx / mat) as the LAST step of a write
	 * or read-miss fill. Handles the pool's large-value bypass: an over-limit value is not
	 * cached, and an existing entry growing over the limit is dropped to unknown (holding the
	 * stale prior value would be wrong; holding the oversized one would defeat the bypass).
	 */
	private cachePoint(
		blockId: BlockId,
		s: BlockCacheState,
		cls: CacheEntryClass,
		actionId: ActionId | undefined,
		bytes: CachedBytes,
		existing: PoolEntry<CachedBytes> | undefined,
		attach: (e: PoolEntry<CachedBytes>) => void,
		detach: () => void,
	): void {
		const len = bytes === null ? 0 : bytes.length;
		if (existing !== undefined) {
			const charge = existing.base + len;
			if (!this.pool.admits(charge)) {
				detach();
				this.pool.drop(existing);
				this.dropIfEmpty(blockId, s);
				return;
			}
			existing.value = bytes;
			this.pool.updated(existing, charge);
			return;
		}
		const key = this.pool.keyFor(this.store, cls, blockId, actionId);
		const base = ENTRY_BASE + key.length * CHAR_BYTES;
		if (!this.pool.admits(base + len)) {
			this.dropIfEmpty(blockId, s);
			return;
		}
		const entry: PoolEntry<CachedBytes> = {
			key, store: this.store, owner: this, cls, blockId, actionId,
			value: bytes, base, charge: base + len, where: 'none',
		};
		attach(entry);
		this.pool.admit(entry);
	}

	/**
	 * Cache a read-miss result into one of the map-backed entry classes, under BOTH fill
	 * guards. `started` is the state object the read began on:
	 *
	 * - **value guard** — fill only while the entry is still unknown, so a newer funnelled
	 *   write that landed during the inner read is not clobbered by this older value;
	 * - **identity guard** — decline entirely if `clear()` (or the empty-state reaper)
	 *   swapped the state object during the inner read. Without it a resumed read reinstalls
	 *   its pre-clear value into the fresh state, and the newer write that superseded it went
	 *   out with the old state — so the stale value would then be served forever. The
	 *   revision and pending-list paths make the same identity check against their own pool
	 *   entries.
	 */
	private fillMiss(
		blockId: BlockId,
		started: BlockCacheState,
		map: Map<ActionId, PoolEntry<CachedBytes>>,
		cls: CacheEntryClass,
		actionId: ActionId,
		bytes: Uint8Array | undefined
	): void {
		// `blocks.get`, not `state()` — a declined fill must not resurrect the block entry.
		if (this.blocks.get(blockId) !== started) return;
		if (map.get(actionId) !== undefined) return;
		this.cachePoint(blockId, started, cls, actionId, bytes ?? null, undefined,
			e => map.set(actionId, e), () => map.delete(actionId));
	}

	// --- metadata ---

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		const s = this.state(blockId);
		const hit = s.meta;
		if (hit !== undefined) {
			this.pool.touch(hit);
			return hit.value ?? undefined;
		}
		let bytes: Uint8Array | undefined;
		try {
			bytes = await this.inner.getMetadata(blockId);
		} catch (err) {
			this.reapOnThrow(blockId, s);
			throw err;
		}
		// Same two fill guards as {@link fillMiss} (value + state identity), spelled out here
		// because metadata is a property rather than a map entry. Caching the miss (`null`) is
		// deliberate: everything that creates metadata funnels through this wrapper, so a
		// confirmed miss stays provably absent until a funnelled write overwrites it —
		// repeated probes of not-yet-created blocks are a real cold-start pattern.
		if (this.blocks.get(blockId) === s && s.meta === undefined) {
			this.cachePoint(blockId, s, 'meta', undefined, bytes ?? null, undefined,
				e => { s.meta = e; }, () => { s.meta = undefined; });
		}
		return bytes;
	}

	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putMetadata(blockId, value);
		} catch (err) {
			// The inner write failed with the backend in an unknown state — drop to unknown so
			// the next read consults the driver. Same recovery shape on every write path below.
			const s = this.blocks.get(blockId);
			const m = s?.meta;
			if (s !== undefined && m !== undefined) {
				s.meta = undefined;
				this.pool.drop(m);
				this.dropIfEmpty(blockId, s);
			}
			throw err;
		}
		const s = this.state(blockId);
		this.cachePoint(blockId, s, 'meta', undefined, value, s.meta,
			e => { s.meta = e; }, () => { s.meta = undefined; });
	}

	// --- revisions ---

	/**
	 * Get or eagerly admit the block's revision-map entry. Eager (before any inner await) so
	 * the fill guards have a stable identity to check across the await; the empty container
	 * is charged its base cost, so probe streams pay for their bookkeeping. Returns
	 * `undefined` when the pool bypasses even the base charge (absurdly small budget) — the
	 * callers then pass straight through to the inner driver, uncached.
	 */
	private ensureRevs(blockId: BlockId): PoolEntry<RevMapState> | undefined {
		const s = this.state(blockId);
		if (s.revs !== undefined) return s.revs;
		const key = this.pool.keyFor(this.store, 'revs', blockId);
		const base = ENTRY_BASE + key.length * CHAR_BYTES;
		if (!this.pool.admits(base)) {
			this.dropIfEmpty(blockId, s);
			return undefined;
		}
		const entry: PoolEntry<RevMapState> = {
			key, store: this.store, owner: this, cls: 'revs', blockId, actionId: undefined,
			value: { byRev: new Map(), covered: [], gen: 0 }, base, charge: base, where: 'none',
		};
		s.revs = entry;
		this.pool.admit(entry);
		return entry;
	}

	async getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		const entry = this.ensureRevs(blockId);
		if (entry === undefined) return this.inner.getRevision(blockId, rev);
		const revs = entry.value;
		if (coversRange(revs.covered, rev, rev)) {
			this.pool.touch(entry);
			return revs.byRev.get(rev);
		}
		const bytes = await this.inner.getRevision(blockId, rev);
		const current = this.blocks.get(blockId)?.revs;
		if (current === entry && !coversRange(revs.covered, rev, rev)) {
			let charge = entry.charge;
			if (bytes !== undefined) {
				revs.byRev.set(rev, bytes);
				charge += REV_SLOT + bytes.length;
			}
			const before = revs.covered.length;
			revs.covered = addCovered(revs.covered, rev, rev);
			charge += (revs.covered.length - before) * INTERVAL_SLOT;
			this.pool.updated(entry, charge);
		}
		return bytes;
	}

	async putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putRevision(blockId, rev, value);
		} catch (err) {
			const s = this.blocks.get(blockId);
			const entry = s?.revs;
			if (s !== undefined && entry !== undefined) {
				s.revs = undefined;
				this.pool.drop(entry);
				this.dropIfEmpty(blockId, s);
			}
			throw err;
		}
		const entry = this.ensureRevs(blockId);
		if (entry === undefined) return;
		const revs = entry.value;
		const had = revs.byRev.get(rev);
		revs.byRev.set(rev, value);
		let charge = entry.charge + (had !== undefined ? value.length - had.length : REV_SLOT + value.length);
		const before = revs.covered.length;
		revs.covered = addCovered(revs.covered, rev, rev);
		charge += (revs.covered.length - before) * INTERVAL_SLOT;
		revs.gen++;
		this.pool.updated(entry, charge);
	}

	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]> {
		const entry = this.ensureRevs(blockId);
		if (entry === undefined) {
			const drained: [number, Uint8Array][] = [];
			for await (const item of this.inner.rangeRevisions(blockId, lo, hi, reverse)) {
				drained.push(item);
			}
			yield* drained;
			return;
		}
		const revs = entry.value;
		if (coversRange(revs.covered, lo, hi)) {
			this.pool.touch(entry);
			// Snapshot before yielding (drain-before-yield): concurrent writes during the
			// consumer's awaits must not mutate what this iteration yields.
			// NOTE: this walks every integer in [lo, hi], not just the present revs — fine
			// while revisions are dense (one per commit) and callers bound `hi` by a real
			// `latest.rev`. If a sparse or very wide range ever appears here, iterate
			// `byRev`'s keys sorted instead.
			const out: [number, Uint8Array][] = [];
			if (reverse) {
				for (let rev = hi; rev >= lo; rev--) {
					const bytes = revs.byRev.get(rev);
					if (bytes !== undefined) out.push([rev, bytes]);
				}
			} else {
				for (let rev = lo; rev <= hi; rev++) {
					const bytes = revs.byRev.get(rev);
					if (bytes !== undefined) out.push([rev, bytes]);
				}
			}
			yield* out;
			return;
		}
		const gen = revs.gen;
		const drained: [number, Uint8Array][] = [];
		for await (const item of this.inner.rangeRevisions(blockId, lo, hi, reverse)) {
			drained.push(item);
		}
		// Claim coverage of [lo, hi] only if nothing mutated the map during the drain (gen
		// unchanged, same entry — clear() and pool eviction both swap the entry). A write that
		// landed mid-drain may be missing from `drained`, and recording coverage anyway would
		// turn that miss into a provably-wrong "rev absent" answer forever after.
		const current = this.blocks.get(blockId)?.revs;
		if (current === entry && revs.gen === gen) {
			let charge = entry.charge;
			for (const [rev, bytes] of drained) {
				const had = revs.byRev.get(rev);
				revs.byRev.set(rev, bytes);
				charge += had !== undefined ? bytes.length - had.length : REV_SLOT + bytes.length;
			}
			const before = revs.covered.length;
			revs.covered = addCovered(revs.covered, lo, hi);
			charge += (revs.covered.length - before) * INTERVAL_SLOT;
			this.pool.updated(entry, charge);
		}
		yield* drained;
	}

	// --- pending ---

	/** Same eager-admission shape (and bypass fallback) as {@link ensureRevs}, for the pending-id set. */
	private ensurePendList(blockId: BlockId): PoolEntry<PendListState> | undefined {
		const s = this.state(blockId);
		if (s.pendList !== undefined) return s.pendList;
		const key = this.pool.keyFor(this.store, 'pendList', blockId);
		const base = ENTRY_BASE + key.length * CHAR_BYTES;
		if (!this.pool.admits(base)) {
			this.dropIfEmpty(blockId, s);
			return undefined;
		}
		const entry: PoolEntry<PendListState> = {
			key, store: this.store, owner: this, cls: 'pendList', blockId, actionId: undefined,
			value: { ids: new Set(), complete: false, gen: 0 }, base, charge: base, where: 'none',
		};
		s.pendList = entry;
		this.pool.admit(entry);
		return entry;
	}

	/** Mirror a funnelled pend into the id set, if one is resident. Re-reads the entry — the write that preceded this call may have evicted it. */
	private notePendListAdd(blockId: BlockId, actionId: ActionId): void {
		const entry = this.blocks.get(blockId)?.pendList;
		if (entry === undefined) return;
		const list = entry.value;
		let charge = entry.charge;
		if (!list.ids.has(actionId)) {
			list.ids.add(actionId);
			charge += ID_SLOT + actionId.length * CHAR_BYTES;
		}
		list.gen++;
		this.pool.updated(entry, charge);
	}

	private notePendListRemove(blockId: BlockId, actionId: ActionId): void {
		const entry = this.blocks.get(blockId)?.pendList;
		if (entry === undefined) return;
		const list = entry.value;
		let charge = entry.charge;
		if (list.ids.delete(actionId)) {
			charge -= ID_SLOT + actionId.length * CHAR_BYTES;
		}
		list.gen++;
		this.pool.updated(entry, charge);
	}

	/** Failed pending write: the affected value entry AND the id set drop to unknown. */
	private dropPendingState(blockId: BlockId, actionId: ActionId): void {
		const s = this.blocks.get(blockId);
		if (s === undefined) return;
		const p = s.pending.get(actionId);
		if (p !== undefined) {
			s.pending.delete(actionId);
			this.pool.drop(p);
		}
		const list = s.pendList;
		if (list !== undefined) {
			s.pendList = undefined;
			this.pool.drop(list);
		}
		this.dropIfEmpty(blockId, s);
	}

	async getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const s = this.state(blockId);
		const cached = s.pending.get(actionId);
		if (cached !== undefined) {
			this.pool.touch(cached);
			return cached.value ?? undefined;
		}
		let bytes: Uint8Array | undefined;
		try {
			bytes = await this.inner.getPending(blockId, actionId);
		} catch (err) {
			this.reapOnThrow(blockId, s);
			throw err;
		}
		this.fillMiss(blockId, s, s.pending, 'pending', actionId, bytes);
		return bytes;
	}

	async putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putPending(blockId, actionId, value);
		} catch (err) {
			this.dropPendingState(blockId, actionId);
			throw err;
		}
		const s = this.state(blockId);
		this.cachePoint(blockId, s, 'pending', actionId, value, s.pending.get(actionId),
			e => s.pending.set(actionId, e), () => s.pending.delete(actionId));
		this.notePendListAdd(blockId, actionId);
	}

	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		try {
			await this.inner.deletePending(blockId, actionId);
		} catch (err) {
			this.dropPendingState(blockId, actionId);
			throw err;
		}
		const s = this.state(blockId);
		this.cachePoint(blockId, s, 'pending', actionId, null, s.pending.get(actionId),
			e => s.pending.set(actionId, e), () => s.pending.delete(actionId));
		this.notePendListRemove(blockId, actionId);
	}

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		const entry = this.ensurePendList(blockId);
		if (entry === undefined) {
			const drained: ActionId[] = [];
			for await (const id of this.inner.listPendingActionIds(blockId)) {
				drained.push(id);
			}
			yield* drained;
			return;
		}
		const list = entry.value;
		if (list.complete) {
			this.pool.touch(entry);
			yield* Array.from(list.ids);
			return;
		}
		// One full enumeration seeds completeness; funnelled writes maintain it from then on.
		// Completeness is NEVER inferred from metadata birth: at the raw layer a pending
		// record CAN exist for a block with no metadata (the conformance suite writes exactly
		// that), so only an actual drain of the inner driver proves the set.
		const gen = list.gen;
		const drained: ActionId[] = [];
		for await (const id of this.inner.listPendingActionIds(blockId)) {
			drained.push(id);
		}
		const current = this.blocks.get(blockId)?.pendList;
		if (current === entry && list.gen === gen) {
			let charge = entry.charge - idsContent(list.ids);
			list.ids = new Set(drained);
			list.complete = true;
			charge += idsContent(list.ids);
			this.pool.updated(entry, charge);
		}
		yield* drained;
	}

	// --- transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const s = this.state(blockId);
		const cached = s.transactions.get(actionId);
		if (cached !== undefined) {
			this.pool.touch(cached);
			return cached.value ?? undefined;
		}
		let bytes: Uint8Array | undefined;
		try {
			bytes = await this.inner.getTransaction(blockId, actionId);
		} catch (err) {
			this.reapOnThrow(blockId, s);
			throw err;
		}
		this.fillMiss(blockId, s, s.transactions, 'tx', actionId, bytes);
		return bytes;
	}

	async putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putTransaction(blockId, actionId, value);
		} catch (err) {
			this.dropMapEntry(blockId, 'transactions', actionId);
			throw err;
		}
		const s = this.state(blockId);
		this.cachePoint(blockId, s, 'tx', actionId, value, s.transactions.get(actionId),
			e => s.transactions.set(actionId, e), () => s.transactions.delete(actionId));
	}

	// --- proofs (PASSTHROUGH — deliberately not cached) ---

	// Proof reads happen on repair and archive-serving paths, never on the hot read path,
	// so proofs get no cache namespace of their own: two delegating methods instead of new
	// cache state, eviction accounting and coherence rules. A namespace that is never
	// populated also cannot go stale. This IS a small behaviour change from when proofs
	// rode the transactions store and were cached incidentally.
	// NOTE: if proof reads ever show up as hot, give proofs their own cache namespace
	// alongside `transactions` (point entries keyed by rev, same shape as `tx`).

	async getProof(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		return this.inner.getProof(blockId, rev);
	}

	async putProof(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		await this.inner.putProof(blockId, rev, value);
	}

	// --- materialized ---

	async getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const s = this.state(blockId);
		const cached = s.materialized.get(actionId);
		if (cached !== undefined) {
			this.pool.touch(cached);
			return cached.value ?? undefined;
		}
		let bytes: Uint8Array | undefined;
		try {
			bytes = await this.inner.getMaterialized(blockId, actionId);
		} catch (err) {
			this.reapOnThrow(blockId, s);
			throw err;
		}
		this.fillMiss(blockId, s, s.materialized, 'mat', actionId, bytes);
		return bytes;
	}

	async putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putMaterialized(blockId, actionId, value);
		} catch (err) {
			this.dropMapEntry(blockId, 'materialized', actionId);
			throw err;
		}
		const s = this.state(blockId);
		this.cachePoint(blockId, s, 'mat', actionId, value, s.materialized.get(actionId),
			e => s.materialized.set(actionId, e), () => s.materialized.delete(actionId));
	}

	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		try {
			await this.inner.deleteMaterialized(blockId, actionId);
		} catch (err) {
			this.dropMapEntry(blockId, 'materialized', actionId);
			throw err;
		}
		// A delete through the funnel is a PROVEN absence, not an unknown.
		const s = this.state(blockId);
		this.cachePoint(blockId, s, 'mat', actionId, null, s.materialized.get(actionId),
			e => s.materialized.set(actionId, e), () => s.materialized.delete(actionId));
	}

	/** Error-path invalidation of one map-backed entry (write failed → unknown). */
	private dropMapEntry(blockId: BlockId, which: 'transactions' | 'materialized', actionId: ActionId): void {
		const s = this.blocks.get(blockId);
		if (s === undefined) return;
		const map = s[which];
		const e = map.get(actionId);
		if (e !== undefined) {
			map.delete(actionId);
			this.pool.drop(e);
			this.dropIfEmpty(blockId, s);
		}
	}

	// --- promote (the single hardest coherence point — see "Invariant P" on
	// `IBlockStorage.promotePendingTransaction`, src/storage/i-block-storage.ts) ---

	/**
	 * The inner driver performs the atomic pending → committed move; this wrapper then mirrors
	 * it as one synchronous cache mutation sequence. When the pending transform was never
	 * cached — pended before this wrapper attached, or its entry EVICTED by the pool — the
	 * committed entry is INVALIDATED rather than synthesized: fabricating it would recreate
	 * exactly the phantom-record class Invariant P exists to prevent. Invalidation also
	 * removes any cached negative for the committed entry, which the promote has just made
	 * stale.
	 *
	 * Eviction landing between the three coupled mutations is safe by construction: the inner
	 * atomic move has already resolved before the first cache mutation, so each of the three
	 * entries (pending value, pending-id set, committed value) steps from one individually
	 * coherent state to another — an eviction merely turns one of those steps into "unknown,
	 * fall through", never into a fabricated value.
	 */
	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		try {
			await this.inner.promote(blockId, actionId);
		} catch (err) {
			// On the contract's missing-pend throw the inner state is unchanged, but the throw
			// may also be a mid-operation fault whose outcome is unknown ("exactly one of the
			// two states") — drop all three affected entries to unknown rather than guess.
			const s = this.blocks.get(blockId);
			if (s !== undefined) {
				const p = s.pending.get(actionId);
				if (p !== undefined) {
					s.pending.delete(actionId);
					this.pool.drop(p);
				}
				const t = s.transactions.get(actionId);
				if (t !== undefined) {
					s.transactions.delete(actionId);
					this.pool.drop(t);
				}
				const list = s.pendList;
				if (list !== undefined) {
					s.pendList = undefined;
					this.pool.drop(list);
				}
				this.dropIfEmpty(blockId, s);
			}
			throw err;
		}
		const s = this.state(blockId);
		const pendingBytes = s.pending.get(actionId)?.value;
		this.cachePoint(blockId, s, 'pending', actionId, null, s.pending.get(actionId),
			e => s.pending.set(actionId, e), () => s.pending.delete(actionId));
		this.notePendListRemove(blockId, actionId);
		if (pendingBytes instanceof Uint8Array) {
			// The block state may have been reaped by an eviction the mutations above caused;
			// re-fetch (or re-create) it before installing the committed value.
			const s2 = this.blocks.get(blockId) ?? this.state(blockId);
			this.cachePoint(blockId, s2, 'tx', actionId, pendingBytes, s2.transactions.get(actionId),
				e => s2.transactions.set(actionId, e), () => s2.transactions.delete(actionId));
		} else {
			// Unknown (never observed, or evicted) — or a cached negative that promote just
			// contradicted, which the funnel makes unreachable but is handled identically for
			// safety. Invalidate; never synthesize.
			this.dropMapEntry(blockId, 'transactions', actionId);
		}
	}
}

function evictFromMap(map: Map<ActionId, PoolEntry<CachedBytes>>, entry: PoolEntry): void {
	if (entry.actionId !== undefined && map.get(entry.actionId) === entry) {
		map.delete(entry.actionId);
	}
}
