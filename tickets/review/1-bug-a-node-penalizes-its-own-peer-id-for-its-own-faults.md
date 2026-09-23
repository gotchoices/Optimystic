description: A machine no longer files misbehaviour complaints against itself, and a stranger can no longer file them on its behalf, so it cannot be scored out of choosing itself to handle its own data.
architecture: docs/architecture.md#reputation--equivocation
files:
  - packages/db-p2p/src/reputation/peer-reputation.ts (`PeerReputationService.refuseSelfReport`, guards in `reportPeer` and `recordSuccess`)
  - packages/db-p2p/src/reputation/types.ts (`ReputationConfig.selfPeerId`)
  - packages/db-p2p/src/libp2p-node-base.ts (the one production construction site passes `node.peerId.toString()`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`verifySignature` `NOTE:` amended)
  - packages/db-p2p/test/peer-reputation.spec.ts (the one new spec)
  - docs/architecture.md (§Reputation & equivocation)
repro: verified
----
# Review: a node penalizes its own peer id, and a stranger can do it for free

## What changed

The reputation table now describes other machines only. `PeerReputationService` takes an optional `selfPeerId` (a `PeerId.toString()` string) on its existing `ReputationConfig`. A report naming that identifier is refused at the one method every report passes through, before any record is created or score computed. `recordSuccess` refuses it too, so no record for the machine's own identifier is ever created and `getScore` / `isBanned` / `isDeprioritized` answer 0 / false for it by construction. The refusal logs one line — reason, the caller's context string, and a running count of refused self-reports — on the existing `peer-reputation` logger.

The guard sits in the service, not the callers, so all three arms in the ticket are closed by one change: the two local reporters in `cluster-coordinator.ts` (`prevoteLocalPromise`, `collectCommits`), the remotely reachable one in `ClusterMember.validateSignatures`, and `detectEquivocation`. The other reporters that also go through the service (dispute service, read-repair, `reconcile-block`, `NetworkManagerService`, matchmaking traffic validation) pass through the same guard; none of them can name this node in practice, and if one did, refusing it is the intended behaviour.

A service built without `selfPeerId` behaves exactly as before, which is why none of the ~30 existing constructions in specs needed changing. The node factory is the only production construction site and now passes the identity.

The `NOTE:` at `verifySignature` in `cluster-repo.ts` gained two lines saying the framing residual now applies to other peers only; the membership-layer residual it describes is untouched. `docs/architecture.md` §Reputation & equivocation gained one sentence beside the health-monitor sentence.

## What a self-ban cost, for the record

As the ticket corrected: a self-ban degraded routing (`Libp2pKeyPeerNetwork.isSelectable` dropped this node from the cohort tier of `findCoordinator`; `retryCouldImprove` stopped counting it), and did not cause a write outage — the last-resort self tier and `shouldAllowSelfCoordination` never consulted the ban, and `findCluster` applies no reputation filter. Two forged messages were enough to trigger it remotely (weight 50 × 2 ≥ ban threshold 80). Reproduced by the prior run with a scratch spec driving `ClusterMember.update()` twice from an unrelated key; that spec was deleted, per the ticket.

## Test added

- `peer-reputation.spec.ts` — "never records reports naming its own identifier, and scores every other identifier as before". One spec, three assertions, at the service layer: (1) with `selfPeerId` set, two `InvalidSignature` reports naming it (enough to ban any other identifier) plus a `recordSuccess` leave `getScore` 0, `isBanned` false and no entry in `getAllReputations`; (2) two identical reports naming a different identifier in the same service still ban it; (3) a service built with no `selfPeerId` bans the same identifier after the same two reports. Removing the guard fails (1). No `ClusterMember.update()`-level spec was added, per the ticket: the remote arm reaches the same guard.

## Verification run

- `yarn workspace @optimystic/db-p2p test` — 3112 passing, 63 pending, 0 failing.
- `yarn build`, `yarn typecheck`, `yarn lint:docs` from the root — all clean.

## Known gaps and things for the reviewer to weigh

- Not run: `yarn test` for the other workspaces, `yarn test:integration`, `yarn check:rn`. The change touches only db-p2p and one optional config field, so I did not expect them to move, but I did not run them.
- The end-to-end remote reproduction (two forged `ClusterMember.update()` calls) was not re-run against the fix; the unit spec covers the decision, and the remote arm is a `reportPeer` call with this node's own id, but nothing exercises that call chain after the change. If the reviewer wants that confirmed, the scratch spec described in the ticket is the recipe.
- The "logged with a running count" behaviour is the ordinary `debug` logger (`createLogger('peer-reputation')`), visible only with debug logging on, like every other reputation line. The count lives on the service instance and is not queryable; the ticket settled that on purpose (no new getter until something needs to read it). Nothing tests the log line.
- Comparison is exact string equality against `PeerId.toString()`. Every reporter I read (`cluster-coordinator.ts`, `cluster-repo.ts`, `NetworkManagerService`, `coordinator-repo.ts`) passes `toString()` output or a record key a coordinator wrote that way; I did not audit peer-id strings that arrive from the wire in other encodings, and did not add normalization, as the ticket specified.
- No new tripwires were introduced. The residual framing of *other* peers by a forged message carrying a victim's real key remains open and is recorded in the existing `NOTE:`; it needs an authenticated membership layer.
