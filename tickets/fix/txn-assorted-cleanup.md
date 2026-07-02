description: A cluster of small correctness-and-tidiness issues in the transaction code: a set that should deduplicate peers doesn't, one component reaches into another's private internals in several places, some data is smuggled through escape-hatch casts instead of real typed fields, a dead deprecated code path lingers, and one lookup crashes on sparse results from certain backends.
files:
  - packages/db-core/src/transaction/coordinator.ts (gatherPhase PeerId Set ~lines 648-659; private Collection.source bracket access in ~5 places)
  - packages/db-core/src/transactor/network-transactor.ts (coordinatingBlockIds / recordCoordinator smuggled via as any, ~lines 434-455)
  - packages/db-core/src/transaction/context.ts (deprecated TransactionContext / commitTransaction path)
  - packages/db-core/src/transactor/transactor-source.ts (result[id]! sparse-result TypeError, ~lines 29-31)
difficulty: medium
----

# Assorted transaction-layer cleanliness and small correctness fixes

Four low-severity items grouped into one pass. Each is small; none warrants its own
ticket, but the last is a real crash on a live path.

## PeerId dedup by object identity

`gatherPhase` merges nominees into a `Set<PeerId>`, but each `PeerId` is a fresh
object from `peerIdFromString`, so identity-based `Set` dedup fails — duplicates flow
into every `PendRequest` (`coordinator.ts:648-659`). Key the set by `toString()`.

## Private-state pokes

The coordinator reaches into `Collection`'s private `source` via bracket access in
~five places, duplicating rev-bump logic. Expose a proper accessor/method and route
through it.

## Escape-hatch casts instead of typed members

`NetworkTransactor` smuggles `coordinatingBlockIds` and `recordCoordinator` through
`as any` (`network-transactor.ts:434-455`). Add the typed members to the relevant
interface so the casts disappear.

## Dead deprecated path

The deprecated `TransactionContext` / `commitTransaction` path (placeholder stamps,
the double-apply from tx-4) is unused by production callers. Delete or quarantine it.
Coordinate with tx-4 and tx-7, which also touch this seam.

## Sparse-result TypeError (real crash)

`TransactorSource.tryGet` does `result[id]!` (`transactor-source.ts:29-31`), which
TypeErrors on sparse results returned by non-Network transactors. Guard for the
missing key instead of asserting non-null.

## Expected behavior

Duplicate peers are collapsed, no component reaches into another's privates, no
runtime data rides on `as any`, the dead path is gone, and a sparse transactor result
is handled rather than crashing.

Severity: LOW (except the sparse-result crash, which is reachable now).
