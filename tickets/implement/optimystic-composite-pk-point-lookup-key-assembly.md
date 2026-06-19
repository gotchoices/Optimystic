----
description: A row lookup by a multi-column primary key returns nothing because the lookup only uses the first key column and ignores the rest; assemble the full composite key so the seek matches the stored row.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts
difficulty: easy
----

## Root cause (reproduced + confirmed)

The composite-PK point-lookup miss is **not** a network sync-visibility issue — it
reproduces deterministically on the `local` transactor, so it lives entirely in the
Quereus vtab seek path. (A `select count(1)` does a full table scan and sees the row;
the point lookup seeks by a malformed key and misses.)

`OptimysticVirtualTable.executePointLookup` is the culprit
(`packages/quereus-plugin-optimystic/src/optimystic-module.ts`):

```ts
// query() — plan=2 (primary key equality seek) and the legacy idxNum===1 branch:
yield* this.executePointLookup(String(filterInfo.args[0]));
...
private async* executePointLookup(key: string): AsyncIterable<Row> {
  ...
  const path = await this.collection.find(key);   // find by key string
```

For a composite primary key, the planner (`getBestAccessPlan`) reports
`seekColumnIndexes = [...pkColumns]` (all PK columns) and marks every PK-equality
filter as handled, so Quereus passes **one arg per PK column** in PK order —
`filterInfo.args = [memberKey, peerId]` for `where MemberKey=? and PeerId=?`.

But `executePointLookup` only consumes `String(filterInfo.args[0])`, dropping every PK
column past the first. The seek key becomes just `"M1"`, whereas rows are stored under
the codec's composite key `extractPrimaryKey(row)` = `pkParts.join('\x00')` =
`"M1\x00P1"` (see `RowCodec.extractPrimaryKey` / `serializeKeyPart` in
`schema/row-codec.ts`). `find("M1")` lands on a "crack" that is not `on`, so the lookup
fails open and yields nothing. Single-column PKs work by accident (`args[0]` already is
the whole key).

This is the exact `memberPeerExists()` seek sereus hit; the platform-side fix is to
assemble the full key from all seek args.

## The fix

Build the seek key with the **same** codec that stored it, so the byte string matches.
`RowCodec.createPrimaryKey(values: SqlValue[])` already does precisely this
(`pkParts.map(serializeKeyPart).join('\x00')`), and it asserts
`values.length === primaryKeyDefinition.length` — a good invariant for a full-PK seek.

Change `executePointLookup` to take the args array and assemble the key:

```ts
} else if (planType === 2 && filterInfo.args.length > 0) {
  yield* this.executePointLookup(filterInfo.args);
...
} else if (filterInfo.idxNum === 1) {                 // legacy branch
  yield* this.executePointLookup(filterInfo.args);
```

```ts
private async* executePointLookup(args: readonly unknown[]): AsyncIterable<Row> {
  if (!this.collection || !this.rowCodec) return;

  // Assemble the full (possibly composite) primary key from ALL seek args using
  // the SAME encoding the row codec uses to store keys (extractPrimaryKey).
  // Using only args[0] silently drops every PK column past the first, so a
  // composite-PK point lookup builds a key that can never match a stored row.
  const key = this.rowCodec.createPrimaryKey(args as SqlValue[]);

  await this.collection.update();
  const path = await this.collection.find(key);
  if (!this.collection.isValid(path)) return;
  ...
}
```

`SqlValue` is already imported in `optimystic-module.ts`. This was applied as a
candidate fix during the fix stage and verified to turn the failing repro green; it has
since been reverted so this stage applies it cleanly.

### Argument-count robustness (decide + document)

`createPrimaryKey` throws if `args.length !== pkColumns.length`. For the `plan=2`
full-PK-equality path this always holds (the planner only marks the seek as a point
lookup when every PK column has an equality filter — `fullPkEquality`), so the strict
check is a useful guard. The legacy `idxNum===1` branch is dead under the current
planner but kept for safety; if you want belt-and-suspenders, guard with
`args.length === this.rowCodec.getPrimaryKeyIndices().length` before calling, and fall
back to a table scan otherwise (mirrors how an unmatched plan already falls through).
Prefer the simple strict version unless a test surfaces a mismatched-arg path.

## Regression test

Add a permanent spec (the fix-stage repro was deleted). Mirror the harness in
`packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts` (real `local`
transactor over `FileRawStorage`, register plugin, `db.eval`):

- `create table MemberPeer (MemberKey text, PeerId text, note text, primary key (MemberKey, PeerId)) using optimystic('tree://.../memberpeer')`
- insert one row `('M1','P1','hello')`
- assert `select count(1) from MemberPeer` == 1 (full scan sees it)
- assert `select note from MemberPeer where MemberKey='M1' and PeerId='P1'` == `'hello'`
  (composite-PK point lookup — fails as `undefined` pre-fix)
- Add a single-column-PK control (`create table T (id text primary key, v text)` →
  `where id='x'`) so the change is proven not to regress the single-column path.

A `local`-transactor spec is the right home: it is fast, deterministic, and isolates the
seek layer. A networked variant adds flakiness without exercising anything the local one
doesn't (the bug is transactor-agnostic). If a networked smoke is wanted, gate it behind
the existing `OPTIMYSTIC_INTEGRATION` flag rather than the default suite.

## Validation

- `cd packages/quereus-plugin-optimystic && yarn build` then
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/<new-spec>.spec.ts" --reporter spec --exit`
  (stream output; mirror the package `test` script).
- Run the full package suite (`yarn test`) to confirm no seek/index regressions.

### Pre-existing build note (NOT this ticket)

`yarn build`'s **DTS** step fails with a duplicate `@libp2p/interface` type-identity
error in `collection-factory.ts` (lines ~170/171/174/308) — two copies of
`@libp2p/interface` resolved across `db-p2p` vs `quereus-plugin-optimystic`
`node_modules`. This is pre-existing (present before any change for this ticket),
unrelated to the seek path, and does **not** affect the tests (ESM JS emits fine and the
mocha runner strips types via `register.mjs`). Do not chase it here; if it blocks CI,
file it separately.

## TODO

- [ ] Change `executePointLookup` to accept `readonly unknown[]` and assemble the key via `this.rowCodec.createPrimaryKey(args as SqlValue[])`.
- [ ] Update both call sites in `query()` (the `plan===2` branch and the legacy `idxNum===1` branch) to pass `filterInfo.args`.
- [ ] Add a permanent regression spec (composite-PK point lookup returns the row + single-column-PK control) under `test/`.
- [ ] `yarn build` (JS) + run the new spec + run `yarn test` for the package; stream output with `tee`.
- [ ] Hand off to review noting the pre-existing DTS build error is out of scope.
