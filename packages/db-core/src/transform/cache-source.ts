import type { IBlock, BlockHeader, BlockId, BlockSource, BlockType, ReadPurpose, Transforms } from "../index.js";
import { applyOperation } from "./helpers.js";
import { LruMap } from "../utility/lru-map.js";
import { createLogger } from "../logger.js";
import type { ReadDependencyCollector } from "../transaction/read-dependency-collector.js";

const log = createLogger('cache');

const DefaultMaxSize = 128;

/** The revision a source reports for an id, or undefined if the source can't report one.
 *  Duck-typed exactly like {@link Tracker}'s getGeneration probe — CacheSource layers over
 *  arbitrary BlockSources (including test doubles) that need not implement it. */
function sourceReadRevision(source: unknown, id: BlockId): number | undefined {
	const src = source as { getReadRevision?: (id: BlockId) => number | undefined };
	return typeof src.getReadRevision === 'function' ? src.getReadRevision(id) : undefined;
}

/** What the source says about `block`, the object it just returned for `id`: the revision the
 *  content is, and whether it may be kept and served again without re-asking.
 *
 *  Prefers the source's per-OBJECT answer (`describeServed`, which TransactorSource provides) over
 *  the by-id {@link sourceReadRevision}. This runs after an `await`, so with two reads of one id in
 *  flight a by-id record describes whichever answer the source processed last — not necessarily
 *  this one — and would stamp one answer's content with the other's revision and verdict. A source
 *  that offers neither allows keeping at revision 0, the behaviour before either probe existed. */
function sourceServed(source: unknown, id: BlockId, block: IBlock): { rev: number; mayRetain: boolean } {
	const src = source as { describeServed?: (block: IBlock) => { rev: number; mayRetain: boolean } | undefined };
	const described = typeof src.describeServed === 'function' ? src.describeServed(block) : undefined;
	return described ?? { rev: sourceReadRevision(source, id) ?? 0, mayRetain: true };
}

export class CacheSource<T extends IBlock> implements BlockSource<T> {
	protected cache: LruMap<BlockId, T>;
	/** Per-id monotonic counter, bumped whenever the cached content for an id changes.
	 * Consumers (e.g. {@link Tracker}'s materialized-block memo) read it via
	 * {@link getGeneration} to detect that a cached "source + ops" result has gone stale.
	 * Over-bumping is safe (it only forces a re-materialize); under-bumping is a correctness
	 * bug, so every content-changing site bumps. A benign LRU evict + reload also bumps. */
	// NOTE: generations is never pruned — it retains one small (id → number) entry per distinct id
	// ever touched, even after LRU eviction from `cache`. Bounded by the number of distinct blocks a
	// collection sees over its lifetime; if that ever grows large enough to matter, evict alongside
	// the LRU (dropping a generation is safe — a reload re-bumps from 0/absent, forcing re-materialize).
	private generations = new Map<BlockId, number>();
	/** Per-id committed revision of the content currently cached for that id. Learned from the
	 *  source on a miss-load, advanced by {@link transformCache} when a commit folds new content
	 *  in, and dropped alongside the cached block on delete/clear. Re-emitted on every cache HIT
	 *  so a hit records a read dependency at the right revision — the whole point of this map, since
	 *  the underlying source is never consulted on a hit. */
	// NOTE: an LRU-evicted id keeps its `revisions` entry (eviction drops `cache` but not this map).
	// That lingering entry is LOAD-BEARING, not a leak: every path that serves or forgets content for
	// an id writes this map in the same step (keep, handThrough, clear, transformCache), so the entry
	// is always the revision of the content LAST SERVED for the id — which is exactly what a write
	// staged over a since-evicted read needs to declare as its base (a rev-only pin, see
	// `PinnedBase.block` in base-pins.ts). Only `peek` pairs a revision with content, and it answers
	// nothing for an evicted id, so the revision never pairs with a block it does not describe.
	private revisions = new Map<BlockId, number>();
	/** The most recent answer per id that this cache returned to a reader but did not keep — a
	 *  below-floor answer, content older than a log entry the collection already walked says the
	 *  block is (see {@link sourceServed}), or an answer overtaken while in flight over an id nothing
	 *  is held for (see {@link admit}). NEVER served to a read: {@link tryGet} re-asks the source
	 *  every time such an id is read, which is the whole point. It exists for the base probes alone
	 *  ({@link peek} / {@link getCachedRevision}): a write staged over this content must declare the
	 *  base it was really built on, at the revision it was really served at, so that the storage-side
	 *  guard which refuses a transform whose declared base is not the one the member holds can fire
	 *  instead of abstaining and applying edits computed against the old content over newer content.
	 *  An id is never in both this map and `cache`/`revisions`. It leaves on its next keepable answer,
	 *  on {@link clear}, and on any {@link transformCache} that touches it, so the map is bounded by
	 *  the source's unmet floors plus the ids caught mid-flight by a clear or a fold. */
	private unkept = new Map<BlockId, { block: T; rev: number }>();

