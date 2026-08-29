description: When two machines end up with different copies of the same stored collection, nothing anywhere notices or says so — the code that refreshes a copy from storage only ever compares counters, and two disagreeing copies each count correctly. Give the refresh a way to spot and report that its own copy and the stored one have diverged.
files:
  - packages/db-core/src/collection/collection.ts (advanceContext ~192, reportShortfall ~209, updateInternal ~267)
  - packages/db-core/src/log/log.ts (getFrom ~172 — the revision filter that makes a fork permanent)
  - packages/db-core/test/two-handle-collection-fork.spec.ts (landed this pass — the negative control)
  - packages/db-core/test/collection.spec.ts (~1349 — existing shortfall-diagnostic tests to extend)
difficulty: hard
----

# Make a refresh able to say "my copy and the stored copy disagree"

## What was established this pass (white-box, in this repo)

`fix/bug-index-subcollection-forks-and-never-merges` asked three things. Answers first,
evidence below.

**1. The two-handle reconciliation path in `db-core` is sound.** A new spec,
`packages/db-core/test/two-handle-collection-fork.spec.ts`, drives two independent
`Collection` handles (each with its own tracker, read cache and action context — exactly
what two machines have) over ONE shared `TestTransactor` against ONE collection id. Five
cases: the collection invented by both handles at once and the collection seeded to a
committed revision first; sequential syncs and `Promise.all` concurrent syncs; a
single-block tree and a fan-out-4 tree deep enough that the two writers land in different
leaf blocks while still sharing header, root and log tail. Every case converges — same
entries, same revision, same action id, no lost write. **So `Collection.update()` →
`Log.getFrom` → replay does not lose a sibling's write at this level.** That spec stays in
the tree as the negative control; it runs in ~15 ms.

**2. The refresh diagnostic cannot fire on a fork.** `Collection.reportShortfall`
(collection.ts ~209) compares `tailRev` — read by `bootstrapContext` off the tail block
that *this collection's own header* names — against where the chain walk landed. Both
numbers come from **the same chain**. A forked replica is internally self-consistent: its
tail claims exactly what its own walk reaches, so `after >= tailRev` and the line stays
silent. The existing test for it (collection.spec.ts ~1400, `inflatedTailTransactor`) has
to *artificially inflate* the tail's claimed revision to make it fire — that is the shape
of a **lagging** refresh, not a forked one. So the diagnostic the fix ticket hoped would
fire on all 111 of those reads structurally cannot. That is the reason the divergence went
unseen, and it is finding #1.

**3. A fork, once created, can never merge — by construction.** `Log.getFrom(startRev)`
returns only entries with `entry.rev > startRev`. Revision numbers are per-collection
counters, not a shared ordering. So once two copies occupy the same revision number with
different actions, neither walk can ever surface the other's entry, and `update()` returns
normally having closed nothing. `advanceContext` (collection.ts ~192) compares only
`next.rev < current.rev` — **revision numbers, never action ids**. There is no code path
anywhere that compares "the action I hold at revision N" against "the action the log names
at revision N". That is finding #2, and it is the "never merges" half of the reported
symptom.

## A correction to the reporting ticket's context (matters for whoever implements this)

The deployment where this reproduces is running **LEGACY (no-coordinator) commit**, not
session mode. Two independent proofs:

- Every action id in the measurement (`-UzaWOQiXI12s6PU5PE5lA`, `fR1TfGRxHLN_Icl0ZK-XIw`,
  `vR5WcYtFvwoW2nYPa8BqCg`, `qpIlrfyFciQszMpLcVLSGA`, `8K0ee3vf3i7d4NoCtniNoQ`) is a bare
  22-character base64url token — 16 random bytes, the shape `Collection.syncInternal` mints
  (collection.ts ~592). Session mode records `transaction.id`, which
  `createTransactionId` (transaction/transaction.ts ~219) always prefixes `tx:`.
- On node `cREUdA` the main table's revision-2 action (`fR1…`) differs from the index's
  revision-2 action (`vR5…`). Under session mode `commitOnce` calls
  `recordCommitted(transaction.id)` for *every* participating collection, so one
  transaction stamps one id on both. Two different ids means two separate actions.

The plugin never wires session mode itself — `TransactionBridge.configureTransactionMode`
is called only from tests — so a host gets `commitDirtyTreesLegacy`, which flushes each
tree with its own `tree.sync()`, its own random action id, and its own independent race.

Two consequences for this work:

- A table and its index are **not** committed from a common base or as one unit in that
  deployment. Comparing a main-table action id against an index action id on the same node
  proves nothing. Only *same collection id, same revision, different action id, across
  nodes* is fork evidence — which is exactly what the reporting ticket's table shows, so
  its reasoning stands.
