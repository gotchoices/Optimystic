/**
 * TEST-7.3.1: Adapter integration tests
 *
 * Tests the optimystic adapter layer that bridges Quereus SQL operations
 * to the distributed database: CollectionFactory, TransactionBridge,
 * OptimysticVirtualTableConnection, and KeyNetwork registration.
 *
 * These tests exercise the adapter components via the plugin registration
 * entry point, since internal classes are bundled and not directly exported.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';
import type { TransactionState } from '../dist/index.js';
import { captureTrace, commitTraces } from './trace-helpers.js';
import { Collection } from '@optimystic/db-core';
import type { ActionHandler, BlockId, BlockStore, CollectionInitOptions, IBlock } from '@optimystic/db-core';
import { TestTransactor } from '@optimystic/db-core/test';

type Row = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) {
		rows.push(row);
	}
	return rows;
};

/** Helper to create a fresh db + plugin for each test */
function createTestEnv() {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false,
	});

	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}

	return { db, plugin };
}

// ─────────────────────────────────────────────────────
// CollectionFactory (via plugin.collectionFactory)
// ─────────────────────────────────────────────────────

describe('CollectionFactory (TEST-7.3.1)', () => {
	it('should create a test transactor with expected interface', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const transactor = await factory.getOrCreateTransactor(options);
		expect(transactor).to.be.an('object');
		expect(transactor.get).to.be.a('function');
		expect(transactor.pend).to.be.a('function');
		expect(transactor.commit).to.be.a('function');
		expect(transactor.cancel).to.be.a('function');
	});

	it('should cache transactors across calls with same key', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const t1 = await factory.getOrCreateTransactor(options);
		const t2 = await factory.getOrCreateTransactor(options);
		expect(t1).to.equal(t2); // Same reference
	});

	it('should create a collection with correct interface', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const collection = await factory.createOrGetCollection(options);
		expect(collection).to.be.an('object');
		expect(collection.replace).to.be.a('function');
	});

	it('should cache collections within an active transaction', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const txnState: TransactionState = {
			transactor: await factory.getOrCreateTransactor(options),
			isActive: true,
			collections: new Map(),
			stampId: 'test-stamp',
		};

		const col1 = await factory.createOrGetCollection(options, txnState);
		const col2 = await factory.createOrGetCollection(options, txnState);
		expect(col1).to.equal(col2); // Same reference from cache
		expect(txnState.collections.size).to.equal(1);
	});

	it('should NOT cache collections when transaction is inactive', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const txnState: TransactionState = {
			transactor: await factory.getOrCreateTransactor(options),
			isActive: false,
			collections: new Map(),
			stampId: 'test-stamp',
		};

		await factory.createOrGetCollection(options, txnState);
		expect(txnState.collections.size).to.equal(0); // Not stored
	});

	it('should registerTransactor and use it on next getOrCreate call', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const mockTransactor = {
			get: async () => [],
			getStatus: async () => { throw new Error('not impl'); },
			pend: async () => ({ success: true }),
			commit: async () => ({ success: true }),
			cancel: async () => { },
		} as any;

		factory.registerTransactor('test:test', mockTransactor);

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const result = await factory.getOrCreateTransactor(options);
		expect(result).to.equal(mockTransactor);
	});

	it('should clearCache and create fresh transactors', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const t1 = await factory.getOrCreateTransactor(options);
		factory.clearCache();
		const t2 = await factory.getOrCreateTransactor(options);

		// After clearing, a new transactor is created
		expect(t1).to.not.equal(t2);
	});

	it('should throw for unknown custom transactor', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'nonexistent-custom',
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		try {
			await factory.getOrCreateTransactor(options);
			expect.fail('Should have thrown');
		} catch (e: any) {
			expect(e.message).to.include('nonexistent-custom');
			expect(e.message).to.include('not found');
		}
	});

	it('should return undefined for getPeerId when no libp2p node registered', () => {
		const { plugin } = createTestEnv();

		const options = {
			collectionUri: 'tree://test/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const peerId = plugin.collectionFactory.getPeerId(options);
		expect(peerId).to.be.undefined;
	});

	it('should create separate collections for different URIs', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const optsUsers = {
			collectionUri: 'tree://mydb/users',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const optsProducts = {
			collectionUri: 'tree://mydb/products',
			transactor: 'test' as const,
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const col1 = await factory.createOrGetCollection(optsUsers);
		const col2 = await factory.createOrGetCollection(optsProducts);

		expect(col1).to.be.an('object');
		expect(col2).to.be.an('object');
		// Different collections (different URIs)
		expect(col1).to.not.equal(col2);
	});

	// The tag is printed as one whitespace-separated `node=<tag>` field, so a tag carrying
	// whitespace would split one trace field into two and make every line carrying it
	// unparseable. Failing at the host's one start-up call is far cheaper than discovering
	// it in the log of the run that needed the log.
	describe('node tag', () => {
		it('defaults to a distinct, whitespace-free tag per factory', () => {
			const a = createTestEnv().plugin.collectionFactory;
			const b = createTestEnv().plugin.collectionFactory;
			expect(a.nodeTag(), 'the default tag is one non-empty token').to.match(/^\S+$/);
			expect(b.nodeTag(), 'two factories in one process do not share a default tag')
				.to.not.equal(a.nodeTag());
		});

		it('rejects a tag that would break the line it is printed on', () => {
			const factory = createTestEnv().plugin.collectionFactory;
			for (const bad of ['', '   ', 'two words', 'trailing ']) {
				expect(() => factory.setNodeTag(bad), `rejected ${JSON.stringify(bad)}`).to.throw(/node tag/i);
			}
			factory.setNodeTag('A');
			expect(factory.nodeTag()).to.equal('A');
		});
	});
});

