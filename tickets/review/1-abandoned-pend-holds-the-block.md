description: A write that was refused, or that nobody is driving any more, used to keep the data block it touched reserved for two seconds — blocking every other machine's write to that block, and each blocked retry reserved it again. Now a refused write is dropped straight away and the machine that gave up tells the others.
prereq:
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts, packages/db-p2p/docs/cluster.md, packages/db-core/src/transaction/transaction.ts, docs/correctness.md
difficulty: medium
----

# Review: a dead pend no longer keeps the block reserved

Implemented from `implement/1-abandoned-pend-holds-the-block`, arm 2 of
`fix/lost-conflict-race-abstains-and-orphans-the-block`. No wire format changed, no type
changed, no new message type. Arm 1 (`member-must-answer-a-lost-conflict-race`) is a separate
follow-on that depends on this and is **not** part of this change.

## The vocabulary you need

- **Cluster member** (`ClusterMember`, `packages/db-p2p/src/cluster/cluster-repo.ts`) — one
  node's half of the consensus protocol.
- **`activeTransactions`** — the member's map of transactions it has voted on but not seen
  finished. `hasConflict()` (`cluster-repo.ts:~1540`) scans it for any entry touching a block
  the incoming transaction touches, so the map is effectively a **reservation table over
  blocks**: anything sitting in it blocks later arrivals on the same blocks.
- **Staleness sweep** — the only thing that removes an entry nobody is advancing:
  `staleThresholdMs = 2000` inside `hasConflict`. Anything retained therefore holds its blocks
  for a full 2 seconds.
- **`resolveRace(existing, incoming)`** — the deterministic arbiter that picks a winner when
  two pending transactions touch the same block.

## What changed (three sites)

### 1. A member no longer retains a transaction it rejected itself
`packages/db-p2p/src/cluster/cluster-repo.ts`, `processUpdate`'s `OurPromiseNeeded` branch
(~line 406–432).

`handlePromiseNeeded` appends this member's vote — approve **or** reject — and the old code
then always fell into `shouldPersist = true`. With the default unanimity threshold
(`maxAllowedRejections = peerCount - superMajority = 0`) a single reject already satisfies the
`Rejected` test in `getTransactionPhase`, so the member was persisting a record it had itself
proven could never commit, and that record reserved its blocks for the full 2 s.

The branch now re-evaluates `getTransactionPhase` after its own vote and, on `Rejected`, calls
`handleRejection` and takes `shouldPersist = false` — exactly mirroring the shape the
`OurCommitNeeded` branch directly below already used.

### 2. `resolveRace` ranks by *approvals*, not by vote-map keys
Same file, new private static `ClusterMember.approvalCount()` (just above `resolveRace`,
~line 1599) plus the first comparison in `resolveRace`.

`record.promises` is the **vote map**: a `reject` occupies a key there exactly as an `approve`
does. Counting `Object.keys(...).length` therefore ranked a record carrying one rejection above
a fresh rival carrying nothing, and it kept out-ranking it (and blocking it) until the sweep
fired. The count is now `Object.values(x.promises).filter(s => s.type === 'approve').length`.

This is also the tighter claim: the safety argument in the `resolveRace` doc comment and
`docs/correctness.md` §Theorem 9 is about *commits*, and the commit rule is
`approvedPromises.length >= superMajority` — approvals only. Ranking by all votes was strictly
looser than the property being asserted. The priority tie-break and hash tie-break below it are
untouched.

### 3. A coordinator that abandons a *proven-dead* transaction tells the cohort
`packages/db-p2p/src/repo/cluster-coordinator.ts`: new private `broadcastAbandonment()` (just
above `updateTransactionRecord`), called from the `rejected-by-validators` site in
`executeTransaction` (~line 366).

At that site the coordinator already holds a merged record carrying enough signed rejections to
*prove* the transaction is dead. Replaying that record to every peer via the same `update()`
every other phase uses makes each member recompute `TransactionPhase.Rejected` and drop the
entry immediately, instead of after its own 2 s window. A member need not trust the sender: it
verifies the signatures it is shown, so the worst a hostile caller can do here is assert
something true.

Delivery is fire-and-forget (`void Promise.all(...)`, per-peer try/catch, never awaited into the
throw, `updateMember(..., immediateRetries = 0, ...)`) so an abandonment can never turn into a
*different* failure. The staleness sweep stays as the backstop if delivery fails.

