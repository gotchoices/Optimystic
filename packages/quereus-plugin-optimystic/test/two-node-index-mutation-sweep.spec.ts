/**
 * Two-node secondary-index MUTATION sweep — generated UPDATE and DELETE orderings.
 *
 * Every other two-node spec only INSERTs, so the index maintenance an UPDATE or DELETE stages
 * (`updateIndexEntries` and `deleteIndexEntries` in `src/schema/index-manager.ts`) had only ever
 * run on one node. Changing an indexed value is the ordinary way an index entry gets orphaned: the
 * old entry must go, the new one must arrive, and the sibling may hold the tree at a different
 * moment. So this file enumerates mutation shapes the way `two-node-index-interleaving-sweep.spec.ts`
 * enumerates insert orderings, and closes every case on BOTH nodes with the two-way check:
 * `expectIndexAgreesWithScan`, whose structural arm reports an index entry no row implies, which
 * no query can see.
 *
 * Every case starts from one committed state: `FormationUsage (Id, Token)` with an index on Token,
 * A's row (100, 'tok-a') and B's row (200, 'tok-b'), both seen by both nodes' scans before anything
 * mutates. The target is always row 100. "Owner" is A; "sibling" is B.
 *
 * Three generated groups (dimension tables below):
 *
 *   sequential (64)   one node mutates, alone.
 *                     declare × open (redeclare | hydrate) × mutator (owner | sibling) ×
 *                     mutation (to-sibling-value | to-new-value | pk-move | delete) ×
 *                     locate (by-pk | by-index)
 *   racing (32)       both nodes stage in open transactions, then commit in a stated order.
 *                     declare × A's op × B's op (update | delete | insert-shared, never both
 *                     insert-shared) × commit (a-first | b-first)
 *   ignore race (4)   a staged INSERT OR IGNORE loses its key to a plain INSERT committed first.
 *                     declare × loser. (`concurrent-insert-refusal.spec.ts` covers this race on
 *                     an index-free table; this is the indexed shape.)
 *
 * What green means. The sequential group must be clean in every case: a red one is a
 * single-writer orphan producer, which needs its own fix ticket citing the case name. The racing
 * groups are NOT clean under today's replay semantics, and nothing here skips, narrows or softens
 * them for it. Each racing case asserts the exact outcome a small model of those semantics
 * predicts: a clean index where it predicts clean, and otherwise exactly the predicted
 * discrepancies and no others, plus index lookups that still match the scan (the orphan's own
 * value included). The test title of a case with a predicted discrepancy ends in `-> pins ...`.
 * See the NOTE on the model.
 *
 * Running it. Every case runs on every `yarn test`; there is no narrowing switch, because a sweep
 * that only runs when someone remembers a flag cannot catch the bug it exists for. Measured on
 * this package: the file's 104 tests take 7s in mocha (11.7s wall, startup included). In the same
 * session the 144-case insert sweep took 10s, and the package suite with this file took 2m9s, so this
 * file is about 5% of it. Re-measure with, from this package:
 *
 *   node --import ./register.mjs node_modules/mocha/bin/mocha.js \
 *     "test/two-node-index-mutation-sweep.spec.ts" --reporter min --exit
 *
 * NOTE: the file's cost is linear in its case count. If it ever passes ~15s on a quiet machine,
 * cross `open` with `declare` only (keeping `open=redeclare` for the rest of the sequential group)
 * rather than gating the file.
 *
 * If a case goes red, its name is the reproduction. Do not narrow the generator, skip the case, or
 * soften the oracle to get a green run.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import type { ITransactor } from '@optimystic/db-core';
import type { IndexIntegrityReport } from '../dist/index.js';
import {
	countIndexScans, expectIndexAgreesWithScan, expectLookupsAgreeWithScan, queryAll, readIndexIntegrity,
} from './query-helpers.js';
import { createMeshDbNode, startMockMesh, type MeshDbNode as Node } from './mesh-node-harness.js';

// --- schema and the committed starting state -------------------------------------

const TABLE = 'FormationUsage';
const TABLE_URI = `tree://default/${TABLE}`;
const INDEX_NAME = 'formation_usage_by_token';

const createTableSql = `
	create table FormationUsage (
		Id integer primary key,
		Token text
	) using optimystic('${TABLE_URI}')
`;
const createIndexSql = `create index ${INDEX_NAME} on FormationUsage(Token)`;

type Which = 'A' | 'B';
type Nodes = Record<Which, Node>;
const BOTH: readonly Which[] = ['A', 'B'];

interface TableRow {
	Id: number;
	Token: string;
}

/** A's row: the one every case mutates. */
const OWNER_ROW: TableRow = { Id: 100, Token: 'tok-a' };
/** B's row: no case mutates it. */
const SIBLING_ROW: TableRow = { Id: 200, Token: 'tok-b' };
const SEEDED_ROWS: readonly TableRow[] = [OWNER_ROW, SIBLING_ROW];

