description: A transaction that writes several collections at once can save some of them and permanently lose the rest, even though nobody else is writing. It happens when the writer's own machine has not yet caught up on a block it is changing, as on a node that has just joined. Before 13586033 the same write succeeded after a retry. This blocks the release planned for 2026-09-18 morning.
files:
  - packages/db-core/src/transaction/coordinator.ts (`commitCollection` ~1640–1715 labels every returned commit failure `stale`; the commit fan-out ~1592; the partial-commit exit ~753–783; `commitAttempts` ~395 retries only a clean `CoordinatorStaleLossError`)
  - packages/db-core/src/transactor/network-transactor.ts (`staleFromBatches` ~995 drops the refusal's reason text)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`refuseCommitNotDurable`, called ~2552, the durability gate)
  - packages/db-p2p/src/storage/storage-repo.ts (~724: a holder with no revision accepts a pend, and its NOTE defers the refusal to the durability gate; `commit:missing-base`)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`commitBatchLegacy` ~951 and its NOTE, which assumes a stale tree costs "one refused attempt" at pend)
  - packages/db-core/src/collection/collection.ts (`sync` / `syncAttempts`: the pre-13586033 path, which survived this by refreshing and retrying)
difficulty: hard
severity: data-loss
likelihood: normal-use
----

# A multi-collection commit half-lands when the writer's replica lags

## Plain version

A node joins a group and at once writes one transaction touching three collections: a Member row, that table's unique index, and a ConsumedInvite row. The invite is saved; the Member row and/or its index are not. The caller gets `CoordinatorPartialCommitError` ("Stale commit for collection default/strand/Member"). The invite is spent, the member is never seated, and nothing retries.

No other writer is involved. The collection is behind only on the writer's own machine.

## Found by, and how it was established

Sereus's release gate against optimystic `9ec2de46` (2026-09-17 ~23:50): 7 of 312 integration tests failed. Sereus traced 4 of them, plus 2 more of the same shape, to this. It was triaged by the sereus session and sent to us as a message; the mechanism below is theirs, from debug traces. Nothing here has been reproduced inside this repository yet.

**Run alone, at `9ec2de46` (not under full-suite load):**

| Test | Failures |
|---|---|
| strand-membership-closed-strand-e2e "joining node… OWN database" | 3 of 4 runs |
| "manager promoted…" | 2 of 4 |
| strand-removal-cuts-network "leaves an open strand alone" | 3 of 3 |
| "tells a removed node…" | 1 of 3 |

**Last green:** the same four sereus files passed 24/24 at sereus `6f43f629`/`e0f8ccd2` (09-17 14:33–14:50), against optimystic between `0fc40ac5` and `61747f60`. strand-membership-closed-strand-e2e passed 5×9/9 at optimystic `421c724b` (19:15), 39 minutes before `13586033` (19:54, `implement/legacy-multi-tree-commit-pends-everything-before-committing-anything`). The durability gate (`7b935081`, 09-11) and the missing-base check (`d6a22d21`, 07-29) both predate those green runs. Not bisected.

**Reproduce in sereus** (`../sereus`; read it, do not write it):

```
cd packages/integration-tests && DEBUG='optimystic:db-p2p:storage-repo,optimystic:db-p2p:coordinator-repo*,optimystic:quereus-plugin:txn-bridge' yarn vitest run src/scenarios/strand-removal-cuts-network.integration.ts
```

Look for `commit:missing-base` followed by `commit-not-durable … durableHolders: 1, cohortSize: 2`. Sereus links `../optimystic`, so it runs against this tree's built `dist/`. Rebuild after each change.

The writing code is `consumeInvite` in sereus `strand-membership-writer.ts:616-634`, one explicit transaction. In closed-strand-e2e both nodes run with `membershipReconciliation:false`, the founder writes only Invite, and a visibility gate separates steps.

## Mechanism (from sereus's traces)

