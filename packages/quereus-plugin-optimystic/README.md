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

## Virtual Table Options

Options are passed in the `USING optimystic(...)` clause:

| Option | Description | Default |
|---|---|---|
| First positional arg | Collection URI (e.g. `'tree://myapp/users'`) | `tree://default/{tableName}` |
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

## Data Model

You define your own schema — the plugin supports arbitrary columns and types. The primary key is serialized as the tree key using an order-preserving, injective tuple framing (see `src/schema/key-encoding.ts`) so composite keys and values containing control bytes never collide or mis-sort. Non-key columns are JSON-encoded as the tree value.

Primary keys must be TEXT (tree keys are strings). Standard SQL operations (SELECT, INSERT, UPDATE, DELETE) all work. Point lookups on the primary key and range scans are optimized; other predicates require a full scan.

## Transactions

The plugin maps Quereus transactions to Optimystic's distributed sync:

- **BEGIN** — Creates a transactor and generates a stamp ID
- **COMMIT** — Syncs all collections (or commits through `TransactionSession` for distributed consensus)
- **ROLLBACK** — Discards local changes and clears session state

The `TransactionBridge` supports two modes:
1. **Legacy mode** (default): Direct collection sync on commit
2. **Transaction mode**: Uses `TransactionSession` for distributed consensus when configured with a coordinator and engine via `configureTransactionMode()`

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

## Custom Networks and Transactors

Register custom implementations before creating tables that reference them:

```typescript
import { registerKeyNetwork, registerTransactor } from '@optimystic/quereus-plugin-optimystic';

registerKeyNetwork('mynetwork', MyCustomKeyNetwork);
registerTransactor('mytransactor', MyCustomTransactor);
```

Then use `transactor='mytransactor'` or `keyNetwork='mynetwork'` in your `USING` clause.

## Quereus SQL Dialect

Quereus is not SQLite — it is a distinct SQL engine with intentional departures from the SQL standard, aligned with [The Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf). Key differences that affect schema design:

- **Columns default to NOT NULL** unless explicitly marked `NULL`. This avoids the "billion-dollar mistake" of nullable-by-default. Use `pragma default_column_nullability = 'nullable'` for SQL-standard behavior.
- **Native temporal types** (`DATE`, `TIME`, `DATETIME`) backed by the Temporal API, instead of storing dates as TEXT/REAL/INTEGER.
- **Native JSON type** with deep equality comparison, not text-based.
- **All tables are virtual tables** — the `USING` clause specifies the backing module.
- **Operation-specific CHECK constraints** — e.g., `CHECK ON INSERT (price >= 0)`.
- **Empty primary keys for singleton tables** — `PRIMARY KEY ()` creates a table limited to 0 or 1 rows, useful for configuration or state tables.
- **Conversion functions** (`integer()`, `date()`, `json()`) preferred over `CAST`.
- **No triggers** — event-driven logic belongs in the application layer.

For the full dialect reference, see the [Quereus SQL Reference](https://github.com/nicktobey/quereus/blob/main/docs/sql.md), particularly Section 11 ("Quereus vs. SQLite").

## Limitations

- Primary keys must be TEXT type (tree keys are strings)
- `msgpack` encoding is declared but not yet implemented
- Savepoints (including Quereus's internal statement-/row-level atomicity) work in legacy/single-node mode; in distributed-consensus (session) mode they are no-ops, so a mid-statement abort there can still leave partial rows staged
- Cross-collection transactions not yet supported

## Development

```bash
npm run build        # Build with tsup
npm run typecheck    # Type check
npm test             # Run tests (mocha, node)
```

See [test/README.md](./test/README.md) for test details.

## License

MIT
