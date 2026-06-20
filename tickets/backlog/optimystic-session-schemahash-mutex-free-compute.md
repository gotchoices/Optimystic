description: In Optimystic's session mode, a host must remember to "warm up" a schema fingerprint before its first transaction or it gets a hard error; explore making that step unnecessary so the obvious wiring just works.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts
difficulty: hard
----

# Session-mode schema hash: compute without the exec mutex (remove the warm-up obligation)

## Background

The fix shipped in `optimystic-session-schemahash-reentrancy` removed the
**deadlock** that used to hang the first transaction after a schema change in
session/consensus mode. `QuereusEngine.getSchemaHash()` now never re-enters the
db from `begin`: it serves a cached hash, and if the cache is cold while a
statement is in flight it **throws** an actionable error instead of hanging.

That makes the engine safe, but it shifts an obligation onto the host: it must
keep the schema hash **warm out of band** — call `getSchemaHash()` once, outside
any statement, after DDL and after any later schema change — or the first
transaction's `begin` throws. The "obvious" wiring
(`configureTransactionMode(coordinator, engine, () => engine.getSchemaHash())`
with no preceding warm-up) does **not** just work; it fails fast with a clear
message, but it still fails.

## What this ticket is about

Investigate eliminating the warm-up obligation entirely by computing the schema
hash **without acquiring Quereus's exec mutex at all** — so a cold hash can be
computed safely even while a host statement is in flight, and the
cache/version-guard/out-of-band-warm machinery becomes unnecessary.

The `schema()` TVF that `computeSchemaHash` currently drives via
`db.eval('select … from schema()')` ultimately just iterates the schema manager
synchronously. The idea: read the catalog directly off `db.schemaManager`
(e.g. `_getAllSchemas()` / `_getAllFunctions()`) and format the same canonical
representation in-process, never touching `db.eval`. No mutex acquisition → no
re-entrancy → no deadlock → no warm-up needed.

## Why it was deferred (the tradeoffs to weigh)

This was judged out of scope for the deadlock fix because it is a larger
redesign with real costs:

- It **duplicates ~100 lines** of Quereus-internal SQL/catalog formatting that
  `schema()` performs, and that duplication must be kept byte-for-byte identical
  across all nodes — the schema hash is a **cross-node consensus value**, so any
  divergence between this in-process formatting and what `schema()` produces (now
  or after a Quereus upgrade) silently breaks validation. Whatever is built must
  guarantee the hash matches `schema()` exactly, ideally pinned by a test that
  compares the two for representative schemas.
- It leans on **underscore-prefixed internal Quereus APIs**
  (`schemaManager._getAllSchemas`, `_getAllFunctions`, …) via casts — APIs with
  no stability guarantee, a maintenance hazard on every `@quereus/quereus` bump.

The decision to make: is seamless naive wiring worth taking on that duplication
and internal-API coupling, or is the current fail-fast-plus-documented-warm-up
contract the better long-term cost/benefit? If pursued, prefer asking the
Quereus maintainers for a **sanctioned mutex-free schema-snapshot API** (one that
`schema()` itself could share) over reaching into internals from this package.

## Acceptance (if pursued)

- Naive wiring (no out-of-band warm-up) drives a first transaction to commit
  without throwing and without deadlocking.
- The mutex-free hash is **provably identical** to the `schema()`-derived hash
  for a representative set of schemas (test-pinned), preserving cross-node
  consensus.
- No reliance on undocumented internals, or an explicit, reviewed decision to
  accept that coupling with a test guarding the exact internal surface used.
