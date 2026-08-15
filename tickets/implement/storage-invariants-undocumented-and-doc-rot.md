----
description: The rules that make the storage layer safe to build on are mostly only written in code comments, and one of them — that a stored dataset belongs to exactly one running program — is written nowhere at all. Three published statements about how storage works are also out of date and contradict each other. Write the rules down and correct the stale text.
prereq:
files: packages/db-p2p/docs/storage.md, docs/internals.md, docs/architecture.md, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p-storage-fs/src/file-storage.ts
difficulty: easy
----

# Write down the storage invariants, and fix three stale doc claims

## Why now

A caching layer over `IRawStorage` is being designed (`coherent-raw-storage-cache`, which lists
this ticket as a prereq). Its correctness rests on five properties of the storage layer. An audit
found that only one of the five is properly documented, and the single most load-bearing one is
documented nowhere. Anything built on unwritten rules is one refactor away from silently breaking.

This ticket is documentation only. No behaviour changes.

## The five invariants and where they stand

| # | Invariant | Status |
|---|---|---|
| 1 | Every write to a store goes through `IRawStorage`; nothing mutates the backend behind it | comment-only — `packages/db-p2p/src/storage/kv-raw-storage.ts:47-56` ("the single choke point") |
| 2 | Every out-of-band writer of a block's `meta.latest` serializes on the per-block commit latch | comment-only — `packages/db-p2p/src/storage/storage-repo.ts:21-27`, `:29-46`. Docs mention the latch in passing (`docs/internals.md:494-498`, `docs/repository.md:155`) but never state the obligation |
| 3 | Committed revisions are append-only; `latest` never advances past a materializable revision | **documented well** — `docs/correctness.md:46`, `:440`, `docs/internals.md:358`, `:378` |
| 4 | `promotePendingTransaction` is a cross-store atomic *move*, not a copy | **documented well** — `packages/db-p2p/docs/storage.md:89-90` and the Invariant P section at `docs/repository.md:89-114` |
| 5 | **A store is owned by exactly one process** | **nowhere, in this repo or in consuming repos** |

Invariant 4's treatment is the model: it states the rule, names the mechanism per backend, and says
what breaks without it. Bring 1, 2 and 5 up to that standard.

Invariant 5 is the one that matters most, because it is currently true only by accident. Consumers
wire one store per node (and, in Sereus, one per strand besides), so nothing shares a directory
today — but nothing anywhere says it must not, and a future host embedding two nodes over one
path would violate it with no warning. Say it plainly, and say what breaks: a second writer makes
any in-process cache of that store's contents serve stale data into consensus decisions.

## Work

**Add an "Invariants" section to `packages/db-p2p/docs/storage.md`** with one entry per invariant
above — the rule, the code site that enforces it, and the consequence of violating it. Lift the
wording for 1 and 2 from the code comments cited above rather than paraphrasing; those comments are
already good. Cross-link 3 and 4 to their existing homes instead of restating them.

**Fix three stale claims.** Each was verified against the code:

1. `docs/internals.md:356` — "`blockId` = content-addressed ID (base64url), immutable". Block ids
   are **not** content hashes: `transactor-source.ts:34-37` generates them from `randomBytes(32)`,
   and `docs/architecture.md:67` and `:330` already say so. This line sits under a "Key Invariants"
   heading, which is exactly where a reader goes for trustworthy facts.
2. `docs/architecture.md:67` and `:330` — revisions described as "immutable and content-addressed".
   Immutable, yes. Content-addressed, no: a revision maps to an `ActionId`, which on the plain
   `Collection.sync` path is `randomBytes(16)` (`packages/db-core/src/collection/collection.ts:489-490`).
   Only the coordinator-level `transaction.id` is content-addressed (`docs/transactions.md:304`).
   The distinction matters to anyone reasoning about cacheability or deduplication.
3. `packages/db-p2p/docs/storage.md:16` and `:22-24` — "the four persistent backends still implement
   `IRawStorage` directly (as `FileRawStorage` does today) and are being migrated onto drivers one
   at a time". `FileRawStorage extends KvRawStorage` now
   (`packages/db-p2p-storage-fs/src/file-storage.ts:411`). Not cosmetic: it determines where a cache
   can hook and whether encoded byte sizes are available for free.

**Consumer-side note.** Invariant 5 also needs one sentence where embedders wire storage: in the
sibling checkout `../sereus`, at `docs/architecture.md`'s Storage Layer diagram and on the
`RawStorageProvider` type documentation in `packages/cadre-core/src/types.ts`. That checkout is not
this repo — do not edit it. Instead, name it in the handoff so a person can carry it over, and state
the invariant in this repo's docs in terms an embedder can act on.

## Edge cases & interactions

- **Don't overstate invariant 1.** It holds for writes issued *in this process*. Its real boundary
  is invariant 5 — say so, or a reader will take it as a guarantee against all outside mutation.
- **Invariant 2 has known deliberate exceptions** — read the surrounding comments at
  `storage-repo.ts:21-46` before writing, and carry any documented exception across rather than
  flattening the rule.
- **Backend variation.** Invariant 4's atomicity is satisfied differently per backend (rename,
  batch, two-map swap). Keep that per-backend framing; a single mechanism claim would be wrong.
- **Check for further rot in the same neighbourhood.** These three were found while auditing for a
  specific design. Read the whole of `packages/db-p2p/docs/storage.md` and the storage sections of
  `docs/internals.md` against the code, and fix what else is stale — but say in the handoff what
  you checked, so the next reader knows the scope of the sweep.
- **`docs/internals.md:328-351` carries clone/mutation tables** covering each storage implementation.
  A future cache wrapper will need a row there; note that in the handoff rather than adding it now.

## Done when

Someone designing a layer over `IRawStorage` can find all five invariants from the storage doc,
with their enforcing code sites, and nothing in the storage documentation contradicts the code or
another doc.