The **`supermajority-failed`** site is deliberately **not** broadcast — a `NOTE:` at that site
says why: nobody voted there, so the record carries no evidence, and a broadcast would be an
unauthenticated "forget this" any caller could use to clear a live transaction out of a member's
reservation table. Once `member-must-answer-a-lost-conflict-race` lands, the interesting half of
that case becomes proof-carrying (the losers' signed conflict votes) and can reuse the same call.

`staleThresholdMs` was **not** lowered — it is the backstop for the no-proof cases (a crashed
coordinator); shortening it would trade one silent failure for another (a member forgetting a
live transaction mid-flight).

## Documentation updated

- `docs/correctness.md` §Theorem 1 Case 2 and §Theorem 9: "more promises" → "more *approvals*"
  throughout, including the monotonicity paragraph and the Byzantine note that reason about the
  count. §Theorem 9 now carries one sentence recording *why* the narrowing happened.
- `packages/db-p2p/docs/cluster.md`: the `resolveRace` code snippet there was stale in a second
  way — it predated the priority tie-break entirely. Refreshed to the current three-key shape
  and the "Promise Count Wins" bullet became "Approval Count Wins".
- `packages/db-core/src/transaction/transaction.ts`: one-word comment fix
  ("promise-count / hash tiebreak" → "approval-count"). No behaviour.

## Tests to exercise this

All three were written first and observed **red** against the unmodified code, then green.

| Test | File | Was red as |
|---|---|---|
| `does not retain a transaction it rejected itself` | `test/cluster-repo.spec.ts`, `describe('validation')` | `expected true to equal false` — the record was in `activeTransactions` |
| `a record carrying only a REJECT vote does not outrank a fresh rival` | `test/cluster-repo.spec.ts`, `describe('priority-aged race resolution')` | `expected 'keep-existing' to equal 'accept-incoming'` |
| `tells the cohort when it abandons a transaction the validators rejected` | `test/cluster-coordinator-supermajority.spec.ts` | `waitFor timed out after 2000ms` |

Two details a reviewer should check rather than assume:

- The reject-vote race test makes the fresh rival **priority 1** so the outcome is decided by the
  priority tie-break at equal approve counts (0 vs 0) rather than by the message-hash tie-break,
  which would have been a coin flip on the chosen `actionId`. Pre-fix it was red regardless of
  priority (1 vote > 0 votes). If you would rather assert the hash-tiebreak form, it needs a
  hash-order-independent assertion like the existing capped-priority test uses.
- The coordinator test's mock **snapshots** each received record
  (`{ ...record, promises: { ...record.promises } }`). Without that snapshot the test was a
  **false green**: `collectPromises` merges into the *same* record object it handed out, so a
  stored reference from the promise phase retroactively appeared to carry the rejections. Worth
  keeping in mind — other coordinator specs that stash handed-out records have the same hazard.

### Validation runs

- `yarn test` in `packages/db-p2p` — **1582 passing, 44 pending, 0 failing** (~35 s). Covers the
  cluster specs named in the ticket: `cluster-repo`, `cluster-coordinator-supermajority`,
  `cluster-consensus-divergence`, `supermajority-coupling`,
  `two-node-convergence-invention-race`.
- `yarn test` in `packages/db-core` — **1365 passing, 0 failing** (touched only by a comment).
- `npx tsc --noEmit` clean in both packages.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Known gaps — please probe these

- **No test asserts the end-to-end effect.** Each defect has a unit-level regression test, but
  nothing drives the actual reported symptom: a retry succeeding on a block that a
  just-abandoned transaction had reserved. A member-plus-coordinator test that abandons one
  transaction and immediately pends a conflicting one on the same block would be the honest
  proof, and it would also catch a future regression that fixes only one of the three arms.
- **The broadcast is unverified in the wild.** It is only exercised against `RecordingClusterClient`
  mocks. Whether a real `ClusterMember` receiving the replayed record actually clears — rather
  than, say, tripping merge validation or equivocation detection in `mergeRecords` on a second
  delivery of the same votes — has **not** been tested. This is the highest-risk part of the
  change. `mergeRecords` detects a peer *changing* vote type; re-delivering identical
  signatures should be a no-op, but it is asserted only by reading, not by running.
- **Fire-and-forget delivery is unbounded in time relative to the caller.** The coordinator
  throws immediately, and the 100 ms cleanup timer in `executeClusterTransaction` may delete the
  transaction while the broadcast is still in flight. That is harmless as written (the broadcast
  closes over its own record) but nothing guards it.
- **Defect 1's fix is scoped to `Rejected`.** Other terminal-ish outcomes from a member's own
  promise vote are not re-examined; if `getTransactionPhase` ever grows another terminal phase,
  this branch will silently keep persisting again.
- Existing test `resolves conflict deterministically based on promise count`
  (`cluster-repo.spec.ts:838`) kept its name even though the rule is now approval count. Its
  body still passes because it uses approve votes; the name is now slightly off.
