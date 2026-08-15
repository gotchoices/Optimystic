description: Wrote down the five safety rules that a caching layer over the storage system will depend on, and corrected the places where the docs said something the code no longer does.
files: packages/db-p2p/docs/storage.md, docs/architecture.md, docs/internals.md
---

# Storage invariants documented; stale storage claims corrected — complete

Documentation-only change. Implemented in `f07e0ff`, reviewed and amended in this pass.

## What shipped

### New "Invariants" section in `packages/db-p2p/docs/storage.md`

Five entries, each stating the rule, its enforcing code site, and what breaks on violation:

1. **Every write goes through `IRawStorage`** — the "single choke point" comment in
   `packages/db-p2p/src/storage/kv-raw-storage.ts`. Explicitly scoped to *this process*; its real
   boundary is invariant 5.
2. **Every out-of-band writer of `meta.latest` serializes on the per-block commit latch** — the
   `commitLatchKey` / `withBlockCommitLatch` helpers in `storage-repo.ts`, plus the one deliberate
   exception: the dispute module's `withBlockCommitLatch` runner is *optional*
   (`dispute/invalidation.ts`, `dispute/cascade.ts`), so a host that supplies none writes unlatched.
   Safe only because such a host has no concurrent `StorageRepo.commit` to race.
3. **Committed revisions are append-only; `latest` never advances past a materializable revision** —
   cross-linked to the existing treatment in `docs/correctness.md` and `docs/internals.md`.
4. **`promotePendingTransaction` is a cross-store atomic move, not a copy** — cross-linked to
   Invariant P in `docs/repository.md`, with the per-backend primitive kept explicit.
5. **A store is owned by exactly one process** — previously written down nowhere. Enforced by
   convention only, not by code; a second writer over the same path makes any in-process cache built
   on invariant 1 serve stale data, potentially into a consensus decision. Carries a "for embedders"
   paragraph.

### Stale claims corrected

- `docs/internals.md` — "`blockId` = content-addressed ID" was wrong; it is `randomBytes(32)`. Fixed.
  The document had been contradicting itself, since another section already said so.
- `docs/architecture.md` (glossary table and glossary list) — "revisions are immutable **and
  content-addressed**". Immutable is true; content-addressed is not. Fixed both.
- `packages/db-p2p/docs/storage.md` — claimed four persistent backends "still implement `IRawStorage`
  directly... migrated onto drivers one at a time". The migration is in fact **complete**: all five
  shipping backends (memory, filesystem, IndexedDB, LevelDB, SQLite) extend `KvRawStorage`. The
  architecture diagram, "File-based Storage", and "Shared KV Kernel" sections were rewritten.

## Review findings

**Verification performed.** Every quoted comment and cited line in the diff was checked against the
code it names: `kv-raw-storage.ts` choke-point comment, `storage-repo.ts` `commitLatchKey` /
`withBlockCommitLatch` docstrings, the optional-latch-runner exception at both dispute sites, the
`MissingBaseRevisionError` refusal path, `randomBytes(32)` in `transactor-source.ts` and
`randomBytes(16)` in `collection.ts`, `FileRawStorage`'s line, and the `promote` implementation of
every driver (filesystem rename, IndexedDB readwrite transaction, LevelDB/SQLite batch, memory map
swap). The migration-complete claim was confirmed by grep: five `extends KvRawStorage`, and the only
direct `implements IRawStorage` outside the kernel is the `CrashingRawStorage` test double. **All
citations were accurate.** Doc-only diff; `yarn lint` clean, `@optimystic/db-p2p` tests 1601 passing
/ 44 pending / 0 failing.

