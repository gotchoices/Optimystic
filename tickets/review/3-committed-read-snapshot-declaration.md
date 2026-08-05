description: A read of already-committed data now answers promptly and correctly even while a write to the same table is stuck waiting on the network, and the database engine has been told it is safe to run such reads at the same time as writes.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/test/read-view-pinned.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/commit-gate.ts, packages/quereus-plugin-optimystic/test/committed-read-stall.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-conformance.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, docs/transactions.md, docs/internals.md, packages/db-core/src/collections/tree/readme.md
difficulty: hard
----

# Implemented: committed-read guarantee proven under stalled commits; `readCommittedSnapshot` declared

`OptimysticModule` now declares `readCommittedSnapshot = true` (alongside the
existing `concurrencyMode = 'reentrant-reads'`), so Quereus 4.8 routes eligible
`readConcurrency: 'committed'` statements off the execution mutex. The
declaration was made only after both proofs passed in both commit modes, and two
real hazards found on the way were fixed first.

## The two design decisions the ticket demanded

### 1. The legacy mid-sweep tear was REAL — fixed by pinning views to the snapshot's boundary

Verified before writing any test: `commitDirtyTreesLegacy` flushes trees one at
a time with awaits between them, and each flushed tree's committed revision
advances immediately. The old committed view pinned to the revision current *at
view creation*, so a committed read taken between tree N and tree N+1 of the
sweep saw the main table post-commit and its index pre-commit — exactly the
full-scan/index disagreement the flag forbids. (Session mode was verified safe
by reading `TransactionCoordinator.commitOnce`: its post-consensus fold loop has
no `await` across collections, so its publish is event-loop-atomic.)

Fix (db-core, small and general): `CollectionSnapshot` now records the committed
boundary (`context`) it was captured on; `Tree.readView` pins the view to the
snapshot's own boundary instead of the current one, and `createReadTracker`
drops cache-seed entries newer than the pin (they are refetched at the pinned
revision — the transactor honours `context.rev`). Since `TransactionBridge.markDirty`
captures its snapshot BEFORE the first stage, every committed read of a dirty
tree now describes the one pre-transaction boundary, mid-sweep or not. A
hand-built snapshot with no boundary falls back to the old behaviour.

**The mid-sweep test was negatively verified**: with the one-line pin in
`Tree.readView` temporarily removed and both packages rebuilt, the MID-SWEEP
stall test fails with exactly the predicted torn read; restored, it passes. The
test is real evidence, not a tautology.

Reviewer should weigh one deliberate semantic shift: committed reads of a table
the current transaction has TOUCHED now describe the transaction's first-touch
boundary rather than "latest externally-folded commit". This also applies to the
serialized deferred-CHECK path (`committed.<Table>` inside constraints). It is
defensible (read-your-transaction-base; validator peers re-execute against their
own committed state regardless), but it is a change in what a deferred CHECK can
observe when an external commit lands mid-transaction.

### 2. First-touch committed read: provisional (read-only) initialization

`OptimysticVirtualTable.initializeForCommittedRead()` (new): when the bridge has
NO active transaction — the overwhelmingly common first touch — it runs the
ordinary full initialization (nothing to interleave with; matches all prior
behaviour). When a writer transaction IS active, it runs `doInitialize(readOnly:
true)`: no transaction state joined, no schema write on mismatch (the merged
candidate is honoured in memory), no `registerCollections()` (the live registry
is what a session coordinator commits from), no change subscription, and the
table is NOT memoized as initialized — the next quiescent or live touch runs the
full pass. Concurrent full/provisional initializations are sequenced (full
awaits an in-flight provisional; provisional joins an in-flight full).
`instantiateTable` no longer initializes its cached arm — callers own
initialization, each through the entry point its path requires.

## Proof inventory

