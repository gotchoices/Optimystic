description: A storage node used to refuse to serve a brand-new record that had been written but not yet finalised whenever the reader asked for it at a specific version. It now reports the missing finalised version as simply absent and serves the pending content over it, and "unreadable" keeps its narrower meaning.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, packages/db-core/test/transactor-source.spec.ts, docs/internals.md, docs/transactions.md
----

# Complete: serve a pending-only block over an absent committed base

## What shipped

A write lands in two steps: the node stores a **pending** record, then — once the cohort agrees —
**promotes** it into a committed revision. Between the two, a brand-new block has a pending record
and no committed revision at all.

`BlockStorage.getBlock` used to throw whenever it was handed a revision number for such a block.
`StorageRepo.get` caught that throw and reported the block `unavailable: 'unmaterializable'` —
"this node holds records proving the block exists and cannot reconstruct it" — which is the wrong
claim: nothing was being *failed* to reconstruct, there was simply no committed base.

`getBlock` now reports "no committed base here" as an **absent base** (`undefined`):

- `rev === undefined` → `undefined` (unchanged).
- `rev` named → attempt `ensureRevision` (a restore may still supply that revision from the
  network). Only `ensureRevision`'s **failure** is swallowed to `undefined`. `materializeBlock` sits
  deliberately outside the `try`, so revision records with no materialization under them still
  throw — that is genuine corruption and must keep reading as `unmaterializable`.

`StorageRepo.get`'s pending-overlay branch — previously dead code — now runs, applying the pending
transform over the absent base. Two arms were added to make it correct once reachable: a graceful
answer when a read-driven promotion refusal already deleted the very pending record being named, and
a flag when the overlay produces nothing over an absent base (a pending *update* with nothing to
apply itself to). A pending *delete* over a real committed base deliberately stays **unflagged** —
an intended tombstone is an authoritative absent.

`CoordinatorRepo.flagUnconfirmedAbsence` was fixed alongside: it tested "does this entry carry a real
answer?" as `!state.latest`, which only worked while content and committed revision moved together.
A pending-only block served through the overlay has content and no committed revision, so an
inconclusive cohort consult would have flagged a block the node positively holds — and
`NetworkTransactor.isAuthoritative` keys off that flag alone, so the batch would have burned its
retry budget re-asking peers for content it already had. The guard now also requires
`entry.block === undefined`.

`docs/internals.md` (the `unavailable` and `materializedRev` bullets) was updated to match.

## Review findings

### Verification performed

- **Read the implement diff first**, then the full current text of `block-storage.ts`,
  `storage-repo.ts` (`get`, `internalCommit`, `readCommitBase`, `refuseMissingBase`) and
  `coordinator-repo.ts` (`get`, `flagUnconfirmedAbsence`, `promoteCorroborated`).
- **Traced every other `getBlock(rev)` caller** for the throw→absent behaviour change:
  `dispute/cascade.ts:147` (already treats absent as a conservative "invalidate" — safe direction),
  `dispute/invalidation.ts:434` (already falls back to `{kind:'delete'}`), `storage-repo.ts:681-682`
  (only reached for recovered blocks, which have `latest` set), `storage-repo.ts:948`
  (`readCommitBase` returns early when `latest` is undefined). No caller depended on the throw.
- **Swept every `state.latest` read** across `packages/*/src` for the same content-vs-revision proxy
  bug the coordinator had. `flagUnconfirmedAbsence` was the only broken one; the implementer had
  already found and fixed it.
- **Ran the two mutation checks the implementer only reasoned about.** Both arms are genuinely
  guarded: disabling the refusal arm fails *"a promotion refusal on the context's OWN actionId…"*
  with `Error: Pending action p1 not found`; narrowing the flag condition back to
  `unavailable !== undefined` fails *"a pending UPDATE over an absent committed base…"* with
  `expected undefined to equal 'unmaterializable'`. Source restored and re-verified clean
  (`git diff` empty against the implement commit for that file before my own edits).
- **`yarn lint`** clean. **`yarn build`** clean. **`yarn test`** across the whole monorepo green:
  db-core 1358 passing, db-p2p 1556 passing / 44 pending, all other packages passing, 0 failing.
  No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.