const insertSql = (id: number, token: string) =>
	`insert into FormationUsage (Id, Token) values (${id}, '${token}')`;

// --- dimensions ------------------------------------------------------------------

/** Which node runs the first `create table`. Block responsibility is by key hash, so the nodes are not symmetric. */
const DECLARERS = ['A', 'B'] as const satisfies readonly Which[];
/**
 * How the other node comes to hold the table and its index, with the insert sweep's meanings:
 * `redeclare` re-issues both statements; `hydrate` issues no DDL and loads both from the persisted
 * catalog. The insert sweep's `both-invent` is omitted: it is about inventing an EMPTY collection,
 * and every mutation here starts from committed rows.
 */
const OPENS = ['redeclare', 'hydrate'] as const;
/** `owner` is A, changing its own row; `sibling` is B, removing an index entry A wrote. */
const MUTATORS = ['owner', 'sibling'] as const;
/**
 * - `to-sibling-value`: Token onto 'tok-b', the value row 200 holds, so two entries share one value prefix.
 * - `to-new-value`: Token onto a value no row holds.
 * - `pk-move`: Id 100 -> 101 with Token kept, so the entry's tree key changes only in its primary-key suffix.
 * - `delete`.
 */
const MUTATIONS = ['to-sibling-value', 'to-new-value', 'pk-move', 'delete'] as const;
/**
 * How the mutation finds row 100: a primary-key lookup, or a seek down the mutator's OWN view of
 * the index (so a node whose index missed the row would silently touch nothing).
 */
const LOCATES = ['by-pk', 'by-index'] as const;

interface SequentialCase {
	declare: (typeof DECLARERS)[number];
	open: (typeof OPENS)[number];
	mutator: (typeof MUTATORS)[number];
	mutation: (typeof MUTATIONS)[number];
	locate: (typeof LOCATES)[number];
}

const SEQUENTIAL_DIMENSIONS = {
	declare: DECLARERS, open: OPENS, mutator: MUTATORS, mutation: MUTATIONS, locate: LOCATES,
} as const satisfies { [K in keyof SequentialCase]: readonly SequentialCase[K][] };

/**
 * - `update`: row 100's Token to the node's own value (A 'tok-x', B 'tok-y').
 * - `delete`: row 100.
 * - `insert-shared`: a new row (A 300, B 400) under 'tok-a', the value row 100 holds, so removing
 *   row 100's entry must not take this sibling entry with it.
 */
const RACE_OPS = ['update', 'delete', 'insert-shared'] as const;
type RaceOp = (typeof RACE_OPS)[number];
/**
 * The order the two staged transactions commit in. This also closes, for mutations, the insert
 * sweep's recorded gap: its `staged-both` order always commits A first.
 */
const COMMIT_ORDERS = ['a-first', 'b-first'] as const;

interface RacingCase {
	declare: (typeof DECLARERS)[number];
	a: RaceOp;
	b: RaceOp;
	commit: (typeof COMMIT_ORDERS)[number];
}

const RACING_DIMENSIONS = {
	declare: DECLARERS, a: RACE_OPS, b: RACE_OPS, commit: COMMIT_ORDERS,
} as const satisfies { [K in keyof RacingCase]: readonly RacingCase[K][] };

/** Two inserts race no existing row, which is the insert sweep's ground rather than this file's. */
const isInsertOnly = (c: RacingCase): boolean => c.a === 'insert-shared' && c.b === 'insert-shared';

interface IgnoreRaceCase {
	declare: (typeof DECLARERS)[number];
	/** The node whose staged INSERT OR IGNORE loses the key to the other node's committed INSERT. */
	loser: Which;
}

