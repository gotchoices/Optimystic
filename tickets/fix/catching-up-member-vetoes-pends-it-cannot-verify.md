description: A cohort member that has just joined and is still pulling blocks approves a pend on a block it holds no committed revision of, then rejects the next pend on that block as `unmaterializable` because of the pending record the first one left. One reject of three fails the write with a non-retryable `ValidatorRejectionError`. Reported from sereus on 1.12.0; seen on both strand and control networks.
files: packages/db-p2p/src/cluster/cluster-repo.ts (validatePendOperations ~1776-1803; content check ~2493), packages/db-p2p/src/storage/storage-repo.ts (get, the `unavailable = 'unmaterializable'` arms ~390-420), packages/db-p2p/src/repo/coordinator-repo.ts (commit, the `local-executed` durability gate ~2820-2832)
repro: verified (in the sereus workspace; mechanism from debug logs)
difficulty: medium
----
Reported from sereus (`@optimystic/*` 1.12.0). Sereus ticket: `tickets/blocked/fresh-strand-replica-vetoes-writes-while-catching-up`. Sereus paths below are relative to the sereus workspace.

# A fresh strand replica vetoes the phone's writes while it catches up

## Symptom

`strand-always-on-replica-hosts-cross-party-join` > "launches a replica from the party-wide join and stops it when the phone leaves" fails in step 3, while the phone writes its `after-replica` rows right after its strand node connects to the always-on machine's new replica. Two fingerprints, both thrown from the phone's `App.Data` commit (`TransactionBridge.commitTransaction` → `Collection.syncAttempts`):

1. `ValidatorRejectionError: Transaction rejected by validators (1/3 rejected): <replica>: block <id> unavailable (unmaterializable): cannot verify revision`, thrown out of `NetworkTransactor.pend`. Not retried.
2. `SyncRetryExhaustedError: sync for collection default/app/Data exhausted 10 retries: commit-not-durable: 0 of 3 cohort member(s) report holding rev 8 of action … (local-executed)`. Seen once, in a full `yarn check` on 2026-10-07 (optimystic 1.11.0 build); the test passed twice alone afterwards.

## Measured rate (optimystic 1.12.0, Sereus `adopt optimystic 1.12.0`)

| run | result |
| --- | --- |
| 4 copies of the file in parallel | 4 of 4 passed |
| 8 copies in parallel, 3 rounds | **6 of 24 failed**, all with fingerprint 1 |

A passing run spends about 5 s in the test; the full-suite failure spent 22 s retrying.

## What the logs show (one failing run, `DEBUG=optimystic:db-p2p:coordinator-repo*,optimystic:db-p2p:cluster*`)

1. The replica's strand node is in the 3-member cohort for an `App.Data` block (`cluster-tx:cluster-members`, phone + host + replica) while it is still pulling the strand's blocks at rev 1 (`cluster-fetch:synced` on its `coordinator-repo` logger, same second).
2. The next pend on that block reaches the replica, which **approves** it (`action-promise-complete`) and persists the pending record, although it holds no committed revision of the block.
3. About 0.5 s later, the following pend on the same block reaches the replica. Its `storageRepo.get` now flags the block `unmaterializable`: it holds a pending record proving the block exists, but no committed base to promote it over (`StorageRepo.get`, the `held === undefined` decline arm). `validatePendOperations` turns any `unavailable` answer into a reject (`cluster-member:validation-block-unavailable` → `validation-rejected`).
4. One reject of three fails the pend, and the writer does not retry a `ValidatorRejectionError`.

So the replica's vote is inconsistent: it approves the first write it cannot check and vetoes the second because of the record the first one left. Fingerprint 2 is the same window seen from the commit side: the coordinator's durability gate counted no member as holding the revision. It was not reproduced with logging on, so the exact arm is unconfirmed.

## Second instance: the control database (`owner-anchor-follows-owner-changes`)

Found while reviewing `owner-anchor-follows-owner-key-changes`, on the cadre's control network rather than a strand. Same fingerprint 1: `Transaction rejected by validators (1/3 rejected): <peer>: block <id> unavailable (unmaterializable): cannot verify revision`, plus `The stream has been reset` from a second member, thrown out of B's `authorizePeer` (a `CadrePeer` insert). A has just added B as an owner (`addOwner`) and B has just received its own `OwnerKey` row; B's write lands about 1.5 s after A's.

| run (with `cadre-invite-any-member`, `cadre-invite-row-unreplicated`, `enrollment-e2e` alongside) | result |
| --- | --- |
| M's `controlCohort.reconcileMs` at 2 s (B writes ~1.5 s after A) | **2 of 3 failed** |
| M at the default 15 s (B writes ~15 s after A) | 3 of 3 passed (8 of 8 in the implement pass) |

Not diagnosed further: no debug logs were taken, so which member rejected, and whether it holds a pending record without a committed base as in step 3 above, is unconfirmed (`repro: verified` for the rejection, `static` for the mechanism). The scenario keeps M at the default interval and carries a `NOTE:` at its `REFRESH_MS`.

## Proposed upstream change (for the optimystic maintainer)

A cohort member that cannot establish a block's revision should not decide the vote alone. Either:

- **(A, recommended)** withhold its vote instead of rejecting when the block is `unavailable`, and let the remaining members' super-majority decide. (The content check at `cluster-repo.ts` ~line 2493 already declines to judge an unmaterializable base, though there "abstain" means approve without attesting content.) The fail-closed posture is kept by the quorum, not by one member that knows its answer is a guess. Or
- **(B)** keep the reject but return it in a retryable shape, so the writer re-drives after the member's catch-up (the backfill lands within about a second here) instead of failing the transaction.

Either way, approval and rejection must agree: a member that rejects a pend it cannot verify should not approve the first such pend either.

## Reproduce

In sereus: run `packages/integration-tests/src/scenarios/strand-always-on-replica-hosts-cross-party-join.integration.ts` as 8 copies in parallel for 3 rounds (`yarn workspace @serfab/integration-tests exec vitest run strand-always-on-replica-hosts-cross-party-join`); about 1 in 4 fail in step 3. An optimystic-local test should cover a 3-member cohort where one member joins with no committed base for a block and receives two consecutive pends on it: both pends must succeed (with option A) or the second must fail retryably and succeed after catch-up (option B), and the member's two votes must agree.
