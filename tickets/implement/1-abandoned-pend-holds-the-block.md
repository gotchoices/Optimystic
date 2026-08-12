description: A write that has already been refused — or that nobody is driving any more — keeps the data block it touched reserved for two seconds, so every other machine's write to that block fails during that window, and each failed attempt reserves the block again.
prereq:
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/test/cluster-repo.spec.ts, docs/correctness.md
difficulty: medium
----

# A dead pend keeps the block reserved

Arm 2 of `fix/lost-conflict-race-abstains-and-orphans-the-block`. Arm 1 (a member that
loses a race must answer instead of staying silent) is the follow-on ticket
`member-must-answer-a-lost-conflict-race`, which depends on this one. This ticket is
self-contained, changes no wire format and no type, and is what makes a retry able to
succeed at all.

## Background — the three pieces involved

A **cluster member** (`ClusterMember`, `packages/db-p2p/src/cluster/cluster-repo.ts`) is one
node's half of the consensus protocol. Every transaction it has voted on but not yet seen
finished sits in its `activeTransactions` map.

`hasConflict(record)` (`cluster-repo.ts:1523`) asks "does any transaction already in that map
touch a block this new one touches?" If yes it calls `resolveRace(existing, incoming)`
(`:1627`) to pick a winner deterministically. If the existing one wins, the incoming one is
refused. The map is therefore a **reservation table over blocks**: anything in it reserves
its blocks against every later arrival.

The only thing that ever removes an entry nobody advances is the staleness sweep inside
`hasConflict` — `staleThresholdMs = 2000` (`cluster-repo.ts:1525`). So *any* entry that
stops being driven holds its blocks for a fixed two seconds.

## What is wrong

Three defects, all in the reservation bookkeeping, all reproduced deterministically with no
network. Reproduction was a throwaway spec built from the existing helpers in
`packages/db-p2p/test/cluster-repo.spec.ts` (`clusterMember`, `createClusterRecord`,
`makePendOperation`) run with
`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/<spec>.ts"` from
`packages/db-p2p`. The spec is not in the tree; the test bodies to land are given under
*TODO* below.

### 1. A member keeps a transaction it has itself terminally refused

`processUpdate`'s `OurPromiseNeeded` branch (`cluster-repo.ts:406-415`) calls
`handlePromiseNeeded`, which appends this member's vote — approve **or reject** — and then
falls into the `shouldPersist = true` path (`:469-483`). The phase is never re-evaluated
after the vote is added.

With the default unanimity threshold a single reject makes the transaction unreachable
forever: `getTransactionPhase` computes `maxAllowedRejections = peerCount - superMajority`
(`:770`), which is `0`, so one reject already satisfies the `Rejected` test at `:775`. The
member is nonetheless holding a record it has proven can never commit, and that record goes
on reserving its blocks for the full 2 s.

Measured: drive a member whose validator returns `{ valid: false }` with one pend, then read
`activeTransactions` — size 1, containing the record the member just rejected.

### 2. `resolveRace` counts reject votes as progress

```ts
const existingCount = Object.keys(existing.promises).length;   // cluster-repo.ts:1629
const incomingCount = Object.keys(incoming.promises).length;
```

`promises` is the vote map, not the approval map — a `reject` occupies a key there exactly as
an `approve` does. So a record carrying one rejection outranks a fresh rival carrying nothing,
and keeps outranking it until the sweep fires.

Measured: `resolveRace(A, B)` where A holds a single **reject** vote and B holds none returns
`keep-existing`.

This also weakens the safety argument the comment above `resolveRace` (`:1582-1625`) and
`docs/correctness.md` §Theorem 9 both rest on. That argument is about *commits*, and the
commit rule is `approvedPromises.length >= superMajority` (`:786`) — approvals only. Ranking
by approvals is therefore the count the invariant actually needs; ranking by all votes is
strictly looser than the property being claimed.

### 3. A coordinator that gives up tells nobody

`ClusterCoordinator.executeTransaction` abandons a transaction at two sites and, at both,
throws to its caller without touching the members it left holding state:

- `rejected-by-validators` — `cluster-coordinator.ts:344-362`
- `supermajority-failed` — `cluster-coordinator.ts:364-375`