**Major — one finding, filed as `bug-docs-claim-block-ids-are-content-hashes` (backlog).**
The implementer's sweep grepped for the phrase "content-addressed" and so missed the more damaging
instance, which uses different words: `docs/correctness.md` **Theorem 15 (Read-Path Integrity)**
proves forgery detection from the premise "Block IDs are content hashes", and concludes that content
integrity holds *unconditionally* with no trust in the serving peer. Block IDs are random 256-bit
values (header block IDs are the collection name verbatim), so the premise is false and the
conclusion does not hold — `docs/transactions.md` already says the opposite in plain terms, so the
two documents contradict each other today. This is a security claim a client author would act on,
which is why it is a ticket rather than an inline fix: correcting it means restating what the
read-path guarantee actually is (multi-peer byte comparison under honest majority, plus commit
signatures) and that is a judgment about a correctness proof, not a wording repair. The ticket covers
the whole class — the remaining "content-addressed" phrasing in `architecture.md`, `optimystic.md`,
and `db-core/docs/network.md` — rather than the single paragraph, so the documents land on one
formulation instead of drifting apart again.

**Minor — three findings, fixed inline in this pass** (`packages/db-p2p/docs/storage.md`):

- Invariant 3 cited `docs/correctness.md:46` for ordering guarantees. That line is the Block
  *definition*, and it carries the "cryptographic block ID" phrasing the ticket above is about.
  Replaced with section references (§6.3 "Ordering Guarantees", and the named bullets in
  `internals.md`'s Key Invariants), and the `storage-repo.ts:876-886` pointer with the symbol names
  `refuseMissingBase` / `MissingBaseRevisionError`.
- Invariant 4 said promote is "never a two-step copy-then-delete". `MemoryStoreDriver.promote` is
  literally a map set followed by a map delete. It is safe — no `await` between them, no durability
  to survive a crash — but the flat claim reads as false to anyone who opens that file. Added the
  exception with its reason.
- Invariant 5 used "strand" without definition. The term belongs to Sereus, a separate project, and
  is defined only in `docs/architecture.md`. Reworded to "the Sereus fabric layered over Optimystic,
  one store per trust domain".

**Already-claimed site — one finding, appended as an arm to `debt-doc-code-citations-rot-silently`
(backlog) rather than filed fresh.** The change introduces about a dozen new `file:line` citations
into prose, in a repo that already has an open ticket about exactly that rot. All of them are
currently accurate, and this review converted the three most fragile (the ones pointing into other
prose documents) to section-and-symbol form; the rest were left alone deliberately, because
converting a mixed set piecemeal yields a document with two conventions, and the convention decision
belongs to that ticket. The arm records that the citation count is growing fastest in the
invariant-describing documents, where a stale pointer misleads most.

**Tripwires — none newly recorded, deliberately.** The one conditional concern in the diff is
invariant 2's optional latch runner: if a non-`StorageRepo` host ever gains concurrent commits on the
same block, the unlatched compensating write becomes a real lost-update bug. That condition is
already stated in the new doc *and* at both code sites (`dispute/invalidation.ts`,
`dispute/cascade.ts` docstrings). Adding a fourth copy would spread one fact across four places.

**Correctness, resource cleanup, error handling, type safety, source hygiene — not applicable.** The
diff touches no code. `storage.md` is 415 lines after this pass, in a repo whose documents routinely
run past a thousand; the new section is scannable (one heading per invariant, consistent
rule / enforced-where / violate-it-and shape) and no split is warranted.

## Carried forward — needs a human

- **The consumer-side note in the sibling `sereus` checkout was not written.** Invariant 5 constrains
  embedders, and Sereus is the embedder. Two places there need a sentence: the Storage Layer diagram
  in its `docs/architecture.md`, and the `RawStorageProvider` type documentation in
  `packages/cadre-core/src/types.ts`. That is a separate repository, so this ticket did not touch it,
  per its own instruction. The "for embedders" paragraph in `packages/db-p2p/docs/storage.md`
  invariant 5 was written to be liftable nearly as-is.
- **No row was added to `docs/internals.md`'s clone/mutation tables for a future cache wrapper.**
  Deferred by design to `coherent-raw-storage-cache`, which names this ticket as a prerequisite.
