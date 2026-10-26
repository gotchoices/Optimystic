import type { SqlValue } from '@quereus/quereus';
import { TreeRangeTakenError } from '@optimystic/db-core';
import type { Action, CollectionId, QueuedFailureReason, TreeGuardRefusedError } from '@optimystic/db-core';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

/**
 * Whether anything another writer does could make a queued transaction fail, and if so what
 * (docs/offline-sync.md §Predicting whether an entry will commit). Delivered on the `queued` status
 * and answered for an open transaction by `CommitOutlook()`.
 */
export type CommitOutlook = {
	/** `'assured'`: no other writer can make this transaction fail — it has no exposure, and every
	 * transaction it depends on is assured. `'exposed'`: some can; `exposures` and `dependsOn` say which. */
	readonly kind: 'assured' | 'exposed';
	/** What another writer would have to do for one of the transaction's checks to refuse it, one per
	 * check that can: collection by collection, in staging order within each. Empty when assured. */
	readonly exposures: readonly Exposure[];
	/** Earlier unsettled transactions whose failure would fail this one, each once, in queue order. */
	readonly dependsOn: readonly OutlookDependency[];
	/** Decisions made against rows nothing re-checks when the transaction is submitted. Needs a
	 * description of what each statement read, which this build does not have, so it is always
	 * `'not-computed'` — a string rather than an absent field, so the JSON `CommitOutlook()` answers
	 * says so too. */
	readonly unchecked: readonly UncheckedDecision[] | 'not-computed';
};

export type Exposure = {
	/** `schema.table`, or the collection id when no table describes the collection. */
	readonly table: string;
	/** The check: `'primary-key'` (an INSERT's key must still be free), `'unique'` (a UNIQUE value must
	 * still be free), `'row'` (the row an UPDATE, DELETE or REPLACE read must be unchanged — and every
	 * check the analysis could not read). */
	readonly rule: 'primary-key' | 'unique' | 'row';
	/** The contended primary key, or for `'unique'` the unique value; `undefined` when not known. */
	readonly key: readonly SqlValue[] | undefined;
	/** For `'unique'`: the constraint's columns. */
	readonly columns?: readonly string[];
};

export type OutlookDependency = {
	readonly transactionId: string;
	/** `'guard'`: one of this transaction's checks covers what the earlier one wrote, so it refuses
	 * when the earlier one fails. `'unchecked'` arrives with the statement analysis. */
	readonly via: 'guard' | 'unchecked';
};

export type UncheckedDecision = {
	readonly table: string;
	readonly kind: 'foreign-key' | 'check' | 'assertion' | 'read' | 'row-selection';
	readonly scope: 'row' | 'group' | 'global';
};

// ── what a table says about its collections ──────────────────────────────────────────────────

/** A table's main tree: keyed by the framed primary key, carrying `absent` and `unchanged` checks. */
export type MainTreeDescription = {
	readonly kind: 'main';
	readonly table: string;
	/** At least one primary-key column is tagged `"optimystic.fresh" = true`. */
	readonly freshKey: boolean;
	/** The table is tagged `"optimystic.single_writer" = true`. */
	readonly singleWriter: boolean;
	/** A tree key's primary-key values, in key order, or `undefined` when it does not decode. */
	decodeKey(key: string): readonly SqlValue[] | undefined;
};

/** An index tree that enforces a UNIQUE constraint, carrying `absentRange` checks over a value's prefix. */
export type UniqueIndexDescription = {
	readonly kind: 'unique-index';
	readonly table: string;
	readonly columns: readonly string[];
	/** At least one of the constraint's columns is tagged `"optimystic.fresh" = true`. */
	readonly freshValue: boolean;
	/** A framed unique value's values, or `undefined` when it does not decode. */
	decodeValue(indexKey: string): readonly SqlValue[] | undefined;
};

/** What a table can say about one of its collections. */
export type TableCollectionDescription = MainTreeDescription | UniqueIndexDescription | { readonly kind: 'index'; readonly table: string };