const IGNORE_RACE_DIMENSIONS = {
	declare: DECLARERS, loser: ['A', 'B'],
} as const satisfies { [K in keyof IgnoreRaceCase]: readonly IgnoreRaceCase[K][] };

/** Every combination taking one value from each dimension table. */
function crossProduct<T extends object>(dimensions: { [K in keyof T]: readonly T[K][] }): T[] {
	let combinations: Partial<T>[] = [{}];
	for (const name of Object.keys(dimensions) as (keyof T)[]) {
		combinations = combinations.flatMap(partial =>
			dimensions[name].map((value): Partial<T> => ({ ...partial, [name]: value })));
	}
	return combinations as T[];
}

/** The case name IS the case, so a red one needs no decoding. */
const sequentialCaseName = (c: SequentialCase): string =>
	`declare=${c.declare} open=${c.open} mutator=${c.mutator} mutation=${c.mutation} locate=${c.locate}`;
const racingCaseName = (c: RacingCase): string =>
	`declare=${c.declare} a=${c.a} b=${c.b} commit=${c.commit}`;
const ignoreRaceCaseName = (c: IgnoreRaceCase): string =>
	`declare=${c.declare} loser=${c.loser}`;

const SEQUENTIAL_CASES = crossProduct<SequentialCase>(SEQUENTIAL_DIMENSIONS);
const RACING_CASES = crossProduct<RacingCase>(RACING_DIMENSIONS).filter(c => !isInsertOnly(c));
const IGNORE_RACE_CASES = crossProduct<IgnoreRaceCase>(IGNORE_RACE_DIMENSIONS);

// --- what an index report is pinned to --------------------------------------------

type OrphanReason = IndexIntegrityReport['orphaned'][number]['reason'];

/** One discrepancy as a case pins it: the entry's decoded value and primary key, and the row it concerns. */
interface PinnedDiscrepancy {
	reason?: OrphanReason;
	value: (string | null)[];
	pk: (string | null)[];
	/** A stale-value orphan's `currentRow`, or a missing entry's `row`. */
	row?: SqlValue[];
}

interface PinnedReport {
	index: string;
	rowCount: number;
	entryCount: number;
	orphaned: PinnedDiscrepancy[];
	missing: PinnedDiscrepancy[];
}

const sortPinned = (list: PinnedDiscrepancy[]): PinnedDiscrepancy[] =>
	[...list].sort((l, r) =>
		JSON.stringify([l.value, l.pk, l.reason ?? '']).localeCompare(JSON.stringify([r.value, r.pk, r.reason ?? ''])));

function pinReport(report: IndexIntegrityReport): PinnedReport {
	return {
		index: report.index,
		rowCount: report.rowCount,
		entryCount: report.entryCount,
		orphaned: sortPinned(report.orphaned.map(orphan => ({
			reason: orphan.reason,
			value: orphan.indexPayloads,
			pk: orphan.primaryKeyPayloads,
			...(orphan.currentRow !== undefined ? { row: [...orphan.currentRow] } : {}),
		}))),
		missing: sortPinned(report.missing.map(entry => ({
			value: entry.indexPayloads,
			pk: entry.primaryKeyPayloads,
			row: [...entry.row],
		}))),
	};
}

// --- the replay model ------------------------------------------------------------
//
// NOTE: this model encodes KNOWN-DEFECTIVE replay semantics, on purpose. Today a racing same-row
// UPDATE or DELETE never refuses its loser. The loser's main-tree action replays blind over the
// rival's row, while its index delta (computed from the row image the statement read) replays
// beside it in the index tree. That leaves an entry no row implies, or resurrects a deleted row.
// Ticket `refuse-concurrent-row-change-loser` (building on `tree-entry-unchanged-guard`) refuses
// the loser instead. Its regression criterion is the racing groups going green with this model
// DELETED, every case then asserting the loser's refusal and a clean index. Until then, a case
// pinning a predicted discrepancy goes red with "found none" the moment the defect is fixed: that
// is the signal to delete the model, not a flake.
//
// If an observed case disagrees with the model, do NOT edit the model to fit. Find which documented
// semantic below was wrong (the blind upsert, the blind delete, keepExisting, or independent index
// replay). Record it on that ticket, or on a new fix/ ticket if the root cause differs. Only then
// correct the model, citing the record in a comment.

/** Row id -> Token, as the model tracks a table. */
type ModelRows = Map<number, string>;

