description: A cluster member used to permanently record an agreed transaction as "done" before actually doing the work, so a temporary error made it skip that transaction forever on retry; it now records "done" only after the work succeeds.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-repo.spec.ts, docs/internals.md
difficulty: medium
----

# Complete: persistent "executed" marker now written only after apply succeeds

## What was wrong

In `handleConsensus` (`cluster/cluster-repo.ts`), a consensus-approved transaction was
recorded as executed **before** its operations were applied, in two places: the in-memory
guard (`executedTransactions.set`) and the durable marker (`stateStore.markExecuted`,
fire-and-forget). The apply loop ran afterward; its catch block rolled back **only** the
in-memory marker. The durable marker stayed (the state-store interface has no
`unmarkExecuted`), so a redelivery of the same consensus record found the durable marker
and short-circuited — silently dropping the operation on that member forever. A transient
apply fault, a propagated genuine commit fault, and a process crash mid-apply all hit this.

## What changed

Single-move fix, **no interface change**: the durable `markExecuted(...)` call moved from
before the apply loop to after it completes without throwing (`cluster-repo.ts:835-846`).
The eager in-memory `set` (line 819) and the catch-block `delete` (line 831) are unchanged
— the in-memory guard provides the synchronous check-and-set that closes the concurrent
apply-window race and must stay eager. Stale placement comments (the `@pitfall` block and
the inline comment above the in-memory `set`) were reworded to match.

Safety of the post-apply ordering (including the crash window between "apply succeeded" and
"durable write landed"): re-applying an already-applied consensus transaction is idempotent
— the "ahead" divergence path in `applyConsensusOperation` tolerates it as a no-op — so the
window converges rather than dropping.

New tests in `test/cluster-repo.spec.ts` under `describe('duplicate execution prevention')`:
the core reproduction (durable marker absent when apply throws; redelivery re-runs the
dropped op) and a same-hash double-delivery guard.

## Review findings

Reviewed the implement diff (581f03f) with fresh eyes before the handoff summary, then
scrutinized the fix, tests, and touched/should-have-touched docs.

**Validation run (required):**
- `yarn workspace @optimystic/db-p2p test` → **1127 passing, 36 pending, 0 failing** (56s).
- `yarn workspace @optimystic/db-p2p build` → clean, EXIT=0 (tsconfig includes `test/`, so
  the spec is type-checked).

**Correctness — checked, sound.** The fix is a clean move of `markExecuted` from
before→after the apply loop with no interface change. Traced the two apply-failure paths
(thrown transient fault; propagated `success:false`-bare-`reason` commit fault) — both
reach the catch, which now has nothing durable to roll back. No regression: the persisted
`executedAt` timestamp is captured pre-apply (line 818) exactly as it was under the old
eager write, so `pruneExecuted`'s timestamp-based pruning
(`persistent-transaction-state-store.ts:80`) sees identical semantics.

**Test coverage — one overclaim, fixed nothing (noted).** The second new test, *"a second
in-flight consensus delivery for the same hash does not double-apply"*, is weaker than its
name: `update()` serializes per-messageHash (`cluster-repo.ts:243-249` — a second call
`await`s the first's `pendingUpdates` promise before creating its own), so the two
"concurrent" deliveries do **not** actually race at the `handleConsensus` async check — the
second runs only after the first fully completes and hits the durable/in-memory dedup. The
test therefore validates serialization + dedup, **not** the concurrent-apply-window race
that the eager in-memory `has`-guard exists to close; that guard remains defense-in-depth
that this test does not independently exercise. The test still passes and is valid for what
it does prove. Minor — recorded here, not filed; the production fix is unaffected.

**Docs — minor gap, fixed inline.** `docs/internals.md` §4 ("Check-Then-Act Race in
Consensus") documented only the eager in-memory guard and was silent on the durable-marker
post-apply ordering this fix now relies on. Added a "Two markers, two lifetimes" note there
so the doc reflects the new reality (`internals.md`, after the CORRECT code block). The
existing line 282 ("rolls back the executed marker and rethrows") remains accurate for the
in-memory marker.

**Tripwire — recorded, no new code marker.** The fix's crash-window safety depends on
`applyConsensusOperation` staying idempotent on re-apply for every operation kind. This is
already documented at the `markExecuted` comment (`cluster-repo.ts:835-846`) and the
method's own doc-comment ("ahead" divergence tolerated), so no new `NOTE:` was added. The
weakest link is the `cancel` branch (`cluster-repo.ts:894` — a bare
`storageRepo.cancel(...)` with no divergence tolerance), which is only reachable on
re-apply of a **multi-op** consensus record where a later op threw after `cancel` applied.
All tested consensus paths are single-op, so this is genuinely dormant, not a latent defect
— left as a tripwire. If multi-op consensus records or a non-idempotent-on-re-apply
operation kind are ever introduced, this fix's crash-window safety must be re-verified.

**Known gaps carried from implement (accepted as floor, not ceiling).** Coverage is
single-peer/single-op only; the crash-mid-apply window and multi-op records are argued safe
by idempotency, not exercised by a test. `markExecuted` remains fire-and-forget (a
post-apply durable-write failure is only logged; the transaction re-runs idempotently on
restart) — intentional and consistent with prior behavior. These are documented in the
implement handoff and not regressions; no tickets filed.

**Findings requiring new tickets: none.** No major defects found. The one behavioral
overclaim (test #2) and the doc gap were minor and handled in this pass.
