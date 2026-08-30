import type { BlockId, ActionId } from "@optimystic/db-core";
import type { StoreIdentity } from "./store-identity.js";

/**
 * Which of the cache's entry classes a pool entry belongs to. Mirrors the sub-states of
 * `CachedStoreDriver`'s per-block cache state; the pool itself never branches on the class —
 * it exists so the owning store can locate the entry's home when the pool evicts it.
 */
export type CacheEntryClass = 'meta' | 'revs' | 'pendList' | 'pending' | 'tx' | 'mat';

/**
 * The owner side of the eviction contract. When the pool evicts an entry it calls
 * `onPoolEvict` exactly once; the owner must remove its own reference to the entry (and only
 * that) so the evicted value becomes unreachable. The callback runs synchronously inside a
 * pool mutation and MUST NOT call back into any pool method — the pool's accounting is
 * mid-update when it fires.
 */
export interface PoolEntryOwner {
	onPoolEvict(entry: PoolEntry): void;
}

/**
 * One cached value's residency record: simultaneously the value holder the owning store's
 * maps point at, and the node the pool's queues link. Owners create these as plain object
 * literals (`where: 'none'`), install the reference in their own state FIRST, and then call
 * {@link SharedCachePool.admit} — that order guarantees evictions triggered by the admission
 * can never observe the owner's block state as empty while the new entry is in flight.
 *
 * `charge` is the entry's whole budget cost: `base` (fixed bookkeeping — entry object, owner
 * map slot, queue slot, key string) plus the owner-computed content bytes. Negatives and
 * empty container states therefore still cost `base`, which is what keeps a remote probe
 * stream of nonexistent keys inside the budget instead of growing bookkeeping for free.
 */
export interface PoolEntry<V = unknown> {
	readonly key: string;
	readonly store: CacheStoreHandle;
	readonly owner: PoolEntryOwner;
	readonly cls: CacheEntryClass;
	readonly blockId: BlockId;
	readonly actionId: ActionId | undefined;
	value: V;
	/** Fixed bookkeeping charge (entry + map slots + key string); never changes. */
	readonly base: number;
	/** Total budgeted bytes: `base` + content. Managed via {@link SharedCachePool.updated}. */
	charge: number;
	/** Which queue currently holds the entry; `'none'` = not resident. Pool-managed. */
	where: 'a1in' | 'am' | 'none';
}

/**
 * A store's registration with the pool. `id` is process-unique and never reused (monotonic
 * counter), so entries and ghost keys of a departed store can never alias a later one.
 * `bytes`/`entries` are live occupancy, maintained by the pool — read-only for callers.
 */
export class CacheStoreHandle {
	bytes = 0;
	entries = 0;
	constructor(
		readonly id: string,
		readonly label: string | undefined,
		/**
		 * The backing store this cache fronts, when the backend names one. Held so
		 * {@link SharedCachePool.unregisterStore} can free the pool's live-identity claim; never
		 * used as, or mixed into, an entry key (that is {@link SharedCachePool.keyFor}'s `id`).
		 */
		readonly identity: StoreIdentity | undefined = undefined,
	) {}
}

export interface CachePoolStats {
	maxBytes: number;
	maxEntries: number;
	bytes: number;
	entries: number;
	a1in: { bytes: number; entries: number };
	am: { bytes: number; entries: number };
	/** Ghost (A1out) key count. Ghost keys are bookkeeping outside the byte budget, bounded by their own cap. */
	ghostKeys: number;
	hits: number;
	admissions: number;
	/** Admissions that went straight to Am because the key was in the ghost set (the 2Q reuse signal). */
	ghostHits: number;
	evictions: number;
	bypasses: number;
	stores: { id: string; label: string | undefined; bytes: number; entries: number }[];
}

export interface SharedCachePoolOptions {
	/** Byte budget for all resident entries across all registered stores. Default is per-platform (see {@link defaultCachePool}). */
	maxBytes?: number;
	/** Entry-count secondary rail (guards the many-tiny-entries case). Default `max(16, maxBytes / 512)`. */
	maxEntries?: number;
	/**
	 * `'2q'` (default): Johnson & Shasha 2Q — A1in probation FIFO at ~25% of EACH budget rail
	 * (bytes and entries), A1out ghost keys at ~50% of the entry cap, Am protected LRU.
	 * `'lru'`: a plain shared LRU
	 * with no admission control — kept ONLY as the comparison baseline for measuring whether
	 * 2Q's pollution resistance earns its complexity (see the pool spec's measurement test).
	 */
	admission?: '2q' | 'lru';
}

