description: Fixed composite-primary-key point lookups that were silently returning no rows because only the first key column was used to build the seek key.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/test/composite-pk-point-lookup.spec.ts
----

## What the change does

`OptimysticVirtualTable.executePointLookup` previously took a single `string` key and
both call sites passed only `String(filterInfo.args[0])`, discarding every PK column past
the first. Rows under a composite PK are stored as `pkParts.join('\x00')`, so the seek
key `"M1"` could never match the stored key `"M1\x00P1"` — the point lookup always missed.

The fix changes the signature to `executePointLookup(args: readonly unknown[])` and
assembles the full key with `this.rowCodec.createPrimaryKey(args)`, the same encoder the
row codec uses to store keys. Both call sites (`plan===2` and legacy `idxNum===1`) now
pass the complete `filterInfo.args`.

## Review findings

### Verdict
The implementation is **correct**. The core seek bug is genuinely fixed, the encoding on
the store path (`extractPrimaryKey`) and the seek path (`createPrimaryKey`) are provably
identical (both route every part through `serializeKeyPart` and share the same
single-column shortcut and `\x00` composite join), and the change is minimal and targeted.

### What was checked

- **Diff read first, fresh** (`git show 1f56fad`) before the handoff summary.
- **Seek-arg ordering contract (the load-bearing assumption).** `createPrimaryKey` maps
  `args` positionally onto `primaryKeyDefinition`, so correctness depends on Quereus
  delivering the seek args in PK-definition order rather than WHERE-clause textual order.
  Traced into the resolved Quereus build
  (`@quereus/quereus/dist/src/planner/rules/access/rule-select-access-path.js:400-405`):
  the equality seek builds `seekKeys = seekCols.map(...)` with `argvIndex: i+1`, and the
  module advertises `seekColumnIndexes = [...pkColumns]` (`optimystic-module.ts:1331`).
  So args always arrive in PK order — the assumption holds. **Added a regression test**
  (reversed-WHERE-order) so a future Quereus change to this contract is caught rather than
  silently miscomputing the key.
- **NULL key handling.** A literal `WHERE col = NULL` never reaches `executePointLookup`:
  the planner emits an `EmptyResultNode` for literal-NULL equality keys
  (`rule-select-access-path.js:396-398`). `createPrimaryKey`'s NULL serialization
  (`\x01NULL\x01`) is therefore only exercised on the store side, where it matches
  `extractPrimaryKey`. No gap.
- **number/bigint consistency.** Both store and seek serialize via `serializeKeyPart`,
  and `number`/`bigint` both `.toString()` to the same digits — keys stay consistent
  across the two paths.
- **Other call sites.** Grepped `executePointLookup` — only the two updated call sites
  exist; no caller still passes the old `string` signature. The legacy `idxNum===1`
  branch is effectively dead under the current planner; if it ever fires with a wrong arg
  count, `createPrimaryKey` throws (surfacing the bug) rather than silently building `''`
  and missing — an improvement over the prior behavior.
- **Codec unit coverage.** `test/row-codec.spec.ts` already unit-tests `createPrimaryKey`
  (composite assembly, throw-on-count-mismatch) and the `extractPrimaryKey`/comparator
  round-trip, including empty-string and separator-injection edge cases.
- **Test import convention.** Specs import `register` from `../dist/plugin.js`; verified
  this is the established repo pattern (every spec does) and that the built chunk
  (`dist/chunk-SC7DTJLI.js`) actually contains the fix, so the tests exercise the fixed
  artifact rather than stale output.
- **Lint + typecheck.** Root `lint` is a no-op ("Lint not configured"); `yarn typecheck`
  (`tsc --noEmit`) passes clean.

### Minor findings — fixed inline this pass
- Added two regression tests to `composite-pk-point-lookup.spec.ts`:
  - **non-PK WHERE order** — `WHERE PeerId = ? AND MemberKey = ?` on a `(MemberKey, PeerId)`
    PK, locking in the arg-ordering contract the fix depends on.
  - **three-column PK** — confirms a full three-column seek isolates the exact row and not
    a shared-prefix sibling (`('A','B','C')` vs `('A','B','X')`), extending coverage past
    two columns.

### Major findings
None. No new fix/plan/backlog tickets filed.

### Out of scope (no action)
- The `yarn build` DTS step fails with a duplicate `@libp2p/interface` type-identity error
  in `collection-factory.ts` (two copies resolved from different `node_modules` subtrees).
  Pre-existing, unrelated to the seek path, and already handled out-of-band by the runner's
  triage pass (commit `52ca9a0`); `tickets/.pre-existing-error.md` is no longer present.
  The ESM JS compiles and tests run via `register.mjs` type-stripping, so this does not
  gate the change.

### Test results
```
test/composite-pk-point-lookup.spec.ts: 4 passing (2 original + 2 added)
Full plugin suite: 219 passing, 5 pending, 0 failing
typecheck: clean
```