/** Published by each table to the offline-mode controller beside its offline policy, and asked when
 * a transaction is judged: read at call time, so a tag change or an index created since needs no
 * re-publication. `undefined` for a collection that is not one of the table's. */
export interface TableOutlookSource {
	describe(collectionId: CollectionId): TableCollectionDescription | undefined;
}

/** What the judgement is told about a collection: a table's description, or — when no published
 * table describes it — at most the name of a table recorded for it. */
export type CollectionDescription = TableCollectionDescription | { readonly kind: 'unknown'; readonly table: string | undefined };

// ── the judgement's inputs ───────────────────────────────────────────────────────────────────

/** One transaction's staged actions per collection it wrote, in the order its collections were
 * sealed; `undefined` for a collection whose segment could not be read. */
export type StagedWrites = ReadonlyMap<CollectionId, readonly Action<unknown>[] | undefined>;

/** An unsettled queue entry ahead of the transaction being judged. */
export type EarlierEntry = {
	readonly transactionId: string;
	readonly seq: number;
	/** The segments it still holds — not those a partial commit already committed. */
	readonly writes: StagedWrites;
	/** Its own outlook's kind. */
	readonly assured: boolean;
};

/** A journaled transaction the restore after a restart has not put back yet: its writes are not
 * staged, so nothing can be matched against them, and it counts as exposed. */
export type DeferredTransaction = {
	readonly transactionId: string;
	readonly seq: number;
	readonly tables: readonly string[];
};

/** The transaction being judged: its staged writes, and `schema.table` of every table it wrote. */
export type JudgedTransaction = { readonly writes: StagedWrites; readonly tables: readonly string[] };

/** What is queued ahead of the transaction being judged, in queue order. */
export type QueueAhead = { readonly earlier: readonly EarlierEntry[]; readonly deferred: readonly DeferredTransaction[] };

/** What one check covers: the exact key for `absent` and `unchanged`, the range for `absentRange`,
 * everything the collection holds for a check the analysis cannot read. */
type GuardSpan =
	| { readonly kind: 'key'; readonly key: string }
	| { readonly kind: 'range'; readonly range: StringRange }
	| { readonly kind: 'whole' };

type StringBound = { readonly key: string; readonly inclusive: boolean };
type StringRange = { readonly first?: StringBound; readonly last?: StringBound };

/** The part of an outlook that depends on nothing but the transaction and what was queued when it
 * was judged — its own exposures, with the collection each came from, and what each judged check
 * covers — against which its dependencies are matched. Fixed when the transaction is judged
 * (docs/offline-sync.md §The outlook); only a partial commit narrows it ({@link followOutlooks}). */
export type OwnJudgement = {
	readonly exposures: readonly { readonly collectionId: CollectionId; readonly exposure: Exposure }[];
	readonly guarded: readonly { readonly collectionId: CollectionId; readonly span: GuardSpan }[];
};

/** A queued transaction's outlook beside the own judgement it was computed from, which is what
 * {@link followOutlooks} recomputes the outlook from as the queue changes. */
export type QueuedJudgement = { readonly own: OwnJudgement; readonly outlook: CommitOutlook };

/** One queued transaction as {@link followOutlooks} reads it, in queue order. */
export type FollowedEntry = {
	readonly transactionId: string;
	readonly seq: number;
	/** The segments it still holds — not those a partial commit already committed. */
	readonly writes: StagedWrites;
	/** `schema.table` of every table behind those segments. */
	readonly tables: readonly string[];
	/** The collections a partial commit has committed: their checks have passed and can no longer refuse. */
	readonly committedCollections: readonly CollectionId[];
	/** Its judgement as held; `undefined` when it was never judged (its judgement threw, or a restore
	 * has registered it and not yet admitted it), which counts as not assured. */
	readonly judgement: QueuedJudgement | undefined;
	/** A replay has refused one of its segments: it is about to fail, so its outlook is left as it was
	 * judged — the failure, not a change of outlook, is what reports it. */
	readonly refused: boolean;
};

