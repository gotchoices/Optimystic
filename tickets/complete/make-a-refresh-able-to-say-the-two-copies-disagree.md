description: A refresh can now spot and log that its own copy of a collection and the stored one were built from different histories, which no existing diagnostic could see. Reviewed, corrected, and shipped.
files:
  - packages/db-core/src/collection/collection.ts (advanceContext — the lineage check; committedActionId — now reuses the shared lookup)
  - packages/db-core/src/collection/action.ts (new exported `actionIdAt` helper)
  - packages/db-core/test/collection.spec.ts (lineage describe, ~line 1505; log-capture helper hoisted to module scope)
  - docs/debugging.md (§ "Did the refresh itself fail to close the gap?")
  - docs/internals.md (§ monotonic context adoption)
----

# Complete: refresh reports "my copy and the stored copy disagree"

## What shipped

At the single point where a collection adopts a freshly-read committed state
(`Collection.advanceContext`), the code now compares the action id held at the collection's
current revision against the action id the freshly-read context names at that same revision.
Revision numbers are counted per collection, so two separately-built copies under one id can each
sit at the same revision under different actions while each stays internally self-consistent —
which is exactly why the existing `collection:context-short-of-tail` line could never see it.
A mismatch emits, on the `optimystic:db-core:collection` debug namespace:

```
collection:lineage-divergence id=<collection> rev=<n> held=<actionId> read=<actionId>
```

It logs and does not throw; adoption proceeds unchanged. Both values come from `ActionContext`
lists already in hand, so there is no extra read and no network traffic. The comparison is gated
on `log.enabled`.

`reportShortfall`'s doc comment now states plainly that it detects lag only, and cross-references
the new line. `docs/debugging.md` gained a section on reading the line; `docs/internals.md` gained
the corresponding invariant bullet.

## Review findings

Ran the implement-stage diff (`fb7f8273`) cold before reading its handoff. Lint (`yarn lint`),
`yarn typecheck` (all workspaces) and `yarn test` (all workspaces) pass — **1436 passing in
db-core, 0 failing; every other workspace green.** No pre-existing failures surfaced, so
`tickets/.pre-existing-error.md` was not written.

### Fixed in this pass (minor)

- **A documented claim about the code was false.** Both the code comment and `docs/debugging.md`
  asserted the line "only fires on a refresh" and that a freshly-opened handle "has nothing to
  disagree with". Not true: `attachToLog` calls the same `advanceContext`, and there the two sides
  come from genuinely different places — `bootstrapContext` adopts the tail block's
  `state.latest.actionId` on trust, while the read side is a walk of that tail's own chain. Open
  therefore *can* fire, and when it does it means storage is internally inconsistent about one
  revision rather than that some replica forked. That is a more alarming finding than the one the
  docs described, so the behaviour was kept and the docs corrected. Confirmed empirically by a new
  test (below), not by reading alone.
- **A silence hole was missing from the caveats.** A context read off a log only lists actions
  back to the most recent checkpoint, so a copy whose held revision predates that checkpoint has
  no entry on the read side and stays silent — meaning the further a copy has fallen behind, the
  more likely a real fork goes unreported. Neither the code comment nor the docs mentioned this;
  both now do, alongside the two holes that were already listed.
- **The revision lookup was written out three times.** `advanceContext` hand-rolled
  `committed.find(e => e.rev === r)?.actionId` twice, duplicating the body of `committedActionId`
  — including a long explanatory NOTE that then existed in one place while two copies of the code
  existed elsewhere. Extracted as an exported `actionIdAt(context, rev)` in `action.ts`, beside
  the `ActionContext` type it reads; all three sites now call it, and the "why undefined is
  legitimate" and "linear in `committed`" notes live once, on the helper.
- **The test file duplicated its log-capture helper byte-for-byte.** `captureCollectionLog`
  appeared identically in the shortfall describe and again in the new lineage describe. Hoisted to
  module scope; both describes use the one copy.
- **Comment-to-code ratio on `advanceContext` had drifted.** The new block restated the same
  point across two paragraphs. Merged, with no substance dropped.

### Test coverage added

The implementer's four tests were a reasonable floor — they cover the two healthy paths (which
matter most; a false positive would be noise in every log this line is meant to be read in), the
diverged refresh with full field parsing, and the per-discovery semantic. One gap was material
enough to close here:

- **`an OPEN whose tail state and log entries name different actions reports too`** — pins the
  open-path firing that the docs denied, and asserts the open still succeeds. It required
  splitting the test double's rewriting into two independently-armable sides (state metadata vs
  log entries), which the double now takes as an option.

### Checked and found clean (no action)

- **False positives.** Re-audited every writer of the held context against the log entry it
  produces: `syncInternal`'s inline bump uses the `actionId` it passed to `addActions` and only
  runs on the success branch (a stale failure never bumps); `bootstrapContext` copies the tail's
  own `state.latest.actionId`. Session mode was the case the handoff flagged as untested — read
  `coordinator.ts:339/384/619/636` against `:693` and confirmed both sides are literally
  `transaction.id`, including the partial-commit branch, which records only collections that
  durably committed. One lineage therefore cannot self-report. Verified statically rather than by
  test, because the identity is a single shared expression, not a behaviour.
- **The `log.enabled` gate.** Means no counter or metric hook exists, as the handoff noted. Left
  as-is: the line has no sink when the namespace is off, and this matches the convention every
  other diagnostic on this class follows.
- **Ordering against the `context-not-lowered` guard.** The lineage check runs first, so in
  principle a divergence is reported even on a read this collection then declines. Harmless and
  in practice unreachable: `next.rev` is the newest entry's revision, so `next.committed` cannot
  hold an entry above it. No change, no test — a test would pin an unreachable combination.
- **Resource cleanup and error paths.** The check does no I/O and cannot throw. The test helper
  restores `debug.log` and the previous namespaces in a `finally`.
- **`two-handle-collection-fork.spec.ts`**, the negative control, is untouched and still passes.

### Tripwire recorded (not a ticket)

Adoption resolves the *context* disagreement but not the *content* one: the instance's read caches
still hold blocks materialized under the old lineage, and since the revision does not change,
nothing re-reads them. This is genuinely conditional rather than a latent defect — no fork has
been reproduced at all (`tickets/blocked/secondary-index-repro-exhausted-upstream.md` is still
open), which is the whole reason this instrument exists. Parked as a `NOTE:` on `advanceContext`
in `collection.ts`, stating the revisit condition: if the line is ever seen firing in the field,
decide then whether a divergence should also drop the read cache and whether to keep re-reporting
per refresh. Both would be behaviour changes; this seam deliberately makes none.

### No major findings, and no new tickets

Nothing in the diff resolved to a wrong invariant, a missing type constraint, or a class of defect
needing its own ticket. The one behavioural question worth raising — per-discovery versus
per-refresh reporting, which the handoff offered as a scope call — is the tripwire above: it
cannot be answered before the line has fired once in the real world, so filing it now would queue
work no one can start.

### Nothing was declined

No accepted-tradeoff `NOTE:` at any touched site had a revisit condition that has tripped, so no
previously-declined finding was re-opened.

## Known limits (unchanged from implement, deliberately)

- This is an **instrument, not a fix**: nothing merges a fork, and the downstream reproducer that
  motivated the work remains switched off.
- Commit-mode wiring (`commitDirtyTreesLegacy`, session-mode enablement) is untouched;
  `tickets/backlog/feat-optimystic-legacy-commit-two-phase.md` owns that seam.
- Divergence logs rather than throws. Promoting it to a hard failure stays a follow-on decision
  after a real firing.