	constructor(
		protected readonly source: BlockSource<T>,
		maxSize = DefaultMaxSize,
		/** Shared per-transaction read-dependency accumulator (same instance the collection's
		 *  TransactorSource holds). Optional: log-walk caches that never form a transaction omit it. */
		private readonly collector?: ReadDependencyCollector,
		/** Pre-warm entries for a pinned read view — the output of another cache's
		 *  {@link snapshotEntries}. Entries are already cloned by snapshotEntries, so they are
		 *  adopted as-is; per-id revisions ride along so a seeded HIT still records at the
		 *  revision the block was committed at. Seeding does not bump generations (a fresh
		 *  cache has no consumers with stale memos). */
		seed?: ReadonlyArray<[BlockId, T, number]>,
	) {
		this.cache = new LruMap(maxSize);
		if (seed) {
			for (const [id, block, revision] of seed) {
				this.cache.set(id, block);
				this.revisions.set(id, revision);
			}
		}
	}

	private bump(id: BlockId) {
		this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
	}

	/** The current generation for an id — advances every time this cache's content for
	 * the id changes (miss-load, clear, or transformCache). Stable across pure cache hits. */
	getGeneration(id: BlockId): number {
		return this.generations.get(id) ?? 0;
	}

	/** INVARIANT: what a read returns for an id is what this cache then describes for it — the
	 *  block {@link peek} answers and the revision {@link getCachedRevision} answers, immediately
	 *  after, are the content the reader holds, on every path (hit, kept, handed through, evicted
	 *  since). A write staged over the returned content pins that revision as its base, so a read
	 *  that returned one thing while the cache described another would put a wrong base on the
	 *  commit — the one direction the storage-side guard cannot catch. {@link admit} is where the
	 *  two are decided together. */
	async tryGet(id: BlockId, purpose: ReadPurpose = 'value'): Promise<T | undefined> {
		const hit = this.cache.get(id);
		if (hit) {
			// Cache hit: the source is never consulted, so re-emit the revision we learned when this
			// id was first loaded/folded. Without this a block served from cache records NO read
			// dependency (the original bug), so its stale-read check could never fire. Carry the
			// caller's purpose so a navigation-only cache hit stays droppable from the conflict set.
			const rev = this.revisions.get(id);
			if (rev !== undefined) this.collector?.record(id, rev, purpose);
			log('hit id=%s', id);
			return structuredClone(hit);
		}
		const generationAtMiss = this.getGeneration(id);
		const answer = await this.source.tryGet(id, purpose);
		if (!answer) {
			// Absent block: record nothing (matches TransactorSource, which skips missing blocks).
			log('miss:absent id=%s', id);
			return undefined;
		}
		const { rev, mayRetain } = sourceServed(this.source, id, answer);
		const served = this.admit(id, answer, rev, mayRetain, generationAtMiss);
		// Record the dependency at the revision RETURNED. On a miss the underlying TransactorSource
		// already recorded the answer's own id@rev/purpose into the shared collector; max-wins
		// (revision) + value-wins (purpose) collapse the two to one entry, at the higher revision.
		this.collector?.record(id, served.rev, purpose);
		return structuredClone(served.block);
	}