// ── reading staged actions ───────────────────────────────────────────────────────────────────

/** One element of a tree `replace` action as it may arrive: in memory, or restored from the journal
 * or the log (an empty slot comes back `null`, which is why every slot is read by truthiness). */
type ReadElement = { readonly key: string; readonly upsert: boolean; readonly guard: { readonly kind: unknown; readonly [field: string]: unknown } | undefined };

/** An action's elements, or `undefined` when it is not a tree `replace` the analysis can read. */
function replaceElements(action: Action<unknown>): ReadElement[] | undefined {
	if (action.type !== 'replace' || !Array.isArray(action.data)) return undefined;
	const elements: ReadElement[] = [];
	for (const element of action.data as unknown[]) {
		if (!Array.isArray(element) || typeof element[0] !== 'string') return undefined;
		const guard: unknown = element[2];
		if (guard && typeof guard !== 'object') return undefined;
		elements.push({ key: element[0], upsert: Boolean(element[1]), guard: guard ? guard as ReadElement['guard'] : undefined });
	}
	return elements;
}

/** A guard's range read structurally — one restored from the journal is a plain object, not a
 * `KeyRange` — or `undefined` when it is not an ascending range over string keys. */
function readRange(range: unknown): StringRange | undefined {
	if (!range || typeof range !== 'object') return undefined;
	const { first, last, isAscending } = range as { first?: unknown; last?: unknown; isAscending?: unknown };
	if (isAscending === false) return undefined;
	const lower = readBound(first);
	const upper = readBound(last);
	if (lower === null || upper === null) return undefined;
	return { ...(lower === undefined ? {} : { first: lower }), ...(upper === undefined ? {} : { last: upper }) };
}

/** `undefined` for an absent bound (unbounded), `null` for one that cannot be read. */
function readBound(bound: unknown): StringBound | undefined | null {
	if (!bound) return undefined;
	if (typeof bound !== 'object') return null;
	const { key, inclusive } = bound as { key?: unknown; inclusive?: unknown };
	return typeof key === 'string' ? { key, inclusive: inclusive === true } : null;
}

function withinRange(key: string, range: StringRange): boolean {
	const { first, last } = range;
	if (first !== undefined && (first.inclusive ? key < first.key : key <= first.key)) return false;
	if (last !== undefined && (last.inclusive ? key > last.key : key >= last.key)) return false;
	return true;
}

// ── what earlier entries wrote ───────────────────────────────────────────────────────────────

/** The keys one segment writes, and those it inserts under an `absent` check; `undefined` when
 * anything in it cannot be read, which counts as writing every key. */
function writtenKeysIn(actions: readonly Action<unknown>[]): { written: Set<string>; insertedAbsent: Set<string> } | undefined {
	const written = new Set<string>();
	const insertedAbsent = new Set<string>();
	for (const action of actions) {
		const elements = replaceElements(action);
		if (elements === undefined) return undefined;
		for (const element of elements) {
			written.add(element.key);
			if (element.upsert && element.guard?.kind === 'absent') insertedAbsent.add(element.key);
		}
	}
	return { written, insertedAbsent };
}

/** What the entries indexed so far write in one collection. */
type CollectionWrites = {
	/** Each key written, with the entries that wrote it, each once, in queue order. */
	readonly byKey: Map<string, EarlierEntry[]>;
	/** Every entry with a segment here, in queue order: what a check over the whole collection depends on. */
	readonly writers: EarlierEntry[];
	/** The entries whose segment here cannot be read, which count as writing every key. */
	readonly unreadable: EarlierEntry[];
	/** Keys an entry inserted under an `absent` check, from the segments that can be read. */
	readonly insertedAbsent: Set<string>;
};

/**
 * What the entries ahead of a transaction write, per collection, added one entry at a time in queue
 * order: matching a check against everything ahead of it is a lookup rather than a pass over the
 * queue, so judging a whole queue in order ({@link followOutlooks}) indexes each segment once.
 */
