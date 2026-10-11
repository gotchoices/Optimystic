description: A node decided which peers belong to its network from the protocols each peer appears to serve, which any connected peer can fake, so a stranger could be picked to store and coordinate this network's writes. The application can now supply an "is this peer one of us?" check, and the key network's cohort and coordinator choices obey it; this needs a review pass.
architecture: docs/internals.md#inbound-stream-authorization
files:
  - packages/db-p2p/src/network-membership-gate.ts (new: `IsNetworkMember`, `NetworkMembershipGate`, `createNetworkMembershipGate`)
  - packages/db-p2p/src/libp2p-key-network.ts (`membershipOf`, `refusedMembership`, `isSelectable`, `getCachedCoordinator`, `heardFromBootstrapPeer`, `unheardBootstrapPeers`, `closeBootstrapWait`, `assembleServingCohortOnce`'s `cohort:membership` line, `membershipOverfetch` NOTE, constructor)
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.isNetworkMember`; the gate is built as `membership` right before `Libp2pKeyPeerNetwork` is constructed)
  - packages/db-p2p/src/repo/client.ts (NOTE at the redirect branch)
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts (`export *` of the new module, both entries)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (two new cases)
  - docs/internals.md (new § *Network Membership Predicate*, cross-linked from the *Inbound Stream Authorization* Scope paragraph), docs/debugging.md (`network-membership` namespace row), docs/architecture.md and packages/db-p2p/readme.md (pointers)
----

# The membership predicate gates cohort and coordinator selection — review handoff

Reported by sereus (security, ranked fourth); their write-up is `C:\projects\sereus\tickets\blocked\stranger-joins-the-control-cohort-by-advertising-protocols.md`. The follow-on ticket `network-membership-predicate-gates-block-pushes` (in `implement/`, prereq on this one) threads the same gate to the four raw-ring senders.

## What was built

- **`NodeOptions.isNetworkMember?: (peerId: string) => boolean`.** Synchronous; only a literal `true` admits. `createNetworkMembershipGate` (new module) wraps it into a total, fail-closed gate: self always admitted, a throw or non-boolean refuses and logs under `optimystic:db-p2p:network-membership:<peer>` (`predicate-threw`, `non-boolean`; a returned promise is also `.catch`-logged so it cannot become an unhandled rejection). Absent predicate → the gate is `undefined` and no check runs anywhere.
- **`createLibp2pNodeBase`** builds the gate once (`const membership`, just before the key network) and passes it as the key network's new ninth positional constructor parameter. The constructor throws if handed a gate without a `protocolPrefix`.
- **`membershipOf`** (the choke point for `findCluster`, every `findCoordinator` tier, `servingCohortAt`, `absentCohortMembers`, `identifiedBootstrapPeerJoiningRing`): after the unscoped and self arms, a refused remote peer is `'foreign'` — returned before `rememberVerdict` and before the `rememberedServing` fallback, so forged lists never enter or are answered from that memory. The memory is not edited on refusal.
- **`isSelectable`** also requires admission (via `refusedMembership`), so a refused peer leaves the cohort-reachable list, the connected fallback, and the `knowable` band behind `retryCouldImprove`.
- **Coordinator cache**: `getCachedCoordinator` re-checks a live hit; a refused pick is deleted and logged `findCoordinator:cache-refused`, and the lookup runs the tiers.
- **`cohort:membership`** log line gains `refused=N`, counted apart from `foreign`.
- **Bootstrap rule** (`heardFromBootstrapPeer`): a configured bootstrap peer the gate refuses is *not yet heard from* when its settled answer says it serves this network — identify answered `'identified'` and its peerStore list serves, or its serving verdict was restored from persistence. A refused peer that answered `'foreign'` (refused identify), or whose identified list does not serve (a same-network relay), is heard from as before. `unheardBootstrapPeers` and `closeBootstrapWait` became async because the identified case needs a peerStore read; the read happens only for refused, identified bootstrap peers. NOTE at the site records the cost (a permanently refused serving bootstrap peer blocks collection creation).
- NOTEs: `membershipOverfetch` (refused peers still take over-fetch slots; remedy is the FRET backlog ticket), redirect branch in `repo/client.ts` (redirect targets are followed ungated, here and in `ClusterClient`).

## Tests added (both in `packages/db-p2p/test/libp2p-key-network.spec.ts`)

- *network-membership scoping* → "a peer refused by the membership predicate is never a cohort member or coordinator": outsider O nearest the key, its peerStore listing `<prefix>/cluster/1.0.0`. Asserts: without a predicate `findCluster` includes O (the fixture reproduces the defect); with a predicate that admits O, `findCoordinator` picks and caches O, then after the predicate starts refusing O the cached pick is re-checked and `findCoordinator` returns the member M, and `findCluster` is `[M, self]`; O restored via `PersistedNetworkState.servingPeers` with an empty protocol list is still excluded; a predicate that throws for O excludes O and the lookup succeeds.
- *bootstrap contact* → "awaits a bootstrap peer the membership predicate refuses while it serves this network, but not one that refused identify": identified + serving + refused → `awaitingBootstrapContact()` true; admitted → false; refused but answered `'foreign'` → false. **This one is beyond the ticket's "one spec"** — I added it because the bootstrap rule is the fork-prevention branch (GitHub #27) with three outcomes, and nothing else pins it. Cut it if you disagree.

## Validation run

- `yarn build` (root): green. `yarn typecheck` (root) and `yarn workspace @optimystic/db-p2p typecheck` (includes `test/`): green.
- `yarn workspace @optimystic/db-p2p test`: 3283 passing, 70 pending, 0 failing. (A first run caught two guards I then satisfied: `entry-parity.spec.ts` requires `export *` lines only, so the module is exported whole — `createNetworkMembershipGate` is public too, from both `index.ts` and `rn.ts`; `logger.spec.ts` requires every namespace documented, hence the `docs/debugging.md` row.)
- `yarn lint:docs`: all resolve.
- **Not run**: `yarn test:integration`, the `quereus-plugin-optimystic` suite, `yarn check:rn`. Without a predicate the key network's behaviour is unchanged (the only always-on change is `unheardBootstrapPeers` becoming async with identical results), so I judged them low-value here; the reviewer may want `check:rn` since `rn.ts` gained a line.

## Known gaps and judgment calls for the reviewer

- **Constructor now has nine positional parameters.** The previous NOTE said to take the options-bag conversion "before a ninth parameter"; the ticket allowed appending if the conversion was not a small diff, and it is ~110 construction sites (99 in the one spec). I appended and rewrote the NOTE to say so and to require the conversion before a tenth.
- **Error code shift, untested**: when the only connected candidates are refused and self is excluded, `findCoordinator` now throws `NO_COORDINATOR_AVAILABLE` ("all candidates excluded") — `isSelectable` drops the peer before `filterByMembership` could set `droppedUnconfirmed` — rather than `NO_NETWORK_COORDINATOR`. Both are failures; neither message names the predicate. Judge whether a predicate refusal deserves its own wording.
- **Fail-closed choice of mine**: for a refused, identified bootstrap peer whose peerStore record cannot be read, `heardFromBootstrapPeer` treats it as serving (not heard). The ticket did not specify this case.
- **The bootstrap wait** closes `'nothing-arriving'` for good when the only arriving bootstrap peer is refused (`identifiedBootstrapPeerJoiningRing` reads it `foreign`). Consistent with the existing "closed for the life of the process" rule; after the predicate admits the peer, lookups pick it up without the wait.
- **`recordCoordinator` still records refused peers** (e.g. a redirect hint); they are evicted on the next hit rather than refused at write. Equivalent in effect, one log line per eviction.
- **Logging volume**: a throwing or non-boolean predicate logs on every classification, unthrottled (debug namespace, so only when enabled). Not parked as a NOTE; add one if you think it matters.
- `NetworkMembership`'s exported type is unchanged (still three values); the refused count is derived in the assembly loop by calling the gate again only for peers that came back `foreign`.

## Usage, for a reviewer exercising it

```ts
const node = await createLibp2pNode({
  networkName: 'net', bootstrapNodes: [...],
  authorizeInboundStream: (remotePeerId) => members.has(remotePeerId),
  isNetworkMember: (peerId) => members.has(peerId)
});
```

With `DEBUG=optimystic:db-p2p:libp2p-key-network*`, an outsider that opened a stream on `/optimystic/net/cluster/1.0.0` shows up as `refused=1` on `cohort:membership` and never in `findCluster`'s peers; `DEBUG=optimystic:db-p2p:network-membership*` shows predicate faults.