	/** Decide, for an answer the source just gave for `id`, what the reader gets and what this cache
	 *  describes for the id from now on — one decision, so the two cannot come apart.
	 *
	 *  A keepable answer that is {@link stillWanted} is kept and returned. Otherwise the answer is
	 *  either below its floor or was overtaken while in flight, and of two answers to one id the
	 *  higher revision is the truer — so if content is HELD for the id (a concurrent read answered
	 *  well, a folded commit, or content that met a floor this answer does not), the held content is
	 *  what the reader gets, exactly as a hit a moment later would get it; the answer leaves no trace.
	 *  Held content is never older than a below-floor answer: raising a floor forgets the id in the
	 *  same step, so anything held for it since met the floor. With nothing held, the answer is
	 *  handed through (see {@link handThrough}): returned, described, not kept. */
	private admit(id: BlockId, answer: T, rev: number, mayRetain: boolean, generationAtMiss: number): { block: T; rev: number } {
		if (mayRetain && this.stillWanted(id, rev, generationAtMiss)) {
			this.keep(id, answer, rev);
			return { block: answer, rev };
		}
		const held = this.cache.get(id);
		const heldRev = held === undefined ? undefined : this.revisions.get(id);
		if (held !== undefined && heldRev !== undefined) {
			log('miss:superseded id=%s rev=%d heldRev=%d unkeepable=%s', id, rev, heldRev, !mayRetain);
			return { block: held, rev: heldRev };
		}
		this.handThrough(id, answer, rev);
		return { block: answer, rev };
	}

	/** Whether an answer at `rev`, asked for when this id's generation was `generationAtMiss`, is
	 *  still one to keep now that it has arrived.
	 *
	 *  A miss is decided before the `await` and acted on after it. If the generation has not moved,
	 *  nothing happened to the id meanwhile and the answer is kept. If it has — a second read of the
	 *  id landed first, a refresh cleared it, a commit folded in ({@link transformCache}) — this answer
	 *  was asked for in a world that has since changed, and keeping it blindly is how old content gets
	 *  remembered for good: nothing clears a block but a log entry naming it, and that entry may be
	 *  the very thing that moved the generation. So it is then kept only to REPLACE strictly older
	 *  content (every answer to one source is for one view, so of two the higher revision is the
	 *  truer, whichever arrives last); what an overtaken answer's reader gets is {@link admit}'s call.
	 *  Only a CACHED id is compared: `revisions` outlives an LRU-evicted block (see its NOTE). */
	private stillWanted(id: BlockId, rev: number, generationAtMiss: number): boolean {
		if (this.getGeneration(id) === generationAtMiss) {
			return true;
		}
		const held = this.cache.has(id) ? this.revisions.get(id) : undefined;
		const replacesOlder = held !== undefined && held < rev;
		if (!replacesOlder) {
			log('miss:overtaken id=%s rev=%d heldRev=%s', id, rev, held ?? 'none');
		}
		return replacesOlder;
	}

	/** A keepable answer: cached, and served to every later read of `id` until something clears it. */
	private keep(id: BlockId, block: T, rev: number) {
		this.cache.set(id, block);
		this.revisions.set(id, rev);
		this.unkept.delete(id);
		this.bump(id);
		log('miss:loaded id=%s cacheSize=%d', id, this.cache.size);
	}

	/** An answer this cache will not keep, over an id it holds nothing for: returned to this one
	 *  reader and described to the base probes (see {@link unkept}), but the next read of `id` asks
	 *  the source again. Only {@link admit} calls this, after establishing that nothing is held —
	 *  a cached id is never also in {@link unkept}.
	 *
	 *  Bumped like a load: the answer changes what this cache can say about the id, and the bump is
	 *  what sends a base pin or a materialized memo built on the previous answer back to be
	 *  re-judged. */
	private handThrough(id: BlockId, block: T, rev: number) {
		this.revisions.delete(id);
		this.unkept.set(id, { block, rev });
		this.bump(id);
		log('miss:unkept id=%s rev=%d', id, rev);
	}

	/** The base this cache can describe for `id`, without consulting the source: the cached block,
	 *  or the content last handed through unkept (see {@link unkept}) — either way the content the
	 *  most recent {@link tryGet} of the id returned, unless it has been evicted since. Cloned
	 *  (callers apply ops to it) and recency-neutral ({@link LruMap.peek}) — an observation pass must
	 *  neither pay a network read nor reshape eviction order. Records no read dependency: the caller
	 *  that peeks already read the block through {@link tryGet} (that is how this cache learned it),
	 *  so the dependency exists; a digest pass merely re-describes it. */
	peek(id: BlockId): T | undefined {
		const block = this.cache.peek(id) ?? this.unkept.get(id)?.block;
		return block === undefined ? undefined : structuredClone(block);
	}

