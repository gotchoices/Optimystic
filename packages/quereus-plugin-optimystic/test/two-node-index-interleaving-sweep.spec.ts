/**
 * Two-node secondary-index interleaving SWEEP — generated, not hand-picked.
 *
 * A downstream project reports a row that replicates fine between two machines while
 * the secondary-index lookup for it comes back empty on the sibling (primary-key
 * lookup and full scan both find it). Four investigations here each answered that
 * report with ANOTHER hand-written two-node scenario, and every one of them
 * converged. Hand-picking has now failed four times, so this spec stops picking and
 * enumerates instead: it crosses the six orderings that actually differ between the
 * passing local cases and the failing downstream run, and closes every generated case
 * with `expectIndexAgreesWithScan` on BOTH nodes.
 *
 * The dimensions crossed (see `Case` below):
 *   declare      — which node declares the table first (the mesh assigns block
 *                  responsibility by key hash, so the two nodes are not symmetric)
 *   open         — how the second node arrives: re-declares the table+index, opens
 *                  cold from the persisted catalog via `plugin.hydrate`, or declares
 *                  the table BEFORE any row exists (both nodes invent the collection)
 *   index        — index created before the first rows, or after them (backfill)
 *   write        — A then B, B then A, or both staged in open transactions before
 *                  either commits
 *   read         — whether each node runs an index-routed seek, for its OWN value on its
 *                  own database, before it writes; a node that invents an index
 *                  collection and reaches it by read never takes the write path's
 *                  reconcile. (No case reads a value only the SIBLING writes — see
 *                  `runPreReads` for what that leaves uncovered.)
 *   token        — the two nodes write the same indexed value or distinct ones (every
 *                  pre-existing case lands both nodes on the same token, and so does the
 *                  downstream scenario: its two machines redeem the SAME invite in one
 *                  tick, writing two rows that share a Token and differ only in primary
 *                  key. An earlier version of this comment said the downstream scenario
 *                  redeems DISTINCT tokens; that was wrong — see the correction and the
 *                  extra shared-value cases in two-node-shared-index-key.spec.ts)
 *
 * Running it. All 144 orderings run on EVERY `yarn test` — the sweep is not gated,
 * because a sweep that only runs when someone remembers a flag cannot catch the bug it
 * exists for. Measured on this package: the file takes 13s wide against a 2m46s suite,
 * and the 12-case CORE_CASES subset it replaces took 1s, so running wide costs ~12s —
 * about 7% of the suite. Re-measure with, from this package:
 *
 *   # wide (the default) and narrow, for the delta
 *   node --import ./register.mjs node_modules/mocha/bin/mocha.js \
 *     "test/two-node-index-interleaving-sweep.spec.ts" --reporter min --exit
 *   INDEX_SWEEP_CORE_ONLY=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
 *     "test/two-node-index-interleaving-sweep.spec.ts" --reporter min --exit
 *
 * `INDEX_SWEEP_CORE_ONLY=1` narrows to CORE_CASES for a tight inner loop. It is a
 * convenience, not a CI setting: nothing in `yarn test`, `yarn test:integration` or
 * `yarn check` sets it, so every one of them runs all 144.
 *
 * NOTE: 144 cases is affordable only because the mock mesh is in-process, and only while
 * the whole file stays a small fraction of the suite. Adding a dimension MULTIPLIES the
 * count — re-measure with the commands above before doing it, and gate rather than
 * ungate if the delta stops being small. The same sweep over the real-libp2p harness
 * would not fit any routine run at all.
 *
 * If a generated case goes red, that IS the reproduction the four prior passes were
 * looking for — the case name states the exact ordering. Do not narrow the generator,
 * skip the case, or soften the oracle to get a green run.
 *
 * Harness mirrors two-node-secondary-index-convergence.spec.ts: two Databases, each
 * bound to its own node's transactor over one 2-node mock mesh.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import type { ITransactor } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '@optimystic/db-p2p/testing';
import register from '../dist/plugin.js';
import { expectIndexAgreesWithScan, queryAll } from './query-helpers.js';

type Plugin = ReturnType<typeof register>;
type Node = { db: Database; plugin: Plugin };

const TABLE_URI = 'tree://default/FormationUsage';

const createTableSql = `
	create table FormationUsage (
		Id integer primary key,
		Token text
	) using optimystic('${TABLE_URI}')
`;
const createIndexSql = `create index formation_usage_by_token on FormationUsage(Token)`;

/** Row ids are fixed per writer so a failure names which node's row went missing. */
const SEED_ID = 1;
const A_ID = 100;
const B_ID = 200;
const SEED_TOKEN = 'tok-seed';