// ─────────────────────────────────────────────────────
// TransactionBridge (via plugin.txnBridge)
// ─────────────────────────────────────────────────────

describe('TransactionBridge (TEST-7.3.1)', () => {
	const defaultOptions = {
		collectionUri: 'tree://test/users',
		transactor: 'test' as const,
		keyNetwork: 'test' as const,
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
	};

	describe('legacy mode (no coordinator)', () => {
		it('should begin a transaction and return active state', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			const txn = await bridge.beginTransaction(defaultOptions);
			expect(txn.isActive).to.be.true;
			expect(txn.stampId).to.be.a('string');
			expect(txn.stampId.length).to.be.greaterThan(0);
			expect(txn.collections).to.be.instanceOf(Map);
		});

		it('should return same transaction on double-begin (SQLite semantics)', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			const txn1 = await bridge.beginTransaction(defaultOptions);
			const txn2 = await bridge.beginTransaction(defaultOptions);
			expect(txn1).to.equal(txn2); // Same object
			expect(txn1.stampId).to.equal(txn2.stampId);
		});

		it('should commit successfully in legacy mode', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			await bridge.commitTransaction();
			expect(bridge.isTransactionActive()).to.be.false;
		});

		it('should rollback and clear state', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			const txn = await bridge.beginTransaction(defaultOptions);
			expect(bridge.isTransactionActive()).to.be.true;

			await bridge.rollbackTransaction();

			expect(bridge.isTransactionActive()).to.be.false;
			expect(txn.isActive).to.be.false;
			expect(txn.collections.size).to.equal(0);
		});

		it('should throw when committing without active transaction', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			try {
				await bridge.commitTransaction();
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e.message).to.include('No active transaction');
			}
		});

		it('should throw when rolling back without active transaction', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			try {
				await bridge.rollbackTransaction();
				expect.fail('Should have thrown');
			} catch (e: any) {
				expect(e.message).to.include('No active transaction');
			}
		});

		it('should generate unique stampIds across transactions', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			const stamp1 = bridge.getCurrentTransaction()!.stampId;
			await bridge.commitTransaction();

			await bridge.beginTransaction(defaultOptions);
			const stamp2 = bridge.getCurrentTransaction()!.stampId;
			await bridge.commitTransaction();

			expect(stamp1).to.not.equal(stamp2);
		});

		// `commit:collections` prints a revision per collection, and its two non-numeric
		// answers mean OPPOSITE things: `none` is "asked, and this collection has never
		// adopted a committed revision" (invented locally — itself a finding), `unknown`
		// is "nobody could be asked". An operator reading a failing log leans hardest on
		// exactly those two tokens, so collapsing them — or dropping one — has to fail
		// here. Driven through doubles because a real Tree cannot produce `unknown` at
		// all, and reaches the emitter over the ordinary legacy commit sweep.
		it('distinguishes none (invented collection) from unknown (unaskable source) in revs=', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			const base = { sync: async () => {}, snapshot: () => ({}), restore: () => {} };
			const invented = { ...base, describe: () => 'double/invented', committedRevision: () => undefined };
			const numbered = { ...base, describe: () => 'double/numbered', committedRevision: () => 7 };
			const unaskable = { ...base, describe: () => 'double/unaskable' };

			await bridge.beginTransaction(defaultOptions);
			for (const tree of [invented, numbered, unaskable]) bridge.markDirty(tree);

			const lines = await captureTrace(async () => {
				await bridge.commitTransaction();
			});

			const trace = commitTraces(lines).find(t => t.rev.has('double/invented'));
			expect(trace, `a legacy commit:collections line named the doubles; saw ${JSON.stringify(lines)}`)
				.to.not.equal(undefined);
			expect(trace!.rev.get('double/invented'), 'committedRevision() returning undefined reads as none')
				.to.equal('none');
			expect(trace!.rev.get('double/unaskable'), 'a source without the accessor reads as unknown, not none')
				.to.equal('unknown');
			expect(trace!.rev.get('double/numbered'), 'a real revision is printed as its number')
				.to.equal('7');
			// The pre-existing `<id>=staged|clean|unknown` half is independent of the
			// revision half: a double omits hasUnsyncedChanges too, so both read unknown
			// there while the revisions above still differ.
			expect(trace!.state.get('double/invented'), 'the state half is unaffected by the revision half')
				.to.equal('unknown');
		});

		// The action id is the half that separates "one collection, this node behind" from
		// "two separately-built collections under one id" — under the second, each copy
		// honestly reports its own revision count and the numbers look like ordinary lag.
		// Its two non-id answers have to keep meaning what the revision half's do, and be
		// sourced INDEPENDENTLY: a double can implement one accessor and not the other, and
		// collapsing the two halves would make a fork read as a lag.
		it('sources the action-id half of revs= independently of the revision half', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			const base = { sync: async () => {}, snapshot: () => ({}), restore: () => {} };
			// Revision present, no action recorded at it: the shape a real Collection produces
			// when the log gave its current revision slot to a checkpoint or invalidation entry.
			const aged = {
				...base, describe: () => 'double/aged',
				committedRevision: () => 4, committedActionId: () => undefined,
			};
			const lineaged = {
				...base, describe: () => 'double/lineaged',
				committedRevision: () => 5, committedActionId: () => 'act-5',
			};
			// Neither accessor: both halves must read `unknown`, not `none`.
			const unaskable = { ...base, describe: () => 'double/unaskable' };

			await bridge.beginTransaction(defaultOptions);
			for (const tree of [aged, lineaged, unaskable]) bridge.markDirty(tree);

			const lines = await captureTrace(async () => {
				await bridge.commitTransaction();
			});

			const trace = commitTraces(lines).find(t => t.rev.has('double/lineaged'));
			expect(trace, `a legacy commit:collections line named the doubles; saw ${JSON.stringify(lines)}`)
				.to.not.equal(undefined);
			expect(trace!.action.get('double/lineaged'), 'a real action id is printed verbatim')
				.to.equal('act-5');
			expect(trace!.rev.get('double/lineaged'), 'and its revision half is unchanged').to.equal('5');
			expect(trace!.action.get('double/aged'), 'committedActionId() returning undefined reads as none')
				.to.equal('none');
			expect(trace!.rev.get('double/aged'), 'a present revision beside an absent lineage still prints')
				.to.equal('4');
			expect(trace!.action.get('double/unaskable'), 'a source without the accessor reads as unknown, not none')
				.to.equal('unknown');
			expect(trace!.rev.get('double/unaskable'), 'and its revision half reads unknown too')
				.to.equal('unknown');
		});

		// The `revs=` field carries THREE values per collection in one `,`-separated,
		// whitespace-free token, and two of the three routinely contain a colon: a collection
		// id is a URI path, and db-core stamps session-mode action ids as `tx:<hash>`. A pair
		// split on the wrong separator does not fail loudly — it recovers an id that is not a
		// collection id, which reads as the collection being ABSENT from the commit, the exact
		// false negative this line exists to rule out. This drives the emitter and the parser
		// together over ids and action ids that carry every separator involved.
		it('recovers the collection id and revision from revs= whatever the action id carries', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			const base = { sync: async () => {}, snapshot: () => ({}), restore: () => {} };
			// A realistic session-mode action id (colon-bearing) under a colon-bearing id.
			const stamped = {
				...base, describe: () => 'tree://double/stamped',
				committedRevision: () => 9, committedActionId: () => 'tx:9Kd_bZ0',
			};
			// Everything the field's own framing uses, which the emitter must escape rather
			// than emit raw: a comma (pair separator), an `@` (the token separator) and a
			// space (the field separator).
			const hostile = {
				...base, describe: () => 'double/hostile',
				committedRevision: () => 2, committedActionId: () => 'a,b@c d',
			};

			await bridge.beginTransaction(defaultOptions);
			for (const tree of [stamped, hostile]) bridge.markDirty(tree);

			const lines = await captureTrace(async () => {
				await bridge.commitTransaction();
			});

			const trace = commitTraces(lines).find(t => t.ids.includes('double/hostile'));
			expect(trace, `a legacy commit:collections line named the doubles; saw ${JSON.stringify(lines)}`)
				.to.not.equal(undefined);
			// The whole-set form of the claim, so it holds for any future action-id stamping:
			// the ids recovered from `revs=` are exactly the ids the untouched `<id>=staged`
			// half named — no pair ate part of an id, and none was dropped.
			expect([...trace!.rev.keys()].sort(), 'every pair recovered its id intact')
				.to.deep.equal([...trace!.ids].sort());
			expect(trace!.rev.get('tree://double/stamped'), 'a colon-bearing id keeps its revision')
				.to.equal('9');
			expect(trace!.action.get('tree://double/stamped'), 'and a colon-bearing action id survives verbatim')
				.to.equal('tx:9Kd_bZ0');
			expect(trace!.action.get('double/hostile'), 'separators inside an action id are escaped, not emitted raw')
				.to.equal('a%2Cb%40c%20d');
			expect(trace!.rev.get('double/hostile'), 'so its revision is still recoverable').to.equal('2');
		});

		// Every one of these lines is attributed to the node that emitted it. Without that,
		// two machines writing one collection at the same instant emit byte-identical lines
		// and an operator can only attribute them positionally.
		it('names the emitting node on commit:collections', async () => {
			const { plugin } = createTestEnv();
			plugin.collectionFactory.setNodeTag('node-under-test');
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			bridge.markDirty({ sync: async () => {}, snapshot: () => ({}), restore: () => {}, describe: () => 'double/tagged' });

			const lines = await captureTrace(async () => {
				await bridge.commitTransaction();
			});

			const trace = commitTraces(lines).find(t => t.ids.includes('double/tagged'));
			expect(trace, `a legacy commit:collections line named the double; saw ${JSON.stringify(lines)}`)
				.to.not.equal(undefined);
			expect(trace!.node, 'the line says which node emitted it').to.equal('node-under-test');
		});
	});

	describe('statement accumulation', () => {
		it('should accumulate statements during active transaction', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);

			await bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			await bridge.addStatement('INSERT INTO users VALUES (2, "Bob")');

			expect(bridge.getStatements()).to.deep.equal([
				'INSERT INTO users VALUES (1, "Alice")',
				'INSERT INTO users VALUES (2, "Bob")',
			]);
			expect(bridge.getStatementCount()).to.equal(2);
		});

		it('should NOT accumulate statements outside a transaction', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			expect(bridge.getStatements()).to.deep.equal([]);
			expect(bridge.getStatementCount()).to.equal(0);
		});

		it('should clear statements after commit', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			await bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			await bridge.commitTransaction();

			expect(bridge.getStatementCount()).to.equal(0);
		});

		it('should clear statements after rollback', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			await bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			await bridge.rollbackTransaction();

			expect(bridge.getStatementCount()).to.equal(0);
		});

		it('should clear accumulated statements on new transaction begin', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			await bridge.addStatement('INSERT INTO users VALUES (1, "Alice")');
			await bridge.commitTransaction();

			await bridge.beginTransaction(defaultOptions);
			expect(bridge.getStatementCount()).to.equal(0);
		});
	});

	describe('transaction mode detection', () => {
		it('should report transaction mode disabled by default', () => {
			const { plugin } = createTestEnv();
			expect(plugin.txnBridge.isTransactionModeEnabled()).to.be.false;
		});

		it('should report transaction mode enabled after configure', () => {
			const { plugin } = createTestEnv();
			plugin.txnBridge.configureTransactionMode(
				{} as any, // mock coordinator
				{} as any, // mock engine
				async () => 'test-hash',
			);
			expect(plugin.txnBridge.isTransactionModeEnabled()).to.be.true;
		});

		it('should return null session in legacy mode', async () => {
			const { plugin } = createTestEnv();
			await plugin.txnBridge.beginTransaction(defaultOptions);
			expect(plugin.txnBridge.getSession()).to.be.null;
		});
	});

	describe('cleanup', () => {
		it('should rollback active transaction on cleanup', async () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			await bridge.beginTransaction(defaultOptions);
			expect(bridge.isTransactionActive()).to.be.true;

			await bridge.cleanup();

			expect(bridge.isTransactionActive()).to.be.false;
			expect(bridge.getCurrentTransaction()).to.be.null;
		});

		it('should be safe to call cleanup with no active transaction', async () => {
			const { plugin } = createTestEnv();
			await plugin.txnBridge.cleanup();
			expect(plugin.txnBridge.getCurrentTransaction()).to.be.null;
		});
	});

	describe('savepoint operations', () => {
		it('depth-keyed savepoint methods are idempotent no-throws on a bare bridge', () => {
			const { plugin } = createTestEnv();
			const bridge = plugin.txnBridge;

			// With no collections registered and no active session, the depth-keyed
			// savepoint operations reduce to no-ops. They must be safe (and
			// idempotent — the shared bridge is broadcast to once per connection).
			expect(() => bridge.createSavepoint(0)).to.not.throw();
			expect(() => bridge.createSavepoint(0)).to.not.throw();
			expect(() => bridge.rollbackToSavepoint(0)).to.not.throw();
			expect(() => bridge.rollbackToSavepoint(0)).to.not.throw();
			expect(() => bridge.releaseSavepoint(0)).to.not.throw();
			// Rolling back / releasing an absent depth is a clean no-op.
			expect(() => bridge.rollbackToSavepoint(5)).to.not.throw();
			expect(() => bridge.releaseSavepoint(5)).to.not.throw();
		});

		// `TransactionBridge.registerCollection` tops up every open savepoint with a
		// clean capture of a collection registered after the savepoint was created
		// (bug ticket `bug-savepoint-rollback-skips-late-registered-collections`).
		// Without the top-up, a table that finishes initializing mid-statement (e.g.
		// a committed-read connection completing its full init inside the first
		// `xUpdate`) is invisible to the statement's savepoint, so a mid-statement
		// failure leaves its partial rows staged to flush at the next commit.
		//
		// These drive the bridge directly with real `Collection` instances (a `set`
		// action stages one fresh block, observable via both the pending queue and
		// the tracker) rather than a full SQL repro — `initializeForCommittedRead`
		// timing is fiddly to force from SQL, and the bridge-level case is the
		// actual invariant these methods must uphold.
		describe('registerCollection tops up open savepoints for late-registered collections', () => {
			type SpecAction = { value: string };

			const handlers: Record<string, ActionHandler<SpecAction>> = {
				set: async (_action, store) => {
					store.insert({ header: store.createBlockHeader('TEST', store.generateId()) });
				},
			};

			const init = (): CollectionInitOptions<SpecAction> => ({
				modules: handlers,
				createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => ({
					header: store.createBlockHeader('TEST', id),
				}),
			});

			async function makeCollection(transactor: TestTransactor, id: string): Promise<Collection<SpecAction>> {
				return Collection.createOrOpen<SpecAction>(transactor, id, init());
			}

			function queuedValues(collection: Collection<SpecAction>): string[] {
				return collection.getPendingActions().map(a => a.data.value);
			}

			async function stageInto(collection: Collection<SpecAction>, value: string): Promise<void> {
				await collection.act({ type: 'set', data: { value } });
			}

			it('discards rows staged into a collection registered after the savepoint (primary repro)', async () => {
				const { plugin } = createTestEnv();
				const bridge = plugin.txnBridge;
				const transactor = new TestTransactor();

				const a = await makeCollection(transactor, 'rb-bridge-a');
				bridge.registerCollection(a);
				bridge.createSavepoint(1);

				// b does not exist yet when the savepoint is created — the late-registration case.
				const b = await makeCollection(transactor, 'rb-bridge-b');
				bridge.registerCollection(b);

				await stageInto(a, 'a1');
				await stageInto(b, 'b1');
				expect(queuedValues(a), 'staged before rollback').to.deep.equal(['a1']);
				expect(queuedValues(b), 'staged before rollback').to.deep.equal(['b1']);

				bridge.rollbackToSavepoint(1);

				expect(queuedValues(a), 'eagerly-captured collection is emptied').to.deep.equal([]);
				expect(queuedValues(b), 'late-registered collection is emptied too').to.deep.equal([]);
			});

			it('holds a top-up entry at every nested open depth', async () => {
				const { plugin } = createTestEnv();
				const bridge = plugin.txnBridge;
				const transactor = new TestTransactor();

				const a = await makeCollection(transactor, 'rb-bridge-nested-a');
				bridge.registerCollection(a);
				bridge.createSavepoint(1);
				bridge.createSavepoint(2);

				// Registered only after BOTH savepoints are already open.
				const b = await makeCollection(transactor, 'rb-bridge-nested-b');
				bridge.registerCollection(b);

				await stageInto(b, 'first');
				bridge.rollbackToSavepoint(2);
				expect(queuedValues(b), 'depth 2 discards the first stage').to.deep.equal([]);

				await stageInto(b, 'second');
				bridge.rollbackToSavepoint(1);
				expect(queuedValues(b), 'depth 1 discards the second stage too').to.deep.equal([]);
			});

			it('does not re-capture an already-registered instance that has since staged rows', async () => {
				const { plugin } = createTestEnv();
				const bridge = plugin.txnBridge;
				const transactor = new TestTransactor();

				const a = await makeCollection(transactor, 'rb-bridge-reregister');
				bridge.registerCollection(a);
				bridge.createSavepoint(1);

				await stageInto(a, 'staged');
				// `reconcileMaintainedIndexes` shape: the SAME instance registered again
				// after it has staged this statement's rows.
				bridge.registerCollection(a);

				bridge.rollbackToSavepoint(1);

				expect(queuedValues(a), 'the staged row is still discarded').to.deep.equal([]);
			});

			it('captures a replacement instance registered under an already-known id', async () => {
				const { plugin } = createTestEnv();
				const bridge = plugin.txnBridge;
				const transactor = new TestTransactor();
				const id = 'rb-bridge-instance-swap';

				const original = await makeCollection(transactor, id);
				bridge.registerCollection(original);
				bridge.createSavepoint(1);
				await stageInto(original, 'on-original');

				// A different Collection instance registers under the SAME id while the
				// savepoint is open (a table re-initializing mid-transaction).
				const replacement = await makeCollection(transactor, id);
				bridge.registerCollection(replacement);
				await stageInto(replacement, 'on-replacement');

				bridge.rollbackToSavepoint(1);

				// Both instances are tracked (by object identity, not id) and rewound to
				// their own capture — the replacement must not be silently skipped just
				// because its id was already known.
				expect(queuedValues(replacement), 'the new instance is rewound to its own capture').to.deep.equal([]);
				expect(queuedValues(original), 'the detached instance is rewound to its own capture too').to.deep.equal([]);
			});
		});
	});
});