- Whether the plugin should self-wire session mode is a separate, unsettled question. Do
  not decide it here. `tickets/backlog/feat-optimystic-legacy-commit-two-phase.md` already
  touches `commitDirtyTreesLegacy`.

## What to build

One seam, two arms. Both live in `Collection`'s refresh path.

### Arm 1 — a boundary invariant at the reconciliation seam

`advanceContext` is the single point where a collection decides what committed state to
adopt. Today it can only refuse to go backwards. Give it the one comparison that can tell
the two failure modes apart:

> The action id I hold at revision N must equal the action id the log names at revision N.

The freshly-walked `ActionContext.committed` from `Log.getFrom` carries `{ actionId, rev }`
pairs, and the collection's own `source.actionContext.committed` carries its own — so the
comparison needs no new read and no network. Where the two lists name **different actions
at the same revision**, the local copy and the stored log are provably different lineages.

Report it distinctly from the existing `collection:context-not-lowered` and
`collection:context-short-of-tail` lines (a new tag such as
`collection:lineage-divergence`, naming the collection id, the revision, and both action
ids). **Log, do not throw** — for the same reason `reportShortfall` logs: `update()` is
called blanket-style over every registered collection between commit retries, and an abort
here would promote a diagnosis to production behaviour before anyone has seen the line fire
in the wild. Whether divergence should later become a hard failure is a follow-on decision,
not this ticket's.

Design note for the implementer: comparing whole `committed` lists is O(n) per refresh and
that list grows one entry per commit. The cheap, sufficient check is the entry at the
*current* revision — the one `committedActionId()` already looks up. Prefer that; do not
add an O(n·m) list diff to a path that runs on every read.

### Arm 2 — stop the shortfall line from reading as fork detection

`reportShortfall`'s doc comment currently reads as though a refresh that closes nothing
will say so. It only detects a refresh that lands *below a revision its own tail claimed* —
i.e. lag. Correct the comment to say plainly what it can and cannot see, and point at
Arm 1 for the divergence case. This is what stopped the last investigation from trusting
its own instrument; leaving the comment as-is invites the next reader to make the same
assumption.

## Tests

- Extend `packages/db-core/test/collection.spec.ts`'s
  `describe('a refresh that lands short of the tail it just read')` with a sibling
  `describe` for divergence: build a collection holding revision N under action X, arrange
  the log to name action Y at revision N, refresh, and assert the new line fires with both
  ids. The existing `inflatedTailTransactor` pattern in that file is the model — a wrapping
  `ITransactor` that rewrites one read is enough; no mesh is needed.
- Assert the healthy path stays silent. That matters more than the positive case: a
  divergence line on an ordinary refresh would be noise in every log this exists to be read
  in, which is the same standard the shortfall tests already hold themselves to.
- Do not modify `two-handle-collection-fork.spec.ts`'s assertions. It passes today and its
  value is that it keeps passing.

## Out of scope — say so, do not silently absorb

- **Do not attempt a seventh two-node reproduction.** Six failed;
  `tickets/blocked/secondary-index-repro-exhausted-upstream.md` puts that question to a
  human and it is still open.
- **Do not change commit-mode wiring**, `commitDirtyTreesLegacy`, or session-mode
  enablement. Different seam, unsettled design question, existing backlog ticket.
- **Do not make divergence throw.** Log first; let a real firing decide.

## Also landed this pass

A `NOTE:` at `collection.ts` `syncInternal`'s success branch, recording that its replay runs
*before* the cache fold and context bump — the inverse of the order `updateInternal` and
`TransactionCoordinator.commitOnce` both document as required. It is dormant: `act()` and
`syncInternal` share the collection latch, so the pending queue cannot grow during the
transact and the replay is always a no-op reset. The note names the condition under which
it would stop being dormant and what to do then. Nothing to action here.

## Validation

`yarn workspace @optimystic/db-core test` — 1431 passing, 0 failing at the point this
ticket was written (includes the 5 new cases). No pre-existing failures observed.

## TODO

- Read `advanceContext`, `reportShortfall` and `updateInternal` in
  `packages/db-core/src/collection/collection.ts` together; they are one decision split
  across three helpers.
- Add the same-revision/different-action comparison to the adopt path, using the entry at
  the current revision rather than a full list diff.
- Emit a distinct, greppable log line naming collection id, revision, held action id and
  log action id. Do not throw.
- Correct `reportShortfall`'s doc comment to state that it detects lag, not divergence, and
  cross-reference the new line.
- Add divergence tests to `collection.spec.ts` alongside the existing shortfall describe,
  including a healthy-path silence assertion.
- Update `docs/debugging.md` § "Which revision did a read descend?" with the new line and
  how an operator reads it against `commit:collections` / `index:seek`.
- Run `yarn workspace @optimystic/db-core test`; note in the review handoff that the
  downstream `sereus` reproducer is still switched off and this change is an instrument,
  not yet a fix for the divergence itself.