**Proof B — `test/committed-read-stall.spec.ts` (9 tests).** A delegating
transactor (`test/commit-gate.ts`, reusable) parks commit-side calls
(`pend`/`commit`) behind a test-controlled gate with an `entered` promise,
idempotent `release()`, `releaseWithError()` (stall that then fails), and
`skipCalls` (place the stall mid-sweep). `get` passes through. Promptness is
asserted with `settleMacrotasks` bounded turns — never wall-clock — which also
proves the engine actually took the mutex-free path (a serialized read would
queue behind the parked writer's mutex and blow the turn budget). Reads are
driven BOTH engine-level (`db.eval(sql, undefined, { readConcurrency:
'committed' })` — the end-to-end the ticket asked for) and hand-driven through
`connect(_readCommitted)` where the access path must be certain (forced index
scans). Covered:

- Session mode: prompt pre-write full scan + agreeing index scan while parked
  (writer provably unsettled, asserted); fresh post-write read after release.
- Session mode: stalled commit released into an ERROR → clean rollback, reads
  taken during the stall still describe the surviving state, no degraded latch.
- Legacy MID-SWEEP (main flushed, index parked): reads show the pre-transaction
  boundary on both access paths. This is the test that fails without fix 1.
- Legacy first-tree failure after a stall: clean rollback, no latch.
- Legacy mid-sweep stall ending in a PARTIAL commit: reads answer pre-split,
  REFUSE (degraded latch, naming the split) after, answer again after the next
  clean commit.
- Different-table committed read is prompt during table A's stall.
- A committed read started during the stall and finished AFTER the commit lands
  serves the pinned pre-commit rows to the last row.
- Cold-cache first-touch committed read (fresh Database, zero cached blocks)
  during a stall: prompt, correct, registers no connection — every block faults
  through the ungated `get` path.
- First-touch committed read during an OPEN writer transaction: bridge registry,
  writer's transaction collection cache, and connection registry all untouched;
  the next live touch upgrades and completes registration.

**Harness — `test/committed-read-conformance.spec.ts` (3 tests).**
`runCommittedReadConformance` + `installCommitStall`, run in BOTH commit modes,
asserting `observedCommitOverlap === true` (a pass without provable overlap
fails the test). Note: `installCommitStall` must be installed BEFORE `create
table` — it wraps connections as they register. Plus a `Database.close()`
during a live concurrent read (close resolves; the read completes or aborts —
the test pins "close never hangs", not which arm ran).

**db-core — `test/read-view-pinned.spec.ts`** gained the "mid-sweep shape" test:
a view built from an old snapshot AFTER the tree committed further still shows
the snapshot boundary, and a fresh snapshot's view shows the new state.

## Validation

- `packages/db-core`: `yarn test` — **1345 passing** (was 1344; +1).
- `packages/quereus-plugin-optimystic`: `yarn build` + `yarn test` —
  **358 passing, 11 pending, 0 failing** (was 346; +12) + `smoke ok quereus@4.8.0`.
- `packages/db-p2p`: `yarn test` — **1515 passing, 44 pending** (baseline, re-run
  because db-core changed under it).
- Root `yarn build` and `yarn lint` clean. No pre-existing failures surfaced
  (`tickets/.pre-existing-error.md` not written).
- Env-gated integration specs (`OPTIMYSTIC_INTEGRATION=1`) not run.

## Honest gaps for the reviewer

- **The harness's index-driven leg is SKIPPED** in both modes: the planner does
  not choose a seek for the harness's range predicate on the integer pk (this
  module's `executeRangeQuery` is a documented full-scan fallback). The skip
  reason is asserted-or-logged, per the harness contract. Index/full-scan
  agreement under stall is instead proven by proof B's forced index scans. If
  range seeks ever land, the harness leg should light up on its own.
- **"Cold block during a stall"** was implemented as the cold-cache first-touch
  read (every block faulted from storage mid-stall) rather than an LRU-overflow
  tree (>128 blocks through SQL would need thousands of rows). The eviction-
  under-pin case is covered at the db-core layer (`read-view-pinned.spec.ts`,
  500 entries, fan-out 4).
- **The provisional-init schema-mismatch arm** (imported DDL that disagrees with
  persisted schema + first touch as a committed read + writer transaction open)
  is implemented (`storedSchema = mergedCandidate`, no write) but not separately
  tested — it is a compound of three rare conditions. The quiescent arm and the
  registry-isolation arm are tested.
- **The close() test does not force the abort arm** — a prompt committed read
  can complete before the close signal is observed at a row boundary. Both arms
  are legal; the test pins only that close cannot hang.
- **Session-mode "stalled then PARTIAL" commit** is still not driven end-to-end
  (the gate parks cleanly or fails whole; making consensus half-land needs a
  per-collection failure injection inside the coordinator's fan-out). The legacy
  partial arm IS driven end-to-end, and the session-mode degraded latch is
  covered by the existing `CoordinatorPartialCommitError` unit path from the
  prior ticket.

## Tripwires recorded (index — analysis lives at the sites)

- `NOTE` at `committedTreeView` (optimystic-module.ts): an index CREATED inside
  the in-flight transaction has no committed entries at the pinned boundary, so
  a committed read routed through it disagrees with a full scan — only for
  DDL+DML in one transaction racing its own publish window; the remedy (refuse
  indexes younger than the pin) is stated there.
- `NOTE` at `TransactionBridge.degradedReason` updated: its "if
  `readCommittedSnapshot` is ever declared" condition has now tripped; the
  declaration deliberately scopes its promise to concurrent tearing and does NOT
  treat a cleared latch as at-rest coherence (documented at the declaration site
  and in docs/transactions.md § "Committed reads run concurrently with a stalled
  commit" — residual-limit paragraph).
- `NOTE` at `createReadTracker` (collection.ts): rev-0 cache-seed entries pass
  the pin filter; committed blocks always carry a real revision on the paths
  that reach it.

## Docs

- `docs/transactions.md` § "Committed reads run concurrently with a stalled
  commit (`readCommittedSnapshot`)": the guarantee, both declarations and what
  holds each, the harness blind spot (parks BEFORE the publish window — proof B
  is the real cover; do not delete it in favour of the harness), and the
  residual degraded-store limit.
- `docs/internals.md` § "Committed reads are pinned, not shared-cache": added
  the snapshot-boundary pin as the third property; flag declaration noted.
- `packages/db-core/src/collections/tree/readme.md`: readView now documents
  pinning to the snapshot's boundary, with the hand-built-snapshot fallback.
