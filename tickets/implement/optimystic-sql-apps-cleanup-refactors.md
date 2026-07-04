description: Two behavior-neutral cleanups in the SQL plugin and reference-peer CLI — replace unsafe private-member pokes (`as any`) with typed accessors, and de-duplicate the CLI options that are copy-pasted across three commands.
prereq: optimystic-reference-peer-offline-storage-share
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/reference-peer/src/cli.ts
difficulty: medium
----

## Scope

Pure refactors — **no behavior change**. Two independent items grouped because
both are cleanliness. Prereq is the storage-share bug fix only because both this
ticket and that one edit `reference-peer/src/cli.ts`; landing the bug fix first
avoids a needless merge conflict. Keep this ticket from expanding into behavior
changes.

## Item A — typed accessors instead of `as any` private pokes

Three sites in `optimystic-module.ts` reach across class boundaries via
`as any`, defeating type-checking:

1. **cli of `db` (module.ts:391)** — `ensureConnectionRegistered()`:
   ```ts
   const db = this.db as any;
   const existingConnections = db.getConnectionsForTable(this.tableName);
   ...
   await db.registerConnection(this.connection);
   ```
   `getConnectionsForTable` / `registerConnection` are real methods on the
   Quereus `Database`. Fix: type `this.db` (or a local accessor) to the
   interface that declares these, so the cast disappears. If the public
   `Database` type genuinely lacks them, add a narrow typed interface
   (e.g. `ConnectionRegistry`) and assert to that once, with a comment, rather
   than blanket `any`.

2. **IndexManager internals (module.ts:1244-1245)** — `addIndex()`:
   ```ts
   (this.indexManager as any).indexTrees.set(indexSchema.name, indexTree);
   (this.indexManager as any).schema = updatedSchema;
   ```
   `IndexManager` (`schema/index-manager.ts:99-131`) keeps `indexTrees` and
   `schema` private. It already exposes `getIndexTree`/`getIndexTrees` but no
   way to register a freshly built tree or swap the schema. Add public methods,
   e.g.:
   ```ts
   registerIndexTree(name: string, tree: Tree<IndexKey, IndexEntry>): void
   setSchema(schema: StoredTableSchema): void   // or updateSchema(...)
   ```
   Then call those from `addIndex` instead of poking privates. Match the file's
   existing doc-comment style on the new methods.

3. **Table internals (module.ts:1907-1908)** — `xDestroy`/teardown:
   ```ts
   const txnState = (table as any).txnBridge?.getCurrentTransaction?.();
   await (table as any).schemaManager.deleteSchema(tableName, txnState?.transactor);
   ```
   `txnBridge` and `schemaManager` are `private` on `OptimysticVirtualTable`
   (module.ts:100,103). `table` here is a sibling `OptimysticVirtualTable`
   instance. Add narrow accessor method(s) on the class — prefer a single
   intent-revealing method that does the work rather than exposing the fields,
   e.g. `async deleteOwnSchema(tableName: string): Promise<void>` that reads its
   own `txnBridge.getCurrentTransaction()` and calls
   `schemaManager.deleteSchema(...)` internally (keep the best-effort try/catch
   semantics at the call site or inside — preserve current behavior exactly).

Leave the `col.affinity as any` casts at module.ts:215-216 alone — those are
enum-narrowing on external Quereus types, not private-member pokes, and are out
of scope.

## Item B — de-duplicate triplicated CLI options

`reference-peer/src/cli.ts` declares nearly the same ~20 commander options three
times, on the `interactive` (lines 724-744), `service` (760-780), and `run`
(797-820) commands. Factor the shared set into one helper applied to each
command, e.g.:

```ts
function withCommonPeerOptions(cmd: Command): Command {
  return cmd
    .option('-p, --port <number>', 'Port to listen on', '0')
    .option('--ws-port <number>', '...')
    // ... the shared options ...
    .option('--announce-file <path>', '...');
}
```

then `withCommonPeerOptions(program.command('interactive'))...` etc.

Watch the small per-command differences — do **not** flatten them away:
- `interactive` and `service` have `--bootstrap-file` in different positions but
  all three include it; `run` also adds `--stay-connected`, a `requiredOption`
  `-a, --action`, `--diary`, and `--content`. Keep those command-specific
  options on their own commands, layered after the shared helper.
- Preserve every option's exact flag string, description text, and default —
  this is a mechanical extraction; the parsed `options` object each `.action()`
  receives must be identical to today.

## TODO

- Add `registerIndexTree` + schema-set methods to `IndexManager`; use them in
  `addIndex` (drop the two `as any` at module.ts:1244-1245).
- Add a typed accessor/method on `OptimysticVirtualTable` for the teardown path;
  drop the two `as any` at module.ts:1907-1908.
- Type `this.db` for the connection-registry calls; drop the `as any` at
  module.ts:391.
- Extract a `withCommonPeerOptions` helper in cli.ts; apply to all three
  commands, keeping command-specific options intact.
- Typecheck + build both packages; run the plugin test suite and reference-peer
  tests. Stream output with `tee`. Confirm no behavior change.
