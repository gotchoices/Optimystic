description: Two people writing at the same time used to both fail on the first try and start over. Now one of them wins outright and the other succeeds on its second try — on groups of two or three machines; on four or more the old behaviour remains, and that limit is written down.
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`prevoteLocalPromise` — new; `collectPromises` — now runs it and excludes self from the round)
  - packages/db-p2p/src/cluster/race-resolution.ts (`resolveRace` — unchanged code, new `NOTE:` recording the three-members-and-up residual)
  - packages/db-p2p/test/transaction-node-count-sweep.spec.ts (round-1 assertion at cohort size 2; the explanatory comment corrected)
  - docs/correctness.md (Theorem 9 restated per retry cycle)
  - docs/internals.md (new section "Both consensus rounds carry the coordinator's own member's vote")
  - packages/db-p2p/docs/cluster.md (Phase 1: Promise Collection)
  - tickets/backlog/bug-a-late-promise-invalidates-the-commit-signatures-already-collected.md (update arm appended, no code change)
----
# The coordinator's own member votes before the promise round fans out

## What changed

`ClusterCoordinator.collectPromises` now hands the record to this node's own cluster member, in process, **before** the fan-out, merges that member's promise into the record, and sends that record to the remote members. The new `prevoteLocalPromise` is the promise-round twin of the commit round's existing `presignLocalCommit`, and the member is then left out of the round it has already voted in.

That is the whole behavioural change. `resolveRace` is untouched; what changed is the input it gets. Its first comparison is the count of `approve` promise votes, and that comparison gates the two below it — the aged priority and the message hash, which are the comparisons that make every member pick the same winner. A record fanned out with no vote on it lost that count to any rival the member it landed on had already voted on, so a first-round collision was decided by arrival order and the tie-breaks never ran. On a two-member cohort where each writer coordinates through its own node that was a guaranteed double loss.

Three rules hold the change together, each with a failure mode if dropped, all stated at the code sites:

- **The pre-vote's outcome is the member's outcome for the round on both paths.** A throw counts as the one invocation the promise phase allows the local member, and is recorded in the round's `summary`, so the per-peer logging, the reputation report and the shortfall arithmetic see it exactly as they saw a failed local delivery before. Re-including self on the throw path would call it twice and break `packages/db-p2p/test/cluster-coordinator-promise-retry.spec.ts` ("does NOT retry the LOCAL cluster on a throw").
- **Only `promises` is merged, never `commits`.** The round merges only `promises` from every other member's answer, and this merge cannot reach the defect in backlog `bug-a-late-promise-invalidates-the-commit-signatures-already-collected`: no commit signature exists anywhere before the promise round completes, because a member signs a commit only after seeing a super-majority of approved promises. Confirmed and written at the site; that ticket has an appended arm saying the same, and saying what of it is unchanged (a remote late member still signs over a promise map nobody else has).
- **`undefined` from the pre-vote means there is no local member in this cohort**, which some test wiring produces; the round then runs over every peer unchanged.

## What to test, and what was measured

**The reproduction and its fix are the same file:** `packages/db-p2p/test/transaction-node-count-sweep.spec.ts` prints a per-size table whose last column reports how the first round went.

```
cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/transaction-node-count-sweep.spec.ts"
```

Before the change, every size from two to five reported `round 1: both lost`. After it, over five consecutive runs:

| machines | round 1 | lost attempts |
| --- | --- | --- |
| 2 | `node 0 won` or `node 1 won` — the message hash decides, so which node wins varies per run | 1 |
| 3 | `node 0 won` or `node 1 won` | 1 |
| 4 | `both lost` | 2 |
| 5 | `both lost` | 2 |

The spec now **asserts** the size-2 row: exactly one writer wins the first round, and exactly one attempt is refused. Sizes 3 to 5 stay reported-but-not-asserted, deliberately — at three the outcome depends on delivery order (see the residual below), and pinning an observation the design does not guarantee would be a flaky test. That is the main judgement call in this ticket for a reviewer to weigh: whether size 3 should be asserted too.

**Which refusal path each size takes.** Captured with `DEBUG='optimystic:db-p2p:*'` over the race phase alone (`--grep "two nodes racing one row"`), one run covering all four racing sizes:

- `cluster-tx:conflict-race-lost` — 2 occurrences. The promise-round vote loss, raised by `ClusterCoordinator` and returned by `CoordinatorRepo.pend` as a conflict.
- `coordinator-repo:pend-remote-refusal` — 4 occurrences. Both pends reach pend consensus, each member's storage then keeps whichever pending record arrived first, and both coordinators hear a cohort refusal.