interface ModelEntry {
	id: number;
	token: string;
}

const entryName = (entry: ModelEntry): string => `${entry.token}|${entry.id}`;

/** A staged statement, as its commit replays it. */
interface StagedWrite {
	/** The main-tree action, re-applied at replay to whatever rows the tree holds by then. */
	replayRow(rows: ModelRows): void;
	/** The index-tree action: computed at STAGING from the pre-race image, replayed verbatim. */
	removes: ModelEntry[];
	adds: ModelEntry[];
}

/** Staging reads the pre-race snapshot, because both statements stage before either commits. */
type Staging = (snapshot: ReadonlyMap<number, string>) => StagedWrite;

function tokenAt(snapshot: ReadonlyMap<number, string>, id: number): string {
	const token = snapshot.get(id);
	if (token === undefined) throw new Error(`replay model: no row ${id} in the pre-race snapshot`);
	return token;
}

const staged = {
	/** A same-key UPDATE stages `[[key, [key, row]]]` with no guard: a blind upsert, which also resurrects a row a rival deleted. */
	update: (id: number, token: string): Staging => snapshot => ({
		replayRow: rows => { rows.set(id, token); },
		removes: [{ id, token: tokenAt(snapshot, id) }],
		adds: [{ id, token }],
	}),
	/** A DELETE stages `[[key, undefined]]` with no guard: a blind delete, a no-op on a row a rival already removed. */
	delete: (id: number): Staging => snapshot => ({
		replayRow: rows => { rows.delete(id); },
		removes: [{ id, token: tokenAt(snapshot, id) }],
		adds: [],
	}),
	/**
	 * An INSERT stages an `absent` guard. No case lets a rival commit the key before it, so the guard
	 * never trips here; one that did would be a refusal this model does not predict, so it throws.
	 */
	insert: (id: number, token: string): Staging => () => ({
		replayRow: rows => {
			if (rows.has(id)) throw new Error(`replay model: the absent guard on insert ${id} would refuse, and no case may reach that`);
			rows.set(id, token);
		},
		removes: [],
		adds: [{ id, token }],
	}),
	/** INSERT OR IGNORE at a key its probe found clear stages `keepExisting`: replay skips the main-tree entry if the key is taken, but not the index add. */
	insertOrIgnore: (id: number, token: string): Staging => () => ({
		replayRow: rows => { if (!rows.has(id)) rows.set(id, token); },
		removes: [],
		adds: [{ id, token }],
	}),
};

interface Prediction {
	/** Both nodes' full scans, by Id. Both commits are always predicted to fulfil. */
	rows: TableRow[];
	/** The report for the table's one index, on both nodes. */
	report: PinnedReport;
}

/** Replay each committer's staged write in commit order, then diff the index entries against the rows. */
function predictReplay(commitOrder: readonly Staging[]): Prediction {
	const snapshot: ReadonlyMap<number, string> = new Map(SEEDED_ROWS.map(row => [row.Id, row.Token]));
	const writes = commitOrder.map(stage => stage(snapshot));
	const rows: ModelRows = new Map(snapshot);
	const entries = new Map([...snapshot].map(([id, token]) => [entryName({ id, token }), { id, token }]));
	for (const write of writes) {
		write.replayRow(rows);
		for (const entry of write.removes) entries.delete(entryName(entry));
		for (const entry of write.adds) entries.set(entryName(entry), entry);
	}

	const implied = new Set([...rows].map(([id, token]) => entryName({ id, token })));
	const orphaned = [...entries.values()]
		.filter(entry => !implied.has(entryName(entry)))
		.map((entry): PinnedDiscrepancy => {
			const current = rows.get(entry.id);
			const pinned = { value: [entry.token], pk: [String(entry.id)] };
			return current === undefined
				? { reason: 'no-row', ...pinned }
				: { reason: 'stale-value', ...pinned, row: [entry.id, current] };
		});
	const missing = [...rows]
		.filter(([id, token]) => !entries.has(entryName({ id, token })))
		.map(([id, token]): PinnedDiscrepancy => ({ value: [token], pk: [String(id)], row: [id, token] }));

	return {
		rows: [...rows].map(([Id, Token]) => ({ Id, Token })).sort(byId),
		report: {
			index: INDEX_NAME,
			rowCount: rows.size,
			entryCount: entries.size,
			orphaned: sortPinned(orphaned),
			missing: sortPinned(missing),
		},
	};
}

