import type { BlockId, ActionId } from "@optimystic/db-core";
import type { RawStoreDriver } from "./raw-store-driver.js";

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
 * dropping the entry (clear / write-error invalidation) can never strand a half-true
 * completeness claim. `gen` serves the same in-flight-enumeration guard as {@link RevMapState}.
 */
interface PendListState {
	ids: Set<ActionId>;
	complete: boolean;
	gen: number;
}

/**
 * All cached state for one block. Entry classes (`meta`, `revs`, `pending`, `transactions`,
 * `materialized`) are deliberately kept distinct and keyed by their natural key, so a future
 * shared cache pool can re-key entries as `(storeId, class, key)` without a rewrite — block
 * ids alone are NOT globally unique (header block ids are name-derived, so two stores running
 * the same schema collide); the wrapper is safe today only because one instance serves one store.
 */
interface BlockCacheState {
	/** Metadata bytes; property absent = unknown. */
	meta?: CachedBytes;
	revs?: RevMapState;
	pending: Map<ActionId, CachedBytes>;
	pendList?: PendListState;
	transactions: Map<ActionId, CachedBytes>;
	materialized: Map<ActionId, CachedBytes>;
}

/**
 * Write-through coherent cache over any {@link RawStoreDriver}. Wrap a backend's driver with
 * this before handing it to `KvRawStorage` and every read the kernel issues is served from
 * memory after the first cold miss, for the life of the process.
 *
 * **Coherence, not eviction policy.** Every save stores its value INTO the cache as it writes
 * the inner driver, rather than invalidating. The cache therefore always holds the last
 * durable value and never needs to re-read a key it has seen. This is what a plain
 * invalidate-on-write memo cannot achieve at this seam: the hot reads exist to observe the
 * writes, so invalidation lands between nearly every read pair (measured: only a 23% cut).
 *
 * **Why this is sound** — the invariants in `docs/storage.md` ("Invariants", 1–5):
 * 1. every backend write funnels through `IRawStorage` (and thus this driver) in-process, so
 *    the cache sees every mutation;
 * 2. every writer of `meta.latest` holds the per-block commit latch, and each cache update is
 *    synchronous with its inner write (no `await` between the inner call resolving and the
 *    cache mutation), so latch-protected read-after-write sees the new value exactly as a
 *    driver read would;
 * 3. committed revisions and materializations are append-only.
 *
 * **Precondition: one process owns the store** (Invariant 5). A second process writing the
 * same backend bypasses this wrapper and makes cached values stale in ways that feed
 * consensus decisions. Not enforced in code — see docs/storage.md.
 *
 * **The cache is always clean, never dirty.** No write is deferred, reordered, or coalesced;
 * the inner driver's durable state never depends on cache contents. {@link clear} is
 * therefore correct at any instant, and any future eviction policy is a pure performance
 * question. Keep it that way: if a change here ever needs a dirty or pinned entry, the
 * design has gone wrong — stop and reconsider.
 *
 * **Values are cached as bytes**, exactly the encoded value the kernel wrote or the driver
 * returned. The kernel decodes fresh objects from those bytes on every read, so the
 * clone-on-read/clone-on-write discipline stays structural (same argument as the codec
 * boundary itself), and an entry's byte size is free for the future bounded pool.
 * NOTE: every cache hit still pays one JSON.parse in the kernel; if decode ever shows up hot
 * on large materialized blocks, cache decoded objects plus an explicit clone instead.
 *
 * **Do not wrap `MemoryStoreDriver`.** The memory driver already holds the same byte
 * references in maps; wrapping it duplicates every map entry (the bytes themselves are
 * shared, so no byte copy — but the bookkeeping is pure overhead with nothing to save).
 */
export class CachedStoreDriver implements RawStoreDriver {
	private readonly blocks = new Map<BlockId, BlockCacheState>();

	/**
	 * Optional passthroughs are wired only when the inner driver provides them, mirroring
	 * `KvRawStorage`'s constructor: feature-detection above this wrapper must observe the
	 * inner driver's true capability. `listBlockIds` deliberately bypasses the cache — it
	 * enumerates the inner metadata keyspace, which funnelled writes keep authoritative.
	 */
	listBlockIds?: () => AsyncIterable<BlockId>;
	approximateBytesUsed?: () => Promise<number>;
	close?: () => Promise<void>;

	constructor(private readonly inner: RawStoreDriver) {
		if (inner.listBlockIds) {
			this.listBlockIds = () => inner.listBlockIds!();
		}
		if (inner.approximateBytesUsed) {
			this.approximateBytesUsed = () => inner.approximateBytesUsed!();
		}
		if (inner.close) {
			this.close = () => inner.close!();
		}
	}