	/** Whether a later {@link tryGet} of `id` is answered from memory with the content this cache
	 *  holds now. `false` for content handed through unkept, which {@link peek} still describes — so
	 *  a consumer that would FREEZE a read result ({@link Tracker}'s materialized memo) asks this, not
	 *  {@link peek}. Recency-neutral. */
	retains(id: BlockId): boolean {
		return this.cache.has(id);
	}

	/** The committed revision of the content this cache last served for `id` — the source-reported
	 *  materialized revision learned on miss-load (see {@link revisions}) or handed through
	 *  ({@link unkept}), NOT the block's own `state.latest.rev`. Answers for an LRU-evicted id too
	 *  (see the NOTE on {@link revisions}): that is the revision a write staged over the evicted
	 *  read was computed against, and what a rev-only base pin carries. {@link peek} returns
	 *  `undefined` for the evicted id, so the revision never pairs with content it does not describe.
	 *  `undefined` once the id has been cleared or folded away, or if it was never served. */
	getCachedRevision(id: BlockId): number | undefined {
		return this.revisions.get(id) ?? this.unkept.get(id)?.rev;
	}

	/** Upgrade an already-captured read of `id` to a `value` read in the shared collector,
	 *  retaining it in the conflict set. The B-tree point-lookup descent calls this (through the
	 *  Tracker, which forwards) to pin the terminal leaf after recording the interior nodes as
	 *  `navigation`. No-op when no collector is wired (log-walk caches) or the id was never
	 *  recorded. Duck-typed by the Tracker; keep the name in sync with Tracker.markReadValue. */
	markReadValue(id: BlockId): void {
		this.collector?.markValue(id);
	}

	generateId(): BlockId {
		return this.source.generateId();
	}

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return this.source.createBlockHeader(type, newId);
	}

	clear(blockIds: BlockId[] | undefined = undefined) {
		if (blockIds) {
			for (const id of blockIds) {
				this.cache.delete(id);
				this.revisions.delete(id);
				this.unkept.delete(id);
				this.bump(id);
			}
		} else {
			for (const [id] of this.cache) {
				this.bump(id);
			}
			for (const id of this.unkept.keys()) {
				this.bump(id);
			}
			this.cache.clear();
			this.revisions.clear();
			this.unkept.clear();
		}
	}

	/** A cloned copy of the current cache contents with each id's committed revision, in LRU
	 *  order (oldest first, so replaying into another LruMap preserves eviction order). For
	 *  building a pinned read view ONLY (see {@link Collection.createReadTracker}): pass the
	 *  result as the `seed` of a fresh, PRIVATE CacheSource. Blocks are cloned on the way out,
	 *  so the seeded cache shares no mutable state with this one. */
	snapshotEntries(): Array<[BlockId, T, number]> {
		const entries: Array<[BlockId, T, number]> = [];
		for (const [id, block] of this.cache) {
			entries.push([id, structuredClone(block), this.revisions.get(id) ?? 0]);
		}
		return entries;
	}

	/** Mutates the cache without affecting the source. `revision` is the committed revision this
	 *  transform lands at; the stored per-id revision advances to it so a later read records a
	 *  dependency at the NEW revision (recording the old one would spuriously fail validation). */
	transformCache(transform: Transforms, revision: number) {
		for (const blockId of transform.deletes ?? []) {
			this.cache.delete(blockId);
			this.revisions.delete(blockId);
			this.unkept.delete(blockId);
			this.bump(blockId);
		}
		for (const [, block] of Object.entries(transform.inserts ?? {})) {
			this.cache.set(block.header.id, structuredClone(block) as T);
			this.revisions.set(block.header.id, revision);
			this.unkept.delete(block.header.id);
			this.bump(block.header.id);
		}
		for (const [blockId, operations] of Object.entries(transform.updates ?? {})) {
			const block = this.cache.get(blockId);
			if (block) {
				for (const op of operations) {
					applyOperation(block, op);
					this.bump(blockId);
				}
				this.revisions.set(blockId, revision);
			} else if (this.unkept.delete(blockId)) {
				// The commit superseded the unkept base, and the ops are NOT folded into it: it was
				// never trusted as this id's content, so the result would not be either. The id stays
				// out of memory and the next read asks the source, which now holds `revision`.
				this.bump(blockId);
			}
		}
	}
}
