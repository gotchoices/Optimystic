description: When the browser's local database gains a new table, nothing checks that an existing browser database survives the change with its data intact — and if another tab still has the old version open, the new tab waits forever with nothing logged to say why. Add the missing check, and make both tabs report what is happening.
architecture: packages/db-p2p/docs/storage.md#5-a-store-is-owned-by-exactly-one-process
files: packages/db-p2p-storage-web/src/db.ts, packages/db-p2p-storage-web/test/db.spec.ts, packages/db-p2p-storage-web/README.md, docs/debugging.md
difficulty: easy
----

# IndexedDB schema upgrades: one test for the whole chain, and a visible blocked upgrade

`packages/db-p2p-storage-web/src/db.ts` has raised `DEFAULT_DB_VERSION` four times — to 2 for the `proofs` object store, 3 for `journal`, 4 for `commitProofs`, 5 for `pieces`. Each bump added a `createObjectStore` call guarded by `objectStoreNames.contains`, which is what makes an existing database gain only the stores it lacks. That guard is the whole upgrade story, and nothing tests it: every case in the package's four spec files opens a *fresh*, uniquely-named database, so the `upgrade` hook always runs on an empty database at version 5 and no version transition is ever executed.

Two things to build. Both are dormant today — no build has shipped to a real browser, so no older database exists anywhere — and both go live at the first release.

## Part 1 — the store set becomes data, and one test covers every bump

The ten `if (!contains) createObjectStore` blocks are ten chances to forget the guard. Replace them with one list and one loop, so the guard is structural rather than repeated:

```ts
/**
 * Every object store in the current schema, in the order the stores appear in
 * {@link OptimysticWebDB}. A version bump appends to this and raises
 * {@link DEFAULT_DB_VERSION}; nothing is ever removed (see the NOTE below).
 */
export const OBJECT_STORES = [
	'metadata', 'revisions', 'pending', 'transactions', 'proofs',
	'commitProofs', 'materialized', 'journal', 'kv', 'pieces',
] as const satisfies readonly StoreNames<OptimysticWebDB>[];
```