const isClean = (prediction: Prediction): boolean =>
	prediction.report.orphaned.length === 0 && prediction.report.missing.length === 0;

/** `''` for a clean prediction; otherwise the discrepancies the case pins, for its test title. */
function describePrediction(prediction: Prediction): string {
	const pinned = [
		...prediction.report.orphaned.map(entry => `orphan ${entry.value[0]}|${entry.pk[0]} (${entry.reason})`),
		...prediction.report.missing.map(entry => `missing ${entry.value[0]}|${entry.pk[0]}`),
	];
	return pinned.length === 0 ? '' : ` -> pins ${pinned.join(', ')}`;
}

// --- statements ------------------------------------------------------------------

const MOVED_ID = 101;
const NEW_TOKEN = 'tok-new';

/** Each sequential mutation's SQL, given how it locates row 100, and the rows it must leave. */
const MUTATION_EFFECTS: Record<SequentialCase['mutation'], { sql: (where: string) => string; rows: readonly TableRow[] }> = {
	'to-sibling-value': {
		sql: where => `update FormationUsage set Token = '${SIBLING_ROW.Token}' where ${where}`,
		rows: [{ Id: OWNER_ROW.Id, Token: SIBLING_ROW.Token }, SIBLING_ROW],
	},
	'to-new-value': {
		sql: where => `update FormationUsage set Token = '${NEW_TOKEN}' where ${where}`,
		rows: [{ Id: OWNER_ROW.Id, Token: NEW_TOKEN }, SIBLING_ROW],
	},
	'pk-move': {
		sql: where => `update FormationUsage set Id = ${MOVED_ID} where ${where}`,
		rows: [{ Id: MOVED_ID, Token: OWNER_ROW.Token }, SIBLING_ROW],
	},
	'delete': {
		sql: where => `delete from FormationUsage where ${where}`,
		rows: [SIBLING_ROW],
	},
};

const LOCATE_WHERE: Record<SequentialCase['locate'], string> = {
	'by-pk': `Id = ${OWNER_ROW.Id}`,
	'by-index': `Token = '${OWNER_ROW.Token}'`,
};

/** A statement a race issues, beside the model of what it stages. */
interface RaceStatement {
	sql: string;
	staging: Staging;
}

/** Each node's own values, so a surviving value names the node that wrote it. */
const RACE_VALUES: Record<Which, { token: string; insertId: number }> = {
	A: { token: 'tok-x', insertId: 300 },
	B: { token: 'tok-y', insertId: 400 },
};

function raceStatement(which: Which, op: RaceOp): RaceStatement {
	const { token, insertId } = RACE_VALUES[which];
	switch (op) {
		case 'update':
			return {
				sql: `update FormationUsage set Token = '${token}' where Id = ${OWNER_ROW.Id}`,
				staging: staged.update(OWNER_ROW.Id, token),
			};
		case 'delete':
			return {
				sql: `delete from FormationUsage where Id = ${OWNER_ROW.Id}`,
				staging: staged.delete(OWNER_ROW.Id),
			};
		case 'insert-shared':
			return {
				sql: insertSql(insertId, OWNER_ROW.Token),
				staging: staged.insert(insertId, OWNER_ROW.Token),
			};
	}
}

const IGNORED_ID = 300;

const IGNORE_RACE = {
	loser: {
		sql: `insert or ignore into FormationUsage (Id, Token) values (${IGNORED_ID}, 'tok-ignored')`,
		staging: staged.insertOrIgnore(IGNORED_ID, 'tok-ignored'),
	},
	winner: {
		sql: insertSql(IGNORED_ID, 'tok-winner'),
		staging: staged.insert(IGNORED_ID, 'tok-winner'),
	},
} as const satisfies Record<'loser' | 'winner', RaceStatement>;

// --- case execution --------------------------------------------------------------

const byId = (l: TableRow, r: TableRow): number => l.Id - r.Id;

/**
 * Register a fresh two-node mock mesh before each case of the enclosing describe, and return the
 * function a case calls for its two nodes.
 *
 * NOTE: nothing closes these Databases; see the accepted tradeoff recorded on `startMockMesh`. This
 * file adds two per case, on top of the insert sweep's. If it slows down or runs the heap up, close
 * each node in an afterEach before looking anywhere else.
 */