class WriteIndex {
	private readonly collections = new Map<CollectionId, CollectionWrites>();

	add(entry: EarlierEntry): void {
		for (const [collectionId, actions] of entry.writes) {
			const writes = this.writesIn(collectionId);
			writes.writers.push(entry);
			const keys = actions === undefined ? undefined : writtenKeysIn(actions);
			if (keys === undefined) {
				writes.unreadable.push(entry);
				continue;
			}
			for (const key of keys.written) {
				const writers = writes.byKey.get(key);
				if (writers === undefined) writes.byKey.set(key, [entry]);
				else writers.push(entry);
			}
			for (const key of keys.insertedAbsent) writes.insertedAbsent.add(key);
		}
	}

	/** Whether an indexed entry inserted `key` in `collectionId` under an `absent` check. */
	insertedAbsent(collectionId: CollectionId, key: string): boolean {
		return this.collections.get(collectionId)?.insertedAbsent.has(key) ?? false;
	}

	/** Every indexed entry that writes inside `span` in `collectionId`, an entry possibly more than once.
	 * NOTE: a range is matched by scanning every key the collection's indexed entries write, so a
	 * unique check behind a long queue of writes to one index is linear in those writes. If judging
	 * ever shows up slow there, keep the keys sorted and seek the range. */
	*writersWithin(collectionId: CollectionId, span: GuardSpan): Iterable<EarlierEntry> {
		const writes = this.collections.get(collectionId);
		if (writes === undefined) return;
		if (span.kind === 'whole') {
			yield* writes.writers;
			return;
		}
		yield* writes.unreadable;
		if (span.kind === 'key') {
			yield* writes.byKey.get(span.key) ?? [];
			return;
		}
		for (const [key, writers] of writes.byKey) {
			if (withinRange(key, span.range)) yield* writers;
		}
	}

	private writesIn(collectionId: CollectionId): CollectionWrites {
		let writes = this.collections.get(collectionId);
		if (writes === undefined) {
			writes = { byKey: new Map(), writers: [], unreadable: [], insertedAbsent: new Set() };
			this.collections.set(collectionId, writes);
		}
		return writes;
	}
}

// ── the judgement ────────────────────────────────────────────────────────────────────────────

/**
 * The outlook of `transaction` were it queued behind `ahead` (docs/offline-sync.md §Predicting
 * whether an entry will commit): its own exposures ({@link ownJudgement}) and what it depends on
 * ({@link outlookFrom}), with the own judgement beside it for {@link followOutlooks}. Holds no state:
 * everything it reads comes through its arguments.
 * NOTE: indexes every earlier entry's segments on each call, so an enqueue behind a long queue is
 * linear in the queue's staged elements. If enqueue ever shows up slow there, keep one index of the
 * queue in the controller, add each entry as it is judged, and rebuild it only when an entry settles.
 */
export function judgeTransaction(
	transaction: JudgedTransaction,
	describe: (collectionId: CollectionId) => CollectionDescription,
	ahead: QueueAhead,
): QueuedJudgement {
	const index = new WriteIndex();
	for (const entry of ahead.earlier) index.add(entry);
	const own = ownJudgement(transaction.writes, describe, index);
	return { own, outlook: outlookFrom(own, transaction.tables, index, ahead.deferred) };
}

/**
 * Bring every queued transaction's outlook up to date with the queue as it is now
 * (docs/offline-sync.md §The outlook): walking `queue` in order, each judged transaction keeps its
 * own judgement, less the exposures and checks in collections a partial commit has committed, and
 * gets its dependencies again against the entries ahead of it as they are now — written-key index
 * built as the walk goes, so each segment is indexed once — and against the `deferred` journaled
 * transactions numbered below it; its kind follows from both, each dependency's kind as computed
 * earlier in the same walk. The own judgement is never redone, so a tag changed since does not move
 * it. A transaction never judged, or already refused, is not recomputed, and counts with the kind it
 * has (none for one never judged) for those behind it. Answers the recomputed judgements.
 */