The per-size attribution — one vote loss each at two and three, two cohort refusals each at four and five — is *inferred* from those totals matching the table's per-size lost-attempt counts (1, 1, 2, 2), not measured per size directly. If a reviewer wants it measured per size, re-run the capture with `--grep` narrowed to one size's `describe`.

That distinction is the point of the comment correction: the spec's old comment attributed the all-lose round at **every** size to the second path. It was right for four and five and wrong for two and three, which is what the ticket flagged. The comment now says which mechanism belongs to which size.

**Test added: none, beyond tightening the existing sweep.** The reproduction the ticket named was already in the tree and already reported the defect in its table; what it lacked was an assertion. Tightening it pins one behaviour at the layer that reproduces it. A separate unit test that `prevoteLocalPromise` is called once would be testing wiring the existing promise-retry spec already constrains.

**Everything run, and its result:** the whole `db-p2p` suite (3109 passing, 63 pending — the same figure the ticket's prototype reported), then every component of `yarn check` from the root: `lint`, `lint:docs` (47 documents, 168 anchored citations, all resolve), `lint:deps`, `build`, `typecheck`, `check:rn`, `test` (7m 2s), `test:integration` (5m 17s). All green. Nothing failed, nothing was skipped, and no pre-existing failure surfaced.

## What this does not fix, and where that is recorded

The pre-vote makes the two racing **coordinators'** members agree. A member that is neither coordinator still votes for whichever record reached it first, and its own approval re-inflates that record to two against the newcomer's one — so from three members up the count comparison can decide again one layer out, and the tie-break is bypassed. Observed as `round 1: both lost` at four and five members. Both writers then re-drive and the retry loop's jittered backoff separates them, so it costs a round rather than correctness.

This is recorded as a `NOTE:` at `resolveRace` in `packages/db-p2p/src/cluster/race-resolution.ts`, including why it is not simply relaxable: a member cannot retract an approval it has already signed, and letting a member that approved a write which went on to reach super-majority also approve its rival is exactly the split brain the approvals-first order exists to prevent. **No ticket was filed for it**, per the ticket's instruction not to attempt it here — it is a documented limit of the current design, not queued work.

## Documentation corrected

`docs/correctness.md` Theorem 9 was overstated. Its statement said one of two conflicting transactions commits "per conflict cycle", and its proof sketch opened by asserting that `resolveRace` deterministically selects a winner — a step that, measured, never ran in a first-round collision at any size from two to five. It now states the guarantee **per retry cycle**, says what makes the arbitration actually run (the pre-vote) and where it still does not (the non-coordinator member), and says plainly that it does not hold per round.

`docs/internals.md` gains a section beside the commit-path ones — *Both consensus rounds carry the coordinator's own member's vote* — covering both rounds, why each wants the vote, and the three rules above. `packages/db-p2p/docs/cluster.md` gains the same under Phase 1, beside the Phase 2 pre-signature paragraph it mirrors.

## Reviewer's starting points

- **Is excluding self on the throw path right?** It is what keeps the "invoked exactly once" contract, but it differs from `presignLocalCommit`, which returns `false` on a throw and lets the round include self. The asymmetry is deliberate and argued at both sites; a reviewer may disagree with the argument.
- **`roundPeers` indexing.** `roundPeers` is derived by filtering `peerIds`, and the per-response handlers now index `roundPeers[idx]` rather than `peerIds[idx]`. An index mismatch here would attribute a peer's vote to the wrong peer, so it is worth a second pair of eyes.
- **Reputation reporting against self.** `prevoteLocalPromise` reports the local peer to `IPeerReputation` on a throw, because the round's failure path did exactly that for the local peer before. A node reporting itself is odd, but it is the pre-existing behaviour, preserved rather than changed. Whether it should be dropped is a separate question this ticket did not settle.
- **Log lines.** The pre-vote reuses the round's own tags (`cluster-tx:promise-request` / `cluster-tx:promise-response`) with an added `prevote: true` field, so an operator's existing filters keep working. No spec keys on those tags today.
- **Cohort of one.** `prevoteLocalPromise`'s doc comment asserts a member cannot sign a commit from a one-vote record at any size this class runs on, because `CoordinatorRepo`'s solo path short-circuits a cohort of one before reaching it. That premise is stated, not tested here.