function meshPerCase(): () => Nodes {
	let transactorFor: (index: number) => ITransactor;
	beforeEach(async () => {
		({ transactorFor } = await startMockMesh(2));
	});
	return () => ({ A: createMeshDbNode(transactorFor(0)), B: createMeshDbNode(transactorFor(1)) });
}

/**
 * Both nodes' full scans must hold exactly `expected`. This is kept apart from the index check on
 * purpose: a mutation that touched no row (say, a by-index seek that missed row 100) fails HERE, as
 * a row-set mismatch, rather than later as an index discrepancy it is not.
 */
async function expectScans(nodes: Nodes, expected: readonly TableRow[], when: string): Promise<void> {
	for (const which of BOTH) {
		const rows = await queryAll(nodes[which].db, `select Id, Token from FormationUsage order by Id`);
		expect(
			rows.map(row => ({ Id: Number(row.Id), Token: String(row.Token) })),
			`node ${which}'s full scan ${when}`,
		).to.deep.equal([...expected].sort(byId));
	}
}

/**
 * Bring both nodes to the state every case mutates from. The declarer creates the table and index;
 * the other node re-declares or hydrates; A inserts its row, then B inserts its own. Both scans must
 * then hold both rows, or the comparison after the mutation could pass vacuously on a node that
 * never saw a row.
 *
 * A `hydrate` node therefore hydrates onto a table with no rows yet. Hydrating onto a populated
 * table and then mutating is not covered here (the insert sweep hydrates after a committed row, but
 * only inserts): a recorded gap, not filed as a ticket.
 */
async function runSetup(declare: Which, open: SequentialCase['open'], nodes: Nodes): Promise<void> {
	const [first, second] = declare === 'A' ? [nodes.A, nodes.B] : [nodes.B, nodes.A];
	await first.db.exec(createTableSql);
	await first.db.exec(createIndexSql);
	if (open === 'hydrate') {
		const hydrated = await second.plugin.hydrate(second.db);
		expect(
			hydrated.indexes,
			'the cold node must hydrate the index from the persisted catalog, or its writes cannot maintain it',
		).to.be.greaterThan(0);
	} else {
		await second.db.exec(createTableSql);
		await second.db.exec(createIndexSql);
	}

	await nodes.A.db.exec(insertSql(OWNER_ROW.Id, OWNER_ROW.Token));
	await nodes.B.db.exec(insertSql(SIBLING_ROW.Id, SIBLING_ROW.Token));
	await expectScans(nodes, SEEDED_ROWS, 'must hold both seeded rows before anything mutates');
}

/** The pk-move's own reads on both nodes: nothing at the old key, and the kept value seeks to the new one. */
async function expectMovedRowOnlyAtNewKey(nodes: Nodes): Promise<void> {
	for (const which of BOTH) {
		const db = nodes[which].db;
		expect(
			await queryAll(db, `select Id from FormationUsage where Id = ${OWNER_ROW.Id}`),
			`node ${which}: no row is left at the old primary key`,
		).to.deep.equal([]);
		const byValue = await queryAll(db, `select Id from FormationUsage where Token = '${OWNER_ROW.Token}'`);
		expect(byValue.map(row => Number(row.Id)), `node ${which}: the kept value seeks to the moved row`)
			.to.deep.equal([MOVED_ID]);
	}
}

type Outcome = 'fulfilled' | `rejected: ${string}`;

/**
 * Run one step per node in `order`, capturing each outcome (`Promise.allSettled` semantics, but
 * awaited one at a time) so the second step runs whatever the first did. The outcomes are then
 * asserted against the prediction, so a refusal fails the case as a named disagreement carrying the
 * refusal's message, not as a bare throw out of the first commit.
 *
 * Never `Promise.all`: this harness is single-threaded, so only staging overlaps, and a
 * nondeterministic commit order would make the case name lie.
 */
