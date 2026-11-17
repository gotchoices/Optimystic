description: Applications cannot read part of a large value in an SQL column, or write a large value, without the whole value sitting in memory, because the SQL engine Optimystic plugs into has no way to pass a value piece by piece. This needs a change to that engine, Quereus, and proposes what the change should be.
architecture: docs/blobs.md#sql
files: docs/blobs.md, ../quereus/packages/quereus/src/vtab/module.ts (`VirtualTableModule`), ../quereus/packages/quereus/src/vtab/capabilities.ts (`ModuleCapabilities`), ../quereus/packages/quereus/src/vtab/table.ts (`VirtualTable`, `UpdateArgs`), ../quereus/packages/quereus/src/common/types.ts (`SqlValue`, `Row`, `StatusCode`), ../quereus/packages/quereus/src/types/logical-type.ts (`LogicalType`), ../quereus/packages/quereus/src/core/database.ts (`Database.prepare`, `Database.registerType`), ../quereus/packages/quereus/src/func/registration.ts (`isAsync`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`OptimysticVirtualTable.update`, `OptimysticVirtualTable.query`), packages/quereus-plugin-optimystic/src/schema/row-codec.ts
difficulty: hard
----

**Blocked: a dependency outside this repository.** Unblocks when the Quereus engine (gotchoices/quereus#40) accepts and ships a contract for opening one column value of one row by table, key and column, reading a byte range of it, and receiving a large value on write as a stream rather than one array — the proposal below, or an edited form of it. The Optimystic work it then enables builds on `feat-sql-columns-hold-blob-references` and `feat-large-blob-column-values-are-stored-out-of-line`.

# Quereus reads and writes a range of a large value

## The problem

docs/blobs.md (the design of record for native large-value support, GitHub #63) stores large values outside transactions as content-addressed blobs. Its §SQL names this as the second further step: "Reading or writing a range of a column value by table, key and column needs an interface Quereus does not have." Today every value crossing the engine is a whole `SqlValue` (`string | number | bigint | boolean | Uint8Array | JsonSqlValue | null`, in `../quereus/packages/quereus/src/common/types.ts`). A module receives a write as a full row (`UpdateArgs.values`) and yields reads as full rows (`VirtualTable.query`), so a 200 MB video in a row is a 200 MB array on every read and write, even when the application wants its first 64 KB. SQLite answers the same need with `sqlite3_blob_open`, `sqlite3_blob_read` and `sqlite3_blob_write`. Quereus has no equivalent: no streaming value, no open-by-key API, and no way for a module to say that it stores large values out of line.

## What happens if nothing is done

Nothing is lost in capability. The explicit `blobref` column type and `plugin.blobs` (`feat-sql-columns-hold-blob-references`) already let an application store, reference, stream and range-read large values: it stores the reference in SQL and reads the bytes through the blob service, outside the engine. What this would add is ergonomics (one API, addressed by table, key and column) and memory: `feat-large-blob-column-values-are-stored-out-of-line` makes plain `blob` columns work at any size but still materializes each value whole, and only this change removes that.

## Proposed contract

Three additions to Quereus, each optional for modules, so no existing module changes behaviour.

**(a) A module declares that it stores large values out of line.** A new field on `ModuleCapabilities` (`../quereus/packages/quereus/src/vtab/capabilities.ts`): `largeValues?: 'out-of-line'`. Unlike the advisory flags there, it is a live gate: the engine consults it to decide whether (b) can delegate to the table and whether (c) may hand the module a stream. Absent, the engine behaves exactly as today.

**(b) Opening one value for reading.** A `Database` method in the style of `sqlite3_blob_open`:

```ts
openValue(table: string, column: string, key: readonly SqlValue[], options?: { schema?: string; signal?: AbortSignal; waitMs?: number }): Promise<ValueHandle>;

interface ValueHandle {
	/** Byte length, when known without reading the bytes. */
	readonly size: number | undefined;
	/** `length` bytes from `offset`, fewer only at the end of the value. */
	read(offset: number, length: number): Promise<Uint8Array>;
	/** The bytes from `offset` (default 0) for `length` (default to the end), in order. */
	stream(offset?: number, length?: number): AsyncIterable<Uint8Array>;
	close(): Promise<void>;
}
```

`key` is the primary-key tuple in key order, the shape `UpdateArgs.oldKeyValues` already uses. The engine resolves the table and column, checks the column is a blob (or text) column, and calls a new optional method on the table: `VirtualTable.openValue?(key: readonly SqlValue[], columnIndex: number, options): Promise<ValueHandle | undefined>`. A table that returns `undefined`, or a module without the capability, gets the engine's fallback: a point lookup of the row, with the whole value wrapped in a handle, so the API works on every module and saves memory only on modules that implement it. No row is `NOTFOUND` (`StatusCode.NOTFOUND`); a NULL value is a handle of size 0 marked null, or `NOTFOUND` — Quereus's choice. "Not here yet" — the value exists but its bytes are not on this machine and could not be fetched within `waitMs` — is a `QuereusError` with `StatusCode.BUSY` whose `cause` is the module's own typed error (for Optimystic, `BlobUnavailableError` with its reason), so a caller can retry; `BUSY` is the code Quereus already uses for "try again", and adding a code is the alternative if Quereus prefers one. The handle reads the value as of the moment it was opened: a module that stores immutable content (Optimystic does) gives that for free; for the fallback, the engine holds the materialized value.

**(c) A large value on write reaches the module as a stream.** A bound parameter may be a `LargeValueSource` — an engine-exported class wrapping `AsyncIterable<Uint8Array>` and an optional declared length. It is accepted only as the whole value of a column in `insert` or `update … set` on a table whose module declares (a); anywhere else (an expression, a function argument, a comparison, a table without the capability) it is a `MISUSE` error. It does not join `SqlValue`: widening that union would make every function, comparison and collation handle a value it cannot read. Instead the module receives it on a side channel, `UpdateArgs.largeValues?: ReadonlyMap<number, LargeValueSource>` keyed by column index, with the column's cell in `values` holding `null`. Constraint checking treats the column as non-NULL with unknown content: NOT NULL passes; a CHECK, generated column, index or foreign key that reads the column refuses the statement with `MISUSE`, since evaluating it would need the bytes. The module consumes the stream once, inside `update()`; for Optimystic that is `plugin.blobs.put`, and the row then stores the reference.

A ranged write into an existing value (`sqlite3_blob_write`) is deliberately not proposed. A content-addressed value is immutable, so writing a range means writing a new value; an application does that by streaming the new content.

## Alternatives rejected

- **A streaming member of `SqlValue`.** Makes the stream visible to every operator and function, none of which could consume it twice; rejected for (c) for the reason above.
- **The `zeroblob` pattern** (insert a placeholder of fixed size, then write ranges through an open handle). Two steps, a row that briefly holds a placeholder, and ranged writes that content-addressed storage cannot do in place.
- **A Quereus logical type that wraps a reference** (`LogicalType` with `parse` fetching bytes). `parse` is synchronous and would still materialize the whole value.
- **Only an Optimystic-side API** (`plugin.blobs.openValue(table, column, key)`). Already possible through `blobref`, but it bypasses the engine's catalog, transactions and key handling, and every module would build its own; the engine is the place that knows table, key and column.

## How reversible

All three additions are optional and additive in Quereus: a module that ignores them is unaffected, and the capability gate means the engine's existing paths stay the default. Removing them later would break only applications that call `openValue` or bind `LargeValueSource`. On the Optimystic side, implementing `openValue` reads what `feat-large-blob-column-values-are-stored-out-of-line` already stores, so no stored data changes either way.

## Work here once it lands

Implement `VirtualTable.openValue` on `OptimysticVirtualTable` over the blob service's `read` with `offset` and `length`, for both `blobref` and out-of-line `blob` columns; declare the capability; accept `UpdateArgs.largeValues` in `update()` by streaming each source into `put`; raise the Quereus dependency and peer ranges together (`yarn lint:deps`, AGENTS.md §Dependencies).
