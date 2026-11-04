/**
 * The judgement at the seams the SQL-level cases in offline-outlook.spec.ts cannot reach, pure, over
 * `judgeTransaction` with a hand-built schema; nothing is staged or queued. The dependency rule for
 * unchecked decisions (docs/offline-sync.md §Dependencies between entries): the schema the judgement is
 * handed, and the deferred journaled records ahead of the entry. And the three already-applied guard
 * kinds (docs/offline-sync.md §Guards that make idempotent writes assured), handed as staged actions:
 * judged as their base kinds, with `tolerates` on the exposures they produce.
 */

import { expect } from 'chai';
import type { Action } from '@optimystic/db-core';
import { followCommit, followOutlooks, judgeTransaction, renderCommitOutlook, WriteIndex } from '../src/optimystic-adapter/commit-outlook.js';
import type { CommitOutlook, EarlierEntry, EntryFacts, FollowedEntry, OutlookSchema, SequencedJudgement, StagedWrites } from '../src/optimystic-adapter/commit-outlook.js';
import type { UncheckedRead } from '../src/optimystic-adapter/write-description.js';

const NOTES = 'outlook/notes';

/** An index of `entries`, each added in order. */
function indexOf(entries: readonly EarlierEntry[]): WriteIndex {
	const index = new WriteIndex();
	for (const entry of entries) index.add(entry);
	return index;
}

/** A `row` read of `Notes` pinned to `n7`, as `uncheckedOf` records it. */
const readOfNote7: UncheckedRead = { table: { schema: 'main', table: 'notes' }, kind: 'read', scope: 'row', rows: [{ key: ['id'], values: ['n7'] }] };

const facts = (unchecked: readonly UncheckedRead[]): EntryFacts => ({ fresh: new Map(), unchecked, complete: true });

/** The schema with `Notes` published; its main tree encodes every pinned row to `K` once `initialized`. */
function schema(initialized: boolean): OutlookSchema {
	return {
		describe: () => ({ kind: 'unknown', table: undefined }),
		table: name => name.table === 'notes'
			? { name: 'main.Notes', ...(initialized ? { tree: { collectionId: NOTES, rowKey: () => 'K' } } : {}) }
			: undefined,
	};
}

/** An earlier entry whose segments are in `tables` but cannot be matched by key here: none are staged. */
const earlier = (transactionId: string, seq: number, tables: readonly string[]): EarlierEntry =>
	({ transactionId, seq, writes: new Map(), tables, assured: true, facts: undefined });

/** The schema with `Notes` published and initialized: its main tree is `NOTES`, each key decoding to itself. */
function notesSchema(singleWriter = false): OutlookSchema {
	return {
		describe: id => id === NOTES
			? { kind: 'main', table: 'main.Notes', freshKey: false, singleWriter, decodeKey: key => [key] }
			: { kind: 'unknown', table: undefined },
		table: () => undefined,
	};
}

/** A tree `replace` action over `elements`, each `[key, entry | undefined, guard]` as the vtab stages them. */
const replace = (...elements: readonly (readonly unknown[])[]): Action<unknown> => ({ type: 'replace', data: elements });

const NO_FACTS: EntryFacts = { fresh: new Map(), unchecked: [], complete: true };

/** The outlook of a transaction whose one segment, in `NOTES`, is `actions`, queued behind `ahead`. */
function judgedNotes(actions: readonly Action<unknown>[], schema: OutlookSchema, ahead: readonly EarlierEntry[] = []): CommitOutlook {
	return judgeTransaction({ writes: new Map([[NOTES, actions]]), tables: ['main.Notes'], facts: NO_FACTS }, schema, indexOf(ahead), []).outlook;
}

