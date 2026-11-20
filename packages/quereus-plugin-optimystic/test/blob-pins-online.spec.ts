/**
 * A transaction's blob pins follow its commit (docs/blobs.md §Committing a reference, §SQL "Pins
 * follow the transaction").
 *
 * The rule this holds: while a transaction that references a blob is being committed the blob is
 * pinned on the writer, so the reference its commit publishes is always backed by at least one
 * copy; once the commit lands the writer announces the blob with the table's reference tree as its
 * scope — taking the `owed` hold that keeps the bytes here until the cohort holds them — and only
 * then releases the pin. A transaction that never lands releases its reference pins and leaves an
 * `unstaged` pin, the application's own hold on bytes it put outside the transaction, in place.
 *
 * Every case runs on a `local` transactor over one `MemoryRawStorage` with the plugin's `types` and
 * `functions` registered as `registerPlugin` does — which is what makes a `blobref` column resolve.
 * That transactor has no libp2p node, so the blob backend is a `SingleMachineBlobService`: an
 * announcement there yields an `owed` hold and durability `local` rather than telling a cohort,
 * which is exactly the observable this asserts against. Real blobs throughout (`plugin.blobs.put`
 * of a few bytes), never fabricated references, so `stat` and the `owed` hold mean something.
 *
 * Not here: the two-node proof that the bytes reach the cohort before the row that shows them, which
 * is `two-node-blob-reference.integration.spec.ts`; the queued-transaction, restart and
 * holding-period arms (`blob-pins-queued.spec.ts`, `blob-pins-reconcile.spec.ts`,
 * `blob-pins-unstaged.spec.ts`); and the partial-commit routing, which is the commit routes' own
 * mechanism rather than this one's.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import {
	BlobScopeRegistry, HlcClock, createTransactionId, createTransactionStamp,
} from '@optimystic/db-core';
import type { BlobDurabilityEvent, BlobRef, CollectionId, ITransactor, Transaction } from '@optimystic/db-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import register from '../dist/plugin.js';
import { QUEREUS_ENGINE_ID, QuereusEngine, createQuereusStatement, parsePinLabel } from '../dist/index.js';
import type { ReferenceChange } from '../dist/index.js';
// The fold itself, from source: a pure function the package does not export, read the way
// `adapter-integration.spec.ts` reads `emptyWriteFacts`.
import { addedReferences, emptyBlobReferenceLedger, putReferences } from '../src/optimystic-adapter/blob-reference-ledger.js';
import type { BlobReferenceLedger } from '../src/optimystic-adapter/blob-reference-ledger.js';
import { captureThrown, expectConstraintRefusal, queryAll } from './query-helpers.js';

type Plugin = ReturnType<typeof register>;

const clock = new HlcClock({ nodeId: 'blob-pins' });

const TABLE_DDL = (uri: string) =>
	`create table T (Id integer primary key, R blobref null) using optimystic('${uri}')`;

/**
 * A `local` session over `storage`, as `blob-reference-tree.spec.ts`'s harness builds one. Two
 * sessions over ONE `MemoryRawStorage` are two handles over one block store — the racing shape —
 * each with its own collection factory and so its own blob store.
 */
function createDb(storage: MemoryRawStorage): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => storage,
	} as unknown as Record<string, SqlValue>);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	for (const type of plugin.types) db.registerType(type.name, type.definition);
	return { db, plugin };
}

async function closeAll(...handles: { db: Database; plugin: Plugin }[]): Promise<void> {
	for (const { db, plugin } of handles) {
		db.close();
		await plugin.dispose();
	}
}

/** A few distinct bytes, so each case's blobs are different references. */
async function* someBytes(seed: number): AsyncIterable<Uint8Array> {
	yield Uint8Array.from({ length: 16 }, (_, i) => (seed * 31 + i) % 251);
}

/** The reference tree's collection id — the table's scope — for a table declared at `uri`. */
function scopeOf(uri: string): CollectionId {
	return `${uri.replace(/^tree:\/\//, '')}/blobrefs` as CollectionId;
}

/**
 * The pins THIS machine holds on `ref`, rendered as the kinds the plugin writes and sorted: the
 * `unstaged` pin of a put outside a transaction, the `put` pin of one inside it, and `ref/<scope>`
 * for a committing transaction's reference. A label this plugin did not write renders verbatim, so
 * a stray owner fails the comparison rather than being counted as one of ours.
 */
async function pinsOn(plugin: Plugin, ref: BlobRef): Promise<string[]> {
	const labels = await plugin.blobs.pinsOf(ref);
	return labels.map(label => {
		const parsed = parsePinLabel(label);
		if (parsed === undefined) return `other(${label})`;
		return parsed.kind === 'reference' ? `ref/${parsed.scope}` : parsed.kind;
	}).sort();
}

