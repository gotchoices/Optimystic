----
description: A peer that can only be reached through a relay gets accepted into a replication group, but none of the other members are ever told how to reach it — so the group looks healthy while replication silently never finishes. The addresses are already being sent over the wire; the receiving side just throws them away.
files: packages/db-core/src/network/i-peer-network.ts, packages/db-p2p/src/peer-address-book.ts (new), packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/repo/redirect.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/relay-third-party-address-gap.spec.ts, packages/db-p2p/test/cluster-service-redirect.spec.ts, packages/db-p2p/test/redirect.spec.ts, packages/db-p2p/test/coordinator-cache-hint.spec.ts, docs/internals.md
difficulty: medium
repro: verified
----
Fixes gotchoices/Optimystic#11. Filed out of `fix/relay-only-cohort-member-addresses-never-reach-siblings`; that ticket's static analysis is now backed by a running reproduction (below), which is already committed as a spec.

## What is broken, plainly

A peer behind a NAT (a phone, a laptop on home wifi) cannot be dialed directly. It reaches the network through a *relay*, and the one address anyone can use to reach it is the relay-qualified address it receives when the relay accepts its reservation.

libp2p tells a peer's address to the peers it is **directly connected to** and to nobody else. There is no relay-side gossip, no reservation-based discovery, and this stack registers no peer-routing service (no kad-dht, no `peerRouters`), so a dialer has no `findPeer` fallback either. A third peer — one that has never had a connection to the NAT'd peer — therefore holds an empty address list for it, and a dial by peer id alone fails immediately.

Replication groups here are chosen by *key position*, not by who happens to be connected. So a NAT'd peer routinely lands in a group alongside peers that have never met it. Those peers report the group as healthy, accept the write locally, and every attempt to reach the NAT'd member dies instantly with `NoValidAddressesError`. Nothing surfaces the condition; the reporter saw clean membership logs on all four devices while a read poll expired after 120 seconds.

## Reproduction (verified, already landed)

`packages/db-p2p/test/relay-third-party-address-gap.spec.ts` is committed and passing (~0.7 s, not env-gated). It boots a relay, a relay-only client, and a sibling that dials only the relay, then asserts both halves of the premise:

```
[pre-merge ] sibling.dial(client.peerId) → NoValidAddressesError: The dial request has no valid addresses
[post-merge] sibling.dial(client.peerId) → ok, via
             /ip4/127.0.0.1/tcp/60609/ws/p2p/12D3KooW9zUf…/p2p-circuit/p2p/12D3KooWEw2s…
```

The merge in between is a single `peerStore.merge(clientPeerId, { multiaddrs: [<the circuit address>] })` — the exact address a `ClusterRecord` already carries. So the cure is proven sufficient in isolation before any of the work below is written. Run it with:

```
yarn workspace @optimystic/db-p2p test --grep "Relay address propagation to a third party"
```

That spec is deliberately an assertion about **libp2p**, not about db-p2p: if a future libp2p makes third-party addresses propagate on their own, its first assertion fails and tells us the application-layer merge has become redundant rather than load-bearing.

## Why the fix belongs at the application layer

The addresses are *already on the wire*, twice over, and both consumers discard them:

- **Cluster records.** `ClusterRecord.peers` is `{ [id]: { multiaddrs: string[], publicKey: string } }` (`db-core/src/cluster/structs.ts:48`), filled from live connections and the peerStore at `libp2p-key-network.ts:914-937`. Every recipient iterates `Object.keys(record.peers)` and dials bare peer ids (`cluster-coordinator.ts:162`, `:650`, `:868`; `cluster/service.ts` on the inbound side). `multiaddrs` is read only for a log count (`cluster-coordinator.ts:534`, `:632`).
- **Redirect payloads.** `RedirectPayload` carries `{ id, addrs }` (`repo/redirect.ts:3`), produced at `cluster/service.ts:139-143` and `repo/service.ts:233`. Both clients then narrow the response to a hand-written `{ id: string }` / `any` and structurally drop `addrs` (`cluster/client.ts:41`, `repo/client.ts:105-111`).

