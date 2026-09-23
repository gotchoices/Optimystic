description: A machine no longer files misbehaviour complaints against itself, and a stranger can no longer file them on its behalf, so it cannot be scored out of choosing itself to handle its own data.
architecture: docs/architecture.md#reputation--equivocation
files:
  - packages/db-p2p/src/reputation/peer-reputation.ts (`PeerReputationService.isSelf`, `refuseSelfReport`, the guard in `recordSuccess`, two `NOTE:` tripwires)
  - packages/db-p2p/src/reputation/types.ts (`ReputationConfig.selfPeerId`)
  - packages/db-p2p/src/libp2p-node-base.ts (`createLibp2pNodeBase` — the one production construction site passes `node.peerId.toString()`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`verifySignature` `NOTE:` amended)
  - packages/db-p2p/test/peer-reputation.spec.ts (the one new spec)
  - docs/architecture.md, docs/internals.md, docs/debugging.md, packages/db-p2p/docs/cluster.md
repro: verified
----
# A node penalizes its own peer id, and a stranger can do it for free — done

## What shipped

`PeerReputationService` now describes machines other than the one running it. It takes the node's own identifier as an optional `selfPeerId` on the existing `ReputationConfig`, and a report naming that identifier is refused at `refuseSelfReport` — the one method every report passes through — before any record is created or score computed. `recordSuccess` refuses it too, so no record for the node's own identifier ever exists and `getScore` / `isBanned` / `isDeprioritized` answer 0 / false for it by construction rather than by a second guard. The refusal logs one `peer-reputation` line carrying the identifier, the reason, the caller's context and a running count of refusals.

Putting the guard in the service rather than in the callers is what closes all four reporting arms at once: the two local ones in `cluster-coordinator.ts` (`prevoteLocalPromise`, `collectCommits`), the remotely reachable one in `ClusterMember.validateSignatures`, and `detectEquivocation`. A service built without `selfPeerId` behaves exactly as before, which is why the roughly thirty test constructions needed no change. `createLibp2pNodeBase` is the only production construction site and now passes `node.peerId.toString()` — the same string form `createReconcileBlock` beside it already takes as its own `selfPeerId`.

What a self-ban cost, for the record: degraded routing, not a write outage. `Libp2pKeyPeerNetwork.isSelectable` dropped the node from `findCoordinator`'s cohort tier and `retryCouldImprove` stopped counting it, while the last-resort self tier, `shouldAllowSelfCoordination` and `findCluster` consult no reputation at all. Two forged messages were enough to trigger it remotely (`InvalidSignature`, weight 50 × 2 ≥ the ban threshold of 80).

## Review findings

### Checked and found sound

- **Every reporter reaches the guard.** All the `reportPeer` call sites under `packages/db-p2p/src` were read: `ClusterMember.validateSignatures` (twice) and `detectEquivocation`, `cluster-coordinator.ts`'s `prevoteLocalPromise` and `collectCommits`, `reconcile-block.ts`, `dispute-service.ts`, `coordinator-repo.ts`'s read-repair, `traffic-validation.ts`, and `NetworkManagerService.reportMisbehavior`. There is no second write path into the records map — `getOrCreateRecord` is called from `reportPeer` and `recordSuccess` only, and both are now guarded.
- **One instance, threaded everywhere.** `PeerReputationService` has exactly one production construction site, and that instance reaches `Libp2pKeyPeerNetwork`, `NetworkManagerService.setReputation`, `ClusterMember`, the coordinator repo factory, `createReconcileBlock`, and the cohort-topic host's anti-DoS backing. No component builds its own, so none escapes the guard.
- **The identifier form agrees across the seam.** Every reporter passes either `PeerId.toString()` output or a `record.peers` key a coordinator wrote that way, and the new `selfPeerId` is `node.peerId.toString()`. The `createReconcileBlock` call immediately above uses the identical expression for its own `selfPeerId`, so the two agree by inspection rather than by coincidence.
- **No persistence to migrate.** The records live in one in-memory `Map`; nothing writes them to `NetworkStatePersistence` or a kv store, so a node that banned itself under the old code starts clean.
- **The read surface is narrower than it looks.** `getAllReputations`, `getReputation` and `isDeprioritized` have no production consumer at all — only tests. The only live readers are `isBanned` (from `isSelectable`) and `getScore` (from the two candidate sorts in `libp2p-key-network.ts`). That matters for the first tripwire below, and it is why omitting self from `getAllReputations` costs nothing.
- **The fix makes existing prose true.** The comment at `isSelfAdmissible` in `libp2p-key-network.ts` already reasoned from "self carries no reputation record, so it scores 0 and sorts ahead of every remote candidate" — which was only accidentally true before and is now guaranteed. Left as written; `docs/internals.md` now says which guarantee holds it up.
- **The new spec earns its place and fails without the guard.** It is the bug's reproduction at the lowest layer that reproduces it, with the ban-threshold count chosen so removing the guard fails it, plus a same-service control on another identifier and a no-`selfPeerId` control on the same string. No test was cut: the rest of `peer-reputation.spec.ts` predates this ticket.

### Fixed in this pass