export function followOutlooks(queue: readonly FollowedEntry[], deferred: readonly DeferredTransaction[]): Map<string, QueuedJudgement> {
	const index = new WriteIndex();
	const followed = new Map<string, QueuedJudgement>();
	for (const entry of queue) {
		let judgement = entry.judgement;
		if (judgement !== undefined && !entry.refused) {
			const own = withoutCollections(judgement.own, new Set(entry.committedCollections));
			const ahead = deferred.filter(record => record.seq < entry.seq);
			judgement = { own, outlook: outlookFrom(own, entry.tables, index, ahead) };
			followed.set(entry.transactionId, judgement);
		}
		index.add({ transactionId: entry.transactionId, seq: entry.seq, writes: entry.writes, assured: judgement?.outlook.kind === 'assured' });
	}
	return followed;
}

/** `own` without what it judged in `collections`. */
function withoutCollections(own: OwnJudgement, collections: ReadonlySet<CollectionId>): OwnJudgement {
	if (collections.size === 0) return own;
	return {
		exposures: own.exposures.filter(({ collectionId }) => !collections.has(collectionId)),
		guarded: own.guarded.filter(({ collectionId }) => !collections.has(collectionId)),
	};
}

/**
 * Judge every check the transaction's staged actions carry, collection by collection and in staging
 * order within each
 * (docs/offline-sync.md §Judging each guard): which another writer can refuse — each an exposure —
 * and what each covers, for {@link outlookFrom} to match against earlier transactions' writes.
 *
 * - A check at a key an earlier element of the same transaction already wrote, in the same
 *   collection, under an `absent` or `unchanged` check is not judged: any change of a rival's that
 *   refuses it refuses that earlier check first. So an insert followed by updates of the row is
 *   judged once, by the insert. An `absentRange` is never covered this way: a rival taking the value
 *   under another key refuses it without touching the earlier element's key.
 * - `absent` is exposed unless the table's primary key is tagged fresh; `absentRange` unless the
 *   unique value is; `unchanged` unless the table is tagged single-writer, or an earlier entry of the
 *   queue inserted the row under a fresh key (no other machine can know it yet).
 * - `keepExisting`, and an element with no check, can never be refused.
 * - Anything the judgement cannot read is exposed, never silent (docs/offline-sync.md §Conservative
 *   by construction): an unknown check kind, an action that is not a tree `replace`, a check in a
 *   collection no table describes or of a kind its collection does not carry, a segment that cannot
 *   be read, a key that does not decode. Each is reported as a `'row'` exposure with no key.
 */
function ownJudgement(
	writes: StagedWrites,
	describe: (collectionId: CollectionId) => CollectionDescription,
	earlier: WriteIndex,
): OwnJudgement {
	const exposures: OwnJudgement['exposures'][number][] = [];
	const guarded: OwnJudgement['guarded'][number][] = [];
	for (const [collectionId, actions] of writes) {
		const judge = new CollectionJudge(collectionId, describe(collectionId), earlier, exposures, guarded);
		if (actions === undefined) {
			judge.unreadable();
			continue;
		}
		for (const action of actions) judge.action(action);
	}
	return { exposures, guarded };
}

/** The judgement of one collection's segment: what it adds to the transaction's exposures and spans. */
class CollectionJudge {
	/** Keys an earlier element of this segment wrote under an `absent` or `unchanged` check. */
	private readonly covered = new Set<string>();

	constructor(
		private readonly collectionId: CollectionId,
		private readonly description: CollectionDescription,
		private readonly earlier: WriteIndex,
		private readonly exposures: OwnJudgement['exposures'][number][],
		private readonly guarded: OwnJudgement['guarded'][number][],
	) {}

	action(action: Action<unknown>): void {
		const elements = replaceElements(action);
		if (elements === undefined) {
			this.unreadable();
			return;
		}
		for (const element of elements) this.element(element);
	}

	/** One exposure and a whole-collection span for something the judgement cannot read. */
	unreadable(): void {
		this.expose({ table: this.description.table ?? this.collectionId, rule: 'row', key: undefined });
		this.cover({ kind: 'whole' });
	}