And nothing in this repository ever writes to the libp2p peerStore — a search for `peerStore.merge|patch|save|consumePeerRecord` across `packages/*/src` returns zero hits. The address book the dialer consults has exactly one writer today (libp2p's own identify), and it only ever learns about direct neighbours.

The concrete win: coordinator D1 knows the NAT'd peer N because N bootstrapped through it. D1 coordinates a transaction over `{D1, D2, N}` and sends D2 a record containing N's circuit address. Today D2 reads the peer ids and throws the addresses away; after this change D2 keeps them and can coordinate its own transactions involving N.

## Keep the admission behavior as-is

`libp2p-key-network.ts:930-936` deliberately admits addressless cohort members and says why: shrinking the cohort below `clusterSize` puts the consensus super-majority out of reach. That is a considered decision, not the defect — do **not** change it. The missing half is propagating the address and making the condition visible.

## Design

### The seam: one optional method on the dialer interface

`IPeerNetwork` (`db-core/src/network/i-peer-network.ts`) is the interface every protocol client dials through, and both `ClusterClient` and `RepoClient` already hold it typed (`ProtocolClient.peerNetwork`). Give it the address-book writer:

```ts
export type IPeerNetwork = {
  connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream>;

  /**
   * Optionally teach the dialer how to reach `peerId`, from addresses carried by an
   * application-level message (a cluster record's peer map, a redirect payload).
   * Implementations without an address book omit it.
   */
  recordPeerAddresses?(peerId: PeerId, multiaddrs: string[]): void;
}
```

`multiaddrs` is `string[]`, matching `ClusterPeers` and `RedirectPayload` — db-core has no multiaddr dependency and must not gain one.

Optional, so the in-memory test doubles (`db-p2p/src/testing/mesh-harness.ts`, the stub networks in `test/coordinator-cache-hint.spec.ts` and `test/rpc-response-deadline.spec.ts`) keep compiling untouched. This mirrors the existing optional `recordCoordinator` on `IKeyNetwork` — but put this one on `IPeerNetwork`, because it is a statement about *dialing*, and because doing so lets the two redirect call sites drop the `(this.peerNetwork as any)` cast that `recordCoordinator` forces on them today.

### The implementation: one shared helper, two callers

New module `packages/db-p2p/src/peer-address-book.ts`, the single place in this repo that writes the peerStore:

```ts
/** Cap on addresses merged per peer from one application-level message. */
export const MAX_MERGED_ADDRS_PER_PEER = 8

export function mergePeerAddresses(
  libp2p: { peerId: PeerId, peerStore?: { merge?(id: PeerId, data: { multiaddrs: Multiaddr[] }): Promise<unknown> } },
  peerId: PeerId,
  addrs: string[],
  log: (fmt: string, ...args: unknown[]) => void
): void
```

Rules it must enforce:

- **Never merge for self.** A self entry is meaningless and, for a relay-only self, self-referential.
- **Parse-validate every address**, dropping (with a `WARN` log naming the address) anything `multiaddr()` rejects — same shape as the existing `Libp2pKeyPeerNetwork.parseMultiaddrs` (`libp2p-key-network.ts:814`). Consider having that method delegate here so there is one validator.
- **Cap at `MAX_MERGED_ADDRS_PER_PEER`** after validation. Without a cap, a crafted record could stuff the address book and turn every cohort member into a dial amplifier aimed at an address of the sender's choosing. The cohort's peer *ids* are keyspace-determined and not attacker-chosen, which bounds this further; the cap bounds the per-peer cost.
- **`peerStore.merge` is async**: `void` the promise with a `.catch` that logs. Never swallow silently (AGENTS.md: exceptions should be exceptional, not control flow).
- **Comment the trust boundary at the merge site**, in words close to these: a merged multiaddr only makes a dial *attempt* possible. The dialed peer still authenticates by peer id at the noise handshake, so an address from an unverified record can waste a dial but can never impersonate. This is the whole reason it is safe to consume addresses from a message we have not otherwise verified.

Callers:

- `Libp2pKeyPeerNetwork.recordPeerAddresses(peerId, addrs)` — a thin public delegate, placed next to `recordCoordinator` (`libp2p-key-network.ts:484`).
- The `cluster` service wiring in `libp2p-node-base.ts:549-574`, as a new optional component (below).

### Arm 1 — consume `ClusterRecord.peers[*].multiaddrs`

The wire ingress for cluster records is `ClusterService.processOperation` (`cluster/service.ts:177`), which handles both directions of a consensus round (a member receiving the coordinator's record, and the coordinator's own inbound). Merge every peer entry's `multiaddrs` there, **before** `checkRedirect` and before `cluster.update` — the redirect path dials too.

The service has no `keyNetwork` (it is constructed inside libp2p services, while `keyNetwork` is built after node start, `libp2p-node-base.ts:703`), so add an optional component alongside the existing `getConnectionAddrs`:

```ts
export interface ClusterServiceComponents extends BaseComponents {
  cluster: ICluster
  peerId?: PeerId
  getConnectionAddrs?: (peerId: PeerId) => string[]
  /** Learn dialable addresses carried by an inbound cluster record. Omitted → no address learning. */
  recordPeerAddresses?: (peerId: PeerId, multiaddrs: string[]) => void
}
```

Wire it in `libp2p-node-base.ts:555-573` as a closure over `components.libp2p` calling `mergePeerAddresses` — the same late-binding shape `getConnectionAddrs` already uses there. (If a tidier late binding to `keyNetwork.recordPeerAddresses` is available, that is equally fine; the constraint is only that both paths end at the one helper.)

Also merge on the **coordinator's** side of the same exchange: `ClusterClient.update` (`cluster/client.ts:32`) receives a `ClusterRecord` back from a member. That record arrived over the wire and may name addresses this node lacks. Route it through the same `this.peerNetwork.recordPeerAddresses?.(...)` before returning.

Do **not** merge from dispute-challenge records. `dispute/dispute-service.ts:388-393` states outright that a challenge's `originalRecord` is not otherwise verified on that path; feeding it into the address book widens an already-flagged surface for no gain here. Say so in a comment there if it helps the next reader.

### Arm 2 — consume redirect `addrs`

At `cluster/client.ts:41` and `repo/client.ts:105`, both clients hand-write a narrower response type than the payload actually carries, which is how `addrs` gets dropped. Fix the type, not just the behavior:

- Import `RedirectPayload` from `repo/redirect.ts` and type the redirect branch of the response against it (`repo/client.ts` currently types the whole response `any` — narrow at least the redirect branch).
- Before constructing `nextClient`, call `this.peerNetwork.recordPeerAddresses?.(nextId, next.addrs ?? [])`.
- Order matters: merge **before** the redirect dial, so the very first hop benefits rather than the one after it.

With `recordPeerAddresses` on `IPeerNetwork`, this call needs no cast — unlike the adjacent `recordCoordinator` hop, which still goes through `pn: any` (`cluster/client.ts:85`, `repo/client.ts:157`). Moving `recordCoordinator` to the same interface is *not* in scope; leave it alone.

### Arm 3 — surface the silent half

At the `findCluster` peer-map build (`libp2p-key-network.ts:914-937`), count members whose `parsed` address list came out empty and, when the count is non-zero, emit a loud log line naming the count and the truncated peer ids. Keep the admission behavior exactly as it is; this only kills the clean-logs hang. Fold it into the existing `findCluster:done` line or add a dedicated `findCluster:addressless-members` line — implementer's call, but it must be visible at default log level for the cluster component, not only under `verbose`.

## Testing

Land these alongside the change:

- **Cluster-record ingress.** Extend `test/cluster-service-redirect.spec.ts` (it already constructs a `ClusterService` from stub components — see its `getConnectionAddrs` cases at `:197`): pass a recording `recordPeerAddresses`, feed an update whose `record.peers` carries multiaddrs, assert every non-self peer's addresses were offered, and assert the merge happened on the redirect path too (not only the process-locally path).
- **Redirect ingress, both clients.** `test/redirect.spec.ts` and `test/coordinator-cache-hint.spec.ts` already build stub networks with a recording `recordCoordinator` (`coordinator-cache-hint.spec.ts:64`). Add `recordPeerAddresses` to those stubs and assert each client offers `next.addrs` for the redirect target **before** it dials — a test that only checks "it was called" would pass on a merge placed after the dial, which fixes nothing.
- **Helper rules.** Direct unit tests for `mergePeerAddresses`: self is skipped, unparseable addresses are dropped and logged, the list is capped at `MAX_MERGED_ADDRS_PER_PEER`, a rejected `peerStore.merge` is logged and not rethrown.
- **Premise guard.** `test/relay-third-party-address-gap.spec.ts` is already committed and must keep passing unchanged.
- **End-to-end (best effort).** If the existing real-libp2p integration harness (`test/real-libp2p.integration.spec.ts`, `OPTIMYSTIC_INTEGRATION=1`) can host a relay + relay-only member + two host members without new scaffolding, add the full round: after one coordinated write, the member that never met the relay-only peer dials it by id and succeeds. If it needs substantial new harness work, **do not** build that here — say so in the review handoff and let it be a follow-up, since the unit ingress tests plus the premise guard already cover both ends of the mechanism.

Gate before handoff: `yarn build`, `yarn typecheck`, `yarn test` from the repo root (`db-core` and `db-p2p` both change), plus `yarn lint`.

## Notes for the implementer

- `packages/db-core` is consumed by `db-p2p` and `quereus-plugin-optimystic`; adding an **optional** member to `IPeerNetwork` breaks no implementation. Confirm with `yarn typecheck` after `yarn build` — the tsup/esbuild-built packages strip types without checking them.
- `backlog/debt-shared-limited-connection-dial-options` also proposes touching `db-core/src/network/i-peer-network.ts` (a shared dial-options helper). Different concern, no conflict, but whichever lands second should expect a small merge.
- The general fix for this class lives outside this repo: the Fret routing layer carries bare peer ids with no address fields, tracked as `backlog/feat-address-hints-in-neighbor-exchange` in the Fret repository. This ticket is the in-repo half, and it is worth one sentence in `docs/internals.md` saying that db-p2p learns third-party addresses from its own cluster records and redirects because libp2p propagates addresses only between directly-connected peers.

## TODO

- Add optional `recordPeerAddresses?(peerId, multiaddrs: string[])` to `IPeerNetwork` in `db-core/src/network/i-peer-network.ts`, documented as the address-book writer for application-carried addresses.
- Create `packages/db-p2p/src/peer-address-book.ts` with `mergePeerAddresses` + `MAX_MERGED_ADDRS_PER_PEER`: self-skip, parse-validate, cap, `void`-with-logged-`catch`, and the noise-handshake trust comment at the merge site.
- Implement `Libp2pKeyPeerNetwork.recordPeerAddresses` as a delegate to the helper, beside `recordCoordinator`; have `parseMultiaddrs` share the helper's validator rather than keeping a second copy.
- Merge `record.peers[*].multiaddrs` at `ClusterService.processOperation`, before `checkRedirect` and before `cluster.update`; add the optional `recordPeerAddresses` component to `ClusterServiceComponents` and wire it in `libp2p-node-base.ts` next to `getConnectionAddrs`.
- Merge the peer map of the `ClusterRecord` a member returns to `ClusterClient.update`.
- Type the redirect branch of both clients against the exported `RedirectPayload` and merge `next.addrs` before the redirect dial, in `cluster/client.ts` and `repo/client.ts`.
- Add the addressless-member count + loud log at the `findCluster` peer-map build; leave the admission decision untouched.
- Add a comment at `dispute/dispute-service.ts` recording that challenge `originalRecord` peer addresses are deliberately not merged, and why.
- Write the tests listed above; keep `relay-third-party-address-gap.spec.ts` green.
- Add the third-party-address-learning paragraph to `docs/internals.md`.
- Run `yarn build`, `yarn typecheck`, `yarn test`, `yarn lint` from the repo root and report results honestly in the review handoff, including whether the end-to-end integration case was added or deferred.
