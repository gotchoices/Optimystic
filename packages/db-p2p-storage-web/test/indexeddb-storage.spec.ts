// Polyfill IndexedDB into the Node test environment before importing `idb`.
import 'fake-indexeddb/auto';
import { expect } from 'chai';
import { IndexedDBRawStorage, IndexedDBStoreDriver } from '../src/indexeddb-storage.js';
import { openOptimysticWebDb, type OptimysticWebDBHandle } from '../src/db.js';
import { runRawStorageConformance, type ConformanceHarness } from '@optimystic/db-p2p/testing';
import type { BlockId, ActionId } from '@optimystic/db-core';

let dbCounter = 0;

async function freshDb(): Promise<OptimysticWebDBHandle> {
	return openOptimysticWebDb(`optimystic-idb-test-${++dbCounter}-${Math.random().toString(36).slice(2)}`);
}

// ---------------------------------------------------------------------------
// Shared parity suite. Proves IndexedDBRawStorage (KvRawStorage over
// IndexedDBStoreDriver) behaves identically to every other backend — round-trips,
// listRevisions ordering, promote atomicity + the exact missing-pend error,
// clone-on-store/read (structural via the byte boundary), drain-before-yield
// iteration, and a BlockStorage parity slice. Runs against `fake-indexeddb`;
// production is the browser, both satisfy the handle interface. Each case gets a
// fresh, uniquely-named db that cleanup closes.
// ---------------------------------------------------------------------------
runRawStorageConformance('IndexedDB', async (): Promise<ConformanceHarness> => {
	const db = await freshDb();
	return {
		storage: new IndexedDBRawStorage(db),
		cleanup: async () => { db.close(); }
	};
});

// ---------------------------------------------------------------------------
// IndexedDB-only tests the shared suite does not cover.
// ---------------------------------------------------------------------------
describe('IndexedDB driver specifics', () => {
	let db: OptimysticWebDBHandle;

	beforeEach(async () => {
		db = await freshDb();
	});

	afterEach(() => {
		db.close();
	});

	// The shared suite has no getApproximateBytesUsed case; navigator.storage is
	// generally absent under Node + fake-indexeddb, so we expect 0. In a real
	// browser the value is > 0; the contract here is "doesn't throw, returns a
	// number >= 0."
	it('getApproximateBytesUsed returns a number', async () => {
		const storage = new IndexedDBRawStorage(db);
		const used = await storage.getApproximateBytesUsed();
		expect(used).to.be.a('number');
		expect(used).to.be.at.least(0);
	});

	// Structured-clone byte fidelity is IndexedDB-specific: a stored Uint8Array
	// must come back AS a Uint8Array (not an ArrayBuffer / DataView), byte-for-byte,
	// or the kernel's decode would drift. Assert it at the driver's byte boundary
	// directly. (The conformance round-trip/clone cases catch this indirectly via
	// decode; this pins the exact type + bytes.)
	it('stores and returns a byte-identical Uint8Array (structured-clone fidelity)', async () => {
		const driver = new IndexedDBStoreDriver(db);
		const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
		await driver.putMetadata('bytes-block' as BlockId, bytes);

		const got = await driver.getMetadata('bytes-block' as BlockId);
		expect(got).to.be.instanceOf(Uint8Array);
		expect(Array.from(got!)).to.deep.equal([0, 1, 2, 250, 255, 128]);
	});

	// The pending scan relies on IndexedDB array-key ordering: the
	// `[blockId] .. [blockId, []]` bound must capture every `[blockId, actionId]`
	// key for the block and nothing from a neighbouring block whose id sorts
	// adjacently. Exercise it directly at the driver level.
	it('listPendingActionIds captures all of a block and leaks no neighbour', async () => {
		const driver = new IndexedDBStoreDriver(db);
		const value = new Uint8Array([1]);
		await driver.putPending('block-1' as BlockId, 'a' as ActionId, value);
		await driver.putPending('block-1' as BlockId, 'b' as ActionId, value);
		// `block-10` sorts adjacent to `block-1` under string comparison; it must
		// not leak into `block-1`'s pending listing.
		await driver.putPending('block-10' as BlockId, 'x' as ActionId, value);

		const ids: ActionId[] = [];
		for await (const id of driver.listPendingActionIds('block-1' as BlockId)) ids.push(id);
		expect(ids.sort()).to.deep.equal(['a', 'b']);
	});
});