/**
 * Separator for pool keys: NUL, spelled as an escape so this file stays plain text — a literal
 * NUL byte in the source makes the whole file binary to git (no diff, no blame, no review).
 * NUL is the one character no id can carry: block ids are user-supplied collection URI paths
 * (which may well contain spaces) and action ids are base64url with an optional `tx:`/`stamp:`
 * prefix, so `(storeId, class, blockId, actionId?)` always splits back unambiguously.
 */
const SEP = '\u0000';

/**
 * A shared, bounded, clean-value cache pool: one per process (see {@link defaultCachePool}),
 * shared by every `CachedStoreDriver` so that N stores compete inside ONE memory budget
 * instead of keeping N unbounded caches. The pool owns residency and eviction only; all
 * cache *semantics* (coherence, negatives, completeness) stay in the owning store.
 *
 * **Always evict, never refuse, never grow unbounded.** Entries are never pinned and never
 * dirty (the cache is write-through; see `CachedStoreDriver`), so eviction is always safe
 * and there is no exhaustion condition to raise. At the bound the pool evicts; the one entry
 * class that can grow while resident (a store's revision map) is simply evicted like any
 * other when its growth pushes the pool over budget.
 *
 * **2Q admission** (default): a first-touch entry enters the A1in probation FIFO; re-hits
 * inside A1in do NOT promote (FIFO order stands, which is also what absorbs the several
 * correlated touches one logical operation makes); eviction from A1in demotes the key to
 * the A1out ghost set; a later admission of a ghosted key — reuse across operations — goes
 * straight to the protected Am LRU. Am evictions do NOT ghost. One-pass bulk scans
 * therefore live and die inside A1in without displacing any store's hot Am set.
 *
 * **Large values bypass**: an entry whose charge exceeds 1/16 of the byte budget is not
 * admitted at all (the owner reads/writes through), so one oversized value cannot flush
 * the pool.
 *
 * **Budget sanity**: `maxBytes`/`maxEntries` must be positive finite numbers — anything else
 * throws. Absurdly small values are accepted as-is: they cannot break coherence (the owning
 * cache is correct at any residency, including zero), they just degrade toward read-through.
 *
 * **One cache per backing store, enforced here.** Every cache — however constructed — registers
 * with a pool, so registration is the one choke point all construction paths share, and
 * {@link registerStore} refuses a second live registration for a backing store identity that
 * already has one (see its doc for why a throw, not a warning). Two deliberate escapes remain,
 * both documented rather than closed:
 *
 * - **Two different pools.** The claim map lives on the pool, so two caches over one store
 *   registered with two DIFFERENT `SharedCachePool` instances both succeed and both diverge.
 *   Closing that would take a process-global identity registry outliving every pool — more
 *   machinery than the case deserves, since passing a non-default pool is an explicit act (tests
 *   do it for isolation, hosts for sizing). Pinned by a test so it reads as a decision.
 * - **Backends that report no identity** (memory drivers, test doubles) are not covered at all,
 *   which is correct: two memory drivers are two genuinely different stores.
 *
 * The cross-process case — two OS processes over one directory — is out of scope entirely; it is
 * the unenforced precondition of Invariant 5 in `packages/db-p2p/docs/storage.md`.
 *
 * Not safe for use from multiple threads; like the caches it serves, it relies on JS
 * single-threaded execution — every mutation completes synchronously.
 */
export class SharedCachePool {
	private maxBytesValue: number;
	private maxEntriesValue: number;
	private readonly admission: '2q' | 'lru';
	private bypassLimit = 0;
	private a1inTargetBytes = 0;
	private a1inTargetEntries = 0;
	private ghostCap = 0;

	private readonly a1in = new Map<string, PoolEntry>();
	private readonly am = new Map<string, PoolEntry>();
	private readonly ghost = new Set<string>();
	private a1inBytes = 0;

	private bytesTotal = 0;
	private entriesTotal = 0;
	private storeCounter = 0;
	private readonly stores = new Map<string, CacheStoreHandle>();
	/**
	 * Live backing-store claims: one entry per registered store that named an identity, freed by
	 * {@link unregisterStore}. Registration bookkeeping only — it holds no values and never
	 * enters the byte or entry budget.
	 */
	private readonly claims = new Map<StoreIdentity, CacheStoreHandle>();

	private hits = 0;
	private admissions = 0;
	private ghostHits = 0;
	private evictions = 0;
	private bypasses = 0;

