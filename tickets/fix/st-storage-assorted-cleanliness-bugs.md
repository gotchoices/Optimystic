description: A cluster of small but real correctness and hygiene defects in the storage layer — code that reorders data belonging to its caller, stores a shared object without copying it, keeps metrics that are never updated, and treats "permission denied" the same as "nothing here."
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/storage/restoration-coordinator-v2.ts, packages/db-p2p/src/storage/arachnode-fret-adapter.ts, packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p-storage-fs/src/file-storage.ts
difficulty: medium
----

# Assorted storage-layer correctness and cleanliness defects

A group of small, independent defects found across the storage subsystem. They are filed
together because each is a localized fix; none warrants its own ticket, but several are genuine
correctness bugs, not just style.

- **In-place sort mutates caller state** (`storage-repo.ts:162-165`). `missing` is an alias of
  `context.committed`, and calling `.sort()` on it reorders the caller's shared request context
  in place. Copy before sorting so the caller's `committed` array is not mutated.

- **Missing clone violates the store's own invariant** (`memory-storage.ts:102-104`).
  `saveTransaction` stores the caller's object reference directly, without `structuredClone`,
  even though the memory store documents a clone-on-store invariant elsewhere. A later caller
  mutation would then corrupt stored state. Clone on store to match the documented contract.

- **Dead / leaky metrics** (`restoration-coordinator-v2.ts:23,188,196-203`). `failureByRing` is
  declared but never incremented (dead metric); there is a bare `console.log` where structured
  logging is expected; and `getMetrics` returns the internal `Map` instances directly, leaking
  shared mutable state to callers. Increment the metric where failures occur (or remove it),
  replace the bare log, and return copies from `getMetrics`.

- **`as any` pokes into internals** (`arachnode-fret-adapter.ts:59`, `ring-selector.ts:95`).
  One `as any` reaches into FRET internals; the other fabricates a fake PeerId. These are
  type-safety escape hatches over unstable internal shapes — tighten to a real interface or
  document why the cast is sound.

- **readdir swallows all errors as "no pendings"** (`file-storage.ts:72,79`).
  `listPendingTransactions` treats *any* readdir failure as an empty directory, so a transient
  `EACCES` (or other non-ENOENT error) silently reports "no pending transactions" and skips
  conflict detection during `pend`. It also regex-filters action ids such that a future id
  scheme would silently vanish from the listing. Map **only** `ENOENT` to empty and let other
  errors surface; loosen or document the id-scheme filter so a new id format is not silently
  dropped.

Expected behavior: after the fix, sorting `missing` leaves `context.committed` untouched; a
post-store caller mutation cannot alter memory-store state; restoration metrics reflect real
failures and `getMetrics` cannot be mutated through its return value; and
`listPendingTransactions` distinguishes "directory absent" (empty) from "could not read
directory" (surface the error).

## Reproduction notes

- Assert `context.committed` order/identity is preserved across a `get`/commit that sorts
  `missing`.
- Store an object in memory-storage, mutate the caller's reference, and assert the stored copy
  is unchanged.
- Point `listPendingTransactions` at a directory that errors with a non-ENOENT code and assert
  it does not report empty.

Suggested-fix hints are inline per bullet above; each is a small, self-contained change.
