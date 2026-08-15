----
description: Wrote down the five safety rules that a caching layer over the storage system will depend on, and corrected three places where the docs said something the code no longer does.
prereq:
files: packages/db-p2p/docs/storage.md, docs/architecture.md, docs/internals.md
difficulty: easy
----

# Storage invariants documented; three stale claims fixed — ready for review

Documentation-only change. No behavior touched, no tests to run (verified nothing outside `docs/` and `packages/db-p2p/docs/` changed — see `git diff --stat` below).

## What changed

### 1. New "Invariants" section in `packages/db-p2p/docs/storage.md`

Added right after the Architecture Overview, before "Core Components". Five entries, each with the rule, the enforcing code site, and what breaks on violation:

1. **Every write goes through `IRawStorage`** — quotes the "single choke point" comment at `packages/db-p2p/src/storage/kv-raw-storage.ts:47-56`. Explicitly scoped to *this process* — its real boundary is invariant 5, said outright so a reader doesn't take it as a guarantee against outside mutation.
2. **Every out-of-band writer of `meta.latest` serializes on the per-block commit latch** — quotes `storage-repo.ts:21-27` (`commitLatchKey`) and `:29-46` (`withBlockCommitLatch`). Carries forward the one deliberate exception I found by reading around the cited lines: `InvalidationContext.withBlockCommitLatch` (`dispute/invalidation.ts:481-490`) and `CollectionEnv.withBlockCommitLatch` (`dispute/cascade.ts:43-49`) are both *optional* — when a host doesn't supply the latch runner (unit tests, non-`StorageRepo` hosts), the compensating write runs unlatched. That's fine only because such a host has no concurrent `StorageRepo.commit` to race.
3. **Committed revisions are append-only; `latest` never advances past a materializable revision** — this one was already well documented, so it's a cross-link to `docs/correctness.md:46`/`:440` and `docs/internals.md`'s "Key Invariants" (`:358`, `:378`), not a restatement.
4. **`promotePendingTransaction` is a cross-store atomic move, not a copy** — also cross-linked (this file's "Shared KV Kernel" section, and Invariant P in `docs/repository.md:89-114`), with the per-backend mechanism (rename / batch / DB transaction) kept explicit rather than flattened into one claim.
5. **A store is owned by exactly one process** — the one that was written down nowhere before this. States plainly that it's enforced by convention only (every deployment happens to wire one store per node), not by code, and spells out the consequence: a second writer over the same path/keyspace makes any in-process cache built on invariant 1 serve stale data, potentially into a consensus decision. Ends with a "for embedders" line: one `IRawStorage` instance per path per process, never two stores over the same location even transiently.

### 2. Three stale claims corrected, verified against code

- `docs/internals.md:356` — "`blockId` = content-addressed ID (base64url)" was simply wrong. `transactor-source.ts:36` generates it from `randomBytes(32)`. Fixed to say it's random, not a content hash, matching what `docs/internals.md:471` and `docs/architecture.md` already said elsewhere (the doc was contradicting itself).
- `docs/architecture.md:67` and `:330` — "revisions are immutable **and content-addressed**". Immutable is true; content-addressed is not. A revision maps to an `ActionId`, and on the plain `Collection.sync` path that's `randomBytes(16)` (`packages/db-core/src/collection/collection.ts:502`, not `:489-490` as the ticket's line numbers suggested — code has moved slightly). Only the coordinator-level `transaction.id` is content-addressed. Fixed both occurrences (table entry + glossary entry) to say so.
- `packages/db-p2p/docs/storage.md:16`/`:22-24` — claimed four persistent backends "still implement `IRawStorage` directly... migrated onto drivers one at a time". **This was more stale than the ticket described**: I checked all five backend packages (`db-p2p` memory, `db-p2p-storage-fs`, `-web`, `-rn`, `-ns`) and every one of them now `extends KvRawStorage` — the migration is *complete*, not in progress. Rewrote the architecture diagram, the "File-based Storage" section, and the "Shared KV Kernel" section's closing paragraph accordingly. Only a test double (`CrashingRawStorage` in `db-p2p/test/mid-ddl-crash.spec.ts`) implements `IRawStorage` directly today.

### Sweep scope (what I checked beyond the three flagged claims)

Read the whole of `packages/db-p2p/docs/storage.md` end to end against the current code, and the storage-relevant parts of `docs/internals.md` (the "Key Invariants" section at `:353-528` and the "Mutation Contracts" / clone-table section at `:328-351`). Also grepped the whole repo for `content-addressed` to check for other instances of the same confusion — the only other hits were either correct already (`docs/internals.md:471`, explicitly says block ids are "random, not content-addressed") or are system-level taglines (`docs/architecture.md:3`, `:9`) that are loosely true at the system level (header blocks and `transaction.id` really are content-addressed) and weren't flagged by the ticket — left those alone rather than widen scope into a judgment call about marketing copy.

Did **not** find additional stale claims beyond the three the ticket named and the deeper-than-expected migration-status one above.

## Known gaps / not done here (by design — see ticket)

- **Consumer-side note not carried over.** The ticket flagged that invariant 5 also needs a sentence in the sibling checkout `../sereus` — its `docs/architecture.md` Storage Layer diagram, and the `RawStorageProvider` type doc in `packages/cadre-core/src/types.ts`. That checkout is a separate repo; per the ticket's explicit instruction I did not touch it. **Someone needs to carry this over by hand**: point them at invariant 5 in `packages/db-p2p/docs/storage.md` (the "for embedders" paragraph is written to be liftable almost as-is) and at the `RawStorageProvider` type.
- **No new row added to `docs/internals.md:328-351`'s clone/mutation tables** for a future cache wrapper — the ticket explicitly asked to defer this to whoever builds the cache (`coherent-raw-storage-cache`, which lists this ticket as a prereq), not to add it speculatively now.
- **Not a tripwire, not a ticket** — the "deliberate exception" in invariant 2 (unlatched writes when no `StorageRepo` host is present) is existing, already-accepted behavior with its own comment at the code site (`dispute/invalidation.ts:487`, `dispute/cascade.ts:47`); I only surfaced it in the doc, I didn't touch the code or add a new NOTE.

## How to verify

Doc-only diff — read it. Sanity checks a reviewer can spot-check without reading the whole repo:

- `packages/db-p2p/src/storage/kv-raw-storage.ts:47-56` — quoted comment text matches.
- `packages/db-p2p/src/storage/storage-repo.ts:21-46` — quoted comment text matches; `withBlockCommitLatch` and `commitLatchKey` docstrings.
- `packages/db-p2p/src/dispute/invalidation.ts:481-490`, `packages/db-p2p/src/dispute/cascade.ts:43-49` — the optional-latch-runner exception.
- `grep -rn "extends KvRawStorage" packages/*/src` — five hits (memory, fs, web/indexeddb, rn/leveldb, ns/sqlite), zero direct `implements IRawStorage` outside the one test double — backs the rewritten migration-status claim.
- `packages/db-core/src/transactor/transactor-source.ts:34-37` and `packages/db-core/src/collection/collection.ts:501-503` — back the blockId/actionId randomness claims.

```
$ git diff --stat
 docs/architecture.md            |   4 +-
 docs/internals.md               |   2 +-
 packages/db-p2p/docs/storage.md | 126 ++++++++++++++++++++++++++++++++++++----
 3 files changed, 117 insertions(+), 15 deletions(-)
```
