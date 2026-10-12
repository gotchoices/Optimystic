description: A node decided which peers belong to its network from the protocols each peer appears to serve, which any connected peer can fake, so a stranger could be picked to store and coordinate this network's writes. The application can now supply an "is this peer one of us?" check, and the key network's cohort and coordinator choices obey it.
architecture: docs/internals.md#network-membership-predicate
files:
  - packages/db-p2p/src/network-membership-gate.ts
  - packages/db-p2p/src/libp2p-key-network.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/repo/client.ts
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts
  - packages/db-p2p/test/libp2p-key-network.spec.ts
  - docs/internals.md, docs/debugging.md, docs/architecture.md, packages/db-p2p/readme.md
----

# The membership predicate gates cohort and coordinator selection — complete

Reported by sereus (security); their write-up is `C:\projects\sereus\tickets\blocked\stranger-joins-the-control-cohort-by-advertising-protocols.md`. Follow-on `network-membership-predicate-gates-block-pushes` (in `implement/`) threads the same gate to the background replication senders; backlog `feat-fret-honours-the-network-membership-predicate` covers FRET's own ring.

## What shipped

- `NodeOptions.isNetworkMember?: (peerId: string) => boolean` — synchronous, fail-closed (only literal `true` admits; throw / non-boolean refuses and logs under `network-membership`), self always admitted, absent → no check anywhere. `createNetworkMembershipGate` builds the total form once in `createLibp2pNodeBase`; it is the key network's ninth positional constructor parameter (the constructor refuses a gate without a `protocolPrefix`).
- `membershipOf` reads a refused remote peer as `foreign` before the protocol list and before the remembered serving verdict, so forged lists never enter or are answered from that memory. `isSelectable` refuses it too; the coordinator cache re-checks every hit (`findCoordinator:cache-refused`); `cohort:membership` counts `refused=` apart from `foreign`.
- Bootstrap rule (`heardFromBootstrapPeer`): a configured bootstrap peer the predicate refuses while it serves this network is not yet heard from, so a joiner whose predicate has not learned its inviter flags absences instead of founding a second catalog (GitHub #27). A refused peer that refused identify, or whose identified list does not serve this network, is heard from as before.
- Docs: new § Network Membership Predicate in `docs/internals.md`, pointers from the Inbound Stream Authorization scope paragraph, `docs/architecture.md`, `packages/db-p2p/readme.md`, and the `network-membership` namespace row in `docs/debugging.md`.

## Review findings

Read the `ticket(implement): network-membership-predicate-gates-cohort-selection` diff first, then the handoff.

**Fixed in this pass**

- **Stale remembered verdict outranked a fresh identify answer for a refused bootstrap peer.** `membershipOf` returns before touching `rememberedServing` for a refused peer, so that memory is never refreshed for it. The implemented rule checked the memory before the identified list, so a refused bootstrap peer restored as serving that now identifies as not serving (a former member turned relay) held the node in "awaiting bootstrap contact" forever — no collection creation, every absence flagged. Reordered `heardFromBootstrapPeer`: identify's `'foreign'` is heard; an `'identified'` answer is judged on its list; only an unanswered peer falls back to the memory. Pinned by a new arm in the existing "awaits a bootstrap peer the membership predicate refuses…" spec (fails on the old order). Doc comment updated to say which source wins.
- **Misleading comment** at the `knowable` retry filter in `findCoordinator` said the membership filter is "deliberately NOT applied"; true of the protocol-list classification, not of the predicate, which `isSelectable` now applies. Added a sentence saying the predicate's refusal is settled and so nothing to wait for.

**Tripwires parked (NOTE: at the site)**

- `heardFromBootstrapPeer`: the identified list is the peerStore's, which a hostile *configured* bootstrap peer can keep "serving" by opening a stream on this network's `cluster` protocol, holding the node in the awaiting state. Remedy if seen: judge on identify's own captured list.
- `createNetworkMembershipGate`: a faulty predicate logs once per classification, unthrottled (debug namespace). Remedy if it floods: once per peer per fault kind.

**Checked, no change**

- Every peer-choice path in `Libp2pKeyPeerNetwork` (`findCluster`, all `findCoordinator` tiers, `servingCohortAt`, `absentCohortMembers` via `servingPeersOutside`, `identifiedBootstrapPeerJoiningRing`, `filterByMembership`) classifies through `membershipOf` or `isSelectable`; self passes the gate everywhere.
- Other construction sites: `quereus-plugin-optimystic`'s `resolveKeyNetwork` prefers the node's attached key network (which carries the gate); its fallback only applies to a host-injected node that `createLibp2pNode` did not build and so has no predicate to honour.
- Constructor at nine positional parameters: the NOTE now requires the options-bag conversion before a tenth; the deferral (≈110 sites) is reasonable and recorded.
- Error-code shift (all connected candidates refused → `NO_COORDINATOR_AVAILABLE` rather than `NO_NETWORK_COORDINATOR`): both are failures and the `refused=` count on `cohort:membership` names the cause; no separate wording needed.
- Fail-closed treatment of an unreadable peerStore record for a refused, identified bootstrap peer (treated as serving → not heard): consistent with the fork-prevention direction; the cost is in the existing accepted-cost NOTE.
- `recordCoordinator` accepting a refused peer: evicted on next hit; equivalent effect.
- Async conversion of `unheardBootstrapPeers` / `closeBootstrapWait`: all callers await; with no predicate the peerStore is never read there.
- Tests: kept both implementer specs. The cohort/coordinator spec reproduces the defect (no predicate → outsider admitted) then pins cache re-check, persisted-verdict override and throwing predicate. The bootstrap spec pins the three-outcome fork-prevention branch, which nothing else covers. Nothing cut — neither restates the implementation nor verifies a mock.
- Docs: read every touched doc plus `docs/internals.md` § Inbound Stream Authorization; all reflect the shipped behaviour after this pass. `yarn lint:docs` resolves.

**Validation**

- `yarn workspace @optimystic/db-p2p build`, `typecheck`: green.
- `yarn workspace @optimystic/db-p2p test`: 3283 passing, 70 pending, 0 failing (before the final comment-only edits; re-ran the key-network, logger and entry-parity specs after them: 281 passing).
- `yarn check:rn`: passed (`rn.ts` gained an export).
- `yarn lint:docs`: all resolve.
- Not run: `yarn test:integration` — the predicate is off unless supplied and no integration spec supplies it; the only always-on change (`unheardBootstrapPeers` async) is covered by the unit bootstrap specs.

**Major findings / tickets filed**: none — nothing past the filing bar; remaining gaps are already owned by `network-membership-predicate-gates-block-pushes` and `feat-fret-honours-the-network-membership-predicate`.