	private element({ key, guard }: ReadElement): void {
		if (guard === undefined || guard.kind === 'keepExisting') return;
		const exactKey = guard.kind === 'absent' || guard.kind === 'unchanged';
		if (exactKey && this.covered.has(key)) return;
		this.judge(key, guard);
		if (exactKey) this.covered.add(key);
	}

	private judge(key: string, guard: NonNullable<ReadElement['guard']>): void {
		const description = this.description;
		switch (guard.kind) {
			case 'absent':
				if (description.kind !== 'main') return this.unreadable();
				this.cover({ kind: 'key', key });
				if (!description.freshKey) this.exposeKey(description, 'primary-key', key);
				return;
			case 'unchanged':
				if (description.kind !== 'main') return this.unreadable();
				this.cover({ kind: 'key', key });
				if (!description.singleWriter && !(description.freshKey && this.earlier.insertedAbsent(this.collectionId, key))) {
					this.exposeKey(description, 'row', key);
				}
				return;
			case 'absentRange': {
				const range = readRange(guard['range']);
				if (description.kind !== 'unique-index' || range === undefined) return this.unreadable();
				this.cover({ kind: 'range', range });
				if (description.freshValue) return;
				const value = range.first === undefined ? undefined : description.decodeValue(range.first.key);
				this.expose(value === undefined
					? { table: description.table, rule: 'row', key: undefined }
					: { table: description.table, rule: 'unique', columns: description.columns, key: value });
				return;
			}
			default:
				return this.unreadable();
		}
	}

	private exposeKey(description: MainTreeDescription, rule: 'primary-key' | 'row', key: string): void {
		const values = description.decodeKey(key);
		this.expose({ table: description.table, rule: values === undefined ? 'row' : rule, key: values });
	}

	// NOTE: one exposure per judged check, so a bulk offline write of N natural-key rows lists N on one
	// status. If such writes ever make statuses heavy, cap the list and mark it truncated.
	private expose(exposure: Exposure): void {
		this.exposures.push({ collectionId: this.collectionId, exposure });
	}

	private cover(span: GuardSpan): void {
		this.guarded.push({ collectionId: this.collectionId, span });
	}
}

// ── dependencies and kind ────────────────────────────────────────────────────────────────────

/**
 * The outlook of a transaction judged {@link ownJudgement}, given what is queued ahead of it
 * (docs/offline-sync.md §Dependencies between entries): it depends on every earlier entry whose
 * segment in a collection writes inside what one of its checks covers — an earlier failure reverts
 * that write, which can make the check refuse — and on every deferred transaction ahead of it that
 * wrote one of its `tables`, whose writes cannot be matched by key. It is assured exactly when it has
 * no exposure and every transaction it depends on is assured; a deferred one never is.
 */
function outlookFrom(
	own: OwnJudgement,
	ownTables: readonly string[],
	earlier: WriteIndex,
	deferred: readonly DeferredTransaction[],
): CommitOutlook {
	const dependencies = new Map<string, { readonly seq: number; readonly assured: boolean }>();
	for (const { collectionId, span } of own.guarded) {
		for (const writer of earlier.writersWithin(collectionId, span)) {
			dependencies.set(writer.transactionId, { seq: writer.seq, assured: writer.assured });
		}
	}
	const tables = new Set(ownTables);
	for (const record of deferred) {
		if (record.tables.some(table => tables.has(table))) {
			dependencies.set(record.transactionId, { seq: record.seq, assured: false });
		}
	}
	const ordered = [...dependencies].sort(([, a], [, b]) => a.seq - b.seq);
	const assured = own.exposures.length === 0 && ordered.every(([, dependency]) => dependency.assured);
	return {
		kind: assured ? 'assured' : 'exposed',
		exposures: own.exposures.map(({ exposure }) => exposure),
		dependsOn: ordered.map(([transactionId]) => ({ transactionId, via: 'guard' as const })),
		unchecked: 'not-computed',
	};
}