async function settleInOrder(
	order: readonly [Which, Which],
	step: (which: Which) => Promise<unknown>,
): Promise<Record<Which, Outcome>> {
	const outcomes: Outcome[] = [];
	for (const which of order) {
		try {
			await step(which);
			outcomes.push('fulfilled');
		} catch (error) {
			outcomes.push(`rejected: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const [first, second] = outcomes as [Outcome, Outcome];
	return order[0] === 'A' ? { A: first, B: second } : { A: second, B: first };
}

/** A racing case observed exactly what the replay model predicts, on both nodes. */
async function expectPrediction(nodes: Nodes, outcomes: Record<Which, Outcome>, prediction: Prediction): Promise<void> {
	expect(outcomes, 'the replay model predicts both commits fulfil; a refusal disagrees with it (see the NOTE on the model)')
		.to.deep.equal({ A: 'fulfilled', B: 'fulfilled' });
	await expectScans(nodes, prediction.rows, 'must hold the rows the replay model predicts');

	for (const which of BOTH) {
		if (isClean(prediction)) {
			await expectIndexAgreesWithScan(nodes[which].db, TABLE, 'Token');
			continue;
		}
		const reports = await readIndexIntegrity(nodes[which].db, TABLE);
		expect(
			reports.map(pinReport),
			`node ${which}: the index report must hold exactly the discrepancies the replay model predicts. ` +
			'If it holds none, the known defect this case pins may be fixed: see the NOTE on the model',
		).to.deep.equal([prediction.report]);
		// The structural arm is spent on the pin, so run the lookup arm alone.
		await expectLookupsAgreeWithScan(nodes[which].db, TABLE, 'Token');
		await expectOrphanSeeks(nodes[which], which, prediction.report.orphaned);
	}
}

/**
 * Seek each orphan's own value. KNOWN DEFECT, pinned rather than skipped
 * (`index-seek-returns-moved-rows`): a stale-value orphan's seek returns the row it points at,
 * which no longer holds that value. A no-row orphan's seek returns nothing. When the seek is
 * fixed, the stale-value seeks go red: every orphan's seek should then return no rows.
 */
async function expectOrphanSeeks(node: Node, which: Which, orphans: readonly PinnedDiscrepancy[]): Promise<void> {
	for (const orphan of orphans) {
		const seek = await queryAll(node.db, `select Id, Token from FormationUsage where Token = ?`, [orphan.value[0]!]);
		const pointedAt = orphan.row === undefined ? [] : [{ Id: Number(orphan.row[0]), Token: String(orphan.row[1]) }];
		expect(
			seek.map(row => ({ Id: Number(row.Id), Token: String(row.Token) })),
			`node ${which}: seeking orphaned value ${orphan.value[0]} returns the row its entry points at (known defect)`,
		).to.deep.equal(pointedAt);
	}
}

/*
 * Pure data, in its own describe, so it needs no mesh and a harness that fails to come up cannot take
 * it down. If a later edit drops, duplicates or narrows generated cases, the routine run quietly stops
 * covering some shape; this fails loudly instead.
 */
describe('Two-node index mutation sweep — generator coverage', () => {
	it('generates 64 sequential, 32 racing and 4 ignore-race cases', () => {
		expect([SEQUENTIAL_CASES.length, RACING_CASES.length, IGNORE_RACE_CASES.length]).to.deep.equal([64, 32, 4]);
	});

	it('names every case exactly once', () => {
		const names = [
			...SEQUENTIAL_CASES.map(sequentialCaseName),
			...RACING_CASES.map(racingCaseName),
			...IGNORE_RACE_CASES.map(ignoreRaceCaseName),
		];
		expect(names.filter((name, index) => names.indexOf(name) !== index), 'duplicate case names').to.deep.equal([]);
	});

	function expectEveryValueCovered<T extends object>(
		group: string,
		cases: readonly T[],
		dimensions: { [K in keyof T]: readonly T[K][] },
	): void {
		for (const name of Object.keys(dimensions) as (keyof T)[]) {
			for (const value of dimensions[name]) {
				expect(cases.some(c => c[name] === value), `${group} cases cover ${String(name)}=${String(value)}`)
					.to.equal(true);
			}
		}
	}

	it('covers every value of every dimension', () => {
		expectEveryValueCovered('sequential', SEQUENTIAL_CASES, SEQUENTIAL_DIMENSIONS);
		expectEveryValueCovered('racing', RACING_CASES, RACING_DIMENSIONS);
		expectEveryValueCovered('ignore-race', IGNORE_RACE_CASES, IGNORE_RACE_DIMENSIONS);
	});

	it('races all eight op pairs, each under both declarers and both commit orders', () => {
		for (const a of RACE_OPS) {
			for (const b of RACE_OPS) {
				const hits = RACING_CASES.filter(c => c.a === a && c.b === b).length;
				const expected = isInsertOnly({ declare: 'A', a, b, commit: 'a-first' })
					? 0
					: DECLARERS.length * COMMIT_ORDERS.length;
				expect(hits, `racing cases for a=${a} b=${b}`).to.equal(expected);
			}
		}
	});
});

describe(`Two-node index mutation sweep — sequential (${SEQUENTIAL_CASES.length} cases)`, function () {
	this.timeout(120_000);
	const openNodes = meshPerCase();

	for (const testCase of SEQUENTIAL_CASES) {
		it(sequentialCaseName(testCase), async () => {
			const nodes = openNodes();
			await runSetup(testCase.declare, testCase.open, nodes);

			const mutator = nodes[testCase.mutator === 'owner' ? 'A' : 'B'];
			const effect = MUTATION_EFFECTS[testCase.mutation];
			const indexScans = await countIndexScans(() => mutator.db.exec(effect.sql(LOCATE_WHERE[testCase.locate])));
			if (testCase.locate === 'by-index') {
				expect(indexScans, 'a by-index mutation must find its row through a secondary-index seek, or it is by-pk in disguise')
					.to.be.greaterThan(0);
			} else {
				expect(indexScans, 'a by-pk mutation must not route through a secondary index, or the two locates are one')
					.to.equal(0);
			}

			await expectScans(nodes, effect.rows, 'must hold the mutated rows');
			if (testCase.mutation === 'pk-move') await expectMovedRowOnlyAtNewKey(nodes);

			// THE oracle, on both nodes. Its structural arm sees a leftover entry (the old value's
			// after an update, row 100's after a pk-move or a delete) and a missing one, including a
			// shared value's second entry under to-sibling-value; its lookup arm sees a seek that
			// misses a row.
			for (const which of BOTH) {
				await expectIndexAgreesWithScan(nodes[which].db, TABLE, 'Token');
			}
		});
	}
});

describe(`Two-node index mutation sweep — racing (${RACING_CASES.length} cases)`, function () {
	this.timeout(120_000);
	const openNodes = meshPerCase();

	for (const testCase of RACING_CASES) {
		const statements: Record<Which, RaceStatement> = {
			A: raceStatement('A', testCase.a),
			B: raceStatement('B', testCase.b),
		};
		const commitOrder: readonly [Which, Which] = testCase.commit === 'a-first' ? ['A', 'B'] : ['B', 'A'];
		const prediction = predictReplay(commitOrder.map(which => statements[which].staging));

		it(`${racingCaseName(testCase)}${describePrediction(prediction)}`, async () => {
			const nodes = openNodes();
			// `open` is fixed: it interacts with setup, not with replay.
			await runSetup(testCase.declare, 'redeclare', nodes);

			// Both transactions open and both statements staged before either commits.
			for (const which of BOTH) {
				await nodes[which].db.exec('begin');
				await nodes[which].db.exec(statements[which].sql);
			}
			const outcomes = await settleInOrder(commitOrder, which => nodes[which].db.exec('commit'));

			await expectPrediction(nodes, outcomes, prediction);
		});
	}
});

describe(`Two-node index mutation sweep — INSERT OR IGNORE race (${IGNORE_RACE_CASES.length} cases)`, function () {
	this.timeout(120_000);
	const openNodes = meshPerCase();
	// The winner's commit lands before the loser's replay, so the model applies it first.
	const prediction = predictReplay([IGNORE_RACE.winner.staging, IGNORE_RACE.loser.staging]);

	for (const testCase of IGNORE_RACE_CASES) {
		const winner: Which = testCase.loser === 'A' ? 'B' : 'A';

		it(`${ignoreRaceCaseName(testCase)}${describePrediction(prediction)}`, async () => {
			const nodes = openNodes();
			await runSetup(testCase.declare, 'redeclare', nodes);

			// The loser's probe finds the key clear and stages; the winner then commits the key; then the
			// loser commits.
			await nodes[testCase.loser].db.exec('begin');
			await nodes[testCase.loser].db.exec(IGNORE_RACE.loser.sql);
			const outcomes = await settleInOrder([winner, testCase.loser], which =>
				nodes[which].db.exec(which === winner ? IGNORE_RACE.winner.sql : 'commit'));

			await expectPrediction(nodes, outcomes, prediction);
		});
	}
});
