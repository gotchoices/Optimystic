----
description: A write that touches two blocks can be committed on one of them and not the other on the same machine. The machine keeps a reservation on the skipped block that nothing ever clears, and from then on it refuses every write any machine makes to that block — permanently. Measured five times out of five in a downstream test suite.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/storage/storage-repo.ts
difficulty: hard
repro: verified
----

# A half-applied multi-block commit leaves a pend nothing can clear

## The observable

A pend that spans **two** blocks is applied on all three cohort members. The commit is then
applied to one of those blocks on all three members, and to the other block on **one** member.
The two members that never applied the second block's commit keep its pending record forever,
and `validatePendOperations` (`cluster-repo.ts:1479`) then rejects **every** later pend touching
that block:

```
Transaction rejected by validators (2/3 rejected):
  pending conflict: block _Paunze… held by unresolved action(s) urFN0UkUeVOk61QtJDkz6A
```

Counted from one traced run, for the single wedging action id:

| event | `_Paunze…` (wedged) | `pPsEZ…` (fine) |
| --- | --- | --- |
| `block-storage pend` | **3** | 3 |
| `block-storage commit` | **1** | 3 |

41 subsequent rejections in that run name `_Paunze…` and only `_Paunze…`. The block stays wedged
for the rest of the process — 50+ seconds and four consecutive downstream tests — and there is no
expiry: a pending record is removed at commit or at cancel, and nothing else.

## Why this is not the two already-fixed orphan tickets

`1-abandoned-pend-holds-the-block` and `3-bug-orphaned-pending-after-divergent-commit` both landed,
and their mechanism — the **in-memory** reservation in `activeTransactions` — is genuinely cleared
now: `CONFLICT_STALE_THRESHOLD_MS` sweeps it in `findConflict`, and an abandoned transaction is
broadcast so members drop it.

This is the **durable** record in storage, checked on a different code path
(`validatePendOperations`'s `pendings` scan, not `findConflict`), and **nothing sweeps it**. The
stale-threshold sweep cannot reach it; it is not in that table.

Two consequences worth stating plainly:

- **It is signed as a rejection**, not as the `conflict` vote kind that
  `2-member-must-answer-a-lost-conflict-race` introduced precisely so a lost race is never counted
  as a "no". A wedged block therefore produces `2/3 rejected` — real rejections — for writes that
  are not in any race.
- **The block is also divergent.** Two members are missing a committed revision the third has, so
  this is not only a stuck reservation: the commit itself was half-applied.

## The tripwire this trips

`block-storage.ts:407` already anticipates this, in the `save` path's Invariant P comment:

> NOTE: deletes only this revision's actionId, not every pending whose action is already
> committed. A broader sweep would repair records orphaned by routes that do not carry the
> committing actionId; **if orphaned pendings ever show up in the field on blocks whose committing
> action id differs, widen to a sweep over listPendingTransactions filtered by getTransaction.**

Orphaned pendings have now shown up. Note the difference from what that note predicted, because it
changes the fix: here the committing action id **is** the same id as the orphaned pend's. The
record is not stale-by-different-action; the commit for this block simply never ran on those two
members while the commit for its sibling block did. So a sweep keyed on "already committed
elsewhere" is one candidate, but the first question is why the two blocks of one action diverged.

## Where to start

1. **Why does one member commit both blocks and the others only one?** All three logged
   `cluster-member:action-consensus` for the commit message. Instrument the path between that
   consensus and `block-storage commit`, per block, and find where the second block is dropped on
   two of the three.
2. **Should a pending record outlive the transaction that wrote it at all?** Whatever the answer to
   (1), a record with no bound and no sweep is a permanent denial-of-service on the block by
   accident. A time bound, a sweep against committed state, or a cancel broadcast on the commit
   path would each convert "wedged forever" into "wedged briefly".
3. **A wedged block should say so.** This cost the downstream repo weeks across several tickets
   because the symptom presented as an ordinary vote shortfall. The same medicine as
   `1-repair-deadlock-is-never-named` applies: name the condition where it is detected.

## Reproducing

The downstream Sereus repo reproduces it **5 runs out of 5** at `@optimystic/db-p2p` 0.27.0
(commit `a878e4b8`):

```
cd ../sereus/packages/integration-tests
DEBUG='optimystic:db-p2p:cluster-member,optimystic:db-p2p:block-storage,optimystic:db-p2p:coordinator-repo*' \
  yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts
```

Every round: 5 failed / 2 passed of 7. The first test passes, the second wedges the block, and the
rest die on the same block and the same action id. To find it in a fresh log:

```
grep -o "unresolved action(s) [A-Za-z0-9_-]*" <log> | sort | uniq -c     # the wedging action id
grep -oE "block-storage (pend|commit) blockId=[A-Za-z0-9_-]+ actionId=<id>" <log> | sort | uniq -c
```

The pend/commit counts are the whole diagnosis: three pends and one commit on the wedged block.

Note it was **intermittent until tonight** — roughly 1 run in 3 across August, 7/7 green twice
earlier the same day, then 5/5 red. Something about machine state moves the rate a long way, so
treat a green run as luck rather than as evidence of a fix, and re-measure in a series.

## Downstream context

Sereus tracks the symptom as `tickets/blocked/control-write-hears-zero-approvals-from-healthy-trio`,
blocked on this repo since 2026-08-12. Its five-run unblock gate is what produced these numbers.
The downstream retry classifier was checked and is behaving correctly — it matches the pend-phase
`[block:` token, and re-presenting a pend-phase aggregate is safe by design — so the retries are
right and merely futile against a pend that never clears. No downstream change is expected from
this ticket beyond retiring the block once it lands.

## TODO

- [ ] Reproduce with per-block instrumentation between commit consensus and `block-storage commit`.
- [ ] Answer why one member applies both blocks and two apply one.
- [ ] Decide the durability policy for a pending record whose transaction is gone: sweep, time
      bound, or explicit cancel on the commit path.
- [ ] Name the wedged-block condition in a log line an operator can grep.
- [ ] Re-run the downstream scenario as a series (≥ 5), not once.
