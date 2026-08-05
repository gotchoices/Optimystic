description: When one database node has a transaction open with unsaved changes and another node commits new data at the same time, the first node can permanently stop seeing that new data — even after it cancels its own transaction.
files: packages/db-core/src/collection/collection.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts
repro: verified
----

# External commit becomes permanently invisible after a staged local transaction

## Observed behavior (verified by hand, 2026-08-05)

Two `Database` instances (A and B) share one storage-backed local transactor
(`StorageRepo` over `MemoryRawStorage`, registered as `local:test` — the same
wiring as `packages/quereus-plugin-optimystic/test/committed-read-interleave.spec.ts`).
Table `Item (id integer primary key, cat text)`; A seeds rows; B hydrates.

| Scenario | Expected | Observed |
| --- | --- | --- |
| A has NO open transaction; B commits a row; A reads | new row visible | visible ✓ |
| A has an OPEN but EMPTY transaction; B commits; A reads inside the txn | visible (or a coherent snapshot) | visible ✓ |
| A has an open transaction WITH a staged row; B commits insert of key `6`; A reads inside the txn | either visible or snapshot-consistent | `6` invisible (defensible as transaction isolation) |
| **A then ROLLS BACK and reads again** | `6` visible — the transaction is gone | **`6` still invisible** |

Storage holds the row (B and a fresh reader see it); node A's live reads do
not, and there is no obvious event that would ever bring it back: the mid-
transaction `Collection.update()` already consumed the log entry for B's
commit (advancing A's revision cursor), so later `update()` calls fetch
nothing new for those blocks. Suspected persistent divergence until some
unrelated commit touches the same blocks; persistence beyond one post-rollback
read is inferred from the cursor advance, not separately verified.

## Repro script

Run from `packages/quereus-plugin-optimystic` (plugin built) as an `.mjs` file:

```js
import { Database } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import register from './dist/plugin.js';

function sharedTransactor(storage) {
  const repo = new StorageRepo((blockId) => new BlockStorage(blockId, storage));
  return {
    async get(g) { return repo.get(g); },
    async getStatus() { throw new Error('not implemented'); },
    async pend(r) { return repo.pend(r); },
    async commit(r) { return repo.commit(r); },
    async cancel(r) { return repo.cancel(r); },
  };
}
function reg(db, transactor) {
  const plugin = register(db, { default_transactor: 'local', default_key_network: 'test' });
  plugin.collectionFactory.registerTransactor('local:test', transactor);
  for (const v of plugin.vtables) db.registerModule(v.name, v.module, v.auxData);
  for (const f of plugin.functions) db.registerFunction(f.schema);
  return plugin;
}
async function count(db) { for await (const r of db.eval('select count(*) as v from Item')) return Number(r.v); }

const storage = new MemoryRawStorage();
const t = sharedTransactor(storage);
const dbA = new Database(); reg(dbA, t);
await dbA.exec(`create table Item (id integer primary key, cat text) using optimystic('tree://dbg/x')`);
await dbA.exec(`insert into Item (id, cat) values (1,'a'), (3,'a'), (4,'a')`);
const dbB = new Database(); const pB = reg(dbB, t); await pB.hydrate(dbB);

await dbA.exec('begin');
await dbA.exec(`insert into Item (id, cat) values (100, 'z')`);   // staged, never committed
await dbB.exec(`insert into Item (id, cat) values (6,'a')`);      // external commit
console.log(await count(dbA)); // 4 (3 committed + staged 100; 6 invisible — maybe OK)
await dbA.exec('rollback');
console.log(await count(dbA)); // EXPECTED 4 (1,3,4,6) — OBSERVED 3 (6 still missing)
```

(Adapted from the probe run during ticket `committed-read-connection-isolation`;
observed values there were 5-vs-4 over a slightly larger seed — same shape.)

## What to determine

- Whether in-transaction invisibility of concurrent external commits is
  intended (snapshot isolation) — probably yes; document it if so.
- Why the fold is lost permanently: the suspect interplay is
  `Collection.updateInternal` (log-entry processing: `sourceCache.clear`,
  `filterConflict` over pending actions, revision-cursor advance) with the
  tree's staged block transforms shadowing reads, plus the Quereus adapter's
  pre-stage snapshot restore on rollback (`TransactionBridge.markDirty` /
  `rollbackTransaction`). Name the exact site, then fix so that after
  rollback (and ideally after commit) the next `update()` observes the
  external row.
- Whether the same loss can affect read-dependency capture (a stale view
  submitted as fresh) — the validator's stale-read rejection may already
  cover the write path; the concern here is silent read staleness.
