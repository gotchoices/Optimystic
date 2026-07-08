description: The top-level end-to-end tests (SQL-over-distributed-store and the reference peer's diary app) used to pause for a fixed number of seconds waiting for writes to spread across the network; they now poll until the data actually arrives and continue the instant it does. Review and accept that change.
files: packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts, packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts, packages/reference-peer/test/distributed-diary.spec.ts, packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts
----

# What this was

Implement-stage work converting fixed `delay(ms)` "wait for the write to propagate" sleeps in the
top-of-stack end-to-end suites into **bounded condition-polls** using the canonical
`waitFor` / `waitForValue` from `@optimystic/db-core/test` (added by the `test-wait-helpers` ticket).

All five listed specs run against a **real 3-node libp2p mesh** (in-memory or file-backed storage),
so there is no injectable clock — condition-poll is the right mechanism (fake-clock was ruled out per
the ticket, confirmed: every node is a production `createLibp2pNode`).

# What changed

Two small, per-file helpers were added to the two quereus specs so every converted read shares one
pattern:

```ts
async function queryAll(db, sql): Promise<Record<string, any>[]>   // for-await over stmt.all(), finalizes
async function queryGet(db, sql): Promise<Record<string, any> | undefined>  // stmt.get(), finalizes
```

`queryGet` returns `undefined` when no row matches — which is exactly what `waitForValue` treats as
"not ready yet", so the poll predicate is just a value check. The diary spec gets an analogous
`waitForEntries(diary, count, description)` that calls `diary.update()` (network refresh) then counts
`diary.select()` entries each round.

Every converted site follows: **poll until the read returns the expected settled state, then keep the
original assertion.** The bound is `{ timeoutMs: 30_000, intervalMs: 200 }` everywhere. Each spec's
local `const delay = …` was deleted; `delay` is now imported from `@optimystic/db-core/test` and
retained only for the genuine setup waits below.

Per-file classification (original → residual fixed sleeps):

- **distributed-quereus.spec.ts** (18 → 11): converted the 4 cross-node verification loops
  (INSERT distribute, UPDATE, DELETE, initial-state). The UPDATE/DELETE polls check for the *new*
  value (75 / 2-rows), so they poll **past** the stale pre-write state — directly fixing the
  eventual-consistency race the sleep was papering over.
- **distributed-transaction-validation.spec.ts** (33 → 21): converted 10 sites — the CHECK-constraint
  row read, StampId replication, multi-collection (3-rows / customer='Charlie' / 2-rows), file-storage
  `SUM=600` (SUM is `null` until every row lands, so the poll is correct), sequential-txn initial
  balance, final balance=600, and the local-schema row read. Also converted the mid-test
  `delay(5000)` between the two sequential updates into a poll that waits until **Node 3 has replicated
  Node 2's write (balance 800) before Node 3 overwrites it** — this makes the "last writer wins = 600"
  outcome deterministic instead of a propagation-vs-write race.
- **distributed-diary.spec.ts** (10 → 4): converted the entry-distribution ordering (each node waits
  until it sees the prior entries before appending, so entries land in Node 1/2/3 order), the
  storage-consistency read, and the concurrent-writes convergence (poll until Node 1 shows all
  successful writes). As a bonus, the debug `await stmt.all()` on Node 2 that logged `{}` (awaiting an
  async iterator) was replaced by `queryAll`, so it now logs real rows.
- **reactive-watch.spec.ts** — **no changes needed.** `test-wait-helpers` already folded its
  `waitUntil` into imported `waitFor`. Its 4 remaining `delay()` calls are all **negative-assertion**
  waits (assert an event did *not* fire after unsubscribe/drop/error) — you cannot condition-poll for
  the *absence* of an event, so these are the documented residual case for `delay`.
- **index-support.spec.ts** — **no changes.** Uses the in-process `test` transactor; it has **zero**
  sleeps (all reads are synchronously consistent). Listed in the ticket but nothing to convert.

# What survived as fixed `delay` (residual, on purpose)

These have no observable read to poll against, so a bounded sleep is the correct residual tool:

- **Mesh convergence in `before()`** — discovery/dial settling before the suite starts. (Diary's
  `before()` already hand-rolls a FRET-peer poll; left as-is.)
- **Collection/diary establishment before the *first* write** — waiting so the second node attaches to
  the originator's collection/header rather than forking a fresh empty one. Removing these risks a
  node reading its own empty fork forever (poll would never converge). This is the main correctness
  boundary the reviewer should sanity-check if any determinism concern arises.
- **Between-write pacing on the same node / FRET stabilize-between-tests** — conservative and
  non-flaky.

# Use cases to validate (reviewer)

- **Sleep→poll early-exit equivalence.** For each converted site, confirm the poll predicate waits on
  the *exact* state the removed sleep implicitly waited for, and that the subsequent `expect(...)` is
  unchanged. The riskiest are the "poll past stale" ones (UPDATE→75, DELETE→2 rows, balance→600,
  customer→Charlie): verify they check the post-write value, not merely row presence.
- **No assert-on-first-poll.** The original bug the sleeps hid was asserting on a transiently
  stale/empty read; confirm no converted site asserts before the predicate is satisfied.
- **Bounded, not unbounded.** Every poll is `timeoutMs: 30_000`; a broken query fails fast with a
  descriptive message rather than hanging to the runner idle-timeout.
- **`SELECT SUM` edge.** In the file-storage test the predicate is `total === 600`; SUM over a
  partially-replicated table returns `null` (defined-but-wrong is impossible here), so the poll cannot
  early-exit on a partial sum. Worth a second look.

# Validation run during implement

Real mesh, streamed, on Windows. Baselines taken at HEAD before editing.

- **distributed-quereus**: 4 passing. 40s at HEAD → **24–25s** after (polls return on arrival, not on a
  fixed 5s timer). Re-run twice, green both times.
- **distributed-transaction-validation**: **6 passing (~1m)**, twice, green both times. The sequential
  test now visibly serializes (log shows Node 3 observing balance 800 before its own update).
- **distributed-diary**: **4 passing (6s)** at the package's real `--timeout 10000`; ~5s of sleeps in
  the entry-distribution test collapsed to ~760ms. Re-run 3× total, green each time.
- **reactive-watch + index-support**: 29 passing (3s) — unaffected, confirmed still green.
- `tsc --noEmit` on both `quereus-plugin-optimystic` and `reference-peer` (the latter's tsconfig
  includes `test/`) → **exit 0**.

# Honest gaps / tripwires

- **Not a full-suite run.** I ran the touched specs individually (repeated), not the entire
  `quereus-plugin-optimystic` suite in one shot (it includes several other 15–120s specs and would
  approach the agent idle budget). No pre-existing failures were observed in what I ran; a full
  `npm test` sweep per package is left to CI / a human.
- **Timeout-bound interaction (tripwire, not a defect).** `reference-peer` runs mocha with a fixed
  `--timeout 10000`, while the new `waitForEntries` bound is 30s. On a healthy machine the poll returns
  in well under 1s, so this never bites; but on a very slow CI box mocha's 10s per-test timeout would
  fire *before* the 30s poll bound, yielding a generic "timeout of 10000ms exceeded" instead of the
  poll's descriptive message. This is pre-existing behaviour (the diary `before()` FRET poll already
  lives under the same 10s cap) and affects only the failure *message*, not correctness — recorded
  here in findings rather than as a code comment (no single site) or a ticket.
- **Determinism depends on the retained first-write establishment delays** (see "residual" section). If
  the reviewer wants those gone too, that is a follow-up — it needs a readiness signal from the
  collection/diary factory that the tests don't currently have.
