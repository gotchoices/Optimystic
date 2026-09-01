description: Remove a piece of write-path code that was supposed to commit a new collection's header block before everything else, but can never actually run, and fix the several comments and one test that still act like it does.
files:
  - packages/db-core/src/transactor/network-transactor.ts:682-775 (`commit` — header-first branch, its NOTE, and the sweep filter comment)
  - packages/db-core/src/transactor/transactor-source.ts:126-170 (`transact` — `headerId` jsdoc, still-conditional forwarding)
  - packages/db-core/src/network/struct.ts:127-136 (`CommitRequest.headerId` / `tailId` doc comments)
  - packages/db-core/test/commit-digest-threading.spec.ts:148-171 (`carries the header and tail digests on their own single-block batches` — built on a shape production never produces)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts:83-86 (comment describing the now-removed behavior)
  - docs/internals.md:622-633 (the retry-consumes-own-log-entry section's parenthetical about the header-first step)
  - packages/db-p2p/src/dispute/dispute-service.ts:534 (uses `commit.headerId` as a collection-id fallback — confirm still correct, no behavior change expected)
difficulty: easy
----

# Decision made: the header-first branch is dead weight, not a missing feature

`tickets/backlog/debt-commit-header-first-branch-is-unreachable` asked whether
`NetworkTransactor.commit`'s header-first step (commit the collection's header block before the
log tail, guarded by `request.headerId && !request.blockIds.includes(request.headerId)`) was
supposed to run during collection creation, or was dead. It was measured unreachable: the only
production caller that sets `headerId` (`TransactorSource.transact`) sets it exactly when the
header is a fresh insert, and an inserted id is always already in `blockIds` — so the guard is
always false in production, and the header commits inside the ordinary sweep (after the tail)
like any other touched block.

**Decision: delete it.** Reasons:

- The ordering that actually runs — tail, then everything else — is the one
  `Collection.bootstrapContext` depends on and every test exercises. There is no live create-race
  scenario left for a header-first step to resolve; `tailId` ordering already resolves the
  create race (two writers racing to create the same collection both try to append the same first
  tail entry, and the loser's stale-revision check catches it there).
- `headerId` is not dead as a *field* — `db-p2p`'s `dispute-service.ts:534` reads
  `commit.headerId` as a fallback way to identify which collection a commit belongs to when
  reporting a dispute. Keep the field; it is genuinely useful as collection-identifying metadata.
  Just stop describing it as an ordering signal.
- All three comments this ticket's predecessor flagged (`struct.ts`, `transactor-source.ts`, the
  NOTE in `network-transactor.ts`) were already rewritten during investigation to describe the
  unreachability accurately and point at this decision — so this ticket is really "delete the
  vestigial branch and the now-resolved NOTE," not "diagnose and then decide."

## What to change

- **`network-transactor.ts` `commit()`**: delete the header-first `if` block (the one guarded by
  `request.headerId && !request.blockIds.includes(request.headerId)`) and its leading comment.
  Delete the long NOTE above the sweep that explains the measurement and links this ticket — the
  measurement is now acted on, so the NOTE has done its job. Simplify the sweep's remaining
  comment: the tail is still the only exclusion from the sweep (`remainingBlocks = blockIds.filter
  (bid => bid !== tailId)`), so say that plainly instead of explaining why a removed second filter
  clause was unsatisfiable.
- **`struct.ts`**: rewrite `CommitRequest.headerId`'s doc comment. It is no longer "nominally
  commit first" — it is collection-identifying metadata, present only when the commit is creating
  the collection, consumed by dispute reporting (`dispute-service.ts`) to name the collection.
  Simplify `tailId`'s doc comment to drop the "since the header-first step never fires" hedge —
  the tail is unconditionally the first block committed, full stop.
- **`transactor-source.ts` `transact()`**: rewrite the `headerId` jsdoc parameter description —
  drop "meant to order the create-the-collection race" (that never happened) and "wire it up or
  drop it" (decided: kept as metadata). State plainly: forwarded to the commit only when the
  header is a fresh insert, so the collection-identifying metadata is present on the commit that
  creates it. The `isNew ? headerId : undefined` forwarding logic itself does not change.
- **`commit-digest-threading.spec.ts`**: the `'carries the header and tail digests on their own
  single-block batches'` test deliberately holds `headerId` out of `blockIds` to exercise the
  branch being deleted — production never builds a request shaped that way. Rewrite it (or fold
  its assertions into the neighboring `'gives each peer only the digests for the blocks in its own
  batch'` test) so it commits a realistic request: header included in `blockIds`, still routed to
  its own single-block batch by the existing per-block batching, and still carrying its own digest
  under `blockDigests`. Confirm both tests still exercise "header and tail each land in their own
  batch even when routed to the same peer" — that per-block batching behavior is real and worth
  keeping covered.
- **`concurrent-diary-append-acknowledgement.spec.ts`**: update the comment at lines 83-86 — it
  currently says a header not in `blockIds` "still commits, because the inner transactor commits
  it first from `request.headerId`." That inner behavior is gone; the `kept` filter's `id ===
  request.headerId` clause is now simply redundant with the always-true "header is already in
  blockIds" fact. Simplify the comment (and the filter, if it reads better without the dead
  clause) accordingly. Confirm the test's actual behavior doesn't change — production headers were
  always already in `blockIds`, so this was cosmetic even before the deletion.
- **`docs/internals.md:622-633`**: the retry-consumes-own-log-entry section's parenthetical
  ("It has a header-first step too, but that branch is unreachable...") describes a branch that
  will no longer exist. Drop the parenthetical; the surrounding claim ("commits the log tail
  BEFORE sweeping the remaining blocks") stays true and now needs no caveat.
- **`dispute-service.ts:534`**: no code change expected — just confirm after the other edits that
  `commit.headerId` is still populated the same way (only on a create) and the fallback chain
  (`commit.headerId ?? record.message.coordinatingBlockIds?.[0] ?? commit.blockIds[0]!`) still
  reads correctly against the updated `struct.ts` doc comment.

## Tasks

- Delete the header-first branch and its NOTE in `network-transactor.ts`; simplify the sweep
  comment.
- Rewrite the `headerId`/`tailId` doc comments in `struct.ts` and the `headerId` jsdoc in
  `transactor-source.ts` to describe metadata-only status, no ordering claim.
- Rebuild `commit-digest-threading.spec.ts`'s header/tail single-batch test around a realistic
  request shape (header inside `blockIds`); keep the per-block-batching assertion it was actually
  covering.
- Update the stale comment (and optionally the now-redundant filter clause) in
  `concurrent-diary-append-acknowledgement.spec.ts`.
- Drop the header-first parenthetical in `docs/internals.md:622-633`.
- Run `db-core` and `db-p2p` test suites; confirm green.