// --- dimensions ------------------------------------------------------------------

/** Which node runs the first `create table`. */
const DECLARERS = ['A', 'B'] as const;
/**
 * How the second node comes to hold the table and its index.
 * - `redeclare`   — the first node finishes its setup, then the second re-issues the
 *                   same CREATE TABLE + CREATE INDEX against storage that already has
 *                   them (addIndex takes its already-persisted early return).
 * - `hydrate`     — the second node issues NO DDL at all and loads the table and its
 *                   index from the persisted catalog.
 * - `both-invent` — the second node declares the table BEFORE any row is written, so
 *                   both nodes stage a fresh collection instance from nothing.
 */
const OPENS = ['redeclare', 'hydrate', 'both-invent'] as const;
/** Index declared before the seed row, or after it (the backfill path). */
const INDEX_TIMINGS = ['index-first', 'rows-first'] as const;
/**
 * Order the two nodes' post-setup writes land in. `a-then-b` and `b-then-a` are the two
 * sequential orders; `staged-both` is a different KIND of value — it stages both mutations
 * before either commits, and pins the commit order to A-then-B. So "both staged, B commits
 * first" is covered and "both staged, A commits second" is not; tracked with the generator's
 * other coverage gaps in `debt-index-sweep-misses-update-delete-and-orphans`.
 */
const WRITE_ORDERS = ['a-then-b', 'b-then-a', 'staged-both'] as const;
/** Whether each node index-seeks its OWN token, on its own database, before writing it. */
const READS = ['read-first', 'write-first'] as const;
/** Both nodes write the seed's token, or each writes its own distinct one. */
const TOKENS = ['same-token', 'distinct-tokens'] as const;

interface Case {
	declare: (typeof DECLARERS)[number];
	open: (typeof OPENS)[number];
	index: (typeof INDEX_TIMINGS)[number];
	write: (typeof WRITE_ORDERS)[number];
	read: (typeof READS)[number];
	token: (typeof TOKENS)[number];
}

/** The case name IS the ordering, so a red case needs no further decoding. */
function caseName(c: Case): string {
	return `declare=${c.declare} open=${c.open} index=${c.index} write=${c.write} read=${c.read} token=${c.token}`;
}

function allCases(): Case[] {
	const cases: Case[] = [];
	for (const declare of DECLARERS) {
		for (const open of OPENS) {
			for (const index of INDEX_TIMINGS) {
				for (const write of WRITE_ORDERS) {
					for (const read of READS) {
						for (const token of TOKENS) {
							cases.push({ declare, open, index, write, read, token });
						}
					}
				}
			}
		}
	}
	return cases;
}

/** The dimension tables by name, so the coverage guard iterates them instead of restating them. */
const DIMENSIONS = {
	declare: DECLARERS, open: OPENS, index: INDEX_TIMINGS,
	write: WRITE_ORDERS, read: READS, token: TOKENS,
} as const satisfies { [K in keyof Case]: readonly Case[K][] };

/**
 * Dimension pairs the core subset covers exhaustively — the ones where the two values
 * plausibly interact rather than compose independently (how the second node opens the
 * table interacts with who declared it and with when the index appeared; write order
 * interacts with whether a read preceded it and with whether the tokens collide).
 */
const COVERED_PAIRS: [keyof Case, keyof Case][] = [
	['declare', 'open'], ['open', 'index'], ['write', 'read'], ['write', 'token'],
];