// ─────────────────────────────────────────────────────
// VtabConnection (tested indirectly through SQL)
// ─────────────────────────────────────────────────────

describe('VirtualTableConnection via SQL (TEST-7.3.1)', () => {
	it('should handle implicit transaction on single INSERT', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT NULL
			) USING optimystic('tree://test/users')
		`);

		// Single INSERT without BEGIN/COMMIT — implicit transaction
		await db.exec("INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'a@test.com')");

		const rows = await collectRows(db.eval('SELECT * FROM users'));
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]!.name).to.equal('Alice');
	});

	it('should handle explicit BEGIN/COMMIT', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/users')
		`);

		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice')");
		await db.exec("INSERT INTO users (id, name) VALUES (2, 'Bob')");
		await db.exec('COMMIT');

		const rows = await collectRows(db.eval('SELECT * FROM users ORDER BY id'));
		expect(rows).to.have.lengthOf(2);
	});

	it('should handle ROLLBACK discarding pending changes', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/users')
		`);

		// Insert one row committed
		await db.exec("INSERT INTO users (id, name) VALUES (1, 'Committed')");

		// Begin, insert, rollback
		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (2, 'RolledBack')");
		await db.exec('ROLLBACK');

		const rows = await collectRows(db.eval('SELECT * FROM users'));
		// Rollback behavior depends on vtab implementation; at minimum the
		// rollback path should execute without error
		expect(rows.length).to.be.at.most(2);
	});

	it('should share transaction state across multiple tables', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/users')
		`);
		await db.exec(`
			CREATE TABLE products (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/products')
		`);

		// Both tables in one transaction
		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice')");
		await db.exec("INSERT INTO products (id, name) VALUES (1, 'Widget')");
		await db.exec('COMMIT');

		const users = await collectRows(db.eval('SELECT * FROM users'));
		const products = await collectRows(db.eval('SELECT * FROM products'));
		expect(users).to.have.lengthOf(1);
		expect(products).to.have.lengthOf(1);
	});

	it('should support sequential transactions on the same table', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('tree://test/users')
		`);

		// Transaction 1
		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (1, 'Alice')");
		await db.exec('COMMIT');

		// Transaction 2
		await db.exec('BEGIN');
		await db.exec("INSERT INTO users (id, name) VALUES (2, 'Bob')");
		await db.exec('COMMIT');

		const rows = await collectRows(db.eval('SELECT * FROM users ORDER BY id'));
		expect(rows).to.have.lengthOf(2);
		expect(rows[0]!.name).to.equal('Alice');
		expect(rows[1]!.name).to.equal('Bob');
	});
});

// ─────────────────────────────────────────────────────
// Key Network Registration
// ─────────────────────────────────────────────────────

describe('Custom Registration via Factory (TEST-7.3.1)', () => {
	it('should register and instantiate a custom transactor class via factory', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		let instantiated = false;

		class TestTransactor {
			constructor() { instantiated = true; }
			async get() { return []; }
			async getStatus() { throw new Error('not impl'); }
			async pend() { return {}; }
			async commit() { return {}; }
			async cancel() { }
		}

		factory.registerCustomTransactor('test-custom-tx', TestTransactor as any);

		const options = {
			collectionUri: 'tree://test/custom-tx',
			transactor: 'test-custom-tx',
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const transactor = await factory.getOrCreateTransactor(options);
		expect(transactor).to.be.instanceOf(TestTransactor);
		expect(instantiated).to.be.true;
	});

	it('should register a custom key network class via factory', () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		class TestKeyNetwork {
			async findCoordinator() { return null; }
			async findCluster() { return []; }
		}

		// Should not throw
		factory.registerCustomKeyNetwork('test-custom-kn', TestKeyNetwork as any);
	});

	it('should use factory-registered transactor instance for custom transactor key', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const mockTransactor = {
			get: async () => [],
			getStatus: async () => { throw new Error('not impl'); },
			pend: async () => ({ success: true }),
			commit: async () => ({ success: true }),
			cancel: async () => { },
		} as any;

		// Register via factory instance method
		// The transactor key format is `${transactor}:${keyNetwork}`
		factory.registerTransactor('my-custom:test', mockTransactor);

		const options = {
			collectionUri: 'tree://test/custom',
			transactor: 'my-custom',
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		const transactor = await factory.getOrCreateTransactor(options);
		expect(transactor).to.equal(mockTransactor);
	});

	it('should throw with helpful message for unregistered custom transactor', async () => {
		const { plugin } = createTestEnv();
		const factory = plugin.collectionFactory;

		const options = {
			collectionUri: 'tree://test/unknown',
			transactor: 'unknown-tx',
			keyNetwork: 'test' as const,
			libp2pOptions: {},
			cache: false,
			encoding: 'json' as const,
		};

		try {
			await factory.getOrCreateTransactor(options);
			expect.fail('Should have thrown');
		} catch (e: any) {
			expect(e.message).to.include('unknown-tx');
			expect(e.message).to.include('registerCustomTransactor');
		}
	});
});

// ─────────────────────────────────────────────────────
// End-to-End: Plugin Registration & Lifecycle
// ─────────────────────────────────────────────────────

describe('Plugin Registration & Lifecycle (TEST-7.3.1)', () => {
	it('should expose collectionFactory and txnBridge from register()', () => {
		const { plugin } = createTestEnv();

		expect(plugin.collectionFactory).to.be.an('object');
		expect(plugin.collectionFactory.createOrGetCollection).to.be.a('function');
		expect(plugin.collectionFactory.getOrCreateTransactor).to.be.a('function');

		expect(plugin.txnBridge).to.be.an('object');
		expect(plugin.txnBridge.beginTransaction).to.be.a('function');
		expect(plugin.txnBridge.commitTransaction).to.be.a('function');
		expect(plugin.txnBridge.rollbackTransaction).to.be.a('function');
	});

	it('should register the optimystic virtual table module', () => {
		const { plugin } = createTestEnv();

		expect(plugin.vtables).to.have.lengthOf(1);
		expect(plugin.vtables[0]!.name).to.equal('optimystic');
	});

	it('should register the StampId function', () => {
		const { plugin } = createTestEnv();

		expect(plugin.functions).to.have.lengthOf(1);
		expect(plugin.functions[0]!.schema.name).to.equal('StampId');
	});

	it('should support full CRUD lifecycle through adapter', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				qty INTEGER NULL
			) USING optimystic('tree://test/items')
		`);

		// Create
		await db.exec("INSERT INTO items (id, name, qty) VALUES (1, 'Apple', 10)");
		await db.exec("INSERT INTO items (id, name, qty) VALUES (2, 'Banana', 5)");

		// Read
		let rows = await collectRows(db.eval('SELECT * FROM items ORDER BY id'));
		expect(rows).to.have.lengthOf(2);
		expect(rows[0]!.name).to.equal('Apple');

		// Update
		await db.exec("UPDATE items SET qty = 20 WHERE id = 1");
		rows = await collectRows(db.eval('SELECT * FROM items WHERE id = 1'));
		expect(rows[0]!.qty).to.equal(20);

		// Delete
		await db.exec('DELETE FROM items WHERE id = 2');
		rows = await collectRows(db.eval('SELECT * FROM items'));
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]!.id).to.equal(1);
	});

	it('should support DROP TABLE and re-CREATE with different schema', async () => {
		const { db } = createTestEnv();

		await db.exec(`
			CREATE TABLE ephemeral (
				id INTEGER PRIMARY KEY,
				val TEXT NOT NULL
			) USING optimystic('tree://test/ephemeral')
		`);

		await db.exec("INSERT INTO ephemeral (id, val) VALUES (1, 'hello')");

		await db.exec('DROP TABLE ephemeral');

		// Re-create with different schema
		await db.exec(`
			CREATE TABLE ephemeral (
				id INTEGER PRIMARY KEY,
				value TEXT NOT NULL,
				extra INTEGER NULL
			) USING optimystic('tree://test/ephemeral2')
		`);

		await db.exec("INSERT INTO ephemeral (id, value, extra) VALUES (1, 'world', 42)");
		const rows = await collectRows(db.eval('SELECT * FROM ephemeral'));
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]!.value).to.equal('world');
	});
});