	/**
	 * Drop every cached entry. Always safe (the cache is clean — see class doc); the next
	 * read of each key re-consults the inner driver. In-flight enumerations notice the
	 * identity change of their state objects and decline to claim completeness.
	 */
	clear(): void {
		this.blocks.clear();
	}

	/**
	 * NOTE: this allocates an entry for EVERY block id touched, including ones that turn out
	 * not to exist (the proven-absent negative is the point). `StorageRepo.get` is reachable
	 * from a remote peer with an arbitrary block-id list, so once a production call site wires
	 * this cache, probes for nonexistent blocks grow `blocks` without bound. The bounded pool
	 * (`shared-bounded-cache-pool-with-2q-admission`) must count negatives and empty states
	 * against its budget, not just populated values.
	 */
	private state(blockId: BlockId): BlockCacheState {
		let s = this.blocks.get(blockId);
		if (!s) {
			s = { pending: new Map(), transactions: new Map(), materialized: new Map() };
			this.blocks.set(blockId, s);
		}
		return s;
	}

	/**
	 * Cache a read-miss result into one of the map-backed entry classes, under BOTH fill
	 * guards. `started` is the state object the read began on:
	 *
	 * - **value guard** — fill only while the entry is still unknown, so a newer funnelled
	 *   write that landed during the inner read is not clobbered by this older value;
	 * - **identity guard** — decline entirely if `clear()` swapped the state object during
	 *   the inner read. Without it a resumed read reinstalls its pre-clear value into the
	 *   fresh state, and the newer write that superseded it went out with the old state —
	 *   so the stale value would then be served forever. The revision and pending-list
	 *   paths make the same identity check against their own sub-state objects.
	 */
	private fillMiss(
		blockId: BlockId,
		started: BlockCacheState,
		map: Map<ActionId, CachedBytes>,
		actionId: ActionId,
		bytes: Uint8Array | undefined
	): void {
		// `blocks.get`, not `state()` — a declined fill must not resurrect the block entry.
		if (this.blocks.get(blockId) !== started) return;
		if (map.get(actionId) === undefined) {
			map.set(actionId, bytes ?? null);
		}
	}