/**
 * The subset `INDEX_SWEEP_CORE_ONLY=1` narrows to — an inner-loop convenience, NOT what
 * any script runs (see the header). Chosen, not sampled: every value of every dimension
 * appears at least four times, and the pairs that plausibly interact ({@link COVERED_PAIRS})
 * are covered exhaustively. The `core subset` describe below re-checks BOTH halves of that
 * claim against the dimension tables, so the subset cannot silently degrade under a later
 * edit — and it runs even when the subset itself does not.
 */
const CORE_CASES: Case[] = [
	{ declare: 'A', open: 'redeclare', index: 'index-first', write: 'a-then-b', read: 'write-first', token: 'same-token' },
	{ declare: 'B', open: 'redeclare', index: 'rows-first', write: 'b-then-a', read: 'read-first', token: 'distinct-tokens' },
	{ declare: 'A', open: 'hydrate', index: 'index-first', write: 'b-then-a', read: 'read-first', token: 'distinct-tokens' },
	{ declare: 'B', open: 'hydrate', index: 'rows-first', write: 'staged-both', read: 'write-first', token: 'same-token' },
	{ declare: 'A', open: 'both-invent', index: 'rows-first', write: 'staged-both', read: 'read-first', token: 'distinct-tokens' },
	{ declare: 'B', open: 'both-invent', index: 'index-first', write: 'a-then-b', read: 'read-first', token: 'same-token' },
	{ declare: 'A', open: 'both-invent', index: 'index-first', write: 'staged-both', read: 'write-first', token: 'distinct-tokens' },
	{ declare: 'B', open: 'hydrate', index: 'index-first', write: 'a-then-b', read: 'write-first', token: 'distinct-tokens' },
	{ declare: 'A', open: 'redeclare', index: 'rows-first', write: 'staged-both', read: 'read-first', token: 'same-token' },
	{ declare: 'B', open: 'both-invent', index: 'rows-first', write: 'b-then-a', read: 'write-first', token: 'same-token' },
	{ declare: 'A', open: 'hydrate', index: 'rows-first', write: 'a-then-b', read: 'read-first', token: 'same-token' },
	{ declare: 'B', open: 'redeclare', index: 'index-first', write: 'b-then-a', read: 'write-first', token: 'distinct-tokens' },
];

/**
 * Wide by default — see the header comment for the measurement that says it can afford to
 * be. The var only NARROWS, so no CI path can accidentally run less than everything.
 */
const RUN_FULL_SWEEP = process.env.INDEX_SWEEP_CORE_ONLY !== '1';

// --- case execution --------------------------------------------------------------

function tokensFor(c: Case): { a: string; b: string } {
	return c.token === 'same-token'
		? { a: SEED_TOKEN, b: SEED_TOKEN }
		: { a: 'tok-a', b: 'tok-b' };
}

/** The two writers in the order their statements are issued. */
function writeSequence(c: Case): ('A' | 'B')[] {
	return c.write === 'b-then-a' ? ['B', 'A'] : ['A', 'B'];
}

const insertSql = (id: number, token: string) =>
	`insert into FormationUsage (Id, Token) values (${id}, '${token}')`;

/**
 * Bring both nodes to the state the write phase starts from: the table exists, the
 * seed row is committed, and BOTH nodes hold the index in their catalog.
 *
 * That last part is a precondition of the oracle rather than part of what is under
 * test — a node whose catalog never learned about the index cannot route a seek into
 * it at all, and would fail `expectIndexAgreesWithScan` for a reason that has nothing
 * to do with cross-node index convergence.
 */