/** Every pin on this machine whose owner starts with `prefix`. */
async function listPins(plugin: Plugin, prefix: string): Promise<string[]> {
	const found: string[] = [];
	for await (const { ref, owner } of plugin.blobs.listPins(prefix)) found.push(`${ref} ${owner}`);
	return found.sort();
}

async function transactorOf(plugin: Plugin, storage: MemoryRawStorage): Promise<ITransactor> {
	return await plugin.collectionFactory.getOrCreateTransactor({
		collectionUri: 'tree://unused',
		transactor: 'local',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
		rawStorageFactory: () => storage,
	});
}

describe('a transaction\'s blob pins follow its commit', function () {
	this.timeout(30_000);

	it('announces and releases a blob a committed row came to reference', async () => {
		const uri = 'tree://blobpins/announce';
		const storage = new MemoryRawStorage();
		const handle = createDb(storage);
		try {
			const { db, plugin } = handle;
			await db.exec(TABLE_DDL(uri));

			// docs/blobs.md §SQL's own example: put outside any transaction, insert in a later statement.
			const { ref } = await plugin.blobs.put(someBytes(1));
			expect(await pinsOn(plugin, ref), 'a put outside a transaction is pinned as unstaged')
				.to.deep.equal(['unstaged']);
			expect((await plugin.blobs.stat(ref)).durability, 'nothing has announced it yet').to.equal(undefined);

			// Subscribed before the insert, so the event the announcement reports belongs to it.
			const events: BlobDurabilityEvent[] = [];
			const unsubscribe = plugin.blobs.onDurability(event => events.push(event));
			try {
				await db.exec(`insert into T (Id, R) values (1, '${ref}')`);
			} finally {
				unsubscribe();
			}

			expect(await pinsOn(plugin, ref), 'the commit announced the blob and released every pin on it')
				.to.deep.equal([]);
			const stat = await plugin.blobs.stat(ref);
			expect(stat.locality, 'the bytes are still here, held as owed').to.equal('here');
			expect(stat.durability?.quorum, 'a cohort of this machine alone is `local`').to.equal('local');
			expect(events.map(event => event.ref), 'one durability event, for this reference')
				.to.deep.equal([ref]);

			// The announcement named the table's reference tree, which has to be a scope the network
			// lists — an announcement into an unlisted tree teaches nothing.
			const listed = await BlobScopeRegistry.enumerate(await transactorOf(plugin, storage));
			expect(listed.scopes, 'the announced scope is in the registry').to.include(scopeOf(uri));
		} finally {
			await closeAll(handle);
		}
	});

	it('releases a put made inside a rolled-back transaction, and keeps one made before it', async () => {
		const uri = 'tree://blobpins/rollback';
		const storage = new MemoryRawStorage();
		const handle = createDb(storage);
		try {
			const { db, plugin } = handle;
			await db.exec(TABLE_DDL(uri));

			// Put BEFORE the transaction: the application's own hold, which a rollback must not take.
			const before = (await plugin.blobs.put(someBytes(2))).ref;

			await db.exec('begin');
			// The Optimystic transaction opens when a table is first touched, which is what gives the
			// put below a transaction to be labelled for (see the StampId() contract).
			await db.exec(`insert into T (Id, R) values (1, null)`);
			const inside = (await plugin.blobs.put(someBytes(3))).ref;
			expect(await pinsOn(plugin, inside), 'a put inside a transaction is pinned under it')
				.to.deep.equal(['put']);
			await db.exec(`insert into T (Id, R) values (2, '${before}'), (3, '${inside}')`);
			await db.exec('rollback');

			expect(await pinsOn(plugin, inside), 'the transaction put it and took it with it')
				.to.deep.equal([]);
			expect(await pinsOn(plugin, before), 'bytes put outside the transaction stay held')
				.to.deep.equal(['unstaged']);
			for (const ref of [before, inside]) {
				expect((await plugin.blobs.stat(ref)).durability, 'nothing was announced').to.equal(undefined);
			}
		} finally {
			await closeAll(handle);
		}
	});

	it('leaves a reference only a rolled-back savepoint staged unpinned and unannounced', async () => {
		// Legacy (staged-tracker) mode, where the bridge restores the trees on a savepoint rollback
		// and the ledger therefore follows it. Quereus wraps every non-FAIL DML statement in its own
		// savepoint, so this is also the mechanism that keeps an aborted statement's references out.
		const uri = 'tree://blobpins/savepoint';
		const storage = new MemoryRawStorage();
		const handle = createDb(storage);
		try {
			const { db, plugin } = handle;
			await db.exec(TABLE_DDL(uri));
			const kept = (await plugin.blobs.put(someBytes(4))).ref;
			const discarded = (await plugin.blobs.put(someBytes(5))).ref;

			await db.exec('begin');
			await db.exec(`insert into T (Id, R) values (1, '${kept}')`);
			await db.exec('savepoint s');
			await db.exec(`insert into T (Id, R) values (2, '${discarded}')`);
			await db.exec('rollback to s');
			await db.exec('commit');

			expect((await queryAll(db, 'select Id from T order by Id')).map(row => row.Id),
				'only the row outside the savepoint committed').to.deep.equal([1]);

			expect(await pinsOn(plugin, kept), 'the committed row\'s reference was announced and released')
				.to.deep.equal([]);
			expect((await plugin.blobs.stat(kept)).durability?.quorum).to.equal('local');

			expect(await pinsOn(plugin, discarded), 'the discarded statement\'s blob keeps the hold it had')
				.to.deep.equal(['unstaged']);
			expect((await plugin.blobs.stat(discarded)).durability,
				'a reference no row holds is never announced').to.equal(undefined);
		} finally {
			await closeAll(handle);
		}
	});

	it('leaves a refused writer\'s blob pinned as it was, with nothing of the transaction left on it', async () => {
		// Two handles over one block store insert the same primary key with different references. The
		// loser's commit is refused with nothing durable, so its reference pin goes and the `unstaged`
		// pin stays — the retry does not have to put the bytes again.
		const uri = 'tree://blobpins/refused';
		const storage = new MemoryRawStorage();
		const loser = createDb(storage);
		const winner = createDb(storage);
		try {
			for (const { db } of [loser, winner]) await db.exec(TABLE_DDL(uri));
			const refused = (await loser.plugin.blobs.put(someBytes(6))).ref;
			const landed = (await winner.plugin.blobs.put(someBytes(7))).ref;

			await loser.db.exec('begin');
			await loser.db.exec(`insert into T (Id, R) values (1, '${refused}')`);
			await winner.db.exec(`insert into T (Id, R) values (1, '${landed}')`);
			expectConstraintRefusal(await captureThrown(() => loser.db.exec('commit')), 'the loser\'s COMMIT');

			expect(await pinsOn(loser.plugin, refused), 'the refused transaction left no pin of its own')
				.to.deep.equal(['unstaged']);
			expect((await loser.plugin.blobs.stat(refused)).durability,
				'nothing committed, so nothing was announced').to.equal(undefined);
			// The winner's own commit behaved as an uncontested one does, on its own store.
			expect(await pinsOn(winner.plugin, landed)).to.deep.equal([]);
			expect((await winner.plugin.blobs.stat(landed)).durability?.quorum).to.equal('local');
		} finally {
			await closeAll(loser, winner);
		}
	});

	it('neither pins nor announces anything while re-executing a replicated transaction', async () => {
		// A validating member derives the same reference-tree entries as the writer — that is the
		// point — but has no bytes, so it must not touch the blob service at all (docs/blobs.md
		// §Registering references, "Members never check whether the bytes exist"). The guard is in
		// `QuereusEngine.execute`, so the engine is driven directly: going through
		// `createQuereusValidator` would add a schema-hash and operations-hash dance that tests
		// nothing here.
		const uri = 'tree://blobpins/replay';
		const storage = new MemoryRawStorage();
		const writer = createDb(storage);
		const member = createDb(storage);
		let engine: QuereusEngine | undefined;
		try {
			await writer.db.exec(TABLE_DDL(uri));
			const { ref } = await writer.plugin.blobs.put(someBytes(8));
			await member.db.exec(TABLE_DDL(uri));

			engine = new QuereusEngine(member.db, {} as never);
			const statements = [createQuereusStatement(`insert into T (Id, R) values (9, '${ref}')`)];
			const result = await engine.execute(await replicatedTransaction(statements));
			expect(result.success, result.error).to.equal(true);
			expect((await queryAll(member.db, 'select Id, R from T order by Id')),
				'the re-execution staged and committed the row, as it must').to.deep.equal([{ Id: 9, R: ref }]);

			// The member's own blob store, which only its re-execution could have written to.
			expect(await listPins(member.plugin, 'sql'), 'no transaction pin').to.deep.equal([]);
			expect(await listPins(member.plugin, 'sql-unstaged/'), 'no unstaged pin').to.deep.equal([]);
			const stat = await member.plugin.blobs.stat(ref);
			expect(stat.locality, 'the member holds none of the bytes').to.equal('unknown');
			// The load-bearing one: an announcement would have created a record with durability
			// `local` and an `owed` hold, keeping bytes this machine never had on behalf of a
			// transaction it does not own.
			expect(stat.durability, 'the member announced nothing').to.equal(undefined);
		} finally {
			engine?.dispose();
			await closeAll(member, writer);
		}
	});
});

