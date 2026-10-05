description: A writer whose clock is more than the transaction timeout behind has every write refused as "Transaction expired", but the coordinator records the refusal as a peer that never answered, so the writer sees "0 rejections", retries uselessly, and penalizes the honest peer that refused it.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (record validation throws `Transaction expired` when `record.message.expiration < Date.now()`; `handleExpiration` already signs a reject with that reason)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (promise round: a member's thrown error becomes `null` and is reported as `PenaltyReason.ConsensusTimeout`; the `cluster-tx:supermajority-failed` branch and its "Failed to get super-majority: … (needed N, 0 rejections)" message)
  - packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/cluster/service.ts (the error envelope that already carries the member's reason back)
  - docs/correctness.md (§7.4 clock assumption), docs/debugging.md
  - tickets/backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text.md (the super-majority text is matched downstream to retry a silent cohort)
difficulty: medium
repro: reported
severity: wrong-result
likelihood: unusual

# A writer refused for clock skew is reported as silence

GitHub issue #24: https://github.com/gotchoices/Optimystic/issues/24. Not a request to drop the
"clocks roughly synchronized" assumption; about what happens when a node breaks it.

## Repro (from the issue)

reference-peer 1.8.0, two local peers, no relay. Peer B writes with `Date.now` shifted by a `--import` preload.

```
skew (ms)  result
0          ok
-20000     ok
-45000     Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections) / The stream has been reset
3600000    ok
writer's debug log: 8 x "error: Error: Transaction expired"
penalties charged to the refusing peer: reason=consensus-timeout weight=5 (8 reports from one write)
```

The window is the transactor's `timeoutMs` (30 s). Behind by more fails; ahead succeeds. Seen in the field on an
Android emulator whose clock had drifted 29 h.

## What is wrong (verified against HEAD)

1. The member's reason comes back (error envelope, rethrown by `ClusterClient.update`), but the coordinator's promise
   round turns any throw into `null`, indistinguishable from no answer, so it lands in `supermajority-failed`
   reporting "0 rejections".
2. A downstream retry matching that text (meant for a silent cohort) retries a decided failure.
3. The honest peer is charged `ConsensusTimeout` per attempt; enough attempts deprioritize it.

## Fix direction

- Have the member refuse an expired record with a signed `reject` vote (as `handleExpiration` does) rather than
  throwing, or have the coordinator classify a returned error envelope as an answer, not silence. Either way it
  counts as a rejection and does not penalize.
- Surface a typed, non-retryable error naming the expiration and the apparent skew (the member can report its
  clock), so an app can tell the user to fix the clock.
- Tests: coordinator spec with a member refusing as expired; assert rejection count, no `ConsensusTimeout`
  penalty, non-retryable error.