- **The refusal log line could not be attributed.** It carried the reason, context and count but not the identifier, while every other line in the `peer-reputation` namespace carries `peerId=`. The namespace is not peer-id-suffixed, so in this repository's in-process meshes all nodes' reputation lines interleave in one stream and a refusal could not be pinned to a node. It now carries the identifier, truncated to twelve characters like its siblings.
- **Two comparison sites, one claiming to be the only one.** `recordSuccess` compared against `selfPeerId` inline while `refuseSelfReport`'s doc comment claimed to be "the one place a self-report is refused". Extracted `isSelf`, which both now call, and corrected the claim to what it is — the one place a *report* is refused. `isSelf` also requires `selfPeerId` to be set rather than relying on an `undefined === undefined` match, which states the unconfigured contract and removes the only way the refusal path could have been reached with nothing to truncate.
- **A dead branch documenting an absence.** `pruneRecord` ended in an `if` whose whole body was the comment "Don't remove — the caller may still be using this record". An empty statement is not documentation. Removed, and the fact it was standing in for — that records are never evicted — is now stated at the map it applies to, with the ticket that bounds it.
- **Three docs were out of date on the invariant this change introduced.** `docs/internals.md` (the onboarding document AGENTS.md points at) described the equivocation ban with no mention that the table excludes the reporting node, and nothing anywhere explained why the guard sits at the service rather than at its callers — so a future reader would have re-derived the remote arm from scratch. It now carries two paragraphs under its equivocation section with the attack, the bounded cost, and bound citations. `packages/db-p2p/docs/cluster.md`'s attack-mitigation list gained a *No Self-Penalty* bullet beside the reputation bullet this change qualifies. `docs/debugging.md`'s `peer-reputation` namespace row now names the `refused self-report` line, which is the only place a refused local fault is countable and was not discoverable from that table.

### Recorded as tripwires, not tickets

- **The guard compares one spelling of an identity.** `peerIdFromString` accepts more than the canonical `PeerId.toString()` form (a base58btc CIDv1 among them), so an attacker-supplied consensus record can spell this node's id a second way, still bind its real key through `peerIdBindsPublicKey`, and reach `reportPeer` past the comparison. It is inert today, and the reason is worth writing down rather than leaving as the implementer's open question: the only live readers of a score always look up a locally-produced `toString()`, so a record filed under any other spelling is one nothing reads. It becomes a real bypass the moment a reader is added that looks a score up by a string taken off the wire. Parked as a `NOTE:` at `isSelf`, naming the normalization to add if that changes.
- **Records are never evicted, so the map only grows.** Parked as a `NOTE:` at the map declaration pointing at the ticket below, so the next person adding an attacker-keyed collection in this file meets it.

### Filed

- **`tickets/backlog/debt-the-reputation-table-has-no-entry-cap.md`** — the records map has no entry cap, `pruneRecord` trims penalties within a record but never removes the record, and `resetPeer` has no caller anywhere in `packages/*/src`, so the map grows monotonically for the life of the process while a stranger adds one entry per inbound consensus record carrying a freshly minted keypair. Filed at the boundary-invariant rung rather than as a point fix: the root cause is one site (`getOrCreateRecord`), and the rule it should enforce — a collection keyed by a name that arrives off the wire is bounded where entries are created — already has an in-repo precedent in `peer-address-book.ts`, which caps this same unvalidated ingress for exactly this reason. Pre-existing, outside this diff, and unclaimed by any open ticket (site grep across `backlog`, `fix`, `plan`, `implement` and `review` found only this ticket). `repro: static`; the confirming run is named in the ticket.

### Considered and left alone

- The framing residual recorded at `verifySignature` in `cluster-repo.ts` — an attacker can still make this node penalize *another* peer with a forged message carrying that peer's real key. Correctly out of scope: the implementer amended the `NOTE:` to say the residual is now about other peers only, and closing it needs the authenticated membership layer that note already names.
- `NetworkManagerService.isBlacklisted`, which gates `getCluster` / `getCoordinator`. Not a live consumer — the unmaintained duplicate tracked by `debt-network-manager-coordinator-selection-is-a-stale-duplicate`.
- `recordSuccess`'s guard is unreachable in production (`IPeerReputation.recordSuccess` has no production caller). Kept, because it is what makes "no record for this identifier is ever created" a property of the class rather than of its current callers.
- No new spec was added for the remote arm. The gap the implementer flagged is real — nothing exercises `ClusterMember.update()` after the fix — but the arm is a `reportPeer` call with this node's own identifier and it reaches the same guard the new spec pins, so a consensus-level spec would test the path rather than the decision. The ticket ruled on this explicitly and reading the call chain confirmed it.

### Empty categories, and why

- **No major findings inside this diff.** Everything above is either a minor fix applied here or a pre-existing condition in the same file. The change is small, sits at a single choke point, adds no state beyond one string and one counter, allocates nothing, and has no failure path to handle.
- **No accepted-tradeoff `NOTE:` at any site was re-litigated.** The one that exists at `verifySignature` was read; its subject is a residual this change deliberately does not touch, and its stated revisit condition (an authenticated membership layer) has not tripped.

## Verification

Run on the final tree, all from the repository root:

- `yarn test` — every workspace, 6621 passing, 77 pending, 0 failing (6m24s). This closes the implementer's largest stated gap: they had run `db-p2p` only.
- `yarn lint`, `yarn lint:docs`, `yarn build`, `yarn typecheck` — all clean.
- Not run: `yarn test:integration` and `yarn check:rn`. Neither is reachable from a string comparison in an in-memory scoring service plus four comment and markdown edits, and both need setup outside a ticket run.
