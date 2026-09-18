# @optimystic/quereus-plugin-optimystic

A [Quereus](https://github.com/nicktobey/quereus) virtual table plugin that provides SQL access to [Optimystic](../../docs/internals.md) distributed tree collections.

## Overview

This plugin registers an `optimystic` virtual table module and a `StampId()` SQL function with Quereus. Tables created with `USING optimystic(...)` are backed by Optimystic distributed trees — you define your own schema (columns, types, indexes) and the plugin handles encoding, storage, and distributed sync.

For cryptographic functions, see the separate [@optimystic/quereus-plugin-crypto](../quereus-plugin-crypto) package.

## Quick Start

```typescript
import { Database } from '@quereus/quereus';
import { register } from '@optimystic/quereus-plugin-optimystic';

const db = new Database();
register(db, { debug: false });

await db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT
  ) USING optimystic('tree://myapp/users', transactor='test', keyNetwork='test');
`);

await db.exec("INSERT INTO users VALUES ('u1', 'Alice', 'alice@example.com')");
const rows = await db.all("SELECT * FROM users WHERE id = 'u1'");
```

See [examples/README.md](./examples/README.md) for Quoomb interactive console configs and multi-node mesh setup.

## Warm Restart — `plugin.hydrate(db)`

When re-opening a `Database` against storage that already contains Optimystic-backed tables, call `plugin.hydrate(db)` **before** running any `apply schema` or `CREATE TABLE IF NOT EXISTS` statements. Without hydration, Quereus diffs the new DDL against an empty in-memory catalog and re-emits a `CREATE TABLE` (and per-index `CREATE INDEX`) for every table — each one round-tripping through the schema tree even though no row data changes. After hydration the catalog already lists those tables, so the DDL diff is a no-op.

```typescript
const plugin = register(db, { default_transactor: 'local', ... });
for (const v of plugin.vtables) db.registerModule(v.name, v.module, v.auxData);
for (const f of plugin.functions) db.registerFunction(f.schema);

await plugin.hydrate(db); // populate catalog from persisted vtab schemas

