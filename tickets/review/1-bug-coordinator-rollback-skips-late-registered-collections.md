description: A table opened partway through a transaction used to keep its changes when that transaction was cancelled — the changes leaked into the next transaction's saved history. Fixed; needs a review pass.
files:
  - packages/db-core/src/transaction/coordinator.ts (`stampData` decl ~60-90; `applyActions` ~100-150; `rollback` ~540-620; reworded NOTE ~890-900)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (new helpers `registerLate` / `insertKeys` ~148-169; new describe block at end, 6 cases)
difficulty: medium
----

# What landed

`TransactionCoordinator` undoes a transaction by restoring every collection to a
snapshot of its staged state (tracker transforms + queued action list). It used to
take that snapshot once, on the transaction's first `applyActions`, covering only the
collections present in the live `this.collections` map at that instant. That map is
owned by the caller (the Quereus adapter's registry) and grows as tables open, so a
collection registered later was visible to commit but missing from every snapshot —
`rollback` never visited it, and its cancelled staged state survived into the next
transaction's durable log entry, still tagged with the cancelled stamp.

Three coupled changes, all inside `coordinator.ts`. No cross-package API added.

**1. Reconcile on every `applyActions`, not just the first.** The capture loop moved
out of the `if (!stampData.has(stampId))` branch. Each call, before `applyActionsRaw`,
captures any collection now in the live map that this stamp has not captured yet.
`preSnapshot.has(collection)` guards against re-capturing a collection this stamp
already staged into (registration is idempotent; the adapter re-registers already-open
index trees) — re-capturing would record a *dirty* state as "before" and rollback
would then preserve the actions it must discard. The loop is synchronous and
`await`-free through to `applyActionsRaw`.

**2. Per-collection earliest capture, ranked by a monotonic `seq`.** Making capture
lazy broke the old `rollback`, which picked ONE snapshot map (the lowest-`order`
stamp's) and restored everything from it. That was sound only while capture was eager.
`stampData[].preSnapshot` is now `Map<Collection, { seq, snapshot }>` with a
coordinator-global `nextCaptureSeq`; `rollback` merges the rolled-back stamp's and
every survivor's maps keeping the lowest `seq` per collection. Stamp `order` still
orders survivor *replay*, and nothing else.

**3. Keyed by `Collection` instance, not `CollectionId`.** If a table re-initializes
and the map's value under an id is replaced with a different `Collection` object, an
id-keyed snapshot would restore the old instance's staged state onto the new one.
Instance keys make that unrepresentable; the restore loop calls
`collection.restorePending(...)` on the captured object directly.

The correctness argument is written as a comment at the merge site in `rollback`:
*for every collection `c`, the minimum capture seq for `c` precedes every tracked
batch that touches `c`* — because a batch naming `c` requires `c` to be in the live
map at that `applyActions` call (`applyActionsRaw` throws `Collection not found`
otherwise), so that call's reconcile captured `c` first. Hence no replayed batch was
already folded into the snapshot it replays onto.

Not touched, deliberately: `execute`'s `preStageSnapshots` and `commitOnceLatched`'s
`preCommitSnapshots` are separate, id-keyed, single-call structures.

# Validation performed

- `yarn test` in `packages/db-core` — **1590 passing, 0 failing**.
- `yarn build` then `yarn test` in `packages/quereus-plugin-optimystic` —
  **692 passing, 13 pending, 0 failing**; `test:smoke` ok. (Its session-mode specs build
  a coordinator straight from `plugin.txnBridge.getCollectionRegistry()` and import
  `../dist/`, so the rebuild was required.)
- `npx tsc --noEmit` in `packages/db-core` — clean.
- **Mutation-checked each leg of the fix is load-bearing.** I temporarily neutered one
  leg at a time and re-ran the focused spec (then restored the file, verified by diff
  stat):
  - reconcile-on-first-call-only → **3 failing**
  - single lowest-`order` map instead of per-collection min `seq` → **2 failing**
  - drop the `preSnapshot.has(col)` guard → **5 failing**

# New test cases (all in `coordinator-rollback-pending.spec.ts`)

New describe block: `TransactionCoordinator.rollback: collections registered mid-transaction`.
New helper `registerLate(transactor, collections, id)` builds a collection and inserts
it into the live map *after* `makeCoordinator` returned — that is the whole repro.
Helper `insertKeys(collection)` reads the tracker's insert keys, so the transform half
is asserted too (the pending half alone was already restored for eagerly-captured
collections, which is why the sibling defect hid so long).

- **`empties a collection registered after the stamp started and staged into by that stamp`** —
  the primary repro. Asserts both halves: empty pending queue AND tracker insert keys
  back to the pre-staging baseline.
- **`drops only the rolled-back stamp when a survivor staged into the late collection first`** —
  x (order 0) captures `a`; `b` registers; y (order 1) captures `b` clean and stages
  into it; x then stages into `b`, capturing it dirty at a *later* seq. `rollback(y)`
  must leave `['x-b']`. Under the old order-only walk this produced
  `['y-b', 'x-b', 'x-b']`. Asserts values and stamp tags, not counts.
- **`drops the rolled-back stamp in the mirror direction…`** — same setup,
  `rollback(x)` must leave `['y-b']` on the late collection and empty `a`.
- **`does not re-capture a collection the stamp already staged into when it is re-registered`** —
  the same instance written back into the map after staging; exercises the `has` guard.
- **`rolls back a replacement instance registered under an id already in the map`** —
  a *different* `Collection` object under an existing id mid-transaction; both
  instances end rewound, nothing throws.
- **`leaves a late-registered, transaction-created collection readable and committable`** —
  a collection with no committed revision keeps its header/root blocks in the tracker;
  restoring the snapshot (rather than resetting to empty) is what keeps it readable.
  Proved by committing a fresh transaction on it after the rollback and reading its log.

Also updated: the stale `makeCoordinator` doc comment that called late registration
"a separate, pre-existing gap" pointing at this ticket in `backlog/`, and two comments
that named the old "earliest-snapshot walk".

# Known gaps — please probe these

- **No runtime repro through SQL.** The original ticket was `repro: static`, and it
  stayed that way: the Quereus path reaches this only in session mode, which no host
  in this repo wires today (`backlog/debt-session-mode-bridge-coverage`). Every new
  test drives `coordinator.applyActions` / `coordinator.rollback` directly. Nothing
  here proves the adapter's real registration timing matches the model in the tests —
  specifically, that `TransactionBridge.registerCollection` always lands before the
  `applyActions([], stampId)` barrier for that table's first DML. Worth a read of
  `optimystic-module.ts` around its "applyActions before any collection.stage"
  invariant to confirm the seam holds in the real driver.
- **Multi-stamp cases are synthetic.** The two-stamp tests interleave calls by hand.
  The adapter drives one stamp per coordinator today, so the whole multi-stamp branch
  of `rollback` is exercised only by these specs.
- **The invariant is argued, not enforced.** Nothing asserts at runtime that a
  collection's minimum capture seq precedes every batch touching it; it rests on
  `applyActionsRaw` throwing `Collection not found`. If a future path stages through a
  collection *not* in the live map, the argument breaks silently. A cheap dev-mode
  assertion in `rollback` is a plausible hardening; I did not add one.
- **`nextCaptureSeq` is unbounded.** A monotonically increasing `number` on a
  long-lived coordinator. Not realistically reachable (2^53 captures), and not
  parked as a NOTE because it did not seem worth the line — say so if you disagree.
- **Cost of the per-call reconcile is unmeasured.** I reasoned about it (one `Map.has`
  per registered collection per `applyActions` call; `snapshotPending`'s deep copy
  still at most once per collection per stamp) but ran no benchmark. The reasoning is
  parked as a `NOTE:` tripwire at the loop, per the ticket.
- **Adjacent, deliberately untouched:** `commit` still deletes only its own
  `stampData` entry, so a sibling stamp's snapshots go stale on commit — tracked in
  `backlog/bug-coordinator-stamp-snapshots-go-stale-when-a-sibling-commits`. This
  change neither fixes nor worsens it. I re-read both NOTEs about it and reworded the
  one in `execute`'s partial-commit branch that named the old walk; check the reworded
  wording is still accurate.
- **Untracked staging** (`Tree.stage` / direct `Collection.act`) into a late-registered
  collection between its capture and the rollback is still discarded. That is the
  pre-existing documented symmetry; I extended the NOTE rather than changing behaviour.
  No new test covers it beyond the existing `stays a no-op for a stamp that never went
  through applyActions`.