	// --- metadata ---

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		const s = this.state(blockId);
		if (s.meta !== undefined) {
			return s.meta ?? undefined;
		}
		const bytes = await this.inner.getMetadata(blockId);
		// Same two fill guards as {@link fillMiss} (value + state identity), spelled out here
		// because metadata is a property rather than a map entry. Caching the miss (`null`) is
		// deliberate: everything that creates metadata funnels through this wrapper, so a
		// confirmed miss stays provably absent until a funnelled write overwrites it —
		// repeated probes of not-yet-created blocks are a real cold-start pattern.
		if (this.blocks.get(blockId) === s && s.meta === undefined) {
			s.meta = bytes ?? null;
		}
		return bytes;
	}

	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putMetadata(blockId, value);
		} catch (err) {
			// The inner write failed with the backend in an unknown state — drop to unknown so
			// the next read consults the driver. Same recovery shape on every write path below.
			delete this.state(blockId).meta;
			throw err;
		}
		this.state(blockId).meta = value;
	}

	// --- revisions ---

	private revs(blockId: BlockId): RevMapState {
		const s = this.state(blockId);
		s.revs ??= { byRev: new Map(), covered: [], gen: 0 };
		return s.revs;
	}

	async getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		const revs = this.revs(blockId);
		if (coversRange(revs.covered, rev, rev)) {
			return revs.byRev.get(rev);
		}
		const bytes = await this.inner.getRevision(blockId, rev);
		const current = this.state(blockId).revs;
		if (current === revs && !coversRange(revs.covered, rev, rev)) {
			if (bytes !== undefined) {
				revs.byRev.set(rev, bytes);
			}
			revs.covered = addCovered(revs.covered, rev, rev);
		}
		return bytes;
	}

	async putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putRevision(blockId, rev, value);
		} catch (err) {
			this.state(blockId).revs = undefined;
			throw err;
		}
		const revs = this.revs(blockId);
		revs.byRev.set(rev, value);
		revs.covered = addCovered(revs.covered, rev, rev);
		revs.gen++;
	}

	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]> {
		const revs = this.revs(blockId);
		if (coversRange(revs.covered, lo, hi)) {
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
		for await (const entry of this.inner.rangeRevisions(blockId, lo, hi, reverse)) {
			drained.push(entry);
		}
		// Claim coverage of [lo, hi] only if nothing mutated the map during the drain (gen
		// unchanged, same state object — clear() swaps the object). A write that landed
		// mid-drain may be missing from `drained`, and recording coverage anyway would turn
		// that miss into a provably-wrong "rev absent" answer forever after.
		const current = this.state(blockId).revs;
		if (current === revs && revs.gen === gen) {
			for (const [rev, bytes] of drained) {
				revs.byRev.set(rev, bytes);
			}
			revs.covered = addCovered(revs.covered, lo, hi);
		}
		yield* drained;
	}

	// --- pending ---

	private pendList(blockId: BlockId): PendListState {
		const s = this.state(blockId);
		s.pendList ??= { ids: new Set(), complete: false, gen: 0 };
		return s.pendList;
	}

	async getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const s = this.state(blockId);
		const cached = s.pending.get(actionId);
		if (cached !== undefined) {
			return cached ?? undefined;
		}
		const bytes = await this.inner.getPending(blockId, actionId);
		this.fillMiss(blockId, s, s.pending, actionId, bytes);
		return bytes;
	}

	async putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putPending(blockId, actionId, value);
		} catch (err) {
			const s = this.state(blockId);
			s.pending.delete(actionId);
			s.pendList = undefined;
			throw err;
		}
		const s = this.state(blockId);
		s.pending.set(actionId, value);
		if (s.pendList) {
			s.pendList.ids.add(actionId);
			s.pendList.gen++;
		}
	}

	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		try {
			await this.inner.deletePending(blockId, actionId);
		} catch (err) {
			const s = this.state(blockId);
			s.pending.delete(actionId);
			s.pendList = undefined;
			throw err;
		}
		const s = this.state(blockId);
		s.pending.set(actionId, null);
		if (s.pendList) {
			s.pendList.ids.delete(actionId);
			s.pendList.gen++;
		}
	}

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		const list = this.pendList(blockId);
		if (list.complete) {
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
		const current = this.state(blockId).pendList;
		if (current === list && list.gen === gen) {
			list.ids = new Set(drained);
			list.complete = true;
		}
		yield* drained;
	}

	// --- transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const s = this.state(blockId);
		const cached = s.transactions.get(actionId);
		if (cached !== undefined) {
			return cached ?? undefined;
		}
		const bytes = await this.inner.getTransaction(blockId, actionId);
		this.fillMiss(blockId, s, s.transactions, actionId, bytes);
		return bytes;
	}

	async putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putTransaction(blockId, actionId, value);
		} catch (err) {
			this.state(blockId).transactions.delete(actionId);
			throw err;
		}
		this.state(blockId).transactions.set(actionId, value);
	}

	// --- materialized ---

	async getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const s = this.state(blockId);
		const cached = s.materialized.get(actionId);
		if (cached !== undefined) {
			return cached ?? undefined;
		}
		const bytes = await this.inner.getMaterialized(blockId, actionId);
		this.fillMiss(blockId, s, s.materialized, actionId, bytes);
		return bytes;
	}

	async putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		try {
			await this.inner.putMaterialized(blockId, actionId, value);
		} catch (err) {
			this.state(blockId).materialized.delete(actionId);
			throw err;
		}
		this.state(blockId).materialized.set(actionId, value);
	}

	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		try {
			await this.inner.deleteMaterialized(blockId, actionId);
		} catch (err) {
			this.state(blockId).materialized.delete(actionId);
			throw err;
		}
		// A delete through the funnel is a PROVEN absence, not an unknown.
		this.state(blockId).materialized.set(actionId, null);
	}

	// --- promote (the single hardest coherence point — see "Invariant P" on
	// `IBlockStorage.promotePendingTransaction`, src/storage/i-block-storage.ts) ---

	/**
	 * The inner driver performs the atomic pending → committed move; this wrapper then mirrors
	 * it as one synchronous cache mutation. When the pending transform was never cached
	 * (pended before this wrapper attached, e.g. by a previous process run), the committed
	 * entry is INVALIDATED rather than synthesized — fabricating it would recreate exactly the
	 * phantom-record class Invariant P exists to prevent. Invalidation also removes any cached
	 * negative for the committed entry, which the promote has just made stale.
	 */
	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		try {
			await this.inner.promote(blockId, actionId);
		} catch (err) {
			// On the contract's missing-pend throw the inner state is unchanged, but the throw
			// may also be a mid-operation fault whose outcome is unknown ("exactly one of the
			// two states") — drop all three affected entries to unknown rather than guess.
			const s = this.state(blockId);
			s.pending.delete(actionId);
			s.transactions.delete(actionId);
			s.pendList = undefined;
			throw err;
		}
		const s = this.state(blockId);
		const pendingBytes = s.pending.get(actionId);
		s.pending.set(actionId, null);
		if (s.pendList) {
			s.pendList.ids.delete(actionId);
			s.pendList.gen++;
		}
		if (pendingBytes instanceof Uint8Array) {
			s.transactions.set(actionId, pendingBytes);
		} else {
			// Unknown (never observed) — or a cached negative that promote just contradicted,
			// which the funnel makes unreachable but is handled identically for safety.
			s.transactions.delete(actionId);
		}
	}
}