	constructor(options?: SharedCachePoolOptions) {
		this.admission = options?.admission ?? '2q';
		this.maxBytesValue = validateBound('maxBytes', options?.maxBytes ?? platformDefaultBytes());
		this.maxEntriesValue = validateBound('maxEntries',
			options?.maxEntries ?? Math.max(16, Math.floor(this.maxBytesValue / 512)));
		this.recomputeDerived();
	}

	get maxBytes(): number { return this.maxBytesValue; }
	get maxEntries(): number { return this.maxEntriesValue; }
	get bytes(): number { return this.bytesTotal; }
	get entries(): number { return this.entriesTotal; }

	/**
	 * Re-budget a live pool (e.g. host config change, or a host correcting the platform
	 * default). Shrinking evicts immediately down to the new bound.
	 */
	setBudget(budget: { maxBytes?: number; maxEntries?: number }): void {
		if (budget.maxBytes !== undefined) {
			this.maxBytesValue = validateBound('maxBytes', budget.maxBytes);
		}
		if (budget.maxEntries !== undefined) {
			this.maxEntriesValue = validateBound('maxEntries', budget.maxEntries);
		}
		this.recomputeDerived();
		this.evictToFit(0, 0);
		this.trimGhost();
	}

	/**
	 * Register a store. The returned handle's `id` is unique for the pool's lifetime — never reused.
	 *
	 * `identity` is the backing store the caller's cache fronts ({@link StoreIdentity}), when the
	 * backend names one. A second registration for an identity this pool already has live
	 * **throws**: the two caches are write-through views that never see each other's writes, so
	 * each serves its own half of the process a permanently stale picture. Throwing is the point —
	 * the failure it replaces is silent wrong data returned to a caller with no way to notice, and
	 * a log line is not a way to notice. A registration with no identity is unaffected: it
	 * registers exactly as it always did.
	 *
	 * The check runs BEFORE any mutation, so a refused registration leaves the pool exactly as it
	 * was — no store row, no consumed id, no claim.
	 *
	 * @throws Error when `identity` already has a live registration on this pool.
	 */
	registerStore(label?: string, identity?: StoreIdentity): CacheStoreHandle {
		const claimed = identity === undefined ? undefined : this.claims.get(identity);
		if (claimed !== undefined) {
			throw new Error(
				`two caches over one backing store never converge: ${JSON.stringify(identity)} is already `
				+ `cached (label ${JSON.stringify(claimed.label ?? null)}); this registration `
				+ `(label ${JSON.stringify(label ?? null)}) would be a second, independent view. Share one `
				+ `CachedRawStorage — withReadCache does this for you — or dispose the first.`
			);
		}
		const handle = new CacheStoreHandle(`s${++this.storeCounter}`, label, identity);
		this.stores.set(handle.id, handle);
		if (identity !== undefined) this.claims.set(identity, handle);
		return handle;
	}

	/**
	 * Release a departing store: evict any of its entries still resident (defensively — the
	 * owner normally clears first), purge its ghost keys, and remove it from the registry.
	 * Idempotent. This forced removal notifies the owner like any other eviction — `drop` here
	 * would de-account entries the owner still references, leaving it serving values the pool
	 * no longer counts. It does NOT ghost (the ghosts are being purged anyway) and does NOT
	 * count as a budget eviction: it is a lifecycle release, not memory pressure.
	 *
	 * Also frees the handle's backing-store claim, so sequential reuse of one store (stop a node,
	 * start another over the same directory) registers cleanly instead of tripping
	 * {@link registerStore}'s guard. The claim is released only when the map still points at THIS
	 * handle — a second, late unregister of a departed handle must not strip the claim out from
	 * under the successor that legitimately took the identity in between.
	 */
	unregisterStore(handle: CacheStoreHandle): void {
		for (const queue of [this.a1in, this.am]) {
			for (const entry of [...queue.values()]) {
				if (entry.store !== handle) continue;
				this.unlink(entry);
				entry.owner.onPoolEvict(entry);
			}
		}
		this.purgeGhosts(handle);
		this.stores.delete(handle.id);
		if (handle.identity !== undefined && this.claims.get(handle.identity) === handle) {
			this.claims.delete(handle.identity);
		}
	}

	/** Drop every ghost key belonging to `handle` (used by store clear/close — pre-clear recency must not survive the clear). */
	purgeGhosts(handle: CacheStoreHandle): void {
		const prefix = handle.id + SEP;
		for (const key of [...this.ghost]) {
			if (key.startsWith(prefix)) this.ghost.delete(key);
		}
	}