// ── checking a prediction against an outcome ─────────────────────────────────────────────────

/** The failure reasons an outlook predicts: a check refused because of what another writer did, or
 * because an earlier queued transaction failed. Expiry, discard, a validator's rejection and the size
 * limit are properties of this write and this machine, not of other writers. */
const PREDICTED_FAILURES: ReadonlySet<QueuedFailureReason> = new Set<QueuedFailureReason>(['constraint', 'concurrent-modification']);

/** A failed transaction, as {@link outlookContradicted} weighs it. */
export type FailureAgainstOutlook = {
	readonly reason: QueuedFailureReason;
	/** The earlier transaction the queue attributes the failure to, when one is. */
	readonly causedBy: string | undefined;
	/** Whether a transaction the outlook lists in `dependsOn` failed while it was listed there. */
	readonly dependencyFailed: boolean;
};

/**
 * Whether a failure is one `outlook` said could not happen (docs/offline-sync.md §Conservative by
 * construction): the transaction was assured, a check refused, and not because a transaction it
 * depends on failed — neither `causedBy` nor any other dependency. Such a failure is a false
 * `optimystic.fresh` or `optimystic.single_writer` tag, or a defect in the analysis.
 *
 * `dependencyFailed` stands beside `causedBy` because the queue names the NEAREST earlier failing
 * transaction as the cause (`OfflineQueue.causeOf`), which in a chain of failures can be one this
 * transaction never depended on while the one it did depend on failed further up the chain.
 */
export function outlookContradicted(outlook: CommitOutlook | undefined, failure: FailureAgainstOutlook): boolean {
	if (outlook?.kind !== 'assured' || !PREDICTED_FAILURES.has(failure.reason)) return false;
	if (failure.causedBy === undefined) return true;
	return !failure.dependencyFailed && !outlook.dependsOn.some(({ transactionId }) => transactionId === failure.causedBy);
}

/** What a guard refusal names, in the terms of an exposure: the table, and the refused primary key —
 * or, out of a unique index, the unique value — decoded by the collection's description; the key
 * `undefined` when it does not decode. */
export function refusedCheck(refusal: TreeGuardRefusedError, description: CollectionDescription): { readonly table: string; readonly key: readonly SqlValue[] | undefined } {
	const table = description.table ?? refusal.collectionId;
	switch (description.kind) {
		case 'main':
			return { table, key: typeof refusal.key === 'string' ? description.decodeKey(refusal.key) : undefined };
		case 'unique-index': {
			const value = refusal instanceof TreeRangeTakenError ? readRange(refusal.range)?.first?.key : undefined;
			return { table, key: value === undefined ? undefined : description.decodeValue(value) };
		}
		default:
			return { table, key: undefined };
	}
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────

/** `outlook` as the JSON `CommitOutlook()` answers: an unknown key as `null`, and each value the way
 * Quereus renders one in its own JSON output — a bigint as a number when it is a safe integer and as
 * a decimal string otherwise, bytes as `0x` followed by hex. */
export function renderCommitOutlook(outlook: CommitOutlook): string {
	const shape = {
		kind: outlook.kind,
		exposures: outlook.exposures.map(({ table, rule, key, columns }) => ({
			table, rule, key: key ?? null, ...(columns === undefined ? {} : { columns }),
		})),
		dependsOn: outlook.dependsOn,
		unchecked: outlook.unchecked,
	};
	return JSON.stringify(shape, sqlValueJson);
}

/** A key's values as JSON, rendered as {@link renderCommitOutlook} renders them; `null` when unknown. */
export function renderKey(key: readonly SqlValue[] | undefined): string {
	return JSON.stringify(key ?? null, sqlValueJson);
}

function sqlValueJson(_field: string, value: unknown): unknown {
	if (typeof value === 'bigint') {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
	}
	if (value instanceof Uint8Array) return `0x${uint8ArrayToString(value, 'base16')}`;
	return value;
}