Every member that voted still has the record. Nothing will advance it. It reserves its blocks
for 2 s.

This is what makes the failure self-sustaining rather than a one-off: each blocked retry is
itself a transaction that some member promised before another member blocked it, so each
failed attempt leaves a *fresh* reservation younger than the threshold. The consuming repo
measured a chain of six such records, each blocking the next, spanning the whole of a
three-attempt bounded retry (see the source fix ticket for the log excerpt).

## The shape of the fix

**Defect 1 — do not retain a record whose phase is terminal.** After `handlePromiseNeeded`
returns, re-evaluate `getTransactionPhase` on the resulting record; if it is now `Rejected`,
take the `shouldPersist = false` path instead of persisting. The cleanest expression is to
make the `OurPromiseNeeded` branch mirror the `OurCommitNeeded` branch, which already
re-evaluates the phase after adding its signature (`:426-434`). A member's own decision to
refuse should end its interest in the record, not begin a two-second hold.

**Defect 2 — rank by approvals.** `resolveRace` compares
`Object.values(x.promises).filter(s => s.type === 'approve').length`. Update the method's
doc comment and `docs/correctness.md` §Theorem 9 to say *approve* count, since both currently
say "promise count" and the distinction is now load-bearing.

**Defect 3 — broadcast the abandonment.** At the `rejected-by-validators` site the coordinator
already holds a merged record carrying enough signed reject votes to prove the transaction is
dead. Sending that record to the cohort (the same `update()` every other phase uses — no new
message type, no protocol change) makes every member compute `TransactionPhase.Rejected` and
clear the entry immediately. A member need not trust the sender: it verifies the signatures it
is shown, so the worst a hostile caller can do with this is present a true statement.

The `supermajority-failed` site is different and should be treated differently: with nobody
having voted there is nothing to prove, so a broadcast there would be an unauthenticated
"forget this" and is **out of scope for this ticket** — leave that case to the staleness
sweep and say so in a `NOTE:` at the site. Once
`member-must-answer-a-lost-conflict-race` lands, the interesting half of that case becomes
proof-carrying too (the losers' conflict votes), and the same broadcast covers it.

Do the broadcast on a path that cannot convert an abandonment into a different failure:
fire-and-forget with `void`, errors logged, never awaited into the throw.

**Do not** simply lower `staleThresholdMs`. It is the backstop for the cases that carry no
proof (a coordinator that crashed); shortening it trades one silent failure for another —
a member forgetting a live transaction mid-flight.

## TODO

- Add the three regression tests to `packages/db-p2p/test/cluster-repo.spec.ts`, before the
  behaviour change, each currently red:
  - *a member does not retain a transaction it rejected itself* — build a member with a
    validator returning `{ valid: false, reason: 'Validation failed' }` (the existing
    `describe('validation')` block has the shape), `update` one pend, then assert the private
    `activeTransactions` map does not contain `record.messageHash`. Cast to reach it, as the
    existing `raceOf()` helper does for `resolveRace`.
  - *a rejected record does not outrank a fresh rival* — `resolveRace(A, B)` where A's
    `promises` holds one `reject` signature (`makeSignedPromise(..., 'reject', 'stale-revision')`)
    and B's is empty must return `accept-incoming`.
  - *a coordinator that abandons a rejected transaction tells the cohort* — coordinator-side;
    `packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts` already stands up a
    coordinator against fake members and is the closest harness. Assert the members receive a
    final `update` carrying the rejections.
- Re-evaluate the phase after the member's own promise vote; take the clear path on a terminal
  phase.
- Rank `resolveRace` by approve votes; update its doc comment and `docs/correctness.md`
  §Theorem 9 ("more promises" → "more *approvals*"), including the monotonicity paragraph that
  reasons about the count.
- Broadcast the proof-carrying abandonment at `cluster-coordinator.ts:358`; add the `NOTE:` at
  the `supermajority-failed` site explaining why that one is not broadcast yet.
- Run `yarn test` in `packages/db-p2p`; the cluster specs
  (`cluster-repo`, `cluster-coordinator*`, `cluster-consensus-divergence`,
  `supermajority-coupling`, `two-node-convergence-invention-race`) are the ones that exercise
  these paths. Report the result honestly in the review hand-off.