	/** Build the pool key for an entry. Store-id first: keying by block id alone would alias name-derived header block ids across stores. */
	keyFor(store: CacheStoreHandle, cls: CacheEntryClass, blockId: BlockId, actionId?: ActionId): string {
		return actionId === undefined
			? store.id + SEP + cls + SEP + blockId
			: store.id + SEP + cls + SEP + blockId + SEP + actionId;
	}

	/**
	 * Would an entry of this total charge be admitted? `false` = large-value bypass (counted);
	 * the owner must then read/write through without caching. Also the gate for value
	 * *updates*: an update growing past the limit should drop the entry instead.
	 */
	admits(charge: number): boolean {
		if (charge > this.bypassLimit) {
			this.bypasses++;
			return false;
		}
		return true;
	}

	/**
	 * Admit a non-resident entry the owner has ALREADY installed in its own state. Evicts
	 * first (so the incoming entry can never be its own victim), then links: to Am when the
	 * key is in the ghost set (2Q reuse signal), to A1in probation otherwise.
	 */
	admit(entry: PoolEntry): void {
		if (entry.where !== 'none') {
			throw new Error(`pool admit of already-resident entry ${entry.key}`);
		}
		this.evictToFit(entry.charge, 1);
		this.admissions++;
		if (this.admission === 'lru') {
			this.link(entry, 'am');
			return;
		}
		if (this.ghost.delete(entry.key)) {
			this.ghostHits++;
			this.link(entry, 'am');
		} else {
			this.link(entry, 'a1in');
		}
	}

	/** Record a read hit: Am refreshes to MRU; A1in stays put (FIFO — no intra-probation promotion). */
	touch(entry: PoolEntry): void {
		this.hits++;
		this.refresh(entry);
	}

	/**
	 * Re-account a resident entry after the owner mutated its value (write hit, or container
	 * growth like a revision-map fill). Queue position refreshes like a touch (without
	 * counting a hit); growth over budget evicts — possibly the updated entry itself, which
	 * is why owners call this LAST and never touch their cache state after.
	 *
	 * NOTE: growth here is NOT re-checked against {@link admits}' large-value bypass, so a
	 * container entry (a block's revision map or pending-id set) can grow past 1/16 of the
	 * budget and squat where a single oversized value would have been refused. Bounded and
	 * self-correcting today: an over-share entry keeps `a1inBytes` above its target, so
	 * probation evicts it preferentially, and anything past `maxBytes` is evicted outright.
	 * If a block ever accumulates enough revisions for one map to hold a real fraction of the
	 * budget (order 20k revs at the 32 MB Node default), gate growth on `admits(charge)` in
	 * the owner's revision/pending-list paths and drop the entry when it fails, exactly as
	 * `CachedStoreDriver.cachePoint` already does for point values.
	 */
	updated(entry: PoolEntry, newCharge: number): void {
		if (entry.where === 'none') return;
		const delta = newCharge - entry.charge;
		entry.charge = newCharge;
		this.bytesTotal += delta;
		entry.store.bytes += delta;
		if (entry.where === 'a1in') this.a1inBytes += delta;
		this.refresh(entry);
		if (delta > 0) this.evictToFit(0, 0);
	}

	/**
	 * Remove an entry WITHOUT the eviction callback — for owners invalidating or clearing
	 * their own entries (the owner is already removing its reference). Never ghosts: an
	 * invalidation says nothing about reuse. No-op if not resident.
	 */
	drop(entry: PoolEntry): void {
		if (entry.where === 'none') return;
		this.unlink(entry);
	}

	stats(): CachePoolStats {
		const amBytes = this.bytesTotal - this.a1inBytes;
		return {
			maxBytes: this.maxBytesValue,
			maxEntries: this.maxEntriesValue,
			bytes: this.bytesTotal,
			entries: this.entriesTotal,
			a1in: { bytes: this.a1inBytes, entries: this.a1in.size },
			am: { bytes: amBytes, entries: this.am.size },
			ghostKeys: this.ghost.size,
			hits: this.hits,
			admissions: this.admissions,
			ghostHits: this.ghostHits,
			evictions: this.evictions,
			bypasses: this.bypasses,
			stores: [...this.stores.values()].map(s => ({ id: s.id, label: s.label, bytes: s.bytes, entries: s.entries })),
		};
	}

	// ---- internals ----

	private recomputeDerived(): void {
		this.bypassLimit = Math.floor(this.maxBytesValue / 16);
		this.a1inTargetBytes = Math.floor(this.maxBytesValue / 4);
		this.a1inTargetEntries = Math.floor(this.maxEntriesValue / 4);
		this.ghostCap = Math.floor(this.maxEntriesValue / 2);
	}