`StoreNames` comes from `idb` (it strips `DBSchema`'s index signature, which plain `keyof OptimysticWebDB` would widen to `string | number`). The `satisfies` clause is the point: a name not in the schema is a type error, so the list and the schema interface cannot drift. `createObjectStore` is typed `<Name extends StoreNames<DBTypes>>(name: Name)`, so passing the union from a `for` loop type-checks with no cast.

The hook becomes:

```ts
upgrade(db) {
	for (const store of OBJECT_STORES) {
		if (!db.objectStoreNames.contains(store)) {
			db.createObjectStore(store);
		}
	}
}
```

The upgrade hook is **version-blind** — it is not a chain of per-version migrations, it is one idempotent "create what is missing". So a test that opens at version 1 and reopens at the current version exercises the worst case and covers the version 2, 3 and 4 starting points by construction; there is no need for a case per version. Asserting the reopened database's store set against `OBJECT_STORES` rather than a hardcoded list means a future bump updates one array and the test follows.

Version 1's store set, from the package's first commit, was `metadata`, `revisions`, `pending`, `transactions`, `materialized`, `kv` — six stores. The test creates those by hand (not through `openOptimysticWebDb`, whose hook would create all ten), because the point is to start from a database the current code did not write:

```ts
it('upgrades a version-1 database, adding every store since and keeping its rows', async () => {
	const name = freshDbName();
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
```

The version-1 open uses raw `openDB` with an untyped schema, so the store names and values need no schema parameter — `openDB(name, 1, …)` with no type argument is simplest, since the handle is thrown away immediately.

## Part 2 — a blocked upgrade reports, and the host decides what to do about it

When a tab holds a connection at the old version, the browser will not run the upgrade until that connection closes; the new tab's open request simply waits. `openOptimysticWebDb` passes no `blocked` or `blocking` callback today, so this surfaces as a browser peer that never finishes initializing storage, with nothing logged.

**The resolution is settled, and it is not a self-close.** The plan ticket left open whether the old tab's connection should close itself so the upgrade can proceed. It must not — not from inside this function:

- The handle is shared by `IndexedDBRawStorage`, `IndexedDBKVStore`, `IndexedDBPieceStore` and the identity helper, and the first two buffer writes in memory and hold armed timers. The package README already states it plainly: *"A write a store still holds when the handle is closed under it is lost, and a timer it still has armed would fire on a closed handle."* A bare `db.close()` from a `blocking` handler would therefore silently discard journaled-but-unapplied writes in the old tab to fix a hang in a different tab — trading a correctness loss for a liveness gain, which is not a defensible library default.
- `openOptimysticWebDb` cannot avoid that, because it does not own the stores attached to its handle: the stores are constructed afterwards, by the host, and the README already puts the shutdown order in the host's hands (`rawStorage.close()` → `kvStore.close()` → `db.close()`). A `blocking` event is a request to run exactly that sequence, so it belongs to the same owner.
- And the situation itself is one the architecture already forbids: two tabs over one database are two processes over one store, which `packages/db-p2p/docs/storage.md` §5 *A store is owned by exactly one process* rules out and says no backend but the filesystem one enforces. The package's job here is to make a forbidden state **visible** and give the host the hook to resolve it — not to invent a policy it cannot implement correctly.

So: log every lifecycle event unconditionally, and hand each one to the host through an optional callback. With no callbacks supplied the behaviour is exactly today's — the old tab keeps its connection, the new open waits — except that both sides now say so in the log.

```ts
/**
 * Callbacks for the connection-lifecycle events IndexedDB raises outside a normal open. Each is
 * also logged whether or not it is supplied; supplying one is how a host takes action.
 *
 * None of these closes the handle. The handle's stores (`IndexedDBRawStorage`, `IndexedDBKVStore`)
 * buffer writes and hold timers, and this function does not own them, so closing from here would
 * lose writes the host could have flushed. The host owns the close order and so owns the decision.
 */
export interface OptimysticWebDbLifecycle {
	/**
	 * An older connection on this origin is holding up this open, so it is waiting rather than
	 * resolving. (`idb`'s `blocked`.) Diagnosis only: the other tab is the one that can yield.
	 */
	onUpgradeBlocked?(currentVersion: number, requestedVersion: number | null): void;
	/**
	 * This connection is what is holding up another tab's open at a newer version. (`idb`'s
	 * `blocking`.) The recommended handler flushes and closes, then prompts a reload — see the
	 * package README.
	 */
	onBlockingUpgrade?(currentVersion: number, requestedVersion: number | null): void;
	/** The browser closed this connection abnormally — eviction, or site data cleared. (`idb`'s `terminated`; not called for `db.close()`.) */
	onConnectionLost?(): void;
}

export async function openOptimysticWebDb(
	name: string = DEFAULT_DB_NAME,
	version: number = DEFAULT_DB_VERSION,
	lifecycle: OptimysticWebDbLifecycle = {},
): Promise<OptimysticWebDBHandle>
```

`onConnectionLost` covers `idb`'s third lifecycle callback. It is a deliberate addition beyond the two the plan ticket named: an abnormally terminated connection is exactly as silent today as a blocked one, it is the same options type and the same three lines of the same function, and leaving it out means a second ticket later editing the same site. Cut it if you disagree — nothing else depends on it.

Each callback is invoked inside a `try`/`catch` that logs a throw. These run as DOM event listeners, where a throwing listener becomes an uncaught error at the top level rather than something the open can report, so the seam swallows-and-logs instead of letting a host bug escape unattributed.

Log through this package's existing `createLogger` (`src/logger.ts`), namespace `db` — giving `optimystic:db-p2p-storage-web:db` with `upgrade-blocked`, `blocking-upgrade` and `connection-lost` lines. Add the sub-namespace to the `db-p2p-storage-web` row of the namespace table in `docs/debugging.md` (line ~101), beside the existing `storage:indexeddb` note.

Two tests, one per behaviour. `fake-indexeddb` fires both events (`FDBFactory` queues a `versionchange` at the open connections and then a `blocked` at the request), so no new dependency is needed.

**The resolution path.** Close the old connection from inside its own `onBlockingUpgrade` — which is the recommended host handler — then await the newer open. This has no timing dependence at all: the open can only resolve if the whole chain worked.

```ts
it('an old connection told it is blocking can close so the upgrade proceeds', async () => {
	const name = freshDbName();
	const seen: [number, number | null][] = [];
	let old: OptimysticWebDBHandle | undefined;
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
```

`old` is read inside its own open's callback, which is safe: the callback can only fire once another open has begun, which is after this open resolved and assigned it. Note the explicit versions — 1 and 2, not `DEFAULT_DB_VERSION` — because the test is about the blocked signal, not the store set, and an explicit pair keeps it readable after the next bump.

**The diagnosis path.** When the old connection does *not* yield, the waiting open must report. `blocked` fires only if connections are still open after the `versionchange` round, so this is a separate case from the one above — supplying no `onBlockingUpgrade` is what lets it fire:

```ts
it('an open blocked by an older connection reports instead of waiting silently', async () => {
	const name = freshDbName();
	const old = await openOptimysticWebDb(name, 1);
	const blocked: [number, number | null][] = [];
	const opening = openOptimysticWebDb(name, 2, {
		onUpgradeBlocked: (current, requested) => { blocked.push([current, requested]); },
	});

	await new Promise(resolve => setTimeout(resolve, 0));
	expect(blocked).to.deep.equal([[1, 2]]);

	old.close();                 // what the host's handler would do, after flushing
	const db = await opening;    // leave nothing pending
	try {
		expect(db.version).to.equal(2);
	} finally {
		db.close();
	}
});
```

The one macrotask tick is because `fake-indexeddb` queues the `blocked` event as a database task rather than firing it synchronously. If one tick proves flaky, poll for `blocked.length > 0` with a short deadline rather than lengthening the sleep — and say so in the handoff.

The log lines themselves get no test: they are wiring, and the callbacks are the contract.

## Where the tests go

A new `packages/db-p2p-storage-web/test/db.spec.ts`. The plan ticket named `test/indexeddb-storage.spec.ts`, but that file is long and about `IndexedDBRawStorage`/`IndexedDBJournalStore`; these three cases are about `openOptimysticWebDb` itself — its schema and its connection lifecycle. Copy the `fake-indexeddb/auto` import and the `freshDbName()` helper from the existing spec (six lines; not worth a shared support module for one more file).

## Documentation

In `packages/db-p2p-storage-web/README.md`, under *Persistence semantics* beside the paragraph that already describes version 5 and the `VersionError` downgrade, add the recommended host handler for a blocking upgrade — the sequence the host already runs at shutdown, plus a reload prompt:

```ts
const db = await openOptimysticWebDb(DEFAULT_DB_NAME, DEFAULT_DB_VERSION, {
  onBlockingUpgrade: async () => {
    await rawStorage.close();   // applies what it still holds, disarms its timers
    await kvStore.close();
    db.close();                 // the other tab's upgrade can now proceed
    showReloadPrompt();         // this tab's storage is gone until it reloads
  },
});
```

Say plainly why the package does not do this itself: it does not own the stores, and closing the handle under them loses writes they still hold. The README's existing note that *"two tabs over one database run two nodes over one store, which storage.md §5 forbids and nothing here enforces"* is the paragraph this belongs near — the callbacks are what makes that violation visible, not what fixes it.

## Edge cases & interactions

- **Starting from version 2, 3 or 4, not just 1.** The hook is version-blind, so version 1 is the worst case and the others are covered by construction — by inspection of the loop, not by a case each. Do not write four tests.
- **A downgrade** (a build asking for a version below the stored one) rejects with the browser's `VersionError`. Already documented in the README as outside the compatibility promise; it is the browser's behaviour, not this package's, so no test.
- **`onBlockingUpgrade` on a connection with buffered writes.** The callback must never close anything itself — by construction, since `openOptimysticWebDb` only invokes the host's function. The README block is what makes the flush-first ordering the host's known duty.
- **A host callback throws.** Caught and logged at the seam, so a host bug does not become an unattributed uncaught error. By inspection.
- **No `lifecycle` argument.** Must be fully optional: the four existing spec files call `openOptimysticWebDb` with one or two arguments, and the package's own README usage passes none. Enforced by the type and by the existing suite still compiling.
- **`db.close()` must not fire `onConnectionLost`.** `idb` documents `terminated` as not called for an explicit close, which matters because the specs call `db.close()` dozens of times. By inspection of that contract.
- **Two opens at the same version never block.** Only a *higher* requested version raises `versionchange`/`blocked`, so a test that opens twice at `DEFAULT_DB_VERSION` can never exercise either callback. Both Part 2 tests therefore use an explicit 1-then-2 pair.
- **A store dropped from the schema.** The loop never deletes, so a future removal would leave the old store and its rows in place in an existing database. Record as a tripwire `NOTE:` on `OBJECT_STORES` — nothing to build; removing a store is not a thing this package has ever done, and the right handling depends on whether its data needs migrating.

## TODO

- Add `OBJECT_STORES` to `src/db.ts` with the `satisfies readonly StoreNames<OptimysticWebDB>[]` bound, and reduce the `upgrade` hook to one guarded loop over it. Keep the existing comment above `DEFAULT_DB_VERSION`, updating its parenthetical now that this ticket is doing the work it defers.
- Add the `NOTE:` tripwire on `OBJECT_STORES`: the loop only ever creates, so a store removed from the schema would linger in an existing database with its rows; revisit if a store is ever dropped.
- Add `OptimysticWebDbLifecycle` and the third parameter to `openOptimysticWebDb`; wire `blocked`/`blocking`/`terminated`, each logging through `createLogger('db')` and then calling the host's callback inside a `try`/`catch` that logs a throw.
- Add `packages/db-p2p-storage-web/test/db.spec.ts` with the three cases above: the version-1 upgrade, the blocking connection that yields, and the blocked open that reports.
- Document the recommended `onBlockingUpgrade` handler in `packages/db-p2p-storage-web/README.md`, next to the existing version-5 and two-tabs paragraphs, including why the package does not close the handle itself.
- Add the `db` sub-namespace and its three line names to the `db-p2p-storage-web` row of the namespace table in `docs/debugging.md`.
- Build the package (`yarn workspace @optimystic/db-p2p-storage-web build`) and run its suite once (`yarn workspace @optimystic/db-p2p-storage-web test`) — it is a small suite, seconds not minutes.