1. The joiner's replica does not yet hold the founder's revision-1 blocks for Member, because peer-join catch-up has not landed.
2. The joiner's transaction pends Member at revision 2, against the correct base (`Member:1@tx:…`, the founder's bootstrap). There is no rival action.
3. The pend is accepted. A holder with no revision accepts an update (`storage-repo.ts` ~724), and that site's NOTE says the commit-tier durability gate refuses it later.
4. At commit, the joiner's local store refuses: `storage-repo commit:missing-base … local latest none is not the declared base 1 of rev 2`. The remote member applied it. The durability gate counts one durable holder in a cohort of two and refuses: `coordinator-repo:commit-not-durable { rev: 2, durableHolders: 1, cohortSize: 2, arm: 'local-executed' }`. The refusal is returned as a retryable conflict.
5. `NetworkTransactor.staleFromBatches` drops the reason text, so `TransactionCoordinator.commitCollection` labels it "Stale commit for collection …" and, per its own comment, treats every returned commit failure as a permanent stale loss. It does not retry.
6. ConsumedInvite is insert-only with no base, so it commits. The commit fan-out runs in parallel, so the siblings land and the result is `CoordinatorPartialCommitError`. `commitAttempts` retries only a clean `CoordinatorStaleLossError`.
7. Before `13586033`, each tree went through its own `Collection.sync`, which treated the refusal as a failed attempt: refresh and retry, up to 10 times. By then the joiner had caught up. The txn-bridge NOTE at `commitBatchLegacy` assumes a behind tree costs "one refused attempt" at pend. Here the pend succeeds and the commit is refused.

Signature 2 in sereus is the same half-commit reached through the joiner's membership reconciler. Over a relay, ConsumedInvite and the index committed and Member did not, so the party is never seated.

## What to settle

- **The commit phase must not treat a refusal that can clear as permanent.** "Not yet durable because a member lags" is not "someone committed a newer revision". The pend is in place and the other members have applied it, so the same commit can succeed once the lagging member catches up. Sibling collections may already have committed by then, so forward recovery (retrying this collection's commit) is the only way back to all-or-nothing. Rolling back is not possible. Decide how the coordinator tells the two apart. The refusal is returned with `conflict: true` and the reason is currently thrown away (item 5). Keep the reason, or better, a machine-readable kind.
- **Do not weaken the durability gate** or the missing-base check. Both are correct: the write really was not durable on a majority when it was refused.
- **This is not only the legacy path.** Session-mode (non-legacy) transactions use the same `TransactionCoordinator` commit phase, so a multi-collection session transaction on a lagging member should hit this too. Check it and cover it.
- **Alternatives sereus listed:** catch up before pending, or hold every sibling's commit until every participant can commit. Weigh them against forward recovery. Whatever you choose must leave the joiner's write fully landed, not refused cleanly: in sereus this is the join itself.
- #17 (a torn legacy commit that leaves a table without its unique index) is what `13586033` fixed. Do not reopen it, and do not revert `13586033` as the fix.

## Reproduce in this repository

Write the regression spec here. The shape: two nodes; the writer's replica lacks the base revision of a block that its multi-collection transaction updates, while the other member holds it; a transaction touching that collection plus an insert-only collection. Assert that every collection lands, or that nothing does.

A scratch attempt from tonight's triage is in the detached worktree at `C:\projects\optimystic-relcheck\packages\quereus-plugin-optimystic\test\scratch-closed-strand-join.spec.ts`. It uses the two-node mock mesh with latency knobs, but it models concurrent writers, not a lagging replica, and it was stopped before producing a result. Reuse whatever helps.

A comparison tree at `13586033`'s parent is in `C:\projects\optimystic-pre13586` (detached at `f8bbf4b6`, not installed). It is available for before-and-after runs.

## Release context

The maintainer wants a release in the morning of 2026-09-18. This ticket is the only thing blocking it. Sereus will re-run its full gate once this lands. The sereus session asks to be told before `dist/` is rebuilt.
