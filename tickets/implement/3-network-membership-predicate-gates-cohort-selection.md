description: A node decides which peers belong to its network from the protocols each peer appears to serve, and any connected peer can fake that, so a stranger can be picked to store and coordinate this network's writes. Let the application supply a "is this peer one of us?" check, and make the key network's cohort and coordinator choices obey it.
architecture: docs/internals.md#inbound-stream-authorization
files:
  - packages/db-p2p/src/network-membership-gate.ts (new: the predicate type and its fail-closed wrapper)
  - packages/db-p2p/src/libp2p-key-network.ts (`membershipOf`, `isSelectable`, `getCachedCoordinator` hit in `findCoordinator`, `heardFromBootstrapPeer`, `assembleServingCohortOnce`'s `cohort:membership` log line, the constructor)
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions`, beside `authorizeInboundStream`; where `Libp2pKeyPeerNetwork` is constructed)
  - packages/db-p2p/src/inbound-authorization.ts (precedent for shape and logging only; not changed)
  - packages/db-p2p/src/index.ts (export the new type)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (existing libp2p doubles with a peerStore)
  - docs/internals.md (new § beside Inbound Stream Authorization)
----

# The membership predicate gates cohort and coordinator selection

Reported by sereus (ranked fourth, security); their write-up is `C:\projects\sereus\tickets\blocked\stranger-joins-the-control-cohort-by-advertising-protocols.md`.

## The defect

`Libp2pKeyPeerNetwork.membershipOf` decides that a remote peer serves this network when its libp2p peerStore protocol list names `<prefix>/cluster/1.0.0` or `<prefix>/repo/1.0.0`. A connected peer can put those protocols into that list two ways, and `authorizeInboundStream` stops neither:

- **Opening a stream.** libp2p 3.3.11's `onIncomingStream` (`dist/src/connection.js`) runs `peerStore.merge` with the negotiated protocol *before* the handler lookup, so a stream the authorization gate then resets has already written the record.
- **Advertising.** The peer registers this network's protocol ids on its own node and identify announces them.

Sereus measured it (2026-10-07): after outsider O opened one refused stream on each members-only protocol of member A, A's `keyNetwork.findCluster` for a control block returned `[O, M, A]`. Every write to that block then sends O the block contents (pend carries the transforms), and counts O toward the cohort.

## Research findings that shape the fix

- **`membershipOf` is the single choke point for cohort and coordinator selection.** `findCluster`, `findCoordinator` (cohort tier through `filterByMembership`, connected-peer fallback, the read tier's assembly), `servingCohortAt` (the cohort-topic root group) and `absentCohortMembers` all classify remote peers through it. A FRET ring member that `membershipOf` refuses never reaches a cohort or a coordinator pick. Gating here therefore closes cohort admission without any FRET change.
- **Two places bypass it.** The coordinator cache (`getCachedCoordinator`, 30-minute TTL by default in `recordCoordinator`) returns a remembered pick without reclassifying it. And `rememberedServing` answers for a peer with an empty protocol list, restored across restarts from `PersistedNetworkState.servingPeers`.
- **Raw-FRET senders also push block contents** (`SpreadOnChurnMonitor`, `RingShiftCoordinator`, `RestorationCoordinator`, `UnderReplicationDrain`'s "pushable" set). Those are the prereq-chained ticket `network-membership-predicate-gates-block-pushes`; together the two close the disclosure inside this repo.
- **FRET's own ring membership** (`classifyByProtocols`) stays forgeable. With both tickets landed it only decides ring routing and the non-root cohort-topic tiers, not who gets database writes — that is hardening, filed as backlog `feat-fret-honours-the-network-membership-predicate`.

## Decisions

- **Separate option from `authorizeInboundStream`.** They answer different questions (may this peer touch my database / is this peer one of us), and they differ in shape: authorization is async with a timeout and runs once per inbound stream; membership must be synchronous because it runs inside the per-peer classification loop of every cohort assembly. Deriving one from the other would force the async predicate into a sync loop or make the sync one take a protocol it does not need. The exposure of an embedder who sets only `authorizeInboundStream` is documented, not derived away (see Docs below).
- **No behaviour change without a predicate.** Requiring identify to have completed before trusting a protocol list was considered and rejected: identify is itself forgeable by advertising, so it would close the refused-stream route only, while on an open network "speaks the namespaced protocol" *is* the membership rule. Absent predicate means today's code path exactly — the gate is `undefined` and no check runs.
- **No reclassify hook in this repo.** The key network reads the predicate live on every classification, so an admitted member counts on the next lookup and a removed one drops out of the next lookup. The only cached verdict (the coordinator cache) is re-checked on hit. A reclassify call is needed only once FRET caches a predicate verdict, which is the FRET ticket's concern.

## The interface

```ts
// packages/db-p2p/src/network-membership-gate.ts
/** Is `peerId` (libp2p base58btc string, `12D3KooW…`) a member of this node's network? Synchronous; keep it an in-memory lookup. */
export type IsNetworkMember = (peerId: string) => boolean;

/** Total, fail-closed form handed to consumers: true only on a literal `true`; a throw or any other value is false, logged. Self is always a member. */
export type NetworkMembershipGate = (peerId: string) => boolean;

export function createNetworkMembershipGate(
	predicate: IsNetworkMember | undefined,
	selfPeerId: string,
	log: (message: string, ...args: unknown[]) => void
): NetworkMembershipGate | undefined;  // undefined when predicate is undefined
```

`NodeOptions.isNetworkMember?: IsNetworkMember`, documented beside `authorizeInboundStream`. `createLibp2pNodeBase` builds the gate once and passes it to `Libp2pKeyPeerNetwork` (prefer turning the trailing positional constructor arguments into an options object over adding a ninth positional argument, if it stays a small diff; otherwise append it). The gate is also what the follow-on ticket threads to the raw-FRET senders, so build it where both can reach it.

`Libp2pKeyPeerNetwork` throws at construction if given a gate but no `protocolPrefix`: the unscoped path skips classification entirely, and production always sets a prefix (`/optimystic/<networkName>`).

## Behaviour in the key network

- **`membershipOf`**: after the unscoped and self arms, a remote peer the gate refuses is `'foreign'`, whatever its protocol list. The refusal returns before `rememberVerdict` and before the `rememberedServing` fallback, so a refused peer is never added to, nor answered from, that memory (forged lists never get persisted). The memory itself is not edited on refusal; a re-admitted peer reads correctly from its protocol list or the memory on the next lookup.
- **`isSelectable`**: also requires the gate's admission (self is admitted by the gate). This drops a refused peer from the cohort-reachable list, the connected fallback, and the `knowable` band that `retryCouldImprove` uses to keep the retry window open.
- **Coordinator cache hit**: a cached pick the gate now refuses is deleted and the lookup falls through to the tiers. Logged once per eviction (`findCoordinator:cache-refused`).
- **`cohort:membership` log line** gains `refused=N`, counted separately from `foreign`, so an operator can tell "another network" from "the predicate said no".
- **`heardFromBootstrapPeer`**: a configured bootstrap peer whose protocol list (or remembered verdict) says it serves this network but which the gate refuses is *not yet heard from*. Reason: a joining node whose predicate has not yet learned its inviter would otherwise see a self-only cohort, rule the shared catalog absent, and found a second one (GitHub #27's failure, through a new door). Fail closed: `awaitingBootstrapContact` stays true, absence is flagged `'cohort-unreachable'`, and the open fails retryably until the predicate admits the peer. A bootstrap peer that does not serve this network (a relay; refused identify) is still heard from, so a node behind infrastructure bootstrap peers is unaffected. Record the cost as a `NOTE:` (a node configured with a bootstrap peer the predicate permanently refuses cannot create collections; the remedy is to drop that peer from the configuration).

## Edge cases & interactions

- **Predicate throws or returns non-boolean** → refused, logged with the peer id via the node's error logger; never thrown into a lookup. Verified by the test below.
- **Self** → always a member; the embedder's predicate may list remote members only (same contract as `authorizeInboundStream`). By inspection of the gate.
- **Refused peer restored from `servingPeers` at start** → never answered from memory (refusal precedes the fallback). Covered by the test.
- **Predicate answer changes while cached**: coordinator cache re-checked on hit (test). `CoordinatorRepo`'s 60 s responsibility cache (`RESPONSIBILITY_TTL_MS`) caches only whether *self* is responsible; the replica set a transaction is sent to is a fresh `findCluster` at transaction time, so a removed peer receives nothing after the change. By inspection; state it in the doc §.
- **Admitted member that the gate refused earlier** → counted on the next lookup from its peerStore list (connected) or after identify; nothing sticky. By inspection.
- **Refused peers crowding the band**: FRET still holds them as ring members near the key, so they occupy over-fetch slots (`membershipOverfetch`, `max(4·clusterSize, clusterSize + 16)`). More refused peers than that nearer a key than the genuine members would shrink the cohort. Not reachable at sereus's scale; leave a `NOTE:` at `membershipOverfetch` naming the FRET ticket as the remedy.
- **Redirects**: `RepoClient` and `ClusterClient` follow a redirect target without consulting the gate. The redirect comes from a cohort member that applies its own predicate, so this needs a member configured without one to matter. Leave a `NOTE:` at the redirect branch in `packages/db-p2p/src/repo/client.ts`; do not gate it here.
- **No predicate** → gate `undefined`; every branch above is skipped. By inspection; the existing suite pins today's behaviour.
- **Related seam**: backlog `1.7-dispute-ejection-registry` wants ejected peers kept out of the same cohort assembly; it can later compose with this gate at `membershipOf` / `isSelectable` rather than adding a parallel filter. Nothing to do here. Likewise backlog `feat-declared-membership-feeds-cohort-assembly` (a declared list as a *placement* input) is a larger change this filter does not pre-empt.
- **Interaction with `authorizeInboundStream`**: unchanged and still needed — the predicate gates who this node *sends to*; authorization gates who may *send to* this node.

## Test (one spec, in `test/libp2p-key-network.spec.ts`)

"a peer refused by the membership predicate is never a cohort member or coordinator": with the existing libp2p double, peer O's peerStore lists `<prefix>/cluster/1.0.0` (what a refused stream leaves behind) and O is in FRET's band; predicate admits everyone but O. Assert:
- `findCluster` excludes O; `findCoordinator` never returns O, including after O was recorded via `recordCoordinator` before the predicate started refusing it;
- O restored through `PersistedNetworkState.servingPeers` with an empty protocol list is still excluded;
- a predicate that throws for O excludes O and the lookup succeeds.

Without the predicate the same fixture includes O (one assertion, proving the fixture reproduces the defect).

## Docs

New § in `docs/internals.md` after *Inbound Stream Authorization*, titled *Network Membership Predicate*: what the protocol list can be forged by (both routes, with the libp2p `onIncomingStream` ordering), the option and its contract (sync, fail closed, self exempt, peer id encoding, cost), what it gates (the choke point, the cache, the bootstrap rule) and what it does not (FRET ring membership and routing, cohort-topic non-root tiers — backlog `feat-fret-honours-the-network-membership-predicate`), and the explicit statement that an embedder supplying only `authorizeInboundStream` is still exposed to being chosen as a cohort member by any peer that opens a stream. Cross-link from the *Inbound Stream Authorization* "Scope" paragraph. Run `yarn lint:docs`.

## TODO

- Add `network-membership-gate.ts` with `IsNetworkMember`, `NetworkMembershipGate`, `createNetworkMembershipGate`; export the type from the package index.
- Add `NodeOptions.isNetworkMember`; build the gate in `createLibp2pNodeBase`; pass it to `Libp2pKeyPeerNetwork` (constructor asserts a prefix is set).
- Gate `membershipOf` (before memory), `isSelectable`, and the coordinator-cache hit; add `refused=` to the `cohort:membership` line.
- Apply the bootstrap "serves but refused → unheard" rule in `heardFromBootstrapPeer`, with its `NOTE:`.
- `NOTE:`s at `membershipOverfetch` and at the redirect branch in `repo/client.ts`.
- Write the one spec above; run `yarn workspace @optimystic/db-p2p test` and `yarn build`.
- Write the internals § and cross-link; `yarn lint:docs`.