await db.exec(`declare schema App { ... } apply schema App;`); // no-op after hydrate
```

`hydrate(db)` resolves to `{ tables, indexes }` (counts of newly-added catalog entries). It is idempotent and a no-op against empty storage.

Everything the declaration determines is persisted in the table's catalog record and rebuilt by `hydrate`, so a hydrated table is the table the same declaration would create in this session: its columns with their declared type spelling (`int`, `varchar(20)`), collations, literal and expression defaults, generated columns, named and unnamed `CHECK`s, foreign keys, `with context` variables, column and table tags, secondary `UNIQUE` constraints and indexes (with the `unique`/partial-predicate flags of `CREATE UNIQUE INDEX`), and the conflict action each rule declares for itself (`unique on conflict ignore`, `primary key (…) on conflict replace`, `id integer primary key on conflict replace`). `apply schema` of the same declaration then diffs to nothing, and re-declaring the table is **not** required for enforcement: a host that hydrates and never re-declares still runs its `CHECK`s, its context requirements and its uniqueness rules. That holds for a table that reached its declaration through earlier schema versions too: a named table-level `CHECK` a later version adds to an existing table (`apply schema` runs `ALTER TABLE … ADD CONSTRAINT … CHECK`) is saved in the record in the same apply, as is one added by a direct `alter table … add [constraint <name>] check (…)`. Like Quereus's own tables, rows already stored are not re-checked against it. Quereus's schema diff does not notice an *unnamed* table-level `CHECK` or a column-level `CHECK` added to an existing table, so `apply schema` never adds those to it (on any module) — name the `CHECK` in the later version. The other `ALTER TABLE` operations are refused (`ADD`/`DROP COLUMN`, `DROP`/`RENAME CONSTRAINT`, `ALTER COLUMN`, `ALTER PRIMARY KEY`, adding a `UNIQUE` or `FOREIGN KEY` constraint), except `RENAME COLUMN`, which renames for the running session only and is not saved in the record. `test/hydrate-restores-declared-table.spec.ts` holds the rebuilt table equal, field by field, to a freshly declared one, so a `TableSchema` field the engine adds later fails that spec until the record carries it.

One thing is deliberately *not* in the record: how the process reaches storage. The `transactor`, `keyNetwork`, `networkName`, `port` and `cache` arguments of `using optimystic(…)` are session binding, not table identity, and are never persisted — the record is the same bytes on every machine that runs one declaration, whichever earlier schema versions that machine migrated through: indexes and `CHECK`s are listed by name, not in the order they were created (so a hydrated table lists them in that order too, where a table declared in this session lists them as declared — this changes no result, but two equally good indexes can be tried in a different order, and when a row breaks several `CHECK`s the one reported can differ; a record written before this rule keeps its creation order until its next schema write, such as a re-declare or a new index, rewrites it), and a table hydrated by a later session opens storage the way that session does, not the way the session that wrote it did. `hydrate` fills them in the way a `create table` without a `using` clause would: from the session's `default_vtab_args` when `optimystic` is its `default_vtab_module`, then from the plugin's registration config (`default_transactor` and friends). The collection URI (the first `using` argument) and the row `encoding` describe the table and its stored bytes, so they stay in the record, and `hydrate` takes only the binding arguments from the session: an `encoding` in `default_vtab_args` applies to tables that session creates, never to a table it hydrates. A binding written explicitly in one table's `using` clause therefore applies to the session that runs that DDL; after a restart the table binds like every other.

A declared action is the *default* for that rule; a statement-level `insert or <action>` always overrides it. `FAIL` and `ROLLBACK` resolved from a declared action behave as `ABORT` (the statement is rejected and the table is unchanged) — the engine selects the FAIL/ROLLBACK unwind behaviour from the statement-level clause only, and its own in-memory tables have the same limitation.

One-time upgrade caveat: a record written by an earlier plugin version lacks whatever that version did not persist (uniqueness metadata, conflict actions, and now `CHECK`s, contexts, foreign keys, tags, declared types, generated-column order and expression defaults), and the no-op DDL after `hydrate` never re-runs the statements that would restore it. Open such storage once with the DDL actually executing (skip `hydrate` for that open); the `CREATE TABLE` / `CREATE INDEX` statements persist the full record in a single schema write, and every later hydrated open is complete.

Format-break caveat: the record shape changed with this version — it carries the fields above, omits the session-binding arguments, and stores expression trees without parser positions — and no record written by an earlier build is read with any compatibility shim (see the upgrade caveat). Separately, the persisted schema record identifies an index's columns by column **name**. Records written by plugin versions that stored a column *position* instead cannot be read — the first table with an index fails with `Persisted catalog record for table '…' is unresolvable`. There is deliberately no fallback to the positional form (it is the ambiguity that made a persisted index outlive the columns it pointed at). Re-create such storage, or migrate each record's index columns from positions to names using that record's own column list.

## Virtual Table Options

Options are passed in the `USING optimystic(...)` clause:

| Option | Description | Default |
|---|---|---|
| First positional arg | Collection URI (e.g. `'tree://myapp/users'`) | `tree://default/{schemaName}/{tableName}` |
| `transactor` | `'network'`, `'local'`, `'test'`, `'mesh-test'`, or custom registered name | `'network'` |
| `keyNetwork` | `'libp2p'`, `'test'`, or custom registered name | `'libp2p'` |
| `port` | libp2p listen port (0 = random) | `0` |
| `networkName` | Network identifier for protocol prefixes | `'optimystic'` |
| `cache` | Enable local collection caching | `true` |
| `encoding` | Row encoding format: `'json'` or `'msgpack'` | `'json'` |

```sql
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL
) USING optimystic(
  'tree://store/products',
  transactor='network',
  keyNetwork='libp2p',
  port=8080,
  networkName='mystore'
);
```

### Default storage location