	private link(entry: PoolEntry, where: 'a1in' | 'am'): void {
		entry.where = where;
		(where === 'a1in' ? this.a1in : this.am).set(entry.key, entry);
		if (where === 'a1in') this.a1inBytes += entry.charge;
		this.bytesTotal += entry.charge;
		this.entriesTotal++;
		entry.store.bytes += entry.charge;
		entry.store.entries++;
	}

	private unlink(entry: PoolEntry): void {
		(entry.where === 'a1in' ? this.a1in : this.am).delete(entry.key);
		if (entry.where === 'a1in') this.a1inBytes -= entry.charge;
		this.bytesTotal -= entry.charge;
		this.entriesTotal--;
		entry.store.bytes -= entry.charge;
		entry.store.entries--;
		entry.where = 'none';
	}

	/** Map insertion order gives A1in its FIFO and Am its LRU: refresh = delete + re-insert. */
	private refresh(entry: PoolEntry): void {
		if (entry.where !== 'am') return;
		this.am.delete(entry.key);
		this.am.set(entry.key, entry);
	}

	private evictToFit(incomingCharge: number, incomingEntries: number): void {
		while (this.bytesTotal + incomingCharge > this.maxBytesValue
			|| this.entriesTotal + incomingEntries > this.maxEntriesValue) {
			const victim = this.pickVictim();
			if (victim === undefined) break; // pool empty — nothing left to evict
			this.evict(victim);
		}
	}

	private pickVictim(): PoolEntry | undefined {
		if (this.admission === 'lru') {
			return first(this.am) ?? first(this.a1in);
		}
		// 2Q: take A1in's FIFO head while probation is over its share of EITHER rail (or Am has
		// nothing); otherwise the protected queue's LRU entry. Probation needs a share of the
		// entry rail too, not just the byte rail: entries small enough that the entry count binds
		// first (cached negatives are near-empty) would otherwise leave `a1inBytes` permanently
		// under its byte target, so every admission would evict from Am and a one-pass scan would
		// flush the protected set — 2Q silently degraded to plain LRU.
		const a1inHead = first(this.a1in);
		if (a1inHead !== undefined && (this.a1inBytes > this.a1inTargetBytes
			|| this.a1in.size > this.a1inTargetEntries || this.am.size === 0)) {
			return a1inHead;
		}
		return first(this.am) ?? a1inHead;
	}

	private evict(entry: PoolEntry): void {
		const fromA1in = entry.where === 'a1in';
		this.unlink(entry);
		if (fromA1in && this.admission === '2q') {
			this.pushGhost(entry.key);
		}
		this.evictions++;
		entry.owner.onPoolEvict(entry);
	}

	private pushGhost(key: string): void {
		this.ghost.delete(key);
		this.ghost.add(key);
		this.trimGhost();
	}

	private trimGhost(): void {
		while (this.ghost.size > this.ghostCap) {
			const oldest = this.ghost.values().next().value;
			if (oldest === undefined) break;
			this.ghost.delete(oldest);
		}
	}
}

function first(queue: Map<string, PoolEntry>): PoolEntry | undefined {
	return queue.values().next().value;
}

function validateBound(name: string, value: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`SharedCachePool ${name} must be a positive finite number, got ${value}`);
	}
	return Math.floor(value);
}

/**
 * Honest per-platform default byte budget: ~8 MB on React Native (the phone running twenty
 * workspaces is the device least able to afford more), 16 MB in browsers, 32 MB on Node
 * (desktop / provider hosts). Hosts with better knowledge should size explicitly — either
 * `defaultCachePool().setBudget(...)` or their own `SharedCachePool` passed to each cache.
 */
function platformDefaultBytes(): number {
	const g = globalThis as { navigator?: { product?: string }; window?: unknown };
	if (g.navigator?.product === 'ReactNative') return 8 * 1024 * 1024;
	if (g.window !== undefined) return 16 * 1024 * 1024;
	return 32 * 1024 * 1024;
}

let defaultPool: SharedCachePool | undefined;

/**
 * The process-wide shared pool every `CachedStoreDriver` joins unless handed a specific one.
 * Lazily created on first use with the platform-default budget; re-budget it live via
 * `setBudget`. One pool per process is the point: twenty workspaces' caches compete inside
 * one budget instead of each sizing itself as if it were alone.
 */
export function defaultCachePool(): SharedCachePool {
	defaultPool ??= new SharedCachePool();
	return defaultPool;
}