describe('commit-outlook: the already-applied guard kinds', () => {
	it('each variant is judged as its base kind, its exposure tolerating the same change, beside the base kind\'s which does not', () => {
		const outlook = judgedNotes([replace(
			['n1', ['n1', 'row'], { kind: 'absentOrEqual' }],
			['n2', ['n2', 'row'], { kind: 'unchangedOrEqual', expected: ['n2', 'old'] }],
			['n3', undefined, { kind: 'unchangedOrAbsent', expected: ['n3', 'old'] }],
			['n4', ['n4', 'row'], { kind: 'unchanged', expected: ['n4', 'old'] }],
		)], notesSchema());
		expect(outlook.kind).to.equal('exposed');
		expect(outlook.exposures).to.deep.equal([
			{ table: 'main.Notes', rule: 'primary-key', key: ['n1'], tolerates: 'same-change' },
			{ table: 'main.Notes', rule: 'row', key: ['n2'], tolerates: 'same-change' },
			{ table: 'main.Notes', rule: 'row', key: ['n3'], tolerates: 'same-change' },
			{ table: 'main.Notes', rule: 'row', key: ['n4'] },
		]);
		const rendered = JSON.parse(renderCommitOutlook(outlook)) as { exposures: Record<string, unknown>[] };
		expect(rendered.exposures.map(exposure => exposure['tolerates'])).to.deep.equal(['same-change', 'same-change', 'same-change', undefined]);
	});

	it('under a single-writer table the two unchanged variants are not exposed, as unchanged is not', () => {
		const outlook = judgedNotes([replace(
			['n2', ['n2', 'row'], { kind: 'unchangedOrEqual', expected: ['n2', 'old'] }],
			['n3', undefined, { kind: 'unchangedOrAbsent', expected: ['n3', 'old'] }],
		)], notesSchema(true));
		expect(outlook).to.deep.equal({ kind: 'assured', exposures: [], dependsOn: [], unchecked: [] });
	});

	it('an absentOrEqual insert covers a later check at its key, and counts as an insert under a fresh key for the entries behind it', () => {
		const insert = replace(['n5', ['n5', 'row'], { kind: 'absentOrEqual' }]);
		const update = replace(['n5', ['n5', 'row2'], { kind: 'unchanged', expected: ['n5', 'row'] }]);
		expect(judgedNotes([insert, update], notesSchema()).exposures, 'judged once, by the insert')
			.to.deep.equal([{ table: 'main.Notes', rule: 'primary-key', key: ['n5'], tolerates: 'same-change' }]);

		const inserter: EarlierEntry = {
			transactionId: 'inserter', seq: 1, writes: new Map([[NOTES, [insert]]]), tables: ['main.Notes'], assured: true,
			facts: { fresh: new Map([[NOTES, new Set(['n5'])]]), unchecked: [], complete: true },
		};
		expect(judgedNotes([update], notesSchema(), [inserter]), 'no other machine can know the row yet')
			.to.deep.equal({ kind: 'assured', exposures: [], dependsOn: [{ transactionId: 'inserter', via: 'guard' }], unchecked: [] });
	});
});

describe('commit-outlook: matching an unchecked decision against what is ahead', () => {
	it('a row read on a published table not yet initialized is named by the table\'s rendering and matched by table', () => {
		const { outlook } = judgeTransaction(
			{ writes: new Map(), tables: ['main.Memos'], facts: facts([readOfNote7]) },
			schema(false),
			indexOf([earlier('writer-of-notes', 1, ['main.Notes']), earlier('writer-of-users', 2, ['main.Users'])]),
			[],
		);
		expect(outlook.unchecked).to.deep.equal([{ table: 'main.Notes', kind: 'read', scope: 'row' }]);
		expect(outlook.dependsOn).to.deep.equal([{ transactionId: 'writer-of-notes', via: 'unchecked' }]);
	});

	it('a row read matched by key still depends on a deferred record that wrote the table, whose writes cannot be matched by key', () => {
		const { outlook } = judgeTransaction(
			{ writes: new Map(), tables: ['main.Memos'], facts: facts([readOfNote7]) },
			schema(true),
			new WriteIndex(),
			[{ transactionId: 'deferred-notes', seq: 1, tables: ['main.Notes'] }, { transactionId: 'deferred-users', seq: 2, tables: ['main.Users'] }],
		);
		expect(outlook.dependsOn).to.deep.equal([{ transactionId: 'deferred-notes', via: 'unchecked' }]);
		expect(outlook.kind, 'a dependency through a decision does not bear on the kind').to.equal('assured');
	});
});