A table declared without a collection URI is stored at `tree://default/<schema>/<table>` — the engine schema the table belongs to, lowercased the way Quereus names schemas (`main` included), then the table name as declared. `create table Member (…)` in `main` lives at `tree://default/main/Member`; `app.Member` lives at `tree://default/app/Member`. The schema is part of the location so that two tables with the same name in different schemas of one database — a built-in `strand.Member` and an app's own `app.Member` — are two tables in storage, not one. Each table's secondary indexes live under its location (`<uri>/index/<indexName>`), and its schema-catalog record is filed under its schema and name together. `defaultCollectionUri(schemaName, tableName)` is exported for hosts that need to name a table's collection directly.

Two tables that give the **same explicit** URI share storage on purpose — that is how a table is pointed at existing data — and the plugin's declaration guards judge each one against whatever record already describes that storage.

Format-break caveat: plugin versions before the schema was part of the location stored defaulted tables at `tree://default/<table>` and filed catalog records under the bare table name. This version neither reads those records nor opens that storage for a defaulted table: after upgrading, `hydrate` finds no such tables and a re-declared table starts empty at its new location. Declare the table with the old location as an explicit URI (`using optimystic('tree://default/Member')`) to keep reading its rows (covered by `test/same-named-tables-across-schemas.spec.ts`). Tables that already named an explicit URI keep their storage, but their old catalog records are skipped by `hydrate` too, so re-declare them after upgrading.

## Data Model

You define your own schema — the plugin supports arbitrary columns and types. The primary key is serialized as the tree key using an order-preserving, injective tuple framing (see `src/schema/key-encoding.ts`) so composite keys and values containing control bytes never collide or mis-sort. Non-key columns are JSON-encoded as the tree value.

Primary keys should be TEXT for ordered/range performance; other types (INTEGER, REAL, …) work correctly but are not pushed down as ordered seeks — the tree keys them as raw strings that don't preserve numeric order, so the engine re-sorts them. Standard SQL operations (SELECT, INSERT, UPDATE, DELETE) all work regardless of key type. Point lookups on the primary key are optimized (O(log n) seek); range predicates (`>`, `>=`, `<`, `<=`) and all other predicates currently apply over a full scan. An `ORDER BY` is only served directly from an index (skipping the engine's sort) when every ordered column is ascending, BINARY-collated, and TEXT; anything else is sorted correctly by the engine.

## Transactions

The plugin maps Quereus transactions to Optimystic's distributed sync:

- **BEGIN** — Creates a transactor and generates a stamp ID
- **COMMIT** — Syncs all collections (or commits through `TransactionSession` for distributed consensus)
- **ROLLBACK** — Discards local changes and clears session state

The `TransactionBridge` supports two modes:
1. **Legacy mode** (default): Direct collection sync on commit
2. **Transaction mode**: Uses `TransactionSession` for distributed consensus when configured with a coordinator and engine via `configureTransactionMode()`

