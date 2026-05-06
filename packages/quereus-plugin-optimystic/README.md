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

You define your own schema — the plugin supports arbitrary columns and types. The primary key is serialized as the tree key (composite keys are joined with `\x00`). Non-key columns are JSON-encoded as the tree value.

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

## Transaction Engine

The package exports a `QuereusEngine` that implements `ITransactionEngine` from `@optimystic/db-core`. It re-executes SQL statements through Quereus for transaction validation, and computes schema hashes from the database catalog.

```typescript
import { QuereusEngine, QUEREUS_ENGINE_ID, createQuereusValidator } from '@optimystic/quereus-plugin-optimystic';

const engine = new QuereusEngine(db, coordinator);
const validator = createQuereusValidator({ db, coordinator });
```

`createQuereusStatement()` and `createQuereusStatements()` are helpers for building the JSON statement format used in transaction records.

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
- Savepoints are not implemented
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