describe('commit-outlook: following a commit without the queue', () => {
	const MEMOS = 'outlook/memos';
	const BODY = 'outlook/notes/index/body';
	/** Enough that dependencies stay sparse: chains, rather than everything depending on everything. */
	const KEYS = Array.from({ length: 16 }, (_, index) => `k${index}`);

	const queueSchema: OutlookSchema = {
		describe: id => {
			if (id === BODY) return { kind: 'unique-index', table: 'main.Notes', columns: ['body'], freshValue: false, decodeValue: key => [key] };
			const table = id === NOTES ? 'main.Notes' : 'main.Memos';
			return { kind: 'main', table, freshKey: false, singleWriter: false, decodeKey: key => [key] };
		},
		table: name => name.table === 'notes'
			? { name: 'main.Notes', tree: { collectionId: NOTES, rowKey: (_key, values) => String(values[0]) } }
			: undefined,
	};

	/** A small deterministic generator (mulberry32), so a failure reproduces from its seed. */
	function randomFrom(seed: number): () => number {
		let state = seed;
		return () => {
			state = (state + 0x6d2b79f5) | 0;
			let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
			mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
			return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
		};
	}

	/** One element in a main tree, with `fresh` gaining its key when its statement says it came from a
	 * fresh source: mostly checks that expose nothing, so that assured and exposed transactions mix. */
	function mainElement(random: () => number, fresh: Set<string>): readonly unknown[] {
		const key = KEYS[Math.floor(random() * KEYS.length)]!;
		const pick = random();
		if (pick < 0.15) return [key, [key, 'row']];
		if (pick < 0.85) {
			fresh.add(key);
			return [key, [key, 'row'], { kind: pick < 0.5 ? 'absent' : 'absentOrEqual' }];
		}
		if (pick < 0.93) return [key, [key, 'row2'], { kind: 'unchanged', expected: [key, 'row'] }];
		if (pick < 0.97) return [key, [key, 'row'], { kind: 'absent' }];
		return [key, undefined, { kind: 'unchangedOrAbsent', expected: [key, 'row'] }];
	}

	function bodyElement(random: () => number): readonly unknown[] {
		const value = KEYS[Math.floor(random() * KEYS.length)]!;
		const range = { first: { key: value, inclusive: true }, last: { key: `${value}~`, inclusive: false }, isAscending: true };
		return [`${value}|pk`, [value], random() < 0.5 ? { kind: 'absentRange', range } : undefined];
	}

	function randomFacts(random: () => number, fresh: ReadonlyMap<string, ReadonlySet<string>>): EntryFacts | undefined {
		if (random() < 0.05) return undefined;
		const pick = random();
		const value = KEYS[Math.floor(random() * KEYS.length)]!;
		const unchecked: UncheckedRead[] = pick < 0.2 ? [{ table: { schema: 'main', table: 'notes' }, kind: 'read', scope: 'row', rows: [{ key: ['id'], values: [value] }] }]
			: pick < 0.3 ? [{ table: { schema: 'main', table: 'notes' }, kind: 'foreign-key', scope: 'global', rows: [] }]
				: [];
		return { fresh, unchecked, complete: random() >= 0.05 };
	}

	/** A transaction's writes and facts: a segment in one or more collections, now and then unreadable. */
	function randomTransaction(random: () => number): { writes: StagedWrites; tables: string[]; facts: EntryFacts | undefined } {
		const writes = new Map<string, readonly Action<unknown>[] | undefined>();
		const fresh = new Map<string, Set<string>>();
		const inCollection = (id: string, element: () => readonly unknown[]): void => {
			const count = 1 + Math.floor(random() * 2);
			writes.set(id, random() < 0.05 ? undefined : [replace(...Array.from({ length: count }, element))]);
		};
		for (const id of [NOTES, MEMOS]) {
			if (random() >= 0.6) continue;
			const freshHere = new Set<string>();
			fresh.set(id, freshHere);
			inCollection(id, () => mainElement(random, freshHere));
		}
		if (random() < 0.25) inCollection(BODY, () => bodyElement(random));
		const tables = [...new Set([...writes.keys()].map(id => (id === MEMOS ? 'main.Memos' : 'main.Notes')))];
		return { writes, tables, facts: randomFacts(random, fresh) };
	}

	it('answers what the walk answers, after each commit of a head, and the kept index what a fresh one does', () => {
		let losses = 0;
		let kindChanges = 0;
		const kinds = new Set<string>();
		for (let seed = 1; seed <= 400; seed++) {
			const random = randomFrom(seed);
			const judgements = new Map<string, SequencedJudgement>();
			const dependents = new Map<string, Set<string>>();
			const kept = new WriteIndex();
			/** The queue, each entry with the outlook it had when a replay refused it, once one has. */
			const queue: { readonly entry: EarlierEntry; refusedAs?: CommitOutlook }[] = [];
			const length = 2 + Math.floor(random() * 15);
			for (let seq = 1; seq <= length; seq++) {
				const transactionId = `t${seq}`;
				const transaction = randomTransaction(random);
				const judgement = judgeTransaction(transaction, queueSchema, kept, []);
				judgements.set(transactionId, { ...judgement, seq });
				for (const { transactionId: dependency } of judgement.outlook.dependsOn) {
					dependents.set(dependency, (dependents.get(dependency) ?? new Set()).add(transactionId));
				}
				const entry: EarlierEntry = {
					transactionId, seq, ...transaction,
					get assured() { return judgements.get(transactionId)?.outlook.kind === 'assured'; },
				};
				kept.add(entry);
				queue.push({ entry });
				kinds.add(judgement.outlook.kind);
			}
			// A refused head fails rather than commits, which is the walk's to follow.
			while (queue.length > 1 && queue[0]!.refusedAs === undefined) {
				const head = queue.shift()!.entry.transactionId;
				if (random() < 0.1) {
					const refusing = queue[Math.floor(random() * queue.length)]!;
					refusing.refusedAs ??= judgements.get(refusing.entry.transactionId)!.outlook;
				}
				const refused = (id: string): boolean => queue.some(({ entry, refusedAs }) => refusedAs !== undefined && entry.transactionId === id);

				judgements.delete(head);
				kept.remove(head);
				const followed = followCommit(head, judgements, dependents, refused);
				dependents.delete(head);
				for (const [id, judgement] of followed) {
					const held = judgements.get(id)!;
					losses += held.outlook.dependsOn.length - judgement.outlook.dependsOn.length;
					if (held.outlook.kind !== judgement.outlook.kind) kindChanges++;
					judgements.set(id, { ...judgement, seq: held.seq });
				}

				const walked = followOutlooks(queue.map(({ entry, refusedAs }): FollowedEntry => ({
					transactionId: entry.transactionId, seq: entry.seq, writes: entry.writes, tables: entry.tables,
					committedCollections: [], facts: entry.facts, judgement: judgements.get(entry.transactionId), refused: refusedAs !== undefined,
				})), []);
				for (const { entry, refusedAs } of queue) {
					expect(judgements.get(entry.transactionId)!.outlook, `seed ${seed}: ${entry.transactionId} after ${head} committed`)
						.to.deep.equal(refusedAs ?? walked.get(entry.transactionId)!.outlook);
				}
				expect(kept, `seed ${seed}: the index after ${head} committed`).to.deep.equal(indexOf(queue.map(({ entry }) => entry)));
			}
		}
		expect(kinds, 'the generated queues mix both kinds').to.have.all.keys('assured', 'exposed');
		expect(losses, 'commits took a dependency off a transaction behind them').to.be.greaterThan(0);
		expect(kindChanges, 'commits changed a kind').to.be.greaterThan(0);
	});

	it('works a transaction out after every dependency it has, though a kind change reaches it late, and answers in queue order', () => {
		const exposedThrough = (seq: number, ...dependsOn: string[]): SequencedJudgement => ({
			seq,
			own: { exposures: [], guarded: [], unchecked: [] },
			outlook: { kind: 'exposed', exposures: [], dependsOn: dependsOn.map(transactionId => ({ transactionId, via: 'guard' })), unchecked: [] },
		});
		// `d` lists the committed `h` directly and `c` only through a change that starts at `b`.
		const judgements = new Map([['b', exposedThrough(2, 'h')], ['c', exposedThrough(3, 'b')], ['d', exposedThrough(4, 'h', 'c')]]);
		const dependents = new Map([['h', new Set(['b', 'd'])], ['b', new Set(['c'])], ['c', new Set(['d'])]]);

		const followed = followCommit('h', judgements, dependents, () => false);

		expect([...followed].map(([id, { outlook }]) => [id, outlook.kind])).to.deep.equal([['b', 'assured'], ['c', 'assured'], ['d', 'assured']]);
	});
});
