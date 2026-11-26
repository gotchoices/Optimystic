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

`hydrate(db)` resolves to `{ tables, indexes }` (counts of newly-added catalog entries). It is idempotent and a no-op against empty storage. With offline mode's `journal` configured it also puts the journaled offline transactions back in the queue before it resolves — see [Restarting](#restarting) under Offline mode — and rejects with `OfflineJournalError` for a journal record a newer build wrote. When it puts at least one table back, and the `Database` does not already have an Optimystic connection, it also leaves one registered under one of those tables' names, so the transaction Quereus opens for the first autocommit write statement reaches the plugin and `StampId()` inside it answers that statement's stamp rather than `NULL` (see [StampId() Function](#stampid-function)).

Everything the declaration determines is persisted in the table's catalog record and rebuilt by `hydrate`, so a hydrated table is the table the same declaration would create in this session: its columns with their declared type spelling (`int`, `varchar(20)`), collations, literal and expression defaults, generated columns, named and unnamed `CHECK`s, foreign keys, `with context` variables, column and table tags, secondary `UNIQUE` constraints and indexes (with the `unique`/partial-predicate flags of `CREATE UNIQUE INDEX`), and the conflict action each rule declares for itself (`unique on conflict ignore`, `primary key (…) on conflict replace`, `id integer primary key on conflict replace`). `apply schema` of the same declaration then diffs to nothing, and re-declaring the table is **not** required for enforcement: a host that hydrates and never re-declares still runs its `CHECK`s, its context requirements and its uniqueness rules. That holds for a table that reached its declaration through earlier schema versions too: a named table-level `CHECK` a later version adds to an existing table, removes from it or changes the body of (`apply schema` runs `ALTER TABLE … ADD CONSTRAINT … CHECK`, `ALTER TABLE … DROP CONSTRAINT`, or the drop and then the add) is saved in the record in the same apply, as is a direct `alter table … add [constraint <name>] check (…)` or `alter table … drop constraint <name>` of a `CHECK`. Quereus checks the rows already stored against an added `CHECK` and refuses it when one fails; no row is rewritten. A column a later version adds or removes is saved the same way (`apply schema` runs `ALTER TABLE … ADD COLUMN` and `ALTER TABLE … DROP COLUMN`; the direct statements work too), for the columns that need no stored row rewritten: an added column must be nullable, have no `DEFAULT`, not be generated and declare no inline `CHECK`, `UNIQUE` or `REFERENCES` (an explicit `COLLATE` and column tags are fine), and a dropped column must be in no primary key, index, `UNIQUE` constraint or foreign key of the table, not be generated, and not be a `blobref` column (see *Large values*). Rows are stored keyed by column name, so a row written before a column was added reads it as `NULL`, and a dropped column's values stay in the stored rows, unread. An `UPDATE` keeps them: it writes the columns the table has and carries every other name the stored row holds over unchanged, which also keeps the values of a column another machine added after this machine loaded the table's description. An `INSERT OR REPLACE` over an existing row replaces it whole, as a replacement under the newer description would read `NULL` in the column it did not name. Re-adding a dropped column's name reads those values back, as they were stored. A failed `apply schema` cannot undo a `DROP COLUMN` (Quereus reports the schema as partially migrated), only an `ADD COLUMN`. One version may add a column and an index on it, or drop both: Quereus creates a version's new indexes after its column changes and drops its removed indexes before them. When several machines run the same upgrade, a machine that finds a change already in the record (another machine applied it first), a tag change included, adopts it and writes nothing, and if a later step of its apply fails, the undo of that change touches only its own catalog: an undo never removes from the record what that machine's apply did not put there. The exception is a machine that changes a named `CHECK` another machine has already changed without it knowing: if its apply then fails, that `CHECK` is removed from the record until the next `apply schema` adds it back. Two refusals guard a column upgrade the record contradicts: adding a column of a name the record holds with a different definition (another machine's upgrade disagrees; retrying does not help), and dropping a column the record shows in an index or key that this machine has not yet hydrated. The plugin cannot tell an older declaration from a deliberate change, so `apply schema` of a declaration older than the stored one undoes the newer `CHECK`s in the record and drops the newer columns — including on a machine still running an older release, which applies its own older declaration. A host must not apply a declaration older than the one stored; Sereus keeps its control-schema version in a table tag for this. Quereus's schema diff does not notice an *unnamed* table-level `CHECK` or a column-level `CHECK` added to an existing table, so `apply schema` never adds those to it (on any module) — name the `CHECK` in the later version. Tag changes are saved in the record too: `alter table … set|add|drop tags`, the same on a column (`alter table … alter column … set tags`), on a named constraint (`alter table … alter constraint … set|add|drop tags`) and on an index (`alter index … set|add|drop tags`), and the tag-only changes `apply schema` makes with those statements. A tag change `apply schema` makes is in the record before the apply returns. An imperative one returns *before* its save lands, because Quereus makes the change in its own catalog and only announces it to the plugin: a host that closes a `Database` and reopens the same storage in the same process calls `await plugin.whenCatalogPersisted()` (or `plugin.dispose()`) in between, and a process that exits straight after such a statement can lose it. Only the tags a change changed are saved, so a machine holding an older copy of the table's description does not put its older tags back. A failed save is logged and the table keeps its old tags in storage: the save is not retried, so the tag stays out of the record until the next change to those tags, or until `apply schema` after a restart re-emits a declared tag, and an imperative tag edit whose save failed is lost at restart. Tags on a `UNIQUE` constraint that a `CREATE UNIQUE INDEX` derived are not saved — the record rebuilds that constraint from its index — so tag the index instead. The other `ALTER TABLE` operations are refused (any other `ADD COLUMN` or `DROP COLUMN`, dropping a `UNIQUE` or `FOREIGN KEY` constraint, `RENAME CONSTRAINT`, `ALTER COLUMN`, `ALTER PRIMARY KEY`, adding a `UNIQUE` or `FOREIGN KEY` constraint, `RENAME COLUMN`). `RENAME COLUMN` is refused because a stored row is keyed by its column names; before Quereus 5.6.0 it renamed for the running session only and was not saved. `test/hydrate-restores-declared-table.spec.ts` holds the rebuilt table equal, field by field, to a freshly declared one, so a `TableSchema` field the engine adds later fails that spec until the record carries it. `DROP INDEX` removes the index from the record, so a later `hydrate` does not bring it back; the index's tree stays in storage, and the record keeps the dropped index's description as *leftover storage* rather than as schema, for the `CREATE INDEX` adoption check described under Limitations.

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

Primary keys should be TEXT for ordered/range performance; other types (INTEGER, REAL, …) work correctly but are not pushed down as ordered seeks — the tree keys them as raw strings that don't preserve numeric order, so the engine re-sorts them. Standard SQL operations (SELECT, INSERT, UPDATE, DELETE) all work regardless of key type. Point lookups on the primary key are optimized (O(log n) seek), and so are `=` and `in (…)` on an index's leading columns or on every column of the primary key: a list seeks once per listed value, and lists on several key columns seek every combination of their values, so `where a = ? and b in (?, ?)` over an index on `(a, b)` seeks two keys. A long list costs out as a scan (at about 46 values on a table `analyze` has not measured), and a column whose list would take the combinations past 1000 seeks is applied by the engine above the seek of the columns before it. A column whose equal values can have different bytes is never sought, because the trees compare raw bytes: one under a non-BINARY collation, of type `timespan` or `json`, or, for an index, of type `boolean` or `any`, since the engine compares `true` equal to `1`. Its `=` and `in` apply over a full scan, as do all other predicates. So does an `=` or `in` compared under a collation other than BINARY (`where a = ? collate nocase` over a BINARY `a`), which the engine applies above whatever else serves the statement. A range predicate (`>`, `>=`, `<`, `<=`, `between`) on an index's first column, or on the column after a run of leading columns pinned by `=`, seeks the index from its bound when that column is TEXT, BINARY-collated and not a `timespan`: `where Timestamp > ? order by Timestamp desc limit 100` over an index on `(Timestamp)` reads the entries past the bound, in either direction, and no others, up to the 256 entries described below. The first bound on each side of the column is claimed; a further one is applied by the engine above the seek. A range on a numeric column still scans (the tree keys a number as text that does not preserve numeric order), as does one on the primary key, and one under another collation (`t collate nocase > ?` over a BINARY index) is applied by the engine above whatever else serves the statement. An `ORDER BY` is served by walking an index, forwards or backwards, when the ordered columns are a leading run of the index's columns followed by the primary key's (a column pinned by an `=` compared under BINARY is skipped), every one of them is TEXT, BINARY-collated and not a `timespan`, all go the same direction, and, for a descending order, none can hold a NULL (a nullable column qualifies under a filter such as `is not null`). An ascending walk returns a nullable column's NULLs first, which is where the engine puts them. `select … order by Timestamp desc, Id desc limit 100` over an index on `(Timestamp)` with a TEXT `Id` then reads about 100 index entries and 100 rows instead of sorting the whole table, and `min`/`max` of an indexed column read one entry. A numeric column (the tree keys it as text that does not preserve numeric order), a nullable column ordered descending with no such filter, a `nulls last` ordering, or mixed directions are sorted correctly by the engine. The walk fetches one row per index entry, about five times what a scan costs per row. The planner is told the statement's `LIMIT` (a `limit ?` included), so an ordered read with no filter walks the index for a page of up to 256 rows (on a table of only a few hundred rows a page near 256 is scanned and sorted instead, which costs less there), and leaves a longer read to the engine's scan and sort: an unlimited read of a table `analyze` measured above 256 rows, or of one it has not measured, which is assumed to hold 1000. An ordered read under a filter the walk leaves to the engine is priced the same whatever its limit, and a sort key that spells out `nulls first` reaches the planner with no limit, so it is priced as the whole read. The limit never reaches the read itself, so a walk or range that has read 256 entries (`WALK_ROWS_BEFORE_SCAN` in `packages/quereus-plugin-optimystic/src/schema/index-walk.ts`) stops and finishes by scanning the table: a read of up to 256 entries costs what the walk costs, and a longer one costs about what a scan and sort cost, plus those 256 fetches, with its remaining rows arriving together once the scan has finished. So a page larger than 256 rows on a very large table costs a scan and sort rather than the walk, and a range holding more than 256 entries reads the whole table, however small a part of it the range is. An equality seek or `in (…)` list reads through the index however many rows it returns.

### Large values — the `blobref` column type

The plugin registers one column type of its own, **`blobref`**: text whose value must be a *blob reference* — the short content identifier (59 characters of lowercase base32) that names a large stored file held outside the row, outside transactions and outside the wire. See [docs/blobs.md §SQL](../../docs/blobs.md#sql) for the whole design, all four parts of which are built — the type, the service an application puts files through, the per-table list of which rows reference which files, and the holds that follow a commit, through to a queued transaction's settlement, the reconciliation after a restart, and the holding period on a file nothing ever referenced.

```sql
create table Attachment (
	Id text primary key,
	Name text,
	ByteSize integer,
	Content blobref null
);
```

- **What is accepted.** Exactly the canonical spelling of a reference, and NULL (which means the row references nothing). A blob has one accepted spelling, so an upper-cased or `=`-padded form of a real reference, a version-0 CID, a CID of another codec, a value with surrounding whitespace, and a number are each refused as a type mismatch where the value is written.
- **How it compares.** As the text it is stored as, under BINARY. So an index on the column is an ordinary text index and serves `order by` by walking, and a `collate` other than BINARY is *refused* on such a column rather than silently ignored — the type's comparison does not consult a collation.
- **A host registering the plugin's parts by hand must register `plugin.types` too**, not only `vtables` and `functions` — `for (const t of plugin.types) db.registerType(t.name, t.definition)`. `registerPlugin` does it for you. The type registry is process-wide, so one registration serves every `Database` in the process.
- **The plugin keeps a list of which rows reference which files.** A table with a `blobref` column gets a second tree beside its index trees, `<table uri>/blobrefs`, holding one entry per non-NULL `blobref` cell, written in the same transaction as the row itself — so the list says what the rows say after every insert, update, delete, REPLACE and primary-key move, and rolls back with them. That list is what will keep a referenced file's bytes alive, and the table's entry in its network's registry of such lists is written by the `create table` (or the `alter table … add column` that gives the table its first `blobref` column) and removed by `drop table`. A statement whose registration cannot be confirmed is refused, since a list nothing knows about is a list nothing reads.
- **Two things you cannot do to a `blobref` column.** `alter table … drop column` on one is refused (`it holds blob references`), and so is re-declaring the table with that column changed to or from `blobref`, or with it left out altogether. Both would leave the list describing rows that no longer hold what it says, and both say the same thing: drop and re-create the table. Dropping an ordinary column of the same table is unaffected.
- **A table with such a column refuses to open — and refuses to be written — without the type.** It is never read as a `blob` column instead: the name contains "BLOB", so the fallback type rules would make it one, and a `blob` column's row codec base64-*decodes* every stored string. Both refusals name the table and the column, and say to register the type. The write refusal matters as much as the open one: a process missing the type that re-declared the table, or added such a column to it, would otherwise persist "these rows are `blob`" over rows written as `blobref`, and then no process could open the table — not even one that has the type. The same applies to a build that predates the type.

#### Putting and reading the bytes — `plugin.blobs`

`plugin.blobs` is the blob service of the plugin's **default** network — the one a table declared with no `using` clause binds to. `put` a stream to get the reference a `blobref` column holds, and `read` it back:

```typescript
const { ref, size } = await plugin.blobs.put(fileStream);
await db.exec('insert into Attachment (Id, Name, ByteSize, Content) values (?, ?, ?, ?)', [id, name, size, ref]);
for await (const bytes of plugin.blobs.read(ref)) { /* … */ }
```

- **A reference means something only in the network whose machines hold the bytes.** `plugin.blobsFor(table)` is the service of the network a given table uses; use it instead of `plugin.blobs` when your tables are on more than one. It rejects for a table that is not a known Optimystic table. Each call returns a **fresh** object, and it is not reference-equal to `plugin.blobs` even for the default network — the wrapper is thin and the store behind it is shared per network, so two services over one network read the same blob records, hold the same pins and each receive the same events. Compare networks, never these objects.
- **The network is resolved on first use**, not when `register` returns, so you may still set the session's `default_vtab_args` afterwards — and registering the plugin does not by itself build the libp2p node of a `network` transactor.
- **A transactor with no libp2p node** (`local`, `test`, `mesh-test`, or one of your own) gets a single-machine service: it stores, reads, pins and sweeps exactly as a node's does, but its cohort is this machine alone, so a reference's durability stays `local` and nothing is ever copied elsewhere. Where its pieces and blob records live is the `pieces` and `kv` of `storageFactory` (see *Plugin-Level Configuration*), in memory by default.
- **Every blob you put is pinned, and the pin follows the transaction.** The pin names the transaction open when the put STARTED, or `unstaged` when there was none. A put inside a transaction is released when that transaction commits, rolls back, or is queued. `pinsOf(ref)` and `listPins(prefix)` show what this machine holds, and `plugin.blobs.unpin(ref, owner)` releases a pin you took yourself. **`plugin.blobs` does not hold every blob it ever put**: each pin ends with the transaction that owns it, or with the holding period below.
- **A blob you put with no transaction open is held for `blob_unstaged_holding_ms` and then let go.** Commit a statement that references it within that period (24 hours by default) and the pin is released by the commit itself, the announcement to the blob's cohort taking over as what keeps the bytes. Reference it never — the user cancelled the upload, your insert threw, the process stopped — and the pin is released once the period has passed, and this machine's next piece sweep deletes the bytes. So an application that puts a file and then abandons it leaks nothing, and one that uploads long before it writes the row should raise the setting. A blob any unfinished transaction references is never let go, however old its pin, including one waiting in the offline queue.
- **A transaction's referenced blobs are announced before its commit returns.** When the commit lands, each reference the transaction added is announced to the blob's cohort with the table's list as its scope — which is what authorizes those machines to store it — and only then is the pin released, so the bytes are never without a hold on this machine. `await db.exec('commit')` resolves after that, so by the time it returns every `plugin.blobs.onDurability` listener has already been told the blob's durability class. If the announcement cannot be made (the network's registry of lists could not be confirmed, or the node was built without a blob copy drain), the commit still succeeds and the pin is KEPT — the bytes stay here and the release is retried later, logged as `blob:pin-kept`.
- **A commit that goes to the offline queue announces nothing until the queue finishes with it.** Nothing is on the network yet, so this machine holds the only copy: the reference pins stay in place, and `await db.exec('commit')` returns without any durability being reported. When the queue later lands the transaction, each reference it added is announced and its pin released exactly as above; if the transaction fails or is withdrawn instead, the pins are released without announcing and the bytes go with this machine's next sweep. Until then the blobs it references are held on THIS machine and nowhere else, so do not treat a queued commit as a backup of a file. So the two-commit pattern below waits for the queue to drain when it is used offline. See [docs/offline-sync.md](../../docs/offline-sync.md#nothing-about-blobs-is-journaled).
- **To get the bytes onto the network before anyone can see the reference, commit twice.** First commit a row that holds only the reference (an attachment row), which authorizes the cohort to store the blob; wait for `onDurability` to report `majority` or `full`; then commit the row people act on (the message that shows the attachment). The second commit cannot land before others hold the bytes, and no machine ever stored bytes no committed row referenced.
- **A blob put INSIDE a transaction that the transaction never references loses its bytes when the transaction ends.** `begin; put(a); put(b); insert … values (a); commit` releases `b`'s pin and the sweep takes its pieces — a put inside a transaction is pinned under that transaction's identity. To keep a blob no row references, put it OUTSIDE any transaction, or pass an explicit `owner` and release that pin yourself. A put that outlives the transaction it began under keeps that transaction's label, and the pin reconciliation a later start makes removes it: no row of that transaction can reference bytes that arrived after it ended.

#### `BlobLocality(ref)` and `BlobSize(ref)`

Two SQL functions report what **this machine** knows about a reference, from its own blob records:

```sql
select Id, Name, BlobLocality(Content) as Locality, BlobSize(Content) as Bytes from Attachment;
```

- **`BlobLocality(ref)`** answers `'here'`, `'partial'`, `'elsewhere'` or `'unknown'` — the last for a reference this machine knows nothing of, which is an ordinary state and not an error.
- **`BlobSize(ref)`** answers the blob's size in bytes, or NULL while its root piece is not here.
- **Neither waits on the network.** They are answered from local records with no probe, which is also why neither is deterministic: the answer changes as bytes move.
- **NULL in gives NULL** from both. Anything that is not a canonical reference — a malformed string, or a value that is not a string — is a type mismatch, with the reason in the message.
- **Both read the DEFAULT network**, because a scalar function has no table context. With tables on several networks, read `plugin.blobsFor(table).stat(ref)` instead.
- **Do not write either into a row.** A member re-executing the statement computes its own machine's answer, which is a different value.

## Transactions

The plugin maps Quereus transactions to Optimystic's distributed sync:

- **BEGIN** — Creates a transactor and generates a stamp ID
- **COMMIT** — Syncs all collections (or commits through `TransactionSession` for distributed consensus)
- **ROLLBACK** — Discards local changes and clears session state

The `TransactionBridge` supports two modes:
1. **Legacy mode** (default): Direct collection sync on commit
2. **Transaction mode**: Uses `TransactionSession` for distributed consensus when configured with a coordinator and engine via `configureTransactionMode()`

> **Read consistency note.** In the default `lazy` read-repair mode, a read served from a locally-cached block may return data up to one commit stale (bounded by `readRepairWindowMs`, default 10 s, plus the cohort consult the expiring read starts behind it — a read never waits on that consult). Reads used as transaction read-dependencies are protected — validators catch stale data at commit time. Bare reads (outside a transaction) carry no such check. Use `readRepairMode: 'paranoid'` to force per-read verification. See [docs/transactions.md — Read Consistency and Staleness](../../docs/transactions.md#read-consistency-and-staleness) for the full discussion and configuration knobs.

### StampId() Function

Returns the current transaction's unique stamp ID, or NULL when there is no transaction to name.

```sql
BEGIN;
SELECT StampId();  -- base64url-encoded 32-byte ID
COMMIT;

-- No explicit transaction: Quereus opens one for the write before it evaluates the row,
-- so the stored id is that transaction's stamp, not NULL.
INSERT INTO Note (id, body) VALUES (StampId(), 'hello');
```

Format: 16 bytes SHA-256(peer ID) + 16 random bytes, base64url encoded. Stable within a transaction, unique across transactions and peers.

What counts as a transaction:

- Inside an explicit `BEGIN` — that transaction's stamp, from the `BEGIN` on, with no DML needed first.
- In an autocommit **write** statement, once this `Database` has any Optimystic connection registered — which any Optimystic table created, touched, or restored by `plugin.hydrate(db)` gives it — the stamp of the transaction Quereus opens for that statement. That holds whether or not the statement writes an Optimystic table, just as an explicit `BEGIN` gives every transaction a stamp.
- In an autocommit **read**, such as `SELECT StampId()` on its own — `NULL`. Quereus opens no transaction for a statement with no side effects.
- On a `Database` with no Optimystic table at all — `NULL`.

### A commit's durability — `plugin.onCommitDurability(listener)`

A commit can succeed while only this machine holds what it wrote. To tell the application which, register a listener on the object `register` returns. After every commit that wrote something, it is called once with an `SqlCommitDurability`:

- `transactionId` — what `StampId()` returned inside the transaction, so a host that tagged rows with it can find them.
- `durability` — who holds each collection the commit wrote (a table's main tree and each of its index trees), and `overall`, the weakest of them.
- `tables` — the same folded per table, keyed `schema.table`.
- `followed` — whether `onCommitFullyHeld` (below) will tell you when a pending commit becomes fully held.

```typescript
import { isFullyDurable } from '@optimystic/quereus-plugin-optimystic';

const unsubscribe = plugin.onCommitDurability(({ transactionId, durability }) => {
  const saved = durability.overall !== undefined && isFullyDurable(durability.overall);
  markMessage(transactionId, saved ? 'delivered' : 'pending');
});
```

An absent `overall` means a collection is saved but nobody could say who holds it; show that commit as pending.

The listener is called synchronously before the commit returns. Quereus runs one writer at a time behind its exec lock, so every report delivered while `await db.exec(...)` is running belongs to that call, which is how a wrapper can hand the answer back from its own `exec`. A transaction that wrote nothing (a read, or a statement that matched no rows) calls no one. A failed commit is reported through its error instead: `CoordinatorPartialCommitError.durability` and `PartialCommitError.durability` describe the half that landed. A listener that throws is logged and the other listeners still run; the commit still succeeds. The returned function unsubscribes and is safe to call twice. A dropped table stops being named in `tables`, so a table later declared over the same URI reports its writes under its own name only.

#### When a pending commit becomes fully held — `plugin.onCommitFullyHeld(listener)`

A commit saved while the other members were offline is pending. When they come back, this machine pushes them the copies they missed, and the commit becomes held by every member. To be told when that happens, register a second listener; it is called once per such commit with `{ transactionId }`:

```typescript
plugin.onCommitDurability(({ transactionId, durability, followed }) => {
  if (durability.overall !== undefined && isFullyDurable(durability.overall)) markMessage(transactionId, 'delivered');
  else markMessage(transactionId, followed ? 'pending' : 'pending, will not clear');
});
plugin.onCommitFullyHeld(({ transactionId }) => markMessage(transactionId, 'delivered'));
```

Read `isFullyDurable(overall)` as "saved now" and `onCommitFullyHeld` as "saved later": a commit already fully held when reported is never reported again. A pending commit is followed only when this machine itself owes the missing copies — its own record of what each member still lacks is the one that announces when they all have them. A commit is reported with `followed: false`, and `onCommitFullyHeld` never fires for it, when that record belongs to another machine or to none (a `local`, `test` or `mesh-test` transactor keeps none), when a block was abandoned (`torn`), or when a collection's holders are unknown. One more case is refused for now: a collection some of whose blocks were held by their whole cohort while others were not, which only happens in a group larger than one cohort. A machine alone in its group — the node the plugin builds for itself runs `clusterSize: 1` — reports every commit pending and followed, and a commit is reported fully held only once another member has taken its copies, so it can stay pending for as long as the machine is alone.

The listener runs synchronously, from the event that covered the commit's last block or from a later commit through this plugin that wrote those blocks at full replication, with the same discipline as `onCommitDurability`. Followed commits live in memory: a restart or `plugin.dispose()` forgets them, and so does a cap on how many can be pending at once (10 000, oldest dropped first). A forgotten commit is never reported, though its copies still reach the other members.

### Offline mode — `plugin.offline`

A commit normally resolves once the network holds what it wrote. In offline mode it resolves as soon as the transaction is **queued on this machine**, and the plugin submits it to the network later, in order, as soon as the other machines can be reached. The design is [docs/offline-sync.md](../../docs/offline-sync.md); this section is the interface as it stands, through stage 6 of that design and the outlook of stages 7 and 9, and says at the end what is still missing.

**A local acknowledgement is a promise to try, not a promise that the network will accept.** The transaction's rows are in every later read on this machine; the plugin submits the transaction under the same `StampId()` once every earlier queued transaction has settled; and it ends in exactly one terminal status, `committed` (with the same durability report an online commit produces) or `failed` (with a typed reason), after which a failed transaction's rows are removed from this machine's view. With `journal` configured each queued transaction is saved on this machine before its commit resolves and put back after a restart (see [Saving the queue on this machine](#saving-the-queue-on-this-machine--offlinejournal) and [Restarting](#restarting)).

```typescript
const plugin = register(db, {
  default_transactor: 'network',
  offline: {
    journal: () => new FileKVStore(path.join(dataDir, 'offline')), // save queued transactions in this IKVStore (or a function returning one); default: memory only
    journalLabel: 'main',                       // keys the journal's records; give each Database sharing one store its own; default: 'default'
    expireAfterMs: 7 * 24 * 3600_000,          // fail a transaction unsettled this long with reason 'expired'; default: no limit
    outcomeRetentionMs: 7 * 24 * 3600_000,     // how long a terminal outcome stays in outcomes() / status(); default: 7 days
    allowSoloCommit: false,                     // let this machine commit a queued transaction alone while it knows of members it cannot reach; default: false
    recheck: { baseMs: 1_000, maxMs: 60_000 }, // advanced: the drain's re-check timer while the cohort is unreachable
    networkCommitTimeoutMs: 5 * 60_000,         // how long a network-acknowledged commit waits behind queued transactions; default: 5 minutes
  },
});

plugin.offline.enter();              // transactions begun from now on are acknowledged locally
plugin.offline.exit();               // transactions begun from now on are acknowledged by the network
await plugin.offline.whenDrained();  // resolves once the queue is empty; rejects with QueueDisposedError on plugin.dispose()
```

`offline` and every key in it are optional. A key the plugin does not know is refused at `register`, so a misspelt option is an error rather than a silently different configuration, and so is a value of the wrong type. Object-typed, so it is passed through `register()`, like `storageFactory`.

**When a queued transaction is sent.** The drain sends the oldest queued transaction only when the machines responsible for what it wrote can be reached, and otherwise sends nothing: the transaction is listed `queued` with `waitingFor: 'cohort'`, and since it was never sent it can still be discarded and can expire. On the `network` transactor the plugin asks the node it built (`node.cohortReachability` from `@optimystic/db-p2p`), which reads the node's own view of each block's group: reachable when the group names another machine, or when this machine is genuinely alone — it knows of no member that is missing, it is not waiting on a configured bootstrap peer, and no peer is being identified. The `local`, `test` and `mesh-test` transactors are always reachable. When another machine connects or is identified, the node tells the plugin about half a second later and the waiting transaction is sent at once, without waiting for the re-check timer; that wake also retries a saved transaction deferred after a restart (see [Restarting](#restarting)). The check can be wrong for a moment, so the send itself carries a second guard: a node that finds itself alone in the group while it knows other members exist refuses to commit a queued transaction alone, and the transaction waits for the group instead. `allowSoloCommit: true` turns that refusal off, letting a machine that has lost its partners commit queued transactions on its own; the other members are then owed copies, as for any write made alone. A host that injects its own libp2p node (`collectionFactory.registerLibp2pNode`) gets the node's check only if that node carries `cohortReachability`; it can register any `ICohortReachability` for a transactor instead with `collectionFactory.registerCohortReachability('<transactor>:<keyNetwork>', gate)`, which wins over the node's.

The acknowledgement a transaction gets is fixed when it **begins**: `enter()` or `exit()` during an open transaction changes nothing about it. Leaving the mode does not stop the drain. Session mode and offline mode refuse each other in either order: `enter()` throws `OfflineModeRefusedError` while `configureTransactionMode` has been called, and `configureTransactionMode` throws `SessionModeRefusedError` while the mode is entered or transactions are still queued.

A commit in offline mode seals every table it wrote into one queue entry, including a table's index trees. One shape cannot be queued and is acknowledged by the network instead, logged as `offline:local-ack-unavailable`: two tables declared over one collection URI written in one transaction. Everything else that holds for an online commit holds for the queued one: a commit that wrote nothing queues nothing, and the constraint and concurrent-modification refusals arrive as the same errors, on the `failed` status instead of out of `commit`.

#### Saving the queue on this machine — `offline.journal`

With `journal` set, every queued transaction is written to that store, and each write a promise depends on is flushed (`IKVStore.flush`) before the step it guards goes on:

- **A commit resolves only once its transaction is saved.** What each table and index tree staged is flushed before `commit` returns, so "acknowledged" means "on disk". A write or flush that fails fails the commit with the store's error: the transaction is rolled back, as a network failure rolls it back, and nothing is queued or reported. The `queued` status and each item `entries()` lists carry `persisted: true` (`false` without a journal).
- **Every send is recorded first.** Before each submission the queue flushes the action id it sends under and what it sends, so a restart re-sends the same write under the same id rather than a second copy. A record that cannot be written stops that submission before anything is sent; the transaction stays queued and is tried again after the backoff.
- **Each terminal outcome is saved before it is reported**, and stays in the store until `acknowledge(transactionId)`, or until `outcomeRetentionMs` has passed and `status` or `outcomes` next looks. The transaction's other records are deleted once its outcome is written.

The cost is one flush per commit, one per submission and one per terminal outcome, each waiting for the store to sync; deletes are not flushed, so a crash can bring back a record already deleted, which the restore resolves (below). A network-acknowledged commit waiting behind the queue is saved like any queued transaction. The records hold the transaction's rows, so protect the store as you protect block storage.

`journal` takes any `IKVStore` — `FileKVStore` from `@optimystic/db-p2p-storage-fs`, the IndexedDB, React Native and NativeScript stores, or the very instance the node was given as the `kv` of `NodeOptions.storage`. Its keys all start with `optimystic-offline/`, which is in db-p2p's `NODE_KV_NAMESPACES`, so a file store sharing a directory with block storage never mistakes them for blocks. A store without `flush` is accepted, since the interface defines that as "every write is already durable". A `MemoryKVStore` is refused: a journal lost with the process is the configuration without one, so leave `journal` off instead. A `journal` given as a function is called once, inside `register`.

The records are keyed under `optimystic-offline/<journalLabel>/`. **Two `Database`s over one store need two labels**: two with the same label list and delete each other's records, which corrupts both queues, and nothing in the store can detect it. The label is lowercase letters, digits, `_` and `-` (lowercase because a filesystem that ignores case would file `One` and `one` together), and is refused without a `journal`.

#### Restarting

`plugin.hydrate(db)` puts every saved transaction back in the queue after rebuilding the catalog and before it resolves, so the first statement after it sees their rows again and each is sent once, under its saved action id — never twice, even when the crash came right after the network accepted it, in which case the restart reports it `committed` (with its holders unknown and `followed: false`) and sends nothing. A host that does not call `hydrate` calls `plugin.offline.restore()` itself; it can be called again at any time, and refuses to run while a transaction is open on the `Database`. Each restored transaction's `queued` status is delivered during the call, so subscribe before `hydrate` to hear it, or read `entries()` after. A transaction whose outcome was saved but whose other records a crash left behind is settled, not restored; its outcome is listed by `outcomes()`.

A saved transaction whose table cannot be reached yet is **deferred**: the table is no longer declared (another machine dropped it while this one was down, or the host restores before `apply schema`), its blocks cannot be read (this machine never held them and the other machines cannot be reached), or it was re-declared over another collection. It and every transaction saved after it wait, so the order holds; `entries()` lists them after the queued ones as `queued` with `waitingFor: 'restore'`, and they count as queued everywhere a queued transaction does — a network-acknowledged commit waits behind them, `whenDrained()` stays pending, and a schema change to their tables is refused. A read of such a table does not fall back to this machine's view while the other machines cannot be reached (the view lacks rows the application was told are committed); the first read that reaches them puts the transaction back, as does the next `restore()`, another machine connecting, and the queue's own re-check timer, which also keeps anything queued since from being sent ahead of it. `discard` withdraws a deferred transaction that was never sent; one that was sent is refused, so a dropped table with such a transaction stays listed until the table exists again or the record is removed from the store by hand.

A journal record written by a newer build stops the restore: `hydrate` and `restore()` reject with `OfflineJournalError` (exported from both entries; `reason`, `key`, `version`), the transactions before it are back in the queue, and nothing is dropped.

#### Reading while the other machines cannot be reached

Every live read first pulls what the other machines have committed, so outside offline mode a read whose pull cannot reach them fails, even for rows this machine holds, with `BlockUnavailableError` along the error's `cause` chain. In offline mode such a read is served from this machine's own view instead: the committed rows it holds plus every queued transaction, through an index or a full scan alike, inside an open transaction or not. While the check the drain asks (see [Offline mode](#offline-mode--pluginoffline)) says the other machines cannot be reached, the read does not try the network at all, so it pays no timeouts. The reads a write makes to check a UNIQUE column do the same, so an offline insert into such a table is queued rather than refused.

- A table tagged `"optimystic.offline" = 'network'` (below) keeps failing, in the mode and out of it.
- The mode does not make data appear. Rows this machine does not hold still fail the read with `BlockUnavailableError` — a table it has never read, say. To read a table offline, read it while online first.
- `readsServedLocally` on the queue state (see [Following a queued transaction](#following-a-queued-transaction--pluginofflineonstatuslistener)) is `true` while the last live read was served this way; the next read that reaches the other machines sets it back, and so does `exit()`. The first such read of each table, and the first after each reconnect, is logged as `offline:read-served-locally`.
- A committed read (`committed.<Table>`) never pulls, and is unchanged.

#### Tables that are always acknowledged by the network — `optimystic.offline`

Not every table should accept a local answer: a table of revoked peers, say, where a machine that has not heard of a revocation must not be told its write is safe. A table tag chooses:

```sql
create table Revocation (id integer primary key, peer text)
  using optimystic('tree://app/revocation')
  with tags ("optimystic.offline" = 'network');
```

| `optimystic.offline` | A transaction that writes the table | A live read in offline mode while the other machines cannot be reached |
|---|---|---|
| `'queue'` (the default) | gets the mode's acknowledgement | is served from this machine's own view |
| `'network'` | gets network acknowledgement, whatever the mode | fails, as outside the mode |

A transaction that writes any `'network'` table is acknowledged by the network as a whole, since it commits atomically; the tag never turns a network acknowledgement into a local one, and the transaction is logged as `offline:network-policy`. Any other value reads as `'queue'`, logged once per table as `offline:unknown-policy-tag`: Quereus applies a tag to its own catalog before the plugin hears of it, so a bad value cannot be refused. The tag is read from the declaration and again after every `alter table … set tags`, so a change applies to the next transaction that commits (one already queued keeps the acknowledgement it got) and to the next live read, and it is saved in the table's catalog record, so `hydrate` restores it.

#### A network-acknowledged commit waits behind the queue

A commit acknowledged by the network — offline mode not entered, a `'network'` table, or the one shape that cannot be queued — takes the ordinary path while nothing is queued. While transactions are queued it was decided on a view that includes them, so it cannot commit ahead of them: it is queued behind them like any transaction, reported through `onStatus` and retained in `outcomes()` like any, and `commit` waits for it to settle.

- `committed`: `commit` resolves. Its durability report reached `onCommitDurability` listeners once, through the drain.
- `failed`: `commit` throws the status's `error`, as an online commit would have thrown it (a `ConstraintError`, a `ConcurrentModificationError`, …), and the transaction's changes are gone from this machine's view.
- not settled within `offline.networkCommitTimeoutMs` (five minutes by default): `commit` throws `OfflineCommitTimeoutError` (`StatusCode.BUSY`, exported from both entries), carrying `transactionId`, `timeoutMs` and `sent`:
  - `sent: false` — it was never sent, so it has been withdrawn: it fails with reason `'discarded'`, the outcome `status(transactionId)` then answers, and its rows are gone.
  - `sent: true` — it may already be saved, so it cannot be withdrawn. It stays queued as a locally acknowledged transaction and its rows stay in this machine's view; follow it under `transactionId` with `onStatus` or `status(transactionId)`. Quereus fires no watcher for a commit that throws, so the tables it wrote are announced to the `Database`'s watchers instead.
- `plugin.dispose()` during the wait: `commit` throws `QueueDisposedError`, and the transaction stays sealed, like every queued one.

The shape that cannot be queued commits ahead of the queue instead, logged as `offline:queue-bypassed`, and when it writes a table with queued transactions it fails with `SealedSegmentsError`, rolled back cleanly; retry it after `whenDrained()`.

#### Schema changes wait for the queued transactions

A statement that changes how a table's rows are stored is refused while a queued transaction wrote the table: an index built now would index rows the network does not hold yet, and a queued transaction carries no write for an index added after it. The statement throws `QueuedEntriesBlockSchemaChangeError` (`StatusCode.BUSY`, exported from both entries), carrying `table` (`schema.table`), `operation` and `transactionIds`, the queued transactions in queue order (then any failed one whose rows are still being removed); one being submitted, or in doubt, counts like any other. Nothing was written, and the same statement succeeds once they settle — `await plugin.offline.whenDrained()` and run it again. Quereus rewraps the error out of `create index`, `create table` and `apply schema`, so look for it along the `cause` chain.

| Refused while the table has queued transactions | Not refused |
|---|---|
| `create index`, `drop index` | `alter table … set tags` |
| `alter table … add column`, `drop column` | a CHECK added or dropped by name |
| `drop table` | |
| `create table` over a collection a table with queued transactions backs, unless it declares the same columns (names and types, in order) and primary key | `create table` of an unrelated table |

Inside `apply schema` a refused step fails the apply like any other failed step: the engine unwinds the steps that landed, and the error reaches the caller. A dropped table's collections are forgotten only once the drop succeeds.

#### A table first written offline joins the copy another machine created

A table declared but never written has no committed storage yet, so the first transaction that writes it creates it. When that transaction is queued, another machine may create the same table (same collection URI) before it drains. The drain finds that machine's copy and adds the queued rows to it — the table ends with one copy holding both machines' rows — rather than creating a second one under the same name. A queued row the other copy refuses — its primary key already taken there, say — fails with reason `'constraint'`, decided on this machine before anything of it is sent, and the other machine's row is what this machine reads from then on. While the other machines cannot be asked whether the table exists, the transaction waits; it never creates the table on an unanswered question.

#### Following a queued transaction — `plugin.offline.onStatus(listener)`

```typescript
import { isFullyDurable } from '@optimystic/quereus-plugin-optimystic';

const unsubscribe = plugin.offline.onStatus(status => {
  switch (status.kind) {
    case 'queued':              ui.mark(status.transactionId, 'pending'); break;
    case 'submitting':          ui.mark(status.transactionId, 'sending'); break;
    case 'committed':           ui.mark(status.transactionId, status.durability.overall !== undefined && isFullyDurable(status.durability.overall) ? 'saved' : 'saved, replicating'); break;
    case 'partially-committed': ui.mark(status.transactionId, 'sending'); break;
    case 'failed':              ui.fail(status.transactionId, status.reason, status.error, status.causedBy); break;
  }
});
```

- `transactionId` is what `StampId()` returned inside the transaction. `tables` names the tables it changed, as `schema.table`.
- `queued` is delivered synchronously inside the commit, before `db.exec` resolves, by the rule `onCommitDurability` uses, which is how an autocommit statement's caller learns the id it never selected. It carries `seq` (the drain order), `waitingFor` (`'earlier-entry'`, `'cohort'`, `'backoff'`, or undefined for the head about to be sent), `attempts`, `inDoubt` (an attempt may have landed), `lastError`, `committedTables` once part of the transaction has committed, `persisted` (it is saved in the journal), `outlook`, whether another machine can make it fail (see [Whether another machine can make a queued transaction fail](#whether-another-machine-can-make-a-queued-transaction-fail--outlook)), and `lane`, whether a later merge will handle its changes (`'convergent'`) or the other machines must agree to them first (`'serializable'`), fixed when it was queued (see the `optimystic.profile` tag below) and present even while it waits to be put back after a restart. It is delivered again whenever one of those changes, except the outlook, which has its own status, and the lane, which never changes.
- `outlook-changed` carries a queued transaction's new `outlook` when its `kind` changes — typically to `'assured'` once the earlier transactions it depended on have committed. It arrives after the status of the transaction whose settling changed it, and is never terminal.
- `committed` is the `SqlCommitDurability` an online commit reports (`durability`, `tables`, `followed`) with `kind` and `effect` added. `onCommitDurability` listeners received that same report a moment earlier, and `onCommitFullyHeld` follows the commit exactly as it follows an online one. Unlike an online report it arrives during no `db.exec`; the transaction id is the attribution. `effect` is `'already-applied'` when another machine had already made every change the transaction's checks could accept as its own — the same task marked done on two machines, the same row deleted on both, the same row inserted under `insert or ignore` on both — so the rows it reports as changed were changed by someone else, and `'applied'` otherwise; see [Whether another machine can make a queued transaction fail](#whether-another-machine-can-make-a-queued-transaction-fail--outlook) for which statements this covers.
- `partially-committed` names the `committedTables` the network already holds and the `pendingTables` the next submission drives; the transaction stays queued, in doubt.
- `failed` carries `reason` (`'constraint'`, `'concurrent-modification'`, `'rejected'`, `'too-large'`, `'expired'`, `'discarded'`), `error` as an online commit would have thrown it (a `ConstraintError` reading `UNIQUE constraint failed: …`, a `ConcurrentModificationError`, with the db-core refusal reachable through `cause`), `changedTables` (whose rows the removal changed), `causedBy` naming the earlier transaction whose removal made this one fail, and `committedTables` when part of it had committed first — the network then holds half of the transaction.
- A listener that throws is logged and the rest still run. The returned function unsubscribes and is safe to call twice.

**What a watcher sees when a transaction fails.** The queued transaction's rows were in this machine's view since its local commit, which fired `Database.watch` subscribers as any commit does. When it fails, its rows leave that view, and every table in its `changedTables` is announced to the `Database`'s watchers as a whole-table change (`Database.notifyExternalChange`, the call [Reactive Watching](#reactive-watching) describes), after the `failed` status has reached every `onStatus` listener. A `committed` status announces nothing, since the drain committed exactly what this machine already showed. A transaction that fails because an earlier one failed is announced again, so a table can wake a watcher once per failed transaction; each wake is a re-query, never a missed change. The rows can leave the view earlier than the `failed` status: a read that pulls the other machine's commit sees the refusal and stops showing them at once, and the status and the announcement follow when the drain acts on it.

Queue-wide state, for a status bar: `plugin.offline.onQueueState(listener)`, published whenever the queue or the mode changes, and `plugin.offline.queueState()` for the current value. It carries `mode` (`'offline'` or `'online'`), `depth`, `oldestQueuedAt`, `draining` (a submission is on the network), `waitingFor` (`'cohort'` or `'backoff'` for the head), `unclassifiedFailures` (attempts the drain could not classify; a rising count with a stuck depth is the signal), `assuredFailures` (transactions reported assured that failed anyway; see below), and `readsServedLocally` (the last live read was served from this machine's own view because the other machines could not be reached; see [Reading while the other machines cannot be reached](#reading-while-the-other-machines-cannot-be-reached)).

#### Whether another machine can make a queued transaction fail — `outlook`

Most queued transactions cannot fail: a new note under an id the application generated, an edit of a row only this machine has seen. A few can: claiming a username another machine may claim first, editing a row other people also edit. Each `queued` status carries an `outlook` that says which, judged when the transaction is queued, from the checks the transaction is judged by again when it is sent:

- `kind` — `'assured'` when no other writer can make it fail, `'exposed'` when one can.
- `exposures` — one per check another writer can refuse, grouped by the table or index they were staged into and in staging order within each, each `{ table, rule, key, columns? }`. `rule` is `'primary-key'` (an insert's key must still be free; `key` is the primary key), `'unique'` (a UNIQUE value must still be free; `columns` names the constraint's columns and `key` the value), or `'row'` (an update, delete or replace read a row another writer may change or delete; `key` is its primary key). A check the plugin cannot judge is reported as `'row'` with no `key`, never left out.
- `dependsOn` — the earlier queued transactions this one relies on, `{ transactionId, via }`, in queue order. `via: 'guard'`: if that transaction fails, a check of this one can refuse, so this one is assured only if every transaction it depends on this way is. `via: 'unchecked'`: one of this transaction's decisions (next) read rows that transaction wrote, so if it fails this one still goes in, resting on rows that are gone. A transaction listed for both reasons is listed as `'guard'`.
- `unchecked` — what the transaction's statements decided by reading other rows, which nothing checks again when it is sent (below), or `'not-computed'`.

How to present it is the application's choice; one way is to show an assured transaction as plain progress and an exposed one as "may not go through", with its exposures as the reason.

**What a statement decided by reading other rows — `unchecked`.** A message that references a conversation, a bulk update that chose its rows by a filter, a value copied from another table: each rests on rows the statement read when it ran, and nothing reads them again when the transaction is sent. `unchecked` lists those decisions, each `{ table, kind, scope }`: `table` as `schema.table`; `kind` one of `'foreign-key'` (a row's foreign key checked against its parent, or a deleted or re-keyed parent against its children), `'check'` (a CHECK with a subquery, named by the table written), `'assertion'`, `'read'` (values taken from other rows: `insert … select`, `set x = (select …)`) or `'row-selection'` (an update or delete that chose its rows by anything but a key equality, so a row another machine adds meanwhile is not touched); and `scope`, how narrowly the read was pinned, `'row'` by a unique key, `'group'` or `'global'`. They do not make the transaction fail; they can make it commit as a fresh evaluation would not — a message whose conversation another machine deleted meanwhile, which then lands dangling. Whether that matters is the application's call, per rule. `'not-computed'` says the list could not be made: a statement of the transaction had no description (the child writes of a foreign-key cascade), or the transaction was put back after a restart from a record saved by a build before the facts were saved with it. An insert into `Messages` referencing a `Conversations` row an earlier queued transaction created reads, on its `queued` status, `"dependsOn":[{"transactionId":"…","via":"unchecked"}],"unchecked":[{"table":"main.Conversations","kind":"foreign-key","scope":"global"}]`.

A value counts as fresh when Quereus's description of the statement says it came from a source no other writer can produce: `StampId()`, which the plugin registers as one, or the builtin `randomblob(n)` with a literal `n` of 16 or more — each bare, or under `hex`, `lower`, `upper`, `cast` or `||` with a literal (only `hex` keeps a blob fresh). So `insert into Note (id, body) values (StampId(), :body)` and `values (hex(randomblob(16)), :body)` are assured with no tag; a key from a parameter, from `random()` or from `substr(StampId(), 1, 8)` is not. `StampId()` answers the same value for every call inside one transaction, so two rows inserted under it in one transaction collide with each other, and the second is refused before anything is queued. Write `hex(randomblob(16))` for a random text key, not bare `randomblob(16)`: the engine stores that as a lossy text rendering of the bytes, so it is not fresh. Five tags declare what the description cannot see, saved in the catalog record like every tag. The first three are read `=== true`; the last two take one value each, and any other value is read as the tag's absence and logged once (`optimystic:profile-tag-ignored`, `optimystic:merge-tag-ignored`):

| Tag | On | Effect on the outlook |
|---|---|---|
| `"optimystic.fresh" = true` | a column | The application generates the column's values unique per write (a UUID made in the app). An insert under a primary key that has such a column, and a UNIQUE value that has one, is not exposed; nor is an update or delete of a row an earlier queued transaction inserted under such a key, since no other machine has seen the row. Such a key also cannot collide, which the lane (below) reads. |
| `"optimystic.single_writer" = true` | a table | Only this machine writes the table's rows (a device's own settings): its updates and deletes are not exposed. Inserts under a natural key still are. |
| `"optimystic.content_key" = true` | a table | The primary key is a deterministic function of the row's other columns (a blob store keyed by content hash), so two machines inserting the same content insert the same row: a plain `insert` of a row another machine already inserted, equal column for column, is then accepted as already applied when the transaction drains, instead of failing as a duplicate. Changes what the drain accepts, not the outlook: the insert is still exposed on its key, tolerating the same change (below). |
| `"optimystic.profile" = 'replay-permitted'` | a table | The table's changes may be merged with other machines' concurrent changes later, when the statement allows it. Today this only **classifies**: each statement's write is recorded as `convergent` or `serializable` on its log entry, its transaction and its queue entry (see [docs/transactions.md § Which lane a transaction takes](../../docs/transactions.md#which-lane-a-transaction-takes)); nothing admits or merges by it yet. The default, and the other value, is `'strong'`: every write is `serializable`, exactly as today, so a table that declares nothing changes nothing. |
| `"optimystic.merge" = 'last-writer-wins'` | a column | Two machines' concurrent assignments of the column merge by the later one winning. The only merge kind defined; today it only decides the lane of a same-key `update` that assigns the column (every assigned column must carry it), and does not merge anything yet. |

```sql
create table Note (id text primary key with tags ("optimystic.fresh" = true), body text)
  using optimystic('tree://app/notes');
```

**A change another machine already made is accepted, not refused.** A queued transaction's checks refuse a rival that changed what the transaction read — except a rival that made exactly the transaction's own change, where the final state is the one both intended: a `delete` of a row the rival already deleted; an `update … where <key> = …` that writes literals or parameters (not `set n = n + 1`, whose result after the rival's would differ) of a row the rival already left equal to its result; an `insert or replace` of such a row; and an `insert or ignore`, `insert … on conflict do nothing` (with no target, or targeting the key) or an insert into a content-keyed table of a row the rival already inserted equal column for column. Such a transaction commits with `effect: 'already-applied'` on its `committed` status; a plain `insert` of an existing row still fails as a duplicate, since an application may rely on that to learn that someone else got there first. The exposures of these checks carry `tolerates: 'same-change'` in the outlook, and stay exposures, because a rival can still make a different change.

**The outlook follows the queue.** A transaction's own checks are judged once, when it is queued — a tag changed later does not judge them again. Its `dependsOn` and `kind` are worked out again whenever an earlier transaction commits, partly commits or fails, so `status` and `entries` always answer the current outlook, and when `kind` changes the transaction gets an `outlook-changed` status: a transaction exposed only through the ones it depended on becomes assured once they have committed. A transaction whose checks a replay has already refused keeps the outlook it had; its `failed` status is what reports it. A transaction put back after a restart is judged again then, from its checks and from what its statements' descriptions said, which are saved with it, so it gets the outlook it had — except that a decision pinned to particular rows comes back as a decision on the whole table, which can add a transaction to `dependsOn` until that one settles; one still waiting to be put back (`waitingFor: 'restore'`) carries no outlook, and counts as an exposed dependency of every later transaction that wrote one of its tables. (Committing offline before `plugin.hydrate` has put the journaled transactions back can turn an assured outlook exposed, when one of them goes back ahead of it; that change is delivered and logged as `offline:outlook-regressed`.)

**An assured transaction that fails is a defect, and is counted.** A tag changes only the prediction: every check is still made when the transaction is sent, so a false tag gives an assured transaction that fails anyway. When a transaction reported assured fails with `'constraint'` or `'concurrent-modification'`, and not because a transaction it depended on failed, the plugin logs `offline:assured-entry-failed` (the transaction, the reason, the class of the check that refused, its table and key, and `causedBy`) and adds one to `assuredFailures` on the queue state. Expiry, `discard`, a validator's rejection and the size limit are never counted: the outlook does not predict them. In a deployment whose tags are true the count stays at zero; a rising one points at a false `optimystic.fresh` or `optimystic.single_writer` tag, or at a value Quereus labelled fresh that was not.

**Asking before committing — `CommitOutlook()`.** Inside an open transaction, `select CommitOutlook()` answers, as JSON, the outlook the transaction would get if it were committed now, behind everything queued; where there is no transaction to judge it answers `NULL`, by the same rule `StampId()` follows ([StampId() Function](#stampid-function)) — so it answers for an autocommit write statement, and `NULL` for `select CommitOutlook()` on its own. A bigint renders as a number when it is a safe integer and as a decimal string otherwise, bytes as `0x` followed by hex, and an unknown key as `null`. It judges what is staged at the moment it is evaluated, so inside a statement that also writes it sees what that statement has staged before it. It works outside offline mode too, where it says whether the commit can lose a race with another writer at all.

```sql
begin;
update Note set body = :body where id = :id;
select CommitOutlook();   -- {"kind":"exposed","exposures":[{"table":"main.Note","rule":"row","key":["n1"]}],"dependsOn":[],"unchecked":[]}
commit;
```

#### Queries and actions

```typescript
plugin.offline.entries();                  // the queued transactions, in order, each with its current status
plugin.offline.status(transactionId);      // the queued status, else a retained terminal outcome, else undefined
plugin.offline.discard(transactionId);     // withdraw a never-sent transaction: it fails with reason 'discarded'
plugin.offline.outcomes();                 // the terminal outcomes retained since they were emitted
plugin.offline.acknowledge(transactionId); // forget one retained outcome
```

`discard` throws `EntryNotDiscardableError` for a transaction that has been sent at least once (the plugin can no longer say whether it landed) or is being submitted, and `UnknownEntryError` for one not queued; both classes are exported from both entries. A saved transaction not yet put back after a restart (see [Restarting](#restarting)) is listed, answered and discarded like a queued one, except in the moment a restore pass is putting it back, when `discard` refuses it (`because: 'restoring'`) until the pass has queued it. A transaction waiting for the other machines is never sent while it waits (see [Offline mode](#offline-mode--pluginoffline)), so it can be withdrawn. One that was sent and refused — the machines dropped out between the check and the send — is in doubt from then on: `discard` refuses it and a passed `expireAfterMs` is deferred until it settles.

#### Not yet in this stage

- **No SQL view of the queue.** `plugin.offline.entries()` is the only listing; an `optimystic_queue` virtual table is in the backlog.

## Reactive Watching

Tables backed by Optimystic drive Quereus's reactive watch API. When a commit
lands on a collection's blocks — whether authored locally or replicated from a
remote peer — the plugin translates it into a `Database.notifyExternalChange`
call, so `Database.watch` / subscribe consumers fire through the normal reactive
path. No polling required. By default only commits **this node's storage applies**
wake a table; a table can opt in to hearing commits made anywhere on the network
(see *Network change notification* below).

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
- **Host requirement.** Without the tag below, only nodes that **host the
  collection's blocks** observe these commits and push invalidations. Edge/client
  nodes that don't host blocks receive no push and continue to fetch on demand.
- **Transactor support.** Reactive watching works with the `network` transactor
  (the hosting node's storage drives it) and the in-process `local`/`test`
  transactors. `mesh-test` and custom transactors that don't implement
  `IBlockChangeNotifier` degrade gracefully to non-reactive behaviour.

### Network change notification

A table declared with the `optimystic.network_watch` tag also wakes when any other
machine commits to it — including on a phone or laptop that stores none of the
table's blocks — and wakes again once that commit can be read whole:

```sql
create table users (id integer primary key, name text)
  using optimystic('tree://app/users')
  with tags ("optimystic.network_watch" = true);
```

The key is quoted because Quereus reads an unquoted tag key as a single identifier.
The value must be the boolean `true`; anything else, the string `'true'` included,
leaves the table on local wakes only. `alter table users set tags (…)` (and an
`apply schema` whose only change is the tag) starts or stops the network watches on
the running table, and is saved in the table's catalog record like any other tag
change (see *Warm Restart* above).

What it needs:

- **A node with the cohort-topic substrate.** The table's node must have been built
  with `cohortTopic.enabled` (`NodeOptions.cohortTopic` in `@optimystic/db-p2p`).
  For a node the plugin builds, pass it as the plugin-level `cohort_topic`; a node
  the host registers (`collectionFactory.registerLibp2pNode`) must have been built
  with it. A tagged table without one — and any table on a `local`, `test`,
  `mesh-test` or custom transactor — logs one warning and keeps local wakes only.
- **A registration at the tail's root.** A collection's notifications are rooted at
  the storage group of its log tail block, so a watcher outside that group is woken
  too; `clusterSize` and `cohortTopic.wantK` need not equal the number of machines.
  What a watcher needs is a live registration at that root (see
  [docs/reactivity.md](../../docs/reactivity.md) §Origination point).
- **A machine that announces.** A commit is announced by the machine that
  coordinated it, from the commit certificate its cohort's consensus produced. The
  node the plugin builds itself runs with `clusterSize: 1`, so its own commits run
  no consensus and are **never announced**: such a node can *watch* — be woken by
  other machines' commits — but other machines are not woken by its commits. A
  node the host builds with a real cluster size both watches and announces.

What it opens: one watch per **collection** of the tagged table — its rows, each
index, each index the plugin synthesizes to enforce a `UNIQUE` constraint, and the
reference tree a table with `blobref` columns has. A SQL transaction writes all of
them, but each lands as its own commit, announced by the machines that store that
collection's log tail; watching only the table's rows would wake a watcher before
the indexes were readable, so a lookup through an index right after the wake would
miss the new row. With every collection watched, the index's own landing wakes the
table a second time, and the renewal's tail check below covers the index too. The
set follows the table: `create index` adds a watch, `drop index` removes one.

What it costs: one cohort registration per watched collection for as long as the
table is open, renewed every 20 s (Edge node) or 30 s (Core node), and one read of
that collection's log tail at each renewal — the fallback check that turns a lost
notification into one renewal's delay rather than a missed wake. The tail reads of
all a machine's watches batch into one request per machine that answers for them,
so what grows with the collection count is how many machines that is. The first
tail read after a watch opens wakes the table's watchers once, whether or not
anything changed, so a tagged table with three indexes invalidates four times as
it opens. On a machine that both stores the table and watches it, another machine's
commit wakes watchers once from storage and once per collection from the network.
All of these are coarse whole-table invalidations, so the cost of an extra one is
one re-query. The watches close on `drop table`, and on `plugin.dispose()` for a
`Database` closed without dropping its tables.

### Materialized views over Optimystic tables

Quereus keeps a materialized view up to date row by row for the writes its own
statements make. Rows another machine commits reach an Optimystic table without
one, so the plugin rebuilds every materialized view that reads the table
(`refresh materialized view`) once this machine learns of the commit — from its
own storage, a network change notification, or a read of the table that pulls
the commit in. Views over plain views over the table count too; a view that
reads only another view is brought up to date by that view's rebuild.

- **When.** After the statement running at the time, and never inside an explicit
  transaction: a rebuild owed while one is open waits for its commit or rollback.
  Commits that arrive while a rebuild is pending are folded into it.
- **Between the commit and the rebuild,** reads of the view still answer from the
  old rows — read directly, or in place of a query over the table that Quereus
  answers from the view (a `select sum(Units) from Chit` when a view holds that sum).
- **This machine's own commits** never rebuild a view; Quereus maintained it as
  they were made.
- **A failed rebuild** is logged once per view and message and retried after 1 s,
  doubling to 60 s. Dropping or recreating the view ends it.
- **`plugin.materializedViews.settled()`** resolves once nothing is pending: no
  change waiting, no rebuild running or owed, except rebuilds waiting to retry
  after a failure. It waits for an open explicit transaction to end first, so
  never await it inside one or inside a statement.
- **A table on the `network` transactor without `optimystic.network_watch`** hears
  another machine's commit only when this machine stores the table's blocks or
  reads the table, so a view over it can stay behind until then; the plugin logs
  one warning per view and table. Tag the table (*Network change notification*
  above) to be told of every commit.

There is no setting yet to keep a view out of every query until its rebuild
instead; that waits on a Quereus API.

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
| `link_round_trip_ms` | The slowest round trip, in milliseconds, between any two nodes that will talk to each other, relayed hops included. The node the plugin builds derives every network deadline from it, including the dial, cancel and overall write deadlines of the plugin's own transactor; see `linkRoundTripMs` under *Slow relayed links* in [the db-p2p readme](../db-p2p/readme.md). Unset keeps the LAN deadlines. A table on a node the host registered takes those deadlines from that node instead. Plugin-level only: it configures the node, which every table on one network and port shares. |
| `cohort_topic` | The node's cohort-topic substrate, passed through as `cohortTopic` to the node the plugin builds (`NodeOptions.cohortTopic` in `@optimystic/db-p2p`): an object with a boolean `enabled`, plus the node's optional `wantK` and `host` tuning. Enabling it is what lets a table tagged `"optimystic.network_watch" = true` hear other machines' commits (see *Network change notification*). Anything without a boolean `enabled` is refused. Has no effect on a node the host registered. Plugin-level only, like `link_round_trip_ms`. |
| `storage_allotment` | How many bytes of this machine you gave the network, passed through as `storageAllotment` to the node the plugin builds (`NodeOptions.storageAllotment` in `@optimystic/db-p2p`): a `bytes` count, plus the node's optional `thresholds` — the fractions of its total at which it reclaims, sheds and refuses — and `usedBytesCacheTtlMs`, the lifetime of its memoized usage scan. All three are optional; `{}` means the defaults. A value that is not an object, a `bytes` or `usedBytesCacheTtlMs` that is not a number, or a key that is none of the above (`gigabytes`, `shedabove`) is refused, naming the key — at the first table or blob use that resolves a binding, not at `register()`. The NUMBERS are the node's to refuse: a `bytes` that is not an integer above 0, thresholds out of order, or a `usedBytesCacheTtlMs` that is not a finite count at or above 0, is a `RangeError` when the node is built. Unset, the node measures against whatever its storage backend reports free — which only the file store and a browser's IndexedDB do; on SQLite, LevelDB and memory it then cannot tell how full it is at all, never sheds or refuses, and advertises no capacity to its peers, which is the case this setting exists for. A `storageFactory` is not required: over memory the allotment simply IS the total, and heap-backed bytes are measured against it. A figure below 2 GiB also shrinks the node's blob read cache, which is an eighth of the total or less, and one leaving under 100 MiB available narrows the node's ring to the deepest one. Has no effect on a node the host registered — that node took its own options. Plugin-level only, like `cohort_topic`, so no two tables can disagree about it; one figure covers every node that one `register()` builds, so if your tables sit on two networks or ports, size it knowing each of those nodes is promised that much. |
| `storageFactory` | `() => NodeStorage` (the type is exported by `@optimystic/db-p2p`) — every store this network persists to on **this machine**, as one value: `blocks`, the raw storage behind a `'local'` transactor; `pieces` and `kv`, where blob pieces and blob records live. Your platform's storage package opens all three over one location in one call — `fileNodeStorage(dir)` from `@optimystic/db-p2p-storage-fs`, for instance. It is also the storage of the node a `'network'` transactor builds (`NodeOptions.storage`), so that node keeps its blocks, blob pieces and blob records where you say and its blob pins survive a restart: **building the node yourself is no longer the only way to get that.** Called **once per network** — per `<transactor>:<keyNetwork>` key — however many tables and blob services resolve on it, and the result is kept for the life of the plugin, so the factory may construct rather than return a value you hold and the plugin can never be the reason two sets of stores open over one location. Omitted, everything is in memory and nothing survives a restart (a `'network'` transactor's node says so in one `node-wiring` `WARN:` line naming what is lost). The plugin **closes nothing** it was handed — `plugin.dispose()` releases only its lease on the read cache in front of `blocks` — so open the stores outside `register()` and close them yourself. The plugin cannot tell whether a store is persistent, so no combination is refused, but `pieces` and `kv` should be persistent together or not at all: persistent pieces over in-memory records lose every pin at restart and the next sweep then deletes the pieces, while persistent records over in-memory pieces report blobs the machine cannot serve (`stat` corrects that as it finds it). Durable `pieces` and `kv` over a `MemoryRawStorage` `blocks` is a legitimate composition — a machine that keeps its blobs and not its blocks. Function-typed, so `register()` only, not a `USING` clause. |
| `blob_unstaged_holding_ms` | How long a blob you `put` with no transaction open keeps its `unstaged` pin when no statement ever references it, in milliseconds. Default `86400000` (24 hours). Past it the pin is released and this machine's next piece sweep deletes the bytes — which is what keeps an upload the user cancelled, or an insert that never ran, from holding storage for ever. The pin of a blob any still-unfinished transaction references is never expired, however old it is, including one waiting in the offline queue. Lower it for a tool or a test that should not wait a day; raise it if your application routinely puts files long before it writes the rows that reference them. An empty string or `null` counts as unset; anything else that is not a finite, positive number is refused by `register`. The sweep runs on its own interval — a quarter of this period, never oftener than a minute and never rarer than an hour — so a very short period still sweeps no more than once a minute, and the 24-hour default sweeps hourly. |
| `cost_profile` | How slow these tables are to read, as the query planner prices them (Quereus's `costProfile`). A hint only: it changes plans, never results. By default it follows `default_transactor`: `'network'` (also the default when `default_transactor` is unset) declares Quereus's `'distributed'` category, since a read can leave the machine and a coordinator may consult its cohort before answering; every other transactor declares nothing, which plans like in-process memory. Give either a preset name — `'memory'`, `'localDisk'`, `'browserIdb'`, `'network'` or `'distributed'` — or, through `register()` only, an object `{ firstRowLatencyMs?, perRowLatencyMs? }` in milliseconds, for example `{ ...COST_PRESETS.network, perRowLatencyMs: 0.02 }` with `COST_PRESETS` from `@quereus/quereus`. It replaces the default entirely; an empty string or `null` counts as unset. An unknown name, another key, or a field that is not a finite, non-negative number is refused by `register`. Override it when the default is wrong for you: a small group whose nodes each hold every block reads from its own replica at local speed (consider `'localDisk'` or `'network'`); `'local'` over a persistent `storageFactory` block store should declare `'localDisk'` (a file, LevelDB, SQLite, MMKV) or `'browserIdb'` (IndexedDB); a host-registered transactor should declare its own category. It applies to every table registered through this plugin, whichever transactor a table names. |

```typescript
import { register } from '@optimystic/quereus-plugin-optimystic';
import { myMmkvNodeStorage } from './my-storage.js';

register(db, {
  default_transactor: 'local',
  // One value for all of it; a storage package opens the three stores over one location.
  storageFactory: () => myMmkvNodeStorage(),
});
```

### Closing down: call `plugin.dispose()` after `db.close()`

`register()` returns a plugin handle with an async `dispose()`. `db.close()` does not reach it,
so call it yourself when you are done with a `Database`:

```typescript
const storage = fileNodeStorage(dir);   // you opened it, so you close it — the plugin never does
const plugin = register(db, { default_transactor: 'local', storageFactory: () => storage });
// ...
db.close();
await plugin.dispose();
await storage.close();
```

`dispose()` first waits for any tag change still being saved to the catalog (see *Warm
Restart*), then closes the network watches of tables tagged `optimystic.network_watch`
(each would otherwise keep renewing its cohort registration until the node stops), stops
following commits for [`onCommitFullyHeld`](#when-a-pending-commit-becomes-fully-held--pluginoncommitfullyheldlistener)
(releasing its subscription to the node's full-replication events and forgetting every commit
still pending), stops the single-machine blob services it built for transactors with no libp2p
node (each runs a periodic sweep, which must not run against a store you have closed — a
`'network'` transactor's blob service belongs to its node and is stopped with the node), and
releases the plugin's claim on the read cache that sits in front of your
`storageFactory` block store. That cache is **one per backing store per process**, shared by
every `Database` registered over the same store — which is what lets two `Database`s over one
directory see each other's committed writes — and it is only cleared once the last claim on it
is released.

So a skipped `dispose()` is not a correctness problem (the cache is write-through, and every
in-process write went through it), but it has one visible consequence: the store's cache stays
warm for the life of the process, so a **later** `Database` over the same store reads it
instead of re-reading the backend. If something outside Optimystic mutates that store between
two `Database`s — a test that writes files into the directory itself, say — dispose in between
or the second `Database` will serve the pre-mutation values.

When the plugin owns libp2p nodes, `plugin.collectionFactory.shutdown()` stops them and then
releases the watches and the read cache as its last step; call `plugin.dispose()` as well, before
or after, so the plugin also stops following commits. Both are safe to call more than once.

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

A client node (`servesBlocks: false`, which stores no blocks; see [db-p2p §Setting Up a Client Node](../db-p2p/readme.md#setting-up-a-client-node)) is registered the same way, with no coordinated repo: `registerLibp2pNode('mynet', clientNode)`. Its reads and writes all go to serving machines, and its tables wake on another machine's commit only with the `optimystic.network_watch` tag.

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
(`'unmaterializable'`, `'peers-unreachable'`, `'cohort-unreachable'`, `'claimed-elsewhere'`,
`'named-by-log'`)
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

It is also exported from the `./plugin` entry, the one most hosts load the plugin through, so you
can import it from wherever you already load the plugin. Both entries export the same class
object, so `instanceof` matches whichever one you import from:

```typescript
import { PartialCommitError } from '@optimystic/quereus-plugin-optimystic/plugin';
```

Its `durability` says who holds the trees it persisted, in the same shape a successful commit's report and `CoordinatorPartialCommitError.durability` use (see [A commit's durability](#a-commits-durability--pluginoncommitdurabilitylistener)).

Both entries also re-export the `@optimystic/db-core` errors a caller classifies commit and write
failures by — `CoordinatorPartialCommitError` (a coordinated commit that landed on some trees but
not others), `SyncRetryExhaustedError`, and `TornActionError` — so a host needs no direct
`@optimystic/db-core` import to catch them. See [docs/transactions.md](../../docs/transactions.md)
for the partial-commit pair and [docs/internals.md](../../docs/internals.md) for the other two.
They re-export `isFullyDurable` too, the predicate a
[commit-durability listener](#a-commits-durability--pluginoncommitdurabilitylistener) tests with.

A commit refused because another machine changed or dropped the description of a table it wrote is a
`StaleTableDescriptionError` (`code === StatusCode.SCHEMA`, exported from both entries), whose
`tables` lists each table with `kind` (`'replaced'` or `'dropped'`) and `difference`. Nothing was
written, and this machine now holds the current description, so retrying the statement runs it under
that description; see [docs/transactions.md](../../docs/transactions.md#a-write-is-checked-against-the-tables-current-description).

When two writers race and the loser's commit is refused, the failure is a typed engine error, the
same as its sequential counterpart. A concurrent duplicate key (or unique value) is the engine's own
`ConstraintError` (`code === StatusCode.CONSTRAINT`), indistinguishable from a sequential duplicate.
A concurrent change to a row the losing statement read is a `ConcurrentModificationError`
(`code === StatusCode.BUSY`, exported from both entries), deliberately not a `ConstraintError`
because no constraint was violated. Both keep the storage-level refusal in `cause`. Retrying the
statement re-reads the row and decides again. See
[docs/internals.md](../../docs/internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards).

## Limitations

- Primary keys are stored as strings; non-TEXT keys work correctly but are not order-optimised (the engine re-sorts them rather than reading them ordered from the tree)
- `msgpack` encoding is declared but not yet implemented
- The query planner sizes a table nobody has analyzed as 1000 rows, the same default Quereus's memory tables use, so joins and filters plan the same way on both. `analyze` gives the planner each table's real size and per-column value counts, but those statistics last only for the life of the process, and Quereus re-collects them automatically only after 500 rows of a table have changed in this process (`auto_analyze_min_mutations`). A small table can therefore be planned on the default for its whole life; run `analyze` after loading it if a plan matters. Keeping the statistics across a restart is not yet implemented
- Savepoints (including Quereus's internal statement-/row-level atomicity) work in legacy/single-node mode; in distributed-consensus (session) mode they are no-ops, so a mid-statement abort there can still leave partial rows staged
- An UPDATE or DELETE re-reads the row it is about to overwrite (index maintenance needs the pre-write image). If the collection cannot produce that row — the engine and the collection disagreeing about what exists, which a networked transactor can hit as a transient point-lookup miss — the statement fails with `could not find the pre-write row` rather than writing a partially-correct row and silently corrupting secondary indexes. One miss is not a disagreement: a row this transaction's own delete already removed, which is how a self-referencing `on delete cascade` reaches a row the same statement also selected. The delete then reports no row for it, as a memory table does
- A connection only maintains the secondary indexes its own table instance knows about. If a query is planned onto an index this connection does not maintain, it fails with `Table 'X' does not maintain index 'Y'` rather than answering from a tree its writes have been skipping. Re-running that index's `CREATE INDEX` on the connection re-attaches it (it is idempotent) and backfills entries for the rows written while it was detached, so nothing stays invisible to index-driven lookups. That re-declare costs one scan of the table and re-stages every row's entry into the attached tree; a `CREATE INDEX` that attaches nothing new (the ordinary warm re-declare) does neither, and one that attaches an index on a table this connection reads as holding no rows skips the scan (and the refresh in front of it) — there is nothing to copy. The backfill populates from the rows the connection can see: its own committed rows, plus anything it has staged in an open transaction. A connection that opens the table cold and finds the index already in the persisted schema attaches nothing and therefore does not verify — rows orphaned by some *other* divergent writer are healed by re-declaring the index on a connection that can see them, not by re-opening the table
- A `CREATE TABLE` that re-declares an existing table (no `DROP TABLE` in between) may reorder or add columns freely — each persisted index keeps pointing at the column it was declared on, and its tree contents stay valid. It may **not** drop a column a persisted index still covers: that is refused with `Cannot re-declare table 'X' without column 'Y': persisted index 'Z' covers it. Drop the index or the table first.` (the catalog holds no index-removal path, so the index would otherwise survive with nothing to point at). Nothing is written when the re-declare is refused
- `DROP TABLE` removes the table's schema from the catalog but does **not** delete its rows or its index trees from storage. What it leaves behind is a *gravestone* — the dropped table's catalog record, kept and stamped with a drop timestamp — so the storage stays described. A later `CREATE TABLE` at the same collection URI is checked against that gravestone (and against any **live** table already declared over the same URI) rather than silently adopting what it finds:
  - **Refused** when the declaration adds a column the surviving rows cannot supply (they would decode as NULL even where the new declaration says `NOT NULL`): `Cannot create table 'X' over '<uri>': that collection still holds rows from a dropped table declared as (…), and this declaration adds column 'Y', which those rows cannot supply.`
  - **Refused** when the declaration re-types a column those rows do carry (a stored row is untagged, so its column types are the only thing that says what a stored value means on the way out): `… still holds rows from a dropped table, and this declaration re-types column 'Y' as BLOB where the stored rows were written as TEXT.`
  - **Refused** when the declaration changes the primary key those rows are keyed under (rows written under the old key can never be reached through the new one): `… still holds rows from a dropped table keyed on (…), and this declaration keys on (…).`
  - **Still inherited** by an identical re-declare, or a narrower one that only drops columns and keeps the primary key and the surviving columns' types — the old rows come back, which is the documented way to re-attach to existing storage (and the way out of the persisted-index re-declare refusal above). Any re-declare over an **empty** collection is allowed under any shape
  - `CREATE INDEX` is held to the same rule over the leftover tree at `<uri>/index/<name>`: adopting a **non-empty** leftover tree under a different column list is refused with `Cannot create index 'X' over '<uri>/index/X': that collection still holds entries from a dropped index of the same name declared on (…), not (…).` A fresh index name, or the same column list the tree was built on, still works. `DROP INDEX` leaves its tree behind the same way and keeps the index's description in the table's record for this check; a re-create of the same name adopts the tree and re-stages every current row, but entries for rows deleted between the drop and the re-create survive in it (an index-driven read skips them; a uniqueness probe still counts them)
  - Refusals write nothing and leave the existing tables untouched; the retry the message names works on the very next statement
  - These checks read the catalog, so they are only as good as the catalog read: a cohort that answers "nothing" for the catalog while the data collection reads fine leaves them blind, and a database dropped by an older build (which wrote a bare tombstone, not a gravestone) is unchecked exactly as it was before

  Use a fresh collection URI when re-creating a table whose old rows should not come back
- A machine that hydrated before another machine changed a table's record keeps its own copy of the table's description, and does not write that copy over the record. It reads under that copy, and finds out at its next write: a transaction that wrote the table is refused at commit with `StaleTableDescriptionError` (`StatusCode.SCHEMA`) when the record describes the table differently (an index, a column or a `CHECK` another machine added or dropped) or holds its gravestone, and nothing is written. The machine then holds the record's description, so the same statement can be retried: it is planned again under the new description, or fails as on a table this machine never had. A tag change never refuses a write. Each committing write pays one read of the catalog for this. A write whose check ran just before the other machine's change landed still commits under the old description, and an index created inside `apply schema` is listed in the record only once the apply ends, so a row another machine writes during that build can be left out of the index. A transaction the offline queue holds is checked when it is queued, and not at all when the catalog cannot be reached then. An `alter table` of the table's columns or constraints, or a `create index`, on such a machine is refused once the table has been dropped, as is a `create index` on a column that has been dropped; a tag change there is kept on that machine only. One case does still write the older copy back: an `apply schema` that runs a data-destroying step and has its catalog commit refused leaves the tables it changed to save this machine's description on their next touch, since nothing else will save those changes
- A partial index (`create index … where …`) holds entries only for the rows its `where` clause is true for, and is never used to answer a query: the planner scans the table instead, as Quereus's own memory tables do, since a seek through it would miss matching rows outside the clause. Nor does it stand in for a full `unique` constraint over the same columns — such a constraint gets its own internal tree. A `where` clause the index maintenance cannot evaluate (a function call, a subquery) is refused at `CREATE INDEX`. Entries an older build wrote for rows outside the clause stay in the tree; `plugin.verifyIndexes` reports them as `outside-predicate`
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