async function runSetup(c: Case, first: Node, second: Node): Promise<void> {
	await first.db.exec(createTableSql);
	if (c.open === 'both-invent') {
		// Second node's vtab comes up against a collection nothing has committed to yet.
		await second.db.exec(createTableSql);
	}

	if (c.index === 'index-first') {
		await first.db.exec(createIndexSql);
		await first.db.exec(insertSql(SEED_ID, SEED_TOKEN));
	} else {
		await first.db.exec(insertSql(SEED_ID, SEED_TOKEN));
		await first.db.exec(createIndexSql);
	}

	if (c.open === 'hydrate') {
		const hydrated = await second.plugin.hydrate(second.db);
		expect(
			hydrated.indexes,
			'the cold node must hydrate the index from the persisted catalog, ' +
			'or its seeks cannot route into the index at all',
		).to.be.greaterThan(0);
	} else {
		if (c.open === 'redeclare') await second.db.exec(createTableSql);
		await second.db.exec(createIndexSql);
	}
}

/**
 * Each node index-seeks the token it is ABOUT to write, on its OWN database. On a
 * collection this node invented, that read is the arm that never takes the write path's
 * reconcile. The row set is not asserted here (the value may not exist yet); the point is
 * that the read happened before the write.
 *
 * Note what this deliberately does NOT produce: no node ever seeks a value only the SIBLING
 * will write, so the read-only-sibling shape — a node that touches an index collection
 * exclusively through reads of someone else's value — is not covered by any case here.
 * Tracked in `debt-index-sweep-misses-update-delete-and-orphans`.
 */
async function runPreReads(c: Case, nodes: Record<'A' | 'B', Node>): Promise<void> {
	const tokens = tokensFor(c);
	for (const which of writeSequence(c)) {
		const token = which === 'A' ? tokens.a : tokens.b;
		await queryAll(nodes[which].db, `select Id from FormationUsage where Token = '${token}'`);
	}
}

async function runWrites(c: Case, nodes: Record<'A' | 'B', Node>): Promise<void> {
	const tokens = tokensFor(c);
	const aInsert = insertSql(A_ID, tokens.a);
	const bInsert = insertSql(B_ID, tokens.b);

	if (c.write === 'staged-both') {
		// Both transactions are open — and both mutations staged — before either
		// commits, so neither node's flush can have seen the other's.
		await nodes.A.db.exec('begin');
		await nodes.A.db.exec(aInsert);
		await nodes.B.db.exec('begin');
		await nodes.B.db.exec(bInsert);
		await nodes.A.db.exec('commit');
		await nodes.B.db.exec('commit');
		return;
	}

	for (const which of writeSequence(c)) {
		await nodes[which].db.exec(which === 'A' ? aInsert : bInsert);
	}
}

/**
 * Both nodes must see all three rows by full scan. This is not the defect under test —
 * it is what keeps the index/scan comparison from passing vacuously, since a node
 * whose scan is missing the sibling's row has an index legitimately missing it too.
 */
async function expectScansConverged(c: Case, nodes: Record<'A' | 'B', Node>): Promise<void> {
	const tokens = tokensFor(c);
	const expected = [
		{ Id: SEED_ID, Token: SEED_TOKEN },
		{ Id: A_ID, Token: tokens.a },
		{ Id: B_ID, Token: tokens.b },
	];
	for (const which of ['A', 'B'] as const) {
		const rows = await queryAll(nodes[which].db, `select Id, Token from FormationUsage order by Id`);
		expect(
			rows.map(r => ({ Id: Number(r.Id), Token: r.Token })),
			`node ${which}'s full scan must hold every committed row before the index can be compared to it`,
		).to.deep.equal(expected);
	}
}

const SELECTED = RUN_FULL_SWEEP ? allCases() : CORE_CASES;

/*
 * Pure data — deliberately its own describe so it needs no mesh, and so a harness that
 * fails to come up cannot take this guard down with it. It guards what the CORE_CASES
 * comment claims: if a later edit drops, duplicates, or narrows entries, the routine run
 * quietly stops covering some ordering, and that must fail loudly rather than go unnoticed
 * behind a green 12-case run.
 */
