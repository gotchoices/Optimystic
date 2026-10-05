description: A node that does not hold a block, and sees itself as the only machine responsible for it, used to answer "this block was never created" even when the reader's own log said the block exists, so the read failed hard. It now answers "I could not find out", so the read is retried on another machine and, failing that, ends in a typed, retryable error.
prereq:
architecture: docs/internals.md#consensus-execution
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`AbsenceVerdict` gains `'unasked'`; new module function `unavailableReasonFor`; `fetchBlockFromCluster`'s empty-cohort and solo-self exits return `'unasked'`; `readRepairBlock` maps through `unavailableReasonFor`)
  - packages/db-core/src/network/struct.ts (`BlockUnavailableReason` gains `'named-by-log'`)
  - packages/db-core/src/transactor/network-transactor.ts (comment only: `unavailableRank` already ranks every non-silence reason at 2, so `'named-by-log'` sits with `'claimed-elsewhere'` with no code change)
  - packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts (two new specs; the mesh fixture's steered `findCoordinator` now steps aside when the steered peer is excluded)
  - docs/internals.md (absence table: new third row and its paragraph), docs/transactions.md (§ Lazy read-repair window, the reason list under Unavailable reads, and the "short-circuits a self-only cohort as conclusive" sentence)
----

# A self-only view no longer rules out a block the asker's log names

GitHub issue #27. A joiner's catalog refresh walked a log entry naming a block, raised a floor for it (`raiseFloors`), and read it with that floor on the request (`BlockGets.floors`). Its own `CoordinatorRepo` had a self-only cohort view, took the solo-self exit of `fetchBlockFromCluster`, and answered an unflagged (authoritative) absent. `NetworkTransactor.get` treats that as final, so the read ended in `Missing block`.

## What changed

- `fetchBlockFromCluster` now tells "nobody was asked" (`'unasked'`: empty cohort, or only this node) apart from "every member answered it holds nothing" (`'confirmed'`). The no-`clusterLatestCallback` exit stays `'confirmed'`.
- `unavailableReasonFor(absence, floor)` is the whole mapping from verdict to `unavailable` reason. `'unasked'` with no floor stays an authoritative absent, exactly as before (one-machine `createOrOpen` probe, every existing self-only spec); with a floor it is flagged `'named-by-log'`. The other verdicts map as before.
- Unchanged: the solo exit's log line and arming (`soloAbsenceNamedThisWindow`, `markBlocksSeen` with the floor), present blocks, and consulted cohorts. A consulted cohort that all answers "holds nothing" under a floor still answers an authoritative absent (out of scope, see the original ticket).
- The `NOTE:` on `unavailableReasonFor` records the accepted cost: a floored read of an inserted block that landed nowhere (backlog `bug-a-refused-write-can-leave-its-log-entry-behind`) on a one-machine deployment now throws `BlockUnavailableError('named-by-log')` instead of `Missing block`. Revisit when log entries become proof their blocks landed.

## Tests added

- `coordinator-repo-absence-write-bypass.spec.ts` → "unit: the asker's floor names a block this node lacks (GitHub issue #27)": on a self-only view, a read without a floor stays an unflagged absent (via `probeAlone`) and the same read with `floors: { [id]: 3 }` comes back `unavailable: 'named-by-log'`. Failed before the fix (`{"state":{}}`).
- Same file, mesh describe → "(#27): a floored read routed to A while A still sees itself alone is answered by another machine": B commits a block with A unreachable; A keeps a self-only view; a `NetworkTransactor.get` with a floor, first routed to A, returns rev 1 with content. Failed before the fix (`{"state":{}}`: A's absent was taken as final). This is the test that observes the second-chance round reaching a second machine. A reviewer may judge it composition of already-tested pieces (the retry for flagged entries is pinned in `network-transactor.spec.ts`) and cut it; it is the only evidence in the repo for the ticket's claim 1, though.
- Fixture change in that mesh describe: the steered `findCoordinator` now returns the steered peer only when the caller did not exclude it, and otherwise defers to the shared mesh view. The other three mesh specs there pass unchanged.

## Validation run

- `yarn build` (root): clean. `tsc --noEmit` for db-p2p (src + test): clean. eslint on the changed files: clean. `yarn lint:docs`: clean.
- db-core `yarn test`: 1861 passing.
- db-p2p `yarn test`: 3205 passing, 65 pending, 1 failing — `test/reactivity/mesh-tail-rotation.spec.ts` "tiers below the root survive a rotation…" (expected 2 subscribers at the new root, got 1). Intermittent: failed 1 of 5 when run alone. The reactivity mesh harness never builds a `CoordinatorRepo`, transactor or floor, so it is unrelated; reported in `tickets/.pre-existing-error.md`.
- quereus-plugin-optimystic `yarn test`: 1001 passing, 14 pending.
- `yarn test:integration`: db-p2p 46 passing / 2 pending; quereus-plugin-optimystic 1007 passing / 8 pending.
- The deleted-block risk from the original ticket (floors are raised for deleted ids too): no suite produced a new `BlockUnavailableError`, and `named-by-log` appears in none of the test logs. A block this node held and then deleted has a committed revision (`state.latest`), so it never reaches the missing path; the risk applies only to a node that never held a block that was later deleted.

## Known gaps — check these

- **The issue's end-to-end scenario was not re-run here.** It needs the sibling sereus packages and a patched Quereus. Everything above is in-repo reasoning plus the two specs.
- **The second-chance round reaching a second machine was observed only in the mesh harness**, whose `findCoordinator` models production's connected-peer fallback as "the first non-excluded node of the ring walk". It was not observed through the real `Libp2pKeyPeerNetwork.findCoordinator`. That fallback filters candidates through `filterByMembership`, which drops peers not yet confirmed to serve this network. If the joiner's self-only view is self-only *because* the founder is still unidentified, the retry can find no candidate, fall through to the last-resort self pick, re-ask self, and end in `BlockUnavailableError('named-by-log')`. That is still the typed, retryable error the ticket asks for, but the ticket's "in the report, the founder" outcome depends on the founder being identified and connected, which no test here exercises.
- `unavailableRank` places `'named-by-log'` at rank 2 by falling through to its default branch, not by naming it. Correct today; a reviewer who prefers an explicit arm can add one.
- docs/debugging.md does not enumerate `unavailable` reasons, so it was not changed.