> **Read consistency note.** In the default `lazy` read-repair mode, a read served from a locally-cached block may return data up to one commit stale (bounded by `readRepairWindowMs`, default 10 s). Reads used as transaction read-dependencies are protected — validators catch stale data at commit time. Bare reads (outside a transaction) carry no such check. Use `readRepairMode: 'paranoid'` to force per-read verification. See [docs/transactions.md — Read Consistency and Staleness](../../docs/transactions.md#read-consistency-and-staleness) for the full discussion and configuration knobs.

### StampId() Function

Returns the current transaction's unique stamp ID, or NULL outside a transaction.

```sql
BEGIN;
SELECT StampId();  -- base64url-encoded 32-byte ID
COMMIT;
```

Format: 16 bytes SHA-256(peer ID) + 16 random bytes, base64url encoded. Stable within a transaction, unique across transactions and peers.

## Reactive Watching

Tables backed by Optimystic drive Quereus's reactive watch API. When a commit
lands on a collection's blocks — whether authored locally or replicated from a
remote peer — the plugin translates it into a `Database.notifyExternalChange`
call, so `Database.watch` / subscribe consumers fire through the normal reactive
path. No polling required.

```typescript
const scope = db.prepare('select * from users where id = ?').getChangeScope([id]);
const sub = db.watch(scope, (event) => {
  // A (local or remote) commit touched `users` — re-query as needed.
});
// ...
sub.unsubscribe();
```

Notes:

- **Coarse, whole-table invalidation.** A remote commit fires watchers as a
  global change for the whole table (it carries no row-level diff). `full` watches
  fire with empty hits; `rows`/`rowsByGroup` watches surface their registered key
  literals as possibly-changed. Over-firing only costs an extra re-query — it never
  misses a change.
- **Host requirement.** Only nodes that **host the collection's blocks** observe
  these commits and push invalidations. Edge/client nodes that don't host blocks
  receive no push and continue to fetch on demand.
- **Transactor support.** Reactive watching works with the `network` transactor
  (the hosting node's storage drives it) and the in-process `local`/`test`
  transactors. `mesh-test` and custom transactors that don't implement
  `IBlockChangeNotifier` degrade gracefully to non-reactive behaviour.

## Transaction Engine

The package exports a `QuereusEngine` that implements `ITransactionEngine` from `@optimystic/db-core`. It re-executes SQL statements through Quereus for transaction validation, and computes schema hashes from the database catalog.

```typescript
import { QuereusEngine, QUEREUS_ENGINE_ID, createQuereusValidator } from '@optimystic/quereus-plugin-optimystic';

const engine = new QuereusEngine(db, coordinator);
const validator = createQuereusValidator({ db, coordinator });
```

`createQuereusStatement()` and `createQuereusStatements()` are helpers for building the JSON statement format used in transaction records.

`QUEREUS_ENGINE_ID` is `quereus@<version>`, where the version is the `@quereus/quereus` this plugin was **built** against, not the one installed at runtime. The build writes it into `src/transaction/quereus-version.ts`. A validator refuses a transaction stamped with an engine id it has not registered (`Unknown engine: …`), so two plugin builds compiled against different Quereus versions refuse each other's session-mode writes, even when both nodes now run the same Quereus. Nodes running the same plugin build agree on the id whatever Quereus they have installed within the peer range; if two such Quereus versions execute a statement differently, validation refuses it on the operations hash instead (see [docs/correctness.md](../../docs/correctness.md) § Theorem 4).

Because the id is fixed at build time, the root entry reads nothing from disk when it loads: it is safe to import in a browser or React Native build. `test/browser-bundle.spec.ts` keeps it that way.

### Schema hash: keep it warm out of band (session mode)

`configureTransactionMode()` takes a `schemaHashProvider` that `beginTransaction`
awaits — and `begin` runs *inside* a statement's exec, while Quereus's exec mutex
is held. The provider therefore **must not re-enter the database**: computing a
schema hash with `db.eval('select … from schema()')` while a statement is in
flight would re-acquire that same mutex and deadlock.

The intended provider is `() => engine.getSchemaHash()`. That engine never
re-enters the db from `begin`: it serves a **cached** hash, and if the cache is
cold while a statement is in flight it **throws an actionable error** instead of
hanging. The flip side is a host obligation — **keep the hash warm out of band**:

```typescript
const engine = new QuereusEngine(db, coordinator);
await engine.getSchemaHash();                       // warm the cache (idle, no statement in flight)
bridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
```

Call `engine.getSchemaHash()` once **outside any statement** after your DDL (and
again after any later schema change made while session mode is live, since the
engine invalidates — but does not auto-recompute — the cache on schema change).
Skip the warm-up and the first transaction's `begin` throws rather than
completing. See `QuereusEngine.getSchemaHash` for the full contract.

## Plugin-Level Configuration

The `register(db, config)` call accepts plugin-level defaults (consumed via the virtual table's `vtabAuxData`):

| Key | Description |
|---|---|
| `default_transactor` | Default `transactor` when a table omits the option |
| `default_key_network` | Default `keyNetwork` when a table omits the option |
| `default_port`, `default_network_name` | libp2p defaults |
| `rawStorageFactory` | `() => IRawStorage` — supplies the raw storage backing the `'local'` transactor. Defaults to in-memory `MemoryRawStorage`. Hosts can plug in persistent storage (e.g. RN/MMKV). Function-typed, so it can only be passed via `register()`, not in a `USING` clause. |

```typescript
import { register } from '@optimystic/quereus-plugin-optimystic';
import { MyMmkvStorage } from './my-storage.js';

register(db, {
  default_transactor: 'local',
  rawStorageFactory: () => new MyMmkvStorage(),
});
```

### Closing down: call `plugin.dispose()` after `db.close()`

`register()` returns a plugin handle with an async `dispose()`. `db.close()` does not reach it,
so call it yourself when you are done with a `Database`:

```typescript
const plugin = register(db, { default_transactor: 'local', rawStorageFactory: () => new FileRawStorage(dir) });
// ...
db.close();
await plugin.dispose();
```

`dispose()` releases the plugin's claim on the read cache that sits in front of your
`rawStorageFactory` storage. That cache is **one per backing store per process**, shared by
every `Database` registered over the same store — which is what lets two `Database`s over one
directory see each other's committed writes — and it is only cleared once the last claim on it
is released.

So a skipped `dispose()` is not a correctness problem (the cache is write-through, and every
in-process write went through it), but it has one visible consequence: the store's cache stays
warm for the life of the process, so a **later** `Database` over the same store reads it
instead of re-reading the backend. If something outside Optimystic mutates that store between
two `Database`s — a test that writes files into the directory itself, say — dispose in between
or the second `Database` will serve the pre-mutation values.

When the plugin owns libp2p nodes, `plugin.collectionFactory.shutdown()` stops them and calls
`dispose()` as its last step; use that instead.

## Custom Networks and Transactors

Register custom implementations before creating tables that reference them:

```typescript
import { registerKeyNetwork, registerTransactor } from '@optimystic/quereus-plugin-optimystic';

registerKeyNetwork('mynetwork', MyCustomKeyNetwork);
registerTransactor('mytransactor', MyCustomTransactor);
```

Then use `transactor='mytransactor'` or `keyNetwork='mynetwork'` in your `USING` clause.

## React Native

Both entries, `@optimystic/quereus-plugin-optimystic` and `@optimystic/quereus-plugin-optimystic/plugin`, bundle for React Native with nothing beyond what `@optimystic/db-p2p` already needs: the global polyfills and the Node built-in module shims listed in [db-p2p's React Native section](../db-p2p/readme.md#react-native). The plugin imports bare `@optimystic/db-p2p`, which the `react-native` export condition routes to db-p2p's React Native entry, so it needs no alias of its own. `yarn check:rn` (the private `packages/rn-bundle-check` workspace) bundles both entries with Metro and compiles them with legacy Hermes, so a change that breaks either step fails in this repository. It never runs the bundle.

At runtime, the `network` transactor cannot build its own libp2p node on React Native: db-p2p's React Native `createLibp2pNode` requires explicit `transports`, and the plugin passes none. Build the node yourself with `createLibp2pNode` from `@optimystic/db-p2p/rn` (see that section for the transports), then hand it to the plugin before creating any table that uses it:

```typescript
const plugin = register(db, { default_transactor: 'network', default_network_name: 'mynet' });
plugin.collectionFactory.registerLibp2pNode('mynet', node, node.coordinatedRepo);
```

A registered node is used by tables whose `networkName` matches and whose `port` resolves to `0`: the default when neither the table's `port` nor the plugin's `default_port` setting names another.

## Quereus SQL Dialect

Quereus is not SQLite — it is a distinct SQL engine with intentional departures from the SQL standard, aligned with [The Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf). Key differences that affect schema design:

- **Columns default to NOT NULL** unless explicitly marked `NULL`. This avoids the "billion-dollar mistake" of nullable-by-default. Use `pragma default_column_nullability = 'nullable'` for SQL-standard behavior.
- **Native temporal types** (`DATE`, `TIME`, `DATETIME`) backed by the Temporal API, instead of storing dates as TEXT/REAL/INTEGER.
- **Native JSON type** with deep equality comparison, not text-based.
- **All tables are virtual tables** — the `USING` clause specifies the backing module.
- **Operation-specific CHECK constraints** — e.g., `CHECK ON INSERT (price >= 0)`.
- **Empty primary keys for singleton tables** — `PRIMARY KEY ()` creates a table limited to 0 or 1 rows, useful for configuration or state tables.
- **`PRIMARY KEY` does not imply `NOT NULL`** (Quereus ≥ 4.14). A key column keeps its declared nullability, so `x integer null primary key` accepts a NULL-keyed row. Under the shipped `not_null` default this is invisible — `id integer primary key` is still non-nullable because *every* column is. Key equality is NULL-self-equal, so two rows with an all-NULL key collide as a duplicate key; SQL comparison stays three-valued, so `where x = null` (or a parameter bound to NULL) matches nothing and only `where x is null` reaches the row. `UNIQUE` still treats NULLs as distinct.
- **Conversion functions** (`integer()`, `date()`, `json()`) preferred over `CAST`.
- **No triggers** — event-driven logic belongs in the application layer.

For the full dialect reference, see the [Quereus SQL Reference](https://github.com/nicktobey/quereus/blob/main/docs/sql.md), particularly Section 11 ("Quereus vs. SQLite").

## Error Handling: typed causes survive the SQL boundary

Optimystic's storage layer raises *typed* read failures so a caller can branch on the
reason rather than parse a sentence — `BlockUnavailableError` carries `reason`
(`'unmaterializable'`, `'peers-unreachable'`, `'cohort-unreachable'`, `'claimed-elsewhere'`)
and `BlockPossiblyStaleError` carries `claimedRev` (see
[docs/transactions.md](../../docs/transactions.md) § Unavailable reads).

This module rewraps a caught failure so the SQL layer gets a message with context
(`"Query failed: …"`), but the original error is preserved on `Error.cause`. Quereus wraps
that in turn and preserves `cause` as well, so the chain reaching an application is:

```
QuereusError  ->  Error ("Query failed: …")  ->  BlockUnavailableError (reason intact)
```

Walk `cause` rather than matching on message text:

```typescript
function rootCause(error: unknown): unknown {
  while (error instanceof Error && error.cause !== undefined) error = error.cause;
  return error;
}

try {
  await db.eval(`select * from t`);
} catch (error) {
  const cause = rootCause(error);
  if (cause instanceof BlockUnavailableError && cause.reason === 'cohort-unreachable') {
    // this node simply could not reach the cohort — retry later, don't treat as absent
  }
}
```

A value thrown that is not an `Error` reaches `cause` unchanged. Message text is unaffected
by this — anything matching on `.message` keeps working.

`PartialCommitError` (a legacy multi-tree commit that durably persisted some trees before it
failed) is exported from the root entry, which imports on every platform, browser and React
Native builds included. Import the class and use `instanceof` rather than matching its `name`
string:

```typescript
import { PartialCommitError } from '@optimystic/quereus-plugin-optimystic';
```

It is also exported from the `./plugin` entry — the one most hosts load the plugin through — so
you can import it from wherever you already load the plugin, with no cross-entry assumption. Both
entries export the same class object, so `instanceof` matches regardless of which one you import
from:

```typescript
import { PartialCommitError } from '@optimystic/quereus-plugin-optimystic/plugin';
```

The `./plugin` entry also re-exports the coordinator-side errors the same retry guidance tells you
to classify on: `CoordinatorPartialCommitError`, `SyncRetryExhaustedError`, and `TornActionError`
(all from `@optimystic/db-core`).

## Limitations

- Primary keys are stored as strings; non-TEXT keys work correctly but are not order-optimised (the engine re-sorts them rather than reading them ordered from the tree)
- `msgpack` encoding is declared but not yet implemented
- Savepoints (including Quereus's internal statement-/row-level atomicity) work in legacy/single-node mode; in distributed-consensus (session) mode they are no-ops, so a mid-statement abort there can still leave partial rows staged
- An UPDATE or DELETE re-reads the row it is about to overwrite (index maintenance needs the pre-write image). If the collection cannot produce that row — the engine and the collection disagreeing about what exists, which a networked transactor can hit as a transient point-lookup miss — the statement fails with `could not find the pre-write row` rather than writing a partially-correct row and silently corrupting secondary indexes
- A connection only maintains the secondary indexes its own table instance knows about. If a query is planned onto an index this connection does not maintain, it fails with `Table 'X' does not maintain index 'Y'` rather than answering from a tree its writes have been skipping. Re-running that index's `CREATE INDEX` on the connection re-attaches it (it is idempotent) and backfills entries for the rows written while it was detached, so nothing stays invisible to index-driven lookups. That re-declare costs one scan of the table and re-stages every row's entry into the attached tree; a `CREATE INDEX` that attaches nothing new (the ordinary warm re-declare) does neither, and one that attaches an index on a table this connection reads as holding no rows skips the scan (and the refresh in front of it) — there is nothing to copy. The backfill populates from the rows the connection can see: its own committed rows, plus anything it has staged in an open transaction. A connection that opens the table cold and finds the index already in the persisted schema attaches nothing and therefore does not verify — rows orphaned by some *other* divergent writer are healed by re-declaring the index on a connection that can see them, not by re-opening the table
- A `CREATE TABLE` that re-declares an existing table (no `DROP TABLE` in between) may reorder or add columns freely — each persisted index keeps pointing at the column it was declared on, and its tree contents stay valid. It may **not** drop a column a persisted index still covers: that is refused with `Cannot re-declare table 'X' without column 'Y': persisted index 'Z' covers it. Drop the index or the table first.` (the catalog holds no index-removal path, so the index would otherwise survive with nothing to point at). Nothing is written when the re-declare is refused
- `DROP TABLE` removes the table's schema from the catalog but does **not** delete its rows or its index trees from storage. What it leaves behind is a *gravestone* — the dropped table's catalog record, kept and stamped with a drop timestamp — so the storage stays described. A later `CREATE TABLE` at the same collection URI is checked against that gravestone (and against any **live** table already declared over the same URI) rather than silently adopting what it finds:
  - **Refused** when the declaration adds a column the surviving rows cannot supply (they would decode as NULL even where the new declaration says `NOT NULL`): `Cannot create table 'X' over '<uri>': that collection still holds rows from a dropped table declared as (…), and this declaration adds column 'Y', which those rows cannot supply.`
  - **Refused** when the declaration re-types a column those rows do carry (a stored row is untagged, so its column types are the only thing that says what a stored value means on the way out): `… still holds rows from a dropped table, and this declaration re-types column 'Y' as BLOB where the stored rows were written as TEXT.`
  - **Refused** when the declaration changes the primary key those rows are keyed under (rows written under the old key can never be reached through the new one): `… still holds rows from a dropped table keyed on (…), and this declaration keys on (…).`
  - **Still inherited** by an identical re-declare, or a narrower one that only drops columns and keeps the primary key and the surviving columns' types — the old rows come back, which is the documented way to re-attach to existing storage (and the way out of the persisted-index re-declare refusal above). Any re-declare over an **empty** collection is allowed under any shape
  - `CREATE INDEX` is held to the same rule over the leftover tree at `<uri>/index/<name>`: adopting a **non-empty** leftover tree under a different column list is refused with `Cannot create index 'X' over '<uri>/index/X': that collection still holds entries from a dropped index of the same name declared on (…), not (…).` A fresh index name, or the same column list the tree was built on, still works
  - Refusals write nothing and leave the existing tables untouched; the retry the message names works on the very next statement
  - These checks read the catalog, so they are only as good as the catalog read: a cohort that answers "nothing" for the catalog while the data collection reads fine leaves them blind, and a database dropped by an older build (which wrote a bare tombstone, not a gravestone) is unchecked exactly as it was before

  Use a fresh collection URI when re-creating a table whose old rows should not come back
- Cross-collection transactions not yet supported

## Development

```bash
npm run build        # Write src/transaction/quereus-version.ts, then build with tsup
npm run typecheck    # Type check
npm test             # Run tests (mocha, node)
```

See [test/README.md](./test/README.md) for test details.

## License

MIT