/**
 * `addedReferences` — the fold that decides WHAT a commit pins, over the changes a transaction's
 * statements staged.
 *
 * Worth its own cases because its key is the REFERRER (one row's one column, which holds at most one
 * reference at a time), not the reference: that is what makes "the last change staged here" equal
 * what the reference tree will hold once the commit lands. Five of the shapes below are reachable
 * through SQL but observable only as the absence of a pin, which no end-to-end case above
 * distinguishes from a pin that was taken and released.
 */
describe('what a commit pins', () => {
	const R1 = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
	const R2 = 'bafkreicojquuwmy7piqjti3zx3buxh47ya64i2vumxmzr5gwqpnfgsd6nu';
	const KEY = 'tree-a/blobrefs';
	const OTHER = 'tree-b/blobrefs';

	/** A ledger holding `changes` on one network, as the bridge records them. */
	function ledgerOf(changes: readonly ReferenceChange[]): BlobReferenceLedger {
		const ledger = emptyBlobReferenceLedger();
		for (const change of changes) ledger.records.push({ backendKey: 'local:test', change });
		return ledger;
	}

	const change = (op: 'add' | 'remove', ref: string, referrer: string, scope = KEY): ReferenceChange =>
		({ op, ref: ref as BlobRef, referrer, scope });

	/** Each case's expectation as `<ref> <scope>`, sorted, so a failure names what it pinned. */
	function pinned(changes: readonly ReferenceChange[]): string[] {
		return addedReferences(ledgerOf(changes)).map(({ ref, scope }) => `${ref} ${scope}`).sort();
	}

	const CASES: readonly { readonly name: string; readonly staged: readonly ReferenceChange[]; readonly pins: string[] }[] = [
		{
			name: 'an insert and a delete of one row in one transaction pin nothing',
			staged: [change('add', R1, 'row1.C'), change('remove', R1, 'row1.C')],
			pins: [],
		},
		{
			name: 'an update from one reference to another pins only the new one',
			staged: [change('remove', R1, 'row1.C'), change('add', R2, 'row1.C')],
			pins: [`${R2} ${KEY}`],
		},
		{
			name: 'a reference merely removed from a row committed earlier is never pinned',
			staged: [change('remove', R1, 'row1.C')],
			pins: [],
		},
		{
			// The two referrers are the row's old and new primary key, so the add survives.
			name: 'a primary-key move keeps the reference pinned',
			staged: [change('remove', R1, 'old.C'), change('add', R1, 'new.C')],
			pins: [`${R1} ${KEY}`],
		},
		{
			// The displaced row and the moving row stage the IDENTICAL referrer; remove-then-add is
			// the order the maintainer stages them in, and it is what leaves the entry present.
			name: 'a displacing move where both rows hold one reference in one column keeps one pin',
			staged: [change('remove', R1, 'k2.C'), change('remove', R1, 'k1.C'), change('add', R1, 'k2.C')],
			pins: [`${R1} ${KEY}`],
		},
		{
			name: 'two rows of one table referencing one blob are one pin',
			staged: [change('add', R1, 'row1.C'), change('add', R1, 'row2.C')],
			pins: [`${R1} ${KEY}`],
		},
		{
			name: 'two columns of one row referencing one blob are one pin, since they share a scope',
			staged: [change('add', R1, 'row1.C'), change('add', R1, 'row1.D')],
			pins: [`${R1} ${KEY}`],
		},
		{
			name: 'one blob referenced from two tables is two scopes and so two pins',
			staged: [change('add', R1, 'row1.C'), change('add', R1, 'row9.C', OTHER)],
			pins: [`${R1} ${KEY}`, `${R1} ${OTHER}`],
		},
	];

	for (const { name, staged, pins } of CASES) {
		it(name, () => {
			expect(pinned(staged)).to.deep.equal(pins);
		});
	}

	it('counts one blob put twice in a transaction once', () => {
		const ledger = emptyBlobReferenceLedger();
		ledger.puts.push({ backendKey: 'local:test', ref: R1 as BlobRef });
		ledger.puts.push({ backendKey: 'local:test', ref: R1 as BlobRef });
		ledger.puts.push({ backendKey: 'other:test', ref: R1 as BlobRef });
		expect(putReferences(ledger).map(put => `${put.ref} ${put.backendKey}`))
			.to.deep.equal([`${R1} local:test`, `${R1} other:test`]);
	});
});

/** One replicated transaction carrying `statements`, as `engine-execution.spec.ts` builds one. */
async function replicatedTransaction(statements: string[]): Promise<Transaction> {
	const stamp = await createTransactionStamp('member-peer', Date.now(), 'test-schema-hash', QUEREUS_ENGINE_ID);
	const hlc = clock.now();
	return {
		stamp,
		statements,
		reads: [],
		hlc,
		lane: 'serializable',
		id: await createTransactionId(stamp.id, statements, [], hlc, 'serializable'),
	};
}
