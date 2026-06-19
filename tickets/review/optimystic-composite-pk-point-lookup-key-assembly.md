----
description: Review the composite-PK point-lookup fix: a one-line signature change plus a full-composite-key assembly replaces the single-arg extraction that caused composite-PK seeks to miss their rows.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/test/composite-pk-point-lookup.spec.ts
----

## What was done

`OptimysticVirtualTable.executePointLookup` previously accepted a single `string` key
and both call sites passed only `String(filterInfo.args[0])`, discarding every PK column
past the first. Rows under a composite PK are stored as `pkParts.join('\x00')`, so the
seek key `"M1"` would never match the stored key `"M1\x00P1"` — the point lookup always
missed.

### Change summary

**`src/optimystic-module.ts`**
- `executePointLookup(key: string)` → `executePointLookup(args: readonly unknown[])`
- Body now calls `this.rowCodec.createPrimaryKey(args as SqlValue[])` to assemble the
  full composite key using exactly the same encoding the row codec used to store it.
- Both call sites updated to pass `filterInfo.args` (the `plan===2` branch and the
  legacy `idxNum===1` branch).

**`test/composite-pk-point-lookup.spec.ts`** (new file)
- `finds a row by composite primary key (two-column PK point lookup)` — the core regression:
  inserts one row into a two-column-PK table and asserts the composite equality seek
  returns it (full scan also confirmed, as a sanity baseline).
- `composite-PK point lookup does not regress single-column PK` — single-column control
  to verify the change doesn't break the common case.
- Both run against the real `local` transactor backed by `FileRawStorage`.

### Test results

```
2 new specs: 2 passing
Full suite: 217 passing, 5 pending, 0 failing
```

### Known gap: DTS build error (pre-existing, out of scope)

`yarn build`'s DTS step fails with a duplicate `@libp2p/interface` type-identity error
in `collection-factory.ts` — two copies of `@libp2p/interface` resolved from different
`node_modules` subtrees. This is pre-existing and unrelated to the seek path. Documented
in `tickets/.pre-existing-error.md`. The ESM JS compiles fine; tests run via
`register.mjs` type-stripping.

## Use cases for review

1. **Composite-PK equality seek** — `WHERE col1 = ? AND col2 = ?` on a two-column PK
   returns the row (was returning nothing pre-fix).
2. **Single-column PK equality seek** — unchanged; the new code path produces the same
   key because `createPrimaryKey([v])` for a single-column PK returns `v` directly
   (the `pkParts.length === 1` shortcut in `createPrimaryKey`).
3. **Arg count invariant** — `createPrimaryKey` throws if `args.length !== pkColumns.length`;
   the `plan===2` planner only emits that plan when every PK column has an equality
   filter (`fullPkEquality`), so this invariant always holds on the hot path. The legacy
   `idxNum===1` branch is dead code under the current planner; if it ever fires with wrong
   arg count it will throw, which surfaces the bug rather than silently returning nothing.

## Review focus

- Confirm both call sites in `query()` now pass the full `filterInfo.args`.
- Confirm `executePointLookup` uses `createPrimaryKey` (not a manual string join or
  `args[0]` extraction).
- Check no other call sites pass the old `string` signature.
- The regression spec covers the composite-PK and single-column-PK paths; the reviewer
  may want to extend it with a three-column PK or NULL values if desired.
