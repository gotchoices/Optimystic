// Polyfill IndexedDB into the Node test environment before importing `idb`.
import 'fake-indexeddb/auto';
import { expect } from 'chai';
import { openDB } from 'idb';
import {
	openOptimysticWebDb,
	DEFAULT_DB_VERSION,
	OBJECT_STORES,
	type OptimysticWebDBHandle,
} from '../src/db.js';

let dbCounter = 0;

function freshDbName(): string {
	return `optimystic-idb-db-test-${++dbCounter}-${Math.random().toString(36).slice(2)}`;
}

describe('openOptimysticWebDb', () => {
	// The `upgrade` hook is version-blind — one idempotent "create what is missing", not a chain of
	// per-version migrations — so version 1 is the worst case and the version 2, 3 and 4 starting
	// points are covered by construction.
	it('upgrades a version-1 database, adding every store since and keeping its rows', async () => {
		const name = freshDbName();
		// The version-1 store set, by hand rather than through `openOptimysticWebDb`, whose hook
		// would create all ten: the point is to start from a database this build did not write.
		const v1 = await openDB(name, 1, {
			upgrade(db) {
				for (const store of ['metadata', 'revisions', 'pending', 'transactions', 'materialized', 'kv']) {
					db.createObjectStore(store);
				}
			},
		});
		await v1.put('metadata', new Uint8Array([7]), 'old-block');
		await v1.put('kv', 'old-value', 'old-key');
		v1.close();

		const db = await openOptimysticWebDb(name);
		try {
			expect(db.version).to.equal(DEFAULT_DB_VERSION);
			expect([...db.objectStoreNames].sort()).to.deep.equal([...OBJECT_STORES].sort());
			expect(Array.from((await db.get('metadata', 'old-block'))!)).to.deep.equal([7]);
			expect(await db.get('kv', 'old-key')).to.equal('old-value');
		} finally {
			db.close();
		}
	});

	// Explicit versions 1 and 2 rather than `DEFAULT_DB_VERSION`: only a *higher* requested version
	// raises `versionchange`, and the pair stays readable after the next bump.
	it('an old connection told it is blocking can close so the upgrade proceeds', async () => {
		const name = freshDbName();
		const seen: [number, number | null][] = [];
		let old: OptimysticWebDBHandle | undefined;
		// Reading `old` inside its own open's callback is safe: the callback can only fire once
		// another open has begun, which is after this open resolved and assigned it.
		old = await openOptimysticWebDb(name, 1, {
			onBlockingUpgrade: (current, requested) => {
				seen.push([current, requested]);
				old!.close();
			},
		});

		const db = await openOptimysticWebDb(name, 2);
		try {
			expect(seen).to.deep.equal([[1, 2]]);
			expect(db.version).to.equal(2);
		} finally {
			db.close();
		}
	});

	// `blocked` fires only if connections are still open after the `versionchange` round, so
	// supplying no `onBlockingUpgrade` is what lets it fire.
	it('an open blocked by an older connection reports instead of waiting silently', async () => {
		const name = freshDbName();
		const old = await openOptimysticWebDb(name, 1);
		// Awaited rather than polled after a tick: the event is queued, not raised synchronously,
		// and awaiting it is what makes the assertion independent of how many turns that takes. If
		// it never fires the test fails on mocha's timeout, naming this line.
		let reportBlocked!: (seen: [number, number | null]) => void;
		const blocked = new Promise<[number, number | null]>(resolve => { reportBlocked = resolve; });
		const opening = openOptimysticWebDb(name, 2, {
			onUpgradeBlocked: (current, requested) => { reportBlocked([current, requested]); },
		});

		expect(await blocked).to.deep.equal([1, 2]);

		old.close();              // what the host's handler would do, after flushing
		const db = await opening; // leave nothing pending
		try {
			expect(db.version).to.equal(2);
		} finally {
			db.close();
		}
	});
});