- **`test:integration` was not run** — same reason the implementer gave (real TCP meshes, beyond a
  single agent run's wall-clock budget). Nothing in the diff is transport-shaped; the repo protocol
  carries these fields as plain JSON and is unchanged.

### Major — filed as a ticket

- **The premise of the ticket is not reachable from any production caller.**
  `ActionContext.actionId` — the field that asks a read to overlay a named pending change, and the
  only way into the branch this ticket revived — is **never set by any code in
  `packages/*/src`**. Every production site builds the context with `committed` + `rev` only
  (confirmed by an exhaustive sweep of all construction sites; the field is written only in test
  files, and `TransactorSource.tryGet` carries a matching `TODO` for the client half). So the
  "writer reads back its own not-yet-finalised change" story cannot happen today.
  The `getBlock` half of the fix is **not** affected — `CoordinatorRepo.promoteCorroborated` reads
  with `{committed, rev}` and no `actionId`, so it is live and the fix is real there.
  Filed **`tickets/blocked/repo-pending-overlay-has-no-producer.md`** (blocked, not backlog: the
  choice is wire-it-up versus delete-it, and that is a human's call).
  Carried into that ticket as its second arm: a **verified** defect in the same unreachable branch —
  a request that both proves a change committed and names it as the pending overlay gets a graceful
  per-block answer if promotion *refused*, but **throws `Pending action <id> not found` and fails the
  whole batch** if promotion *succeeded*. Reproduced with a scratch probe (not committed). Not a
  regression — identical before the implement commit.

### Minor — fixed in this pass

- **`TestTransactor` could not produce the shape the new docs claim it mirrors.**
  `docs/internals.md` now states that a pending-only insert answers with content and no
  `materializedRev`, and that "`TestTransactor` mirrors that". It did not: its `applyTransformSafe`
  bailed out with `if (!block) return undefined`, so an insert — which needs no base — was dropped
  and the double returned *no block at all* for exactly that read. Fixed in
  `test-transactor.ts:488` to apply the transform over an absent base (cloning both sides, matching
  the convention its own commit path already used). A pending *update* over an absent base still
  resolves to undefined, matching the real repo. Both suites re-run green.
- **The comment on the surviving `Pending action … not found` throw was factually wrong.** It said
  the throw only fires for a caller-contract violation ("the caller asserted a pending this repo
  never had"). It also fires when the read's own promotion just succeeded. Corrected at
  `storage-repo.ts:295`, pointing at the blocked ticket.
- **`docs/transactions.md` § "Unavailable reads" was left stale.** Its description of when a read is
  "indeterminate" still implied a block held only as a pending record was in that set. Added one
  bullet stating that a written-but-not-yet-committed block is an absence, not an indeterminacy, and
  that only an overlay producing nothing is flagged.

### Minor — test gaps closed in this pass

- **The production-reachable shape had no direct unit test.** A pending-only block read at a named
  revision with **no** `actionId` — precisely what `promoteCorroborated` issues — was covered only
  indirectly through the read-repair integration-style test. Added
  *"a pending-only block read at a named rev with NO actionId is a plain unflagged absent"* to
  `storage-repo.spec.ts`, pinning the unflagged absence, the empty `state`, and that the pending
  record survives the read.
- **The `materializedRev` → revision `0` fallback was documented but unpinned.** The implementer
  flagged this as the gap they would test next. Added
  *"records revision 0 for content served over an absent committed base"* to
  `transactor-source.spec.ts`, asserting the repo answer shape (content, no `materializedRev`, no
  `state.latest`) and that **both** sinks — `getReadDependencies()` and `getReadRevision()` — record
  `0`. This test is what forced the `TestTransactor` fix above.

### Considered and left alone

- **`isMissing = !localEntry?.state?.latest` in `CoordinatorRepo.get` (line 345).** A pending-only
  block served with content still triggers a cohort consult on every read. The implementer left this
  deliberately and flagged it. I agree: this node genuinely holds no committed revision, a cohort
  peer may, and if the consult corroborates one the refreshed read is strictly better. It costs
  round trips, not correctness — recorded as a tripwire below rather than changed.
- **The substituted read-repair test.** *"falls through to acquisition when no local promotion can
  reach the revision"* stopped asserting the `cluster-fetch:promote-unavailable` tag (that read is no
  longer a fault, so the tag is no longer emitted) and now pins the outcome, with a new sibling test
  wedging B's `latest` at an unmaterializable revision to keep the step-over covered. I traced the
  sibling test's path by hand — it does reach `promoteCorroborated` → flagged entry → tag → no abort
  — and it preserves the original intent.
- **`getBlock`'s comment density.** The new arm is ~8 lines of code under ~30 lines of comment, and
  the method is now 57 lines. Left as-is: it matches the surrounding file exactly (`setLatest`,
  `saveForwardRevision`, and `materializeBlock` all carry comparable blocks), and the comments are
  load-bearing invariants rather than narration. Extracting a helper would churn the diff without
  making anything clearer.
- **File sizes.** `storage-repo.ts` is 1004 lines and `storage-repo.spec.ts` 2274 (`wc -l`). Both are
  large but pre-existing; this ticket added 33 and 149 lines respectively. Not size-debt this ticket
  created, and no open ticket claims those files.
- **The `unavailable`-set-but-different-`actionId` conflation.** If a promotion refusal fires for
  action A and the caller separately names an action B this repo never had, the new arm returns a
  flagged entry rather than the contract-violation throw. Both still surface as a thrown error one
  layer up (`BlockUnavailableError` vs the raw message), so the cost is diagnostic sharpness only —
  not worth a ticket, and moot while the branch has no production caller.

### Tripwires parked

Index only — the analysis lives at each site.

- `block-storage.ts`, inside the `meta.latest === undefined` arm (parked by the implementer): a
  contextful read of a pending-only block still attempts a network restore before falling back to
  absent; short-circuit on empty ranges if pending-only read-backs ever show as hot.
- `coordinator-repo.ts:345` (`isMissing`) and the surrounding block already carry the reasoning for
  why a content-bearing pending-only block still consults the cohort; the extra round trip is the
  known cost. Recorded here rather than adding a redundant `NOTE:` next to the existing commentary.

### Nothing found in

Checked and clean, so recording explicitly rather than silently: resource cleanup (no new handles,
latches, or subscriptions — the only latch use in the diff is the pre-existing commit latch, and the
new `try` in `getBlock` holds none); type safety (the change *removed* the `meta.latest!` non-null
assertion; no new casts beyond the file's existing `as GetBlockResult`); error handling (the swallow
is narrowed to one call and logs what it swallowed); and concurrency (the diff adds no new shared
mutable state).