describe('Two-node secondary-index interleaving sweep — core subset coverage', () => {
	it('names each ordering exactly once', () => {
		const names = CORE_CASES.map(caseName);
		expect(new Set(names).size, `duplicate core case: ${names.join(' / ')}`).to.equal(names.length);
	});

	it('covers every value of every dimension at least four times', () => {
		for (const [dimension, values] of Object.entries(DIMENSIONS)) {
			for (const value of values) {
				const hits = CORE_CASES.filter(c => c[dimension as keyof Case] === value).length;
				expect(hits, `core subset covers ${dimension}=${value}`).to.be.greaterThanOrEqual(4);
			}
		}
	});

	// The half the prose used to assert on its own: a subset can hold every dimension VALUE
	// while missing a combination entirely, which is the coverage that actually matters here.
	for (const [left, right] of COVERED_PAIRS) {
		it(`covers every ${left} × ${right} combination`, () => {
			const present = new Set(CORE_CASES.map(c => `${c[left]}|${c[right]}`));
			for (const l of DIMENSIONS[left]) {
				for (const r of DIMENSIONS[right]) {
					expect(present.has(`${l}|${r}`), `core subset covers ${left}=${l} with ${right}=${r}`)
						.to.equal(true);
				}
			}
		});
	}
});

// The title states which arm ran, so a green run under INDEX_SWEEP_CORE_ONLY is never
// mistaken for "all 144 orderings passed".
describe(`Two-node secondary-index interleaving sweep (${SELECTED.length} of ${allCases().length} orderings; ` +
	`${RUN_FULL_SWEEP ? 'full sweep' : 'core subset only — unset INDEX_SWEEP_CORE_ONLY for all'})`, function () {
	this.timeout(120_000);

	let mesh: Mesh;
	let transactors: Map<string, ITransactor>;

	beforeEach(async () => {
		mesh = await createMesh(2, {
			responsibilityK: 2,
			clusterSize: 2,
			superMajorityThreshold: 0.67,
		});
		transactors = buildNetworkTransactors(mesh);
	});

	const transactorFor = (index: number): ITransactor => {
		const peerId = mesh.nodes[index]!.peerId.toString();
		const t = transactors.get(peerId);
		if (!t) throw new Error(`No transactor for peer ${peerId}`);
		return t;
	};

	// NOTE: nothing closes these Databases, and nothing tears the mesh down — the mesh is a
	// pure in-process mock over MemoryRawStorage with no sockets or timers to release, and
	// the sibling two-node specs leave theirs open the same way. Harmless at the size the
	// header measures (288 Databases across the wide arm), but it is per-case garbage that
	// grows with the case count: if a widened sweep slows down or runs the heap up, close
	// each node in an afterEach before looking anywhere else.
	function createNode(transactor: ITransactor): Node {
		const db = new Database();
		const config = {
			default_transactor: 'shared',
			default_key_network: 'test',
			enable_cache: false,
		} as unknown as Record<string, SqlValue>;
		const plugin = register(db, config);
		// The factory keys its transactor cache on `${transactor}:${keyNetwork}`, so this
		// makes every collection this Database opens ride THIS mesh node's stack.
		plugin.collectionFactory.registerTransactor('shared:test', transactor);
		for (const vtable of plugin.vtables) {
			db.registerModule(vtable.name, vtable.module, vtable.auxData);
		}
		for (const func of plugin.functions) {
			db.registerFunction(func.schema);
		}
		return { db, plugin };
	}

	for (const testCase of SELECTED) {
		it(caseName(testCase), async () => {
			const nodes: Record<'A' | 'B', Node> = {
				A: createNode(transactorFor(0)),
				B: createNode(transactorFor(1)),
			};
			const first = testCase.declare === 'A' ? nodes.A : nodes.B;
			const second = testCase.declare === 'A' ? nodes.B : nodes.A;

			await runSetup(testCase, first, second);
			if (testCase.read === 'read-first') await runPreReads(testCase, nodes);
			await runWrites(testCase, nodes);

			await expectScansConverged(testCase, nodes);

			// THE oracle: for every Token value present, the index-routed seek must return
			// exactly what the full scan returns — on both nodes, for this ordering.
			await expectIndexAgreesWithScan(nodes.A.db, 'FormationUsage', 'Token');
			await expectIndexAgreesWithScan(nodes.B.db, 'FormationUsage', 'Token');
		});
	}
});
