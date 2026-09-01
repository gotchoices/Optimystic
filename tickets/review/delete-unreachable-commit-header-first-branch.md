description: Removed dead code that would have committed a new collection's header block before everything else — it could never actually run — and updated the comments and one test that still described it as live.
files:
  - packages/db-core/src/transactor/network-transactor.ts:682-745 (`commit` — header-first branch deleted, NOTE deleted, sweep comment simplified)
  - packages/db-core/src/transactor/transactor-source.ts:126-146 (`transact` — `headerId` jsdoc rewritten to metadata-only)
  - packages/db-core/src/network/struct.ts:127-135 (`CommitRequest.headerId`/`tailId` doc comments rewritten)
  - packages/db-core/test/commit-digest-threading.spec.ts:148-172 (`carries the header and tail digests on their own single-block batches` rebuilt around a realistic request shape)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts:44-60,83-86 (two stale comments updated; filter logic unchanged)
  - docs/internals.md:622-627 (header-first parenthetical dropped)
  - packages/db-p2p/src/dispute/dispute-service.ts:534 (confirmed unchanged; fallback chain still reads correctly)
----

# What changed

`NetworkTransactor.commit` (`packages/db-core/src/transactor/network-transactor.ts`) used to have
a branch that committed a new collection's header block first, guarded by `request.headerId &&
!request.blockIds.includes(request.headerId)`. A prior investigation (`tickets/backlog/debt-commit-header-first-branch-is-unreachable`,
now resolved) measured this guard is always false in production — instrumented across every
db-p2p mesh test and db-core suite, 0 hits — because the only production caller that sets
`headerId` (`TransactorSource.transact`) sets it exactly when the header is a fresh insert, and an
inserted id is always already in `blockIds`. So in production the header always committed inside
the ordinary sweep (after the tail), and the header-first branch was dead code exercised only by
two hand-built test requests.

This ticket deletes that branch and its associated NOTE, and brings every comment/doc/test that
described the header-first step as live in line with what the code actually does:

- **`network-transactor.ts` `commit()`**: header-first `if` block and its leading comment deleted.
  The long investigation NOTE above the sweep deleted (it had done its job — the ticket it pointed
  at is now resolved). Sweep comment simplified to state plainly that the tail is the only
  exclusion.
- **`struct.ts`**: `CommitRequest.headerId` doc comment rewritten — it's collection-identifying
  metadata (present only on a create), not an ordering signal. `tailId` doc comment simplified to
  drop the "since the header-first step never fires" hedge; it's unconditionally first.
- **`transactor-source.ts`**: `transact()`'s `headerId` jsdoc rewritten to drop the "meant to order
  the create race" and "wire it up or drop it" framing (decided: kept as metadata, forwarding logic
  unchanged — `isNew ? headerId : undefined`).
- **`commit-digest-threading.spec.ts`**: the single-block-batches test previously built its request
  with `headerId` deliberately held OUT of `blockIds` (the exact shape that exercised the deleted
  branch — production never builds a request shaped that way). Rebuilt with the header included in
  `blockIds` (`blockIds: [tail, header, b2]`). It still proves the thing worth proving: header and
  tail both route to peer-A but land as two separate single-block commits — the tail always commits
  first via its own dedicated call, and the header lands in its own per-peer batch during the sweep
  because b2 (the other swept block) routes to a different peer.
- **`concurrent-diary-append-acknowledgement.spec.ts`**: two comments (one in the file-level
  docstring, one at the `kept` filter) described `NetworkTransactor.commit` as committing the
  header first "when it is not itself in blockIds." Both rewritten to describe the actual
  tail-then-sweep order. The `kept` filter itself (`id === tailId || id === headerId`) is
  unchanged — production headers are always already in `blockIds`, so the `headerId` clause was
  cosmetic even before this deletion, not dead weight worth removing.
- **`docs/internals.md`**: dropped the parenthetical in the retry-consumes-own-log-entry section
  that caveated "header-first step too, but that branch is unreachable" — the branch no longer
  exists, so the surrounding claim ("tail committed BEFORE sweeping") needs no caveat.
- **`dispute-service.ts:534`**: no code change. Confirmed `commit.headerId ?? coordinatingBlockIds?.[0]
  ?? blockIds[0]!` still reads correctly: `headerId` is still populated the same way (only on a
  create) and still names the collection for dispute reporting.

# Validation

- `packages/db-core`: `yarn build` clean, `yarn test` → **1546 passing**.
- `packages/db-p2p`: `yarn build` clean, `yarn test` → **2489 passing, 49 pending** (pending count
  is pre-existing `.skip`s unrelated to this change — not introduced or touched here).
- No new tests added: this is a pure deletion + comment/doc accuracy pass, with one existing test
  reshaped to stop exercising the deleted branch while preserving the real per-block-batching
  behavior it was actually covering.

# What a reviewer should look at

- Confirm the deleted header-first branch really is unreachable in production — the claim rests on
  `TransactorSource.transact` (`transactor-source.ts:152-161`) always forwarding `headerId` only
  for a fresh insert (`isNew = transform.inserts && Object.hasOwn(transform.inserts, headerId)`),
  which guarantees `headerId` is in `pendResult.blockIds` whenever it's forwarded. This ticket did
  not re-run the instrumentation; it trusted the prior investigation's measurement recorded in the
  now-superseded backlog ticket. Worth a second look if there's any other production caller of
  `NetworkTransactor.commit` this didn't account for (only `TransactorSource` and hand-built test
  requests were found).
- The rebuilt `commit-digest-threading.spec.ts` test relies on the fixture's fixed routing table
  (`setup()`'s `net.route(...)` calls) — header and tail both prefer peer-A, b2 prefers peer-C. If
  that shared fixture ever changes routing, the test's "two separate single-block batches" claim
  could silently stop being exercised (both would land in the same batch instead). No action
  needed now — flagging as a fixture-coupling tripwire, not a defect.
- Nothing else in the diff should be behavior-changing — this was scoped to dead code deletion and
  comment/doc accuracy. Worth a quick diff skim to confirm no stray logic change slipped in
  alongside the comment rewrites.
