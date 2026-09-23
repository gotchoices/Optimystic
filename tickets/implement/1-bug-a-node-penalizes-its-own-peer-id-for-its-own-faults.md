description: A machine files misbehaviour complaints against itself, and any stranger on the network can file them on its behalf. Enough complaints and the machine stops choosing itself to handle its own data.
architecture: docs/architecture.md#reputation--equivocation
files:
  - packages/db-p2p/src/reputation/peer-reputation.ts (`PeerReputationService` — where the guard goes)
  - packages/db-p2p/src/reputation/types.ts (`ReputationConfig` — gains the identity field)
  - packages/db-p2p/src/libp2p-node-base.ts (the one production construction site — "Initialize peer reputation service")
  - packages/db-p2p/src/cluster/cluster-repo.ts (`ClusterMember.validateSignatures` — the remotely reachable reporter; the `NOTE:` at `verifySignature` needs one clause amended)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`prevoteLocalPromise`, `collectCommits` — the two local reporters)
  - packages/db-p2p/src/libp2p-key-network.ts (`isSelectable` — the only live consumer a self-ban reaches)
  - docs/architecture.md (§Reputation & equivocation)
difficulty: easy
repro: verified
----
# A node penalizes its own peer id, and a stranger can do it for free

## What is wrong

Every machine keeps a score for each machine it deals with and stops preferring one whose score gets bad enough. The score is meant to describe *other* machines. Nothing in it excludes the machine keeping it, so this machine's own identifier sits in the same table as everyone else's and is treated the same way.

Three places put it there. Two are local: when this machine's own copy of the database throws during a consensus step, the coordinating code records that throw as a penalty against this machine. The third is not local at all — a peer that can open a connection can make this machine penalize itself, with no local fault involved, and that is the arm that matters most.

## The remote arm (found while reproducing; not in the original report)

`ClusterMember.validateSignatures` in `packages/db-p2p/src/cluster/cluster-repo.ts` checks every vote signature on every inbound consensus record and, when a signature fails, records a penalty against the peer the signature is attributed to — but only when the public key attached to that peer is provably the key that peer's identifier names (`verifySignature` returns `penalize: true` only after that binding check). For an Ed25519 peer the public key *is* derivable from the identifier, and identifiers are public. So a sender can attach this machine's own identifier, this machine's own real public key, and a junk signature. The binding check passes, the signature check fails, and this machine records a penalty against itself while the sender records nothing.

That penalty is weight 50 and the ban threshold is 80, so **two such messages ban this machine's own identifier in its own table**. The validation runs inside `processUpdate` before any membership or authorization check, and the per-stream authorization hook (`authorizeInboundStream`) is off unless an embedder supplies one, so the two messages need no standing whatsoever.

Reproduced by the prior run on this ticket with a spec driving `ClusterMember.update()` twice from an unrelated key: this node's own score reached ~100 and `isBanned` was true for its own identifier, while the sender's score stayed 0. That spec was scratch and was deleted; the permanent test this ticket asks for is the unit-level one below, which reproduces the same defect at its own layer.

The existing `NOTE:` at `verifySignature` already records that an attacker can frame *another* peer this way and that closing it needs an authenticated membership layer. That residual is untouched here and stays open. Framing *this* machine is a different matter: a machine has no business judging itself from a message a stranger sent, and that half closes completely at the scoring service with no membership layer needed.

## The two local arms

Both are in `packages/db-p2p/src/repo/cluster-coordinator.ts`:

- `prevoteLocalPromise` hands the record to this node's own cluster member before the promise round fans out. When that member throws — a validation failure, a merge failure, a storage fault — the catch records a `ConsensusTimeout` penalty against this node's own identifier.
- `collectCommits` reports a `ConsensusTimeout` penalty for every member whose delivery failed. This node's own identifier is in that list whenever `presignLocalCommit` returned false, which it does when there is no local member in the cohort or when the member threw.

`ConsensusTimeout` is weight 5, so sixteen of these inside one half-life window (30 minutes) reach the ban threshold — the arithmetic the original report described.

A fourth site, `detectEquivocation` in `cluster-repo.ts`, would report this machine for `Equivocation` (weight 100, an immediate ban) if two validly-signed opposing votes from this machine's own key ever reached it. That needs this machine's own private key, so it is not remotely forgeable, but the same guard covers it.

## What a self-ban actually costs — corrected

The original report said writes the machine is responsible for stop being accepted. That is stronger than what the code does, and the implementer should not go looking for a write outage that is not there. What a self-ban reaches today:

- `Libp2pKeyPeerNetwork.isSelectable` drops a banned identifier from the ranked candidates in `findCoordinator`'s cohort tier, so this machine stops preferring itself to coordinate keys it is responsible for. It falls through to the connected-peer tier, which is remote-only, and then to the last-resort self tier — and **neither the last-resort tier nor `shouldAllowSelfCoordination` consults the ban**, so an isolated machine still selects itself there. The cost is degraded routing and extra fall-through, not a hard refusal.
- `retryCouldImprove` stops counting self among the candidates worth waiting for, so the retry window can close earlier.
- `findCluster` applies no reputation filter at all, so cohort membership is unaffected and `CoordinatorRepo`'s responsibility check still accepts the writes this machine owns.
- `NetworkManagerService.isBlacklisted` gates `getCluster` and `getCoordinator`, and nothing in this repository calls either (the unmaintained duplicate tracked by `debt-network-manager-coordinator-selection-is-a-stale-duplicate`). Not a live consumer; leave it alone.

So the defect is a real and remotely-triggerable self-degradation with a bounded blast radius, not an outage. Say so honestly in the review handoff.

## Expected behaviour

A machine's reputation table describes other machines only. A report naming the machine's own identifier is not recorded and never affects any score, ban or ranking decision — whoever caused the report, and whether the underlying fault was real or fabricated.

Local faults stay visible. Each of the three sites already logs its own failure; the service adds one line of its own when it refuses a self-report, carrying the reason and a running count, so "this machine faulted sixteen times in half an hour" is answerable from the log without any mechanism that can take the machine out of service.

## Two decisions the original report left open — both settled here

**Where the guard goes, and how the service learns its own identity.** In `PeerReputationService`, not in the callers. Fixing the two local callers would have left the third one — the remotely reachable one — wide open, which is exactly what happened: the report named two sites and there were three. A guard at the one place every report passes through cannot be missed by a fourth.

The identity arrives as a new optional field on the existing `ReputationConfig` (`selfPeerId?: string`), which the constructor already accepts, so no call site changes shape. A service built without it behaves byte-for-byte as it does today — which is what keeps the roughly thirty test constructions and any embedder's construction working untouched. The alternative, a required-but-nullable first constructor parameter that would make the node factory's omission a compile error, was weighed and rejected: it buys a compiler check on exactly one production site while churning every test site into passing `undefined`.

**Whether a local fault deserves a record under a different name.** A log line, and no new query method. The dispute subsystem's health monitor is the precedent — count your own faults, do not act on them — and an operator counts a log line without a consumer-less API existing. If something later genuinely needs to read the count, add the getter then.

## Comparison form

Identifiers reach `reportPeer` as strings produced by `PeerId.toString()` at every site (the coordinator's `localCluster.peerId.toString()`, and the record keys a coordinator wrote the same way). Compare strings; do not accept a `PeerId` object and do not normalize.

## TODO

- Add `selfPeerId?: string` to `ReputationConfig` in `packages/db-p2p/src/reputation/types.ts`, documented as the identifier of the machine running this service — reports naming it are never recorded.
- In `PeerReputationService`, read it in the constructor and make `reportPeer` return early for that identifier before any record is created or any score computed. Do the same in `recordSuccess`, so no record for the machine's own identifier is ever created and the read methods answer 0 / false for it by construction rather than by a second guard.
- Log the refusal from the service: the reason, the context string the caller passed, and a count of self-reports refused so far, so a run of local faults is countable from one line.
- Pass `node.peerId.toString()` from the single production construction site in `packages/db-p2p/src/libp2p-node-base.ts` (the `new PeerReputationService()` under "Initialize peer reputation service"; `node` is already in scope there).
- Amend the `NOTE:` at `verifySignature` in `packages/db-p2p/src/cluster/cluster-repo.ts`: the framing residual it records now applies to other peers only, because a report naming this node's own identifier is refused at the service. Do not widen or narrow the rest of that note — the membership-layer residual it describes is unchanged.
- Add one spec for the service covering the reproduction and the fallback: with `selfPeerId` configured, repeated reports naming it leave `getScore` at 0 and `isBanned` false — at a count that bans any other identifier, so the test fails if the guard is removed; reports naming a different identifier score and ban exactly as before; and a service built with no `selfPeerId` scores its own identifier as it does today. One spec, three assertions — this is the bug's reproduction at the lowest layer that reproduces it. Do not add a second spec driving `ClusterMember.update()`: the remote arm reaches the same guard, and a consensus-level spec would test the path rather than the decision.
- Update `docs/architecture.md` §Reputation & equivocation: one sentence after the threshold paragraph saying the table describes other machines only, that a report naming the node's own identifier is logged and never scored, and that this is what stops a fault — or a stranger's forged message — removing the node from its own coordinator selection. Keep it beside the existing sentence about the dispute health monitor, which makes the same point for disputes.
- Run `yarn workspace @optimystic/db-p2p test` and `yarn build` + `yarn typecheck` from the root before handing off.
