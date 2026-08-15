----
description: A peer that can only be reached through a relay is admitted to replication cohorts, but its address is never shared with the other members — so the cohort looks healthy while replication silently never completes.
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/cluster/service.ts, packages/db-core/src/cluster/structs.ts, packages/db-p2p/test/relay-address-propagation.spec.ts
repro: static — inferred from code plus the reporter's device logs and minimal libp2p repro in gotchoices/Optimystic#11; confirm by extending relay-address-propagation.spec.ts with a third (non-relay) sibling and asserting its dial by peer id succeeds after a cluster round.
----
Filed from the investigation of gotchoices/Optimystic#11 (NAT-only cohort member admitted but undialable; every sibling-initiated dial dies with `NoValidAddressesError`; failure is silent — membership and local writes all report success while the 120s read poll expires).

## Root cause

Nothing in the stack propagates a relay-only peer's dialable address to **third parties**. libp2p's identify/identifyPush only exchanges addresses between *directly connected* peers (that is the scope of the #7 fix and its guard `relay-address-propagation.spec.ts`), FRET messages carry bare peer-id strings with no address fields, and db-p2p itself never writes to the libp2p peerStore — a repo-wide search for `peerStore.merge|patch|save|consumePeerRecord` returns zero matches. So a sibling that was never directly connected to the NAT'd peer has an empty address book for it, and every dial by bare peer id (`libp2p-key-network.ts:553`, reached via `ProtocolClient.processMessage` → `connect()`) throws `NoValidAddressesError`.

The admission side is a **documented deliberate choice**, not an oversight: `libp2p-key-network.ts:930-936` admits addressless cohort members on purpose ("we intentionally do NOT drop addressless members here, because shrinking the cohort below clusterSize puts consensus supermajority out of reach") and even predicts the exact observed error string. Keep that decision — the missing half is propagating the address and surfacing the condition.

## The pointed part: the addresses are already on the wire, then thrown away

- `ClusterRecord.peers` is `{ [id]: { multiaddrs, publicKey } }` (`db-core/src/cluster/structs.ts:48-53`), populated from live connections and peerStore at `libp2p-key-network.ts:914-937`. Every recipient of a `ClusterRecord` — the coordinator's update/commit/broadcast loops at `cluster-coordinator.ts:162`, `:650`, `:868`, and the cluster service handling an inbound record — iterates `Object.keys(record.peers)` and dials bare peer ids. The `multiaddrs` field is only ever read for a log count (`:534`, `:632`).
- Redirect payloads carry `{ id, addrs }` (`repo/redirect.ts:3`, produced by `cluster/service.ts:139-143` and `repo/service.ts:233`), but both clients narrow the response type to `{ id }` and structurally drop `addrs` (`cluster/client.ts:41-48`, `repo/client.ts:110-120`).

So the information needed to dial a relay-only member exists at the moment a cluster record or redirect arrives; it just never reaches the address book the dialer consults.

## Fix arms

1. **Consume `ClusterRecord.peers[*].multiaddrs`**: on receiving a cluster record (member receiving a coordinator's record, coordinator receiving a member's), `peerStore.merge` each peer's multiaddrs before any dial. This closes the return path for the consensus round itself: the coordinator learned the NAT'd peer's `/p2p-circuit` addr from the record the NAT'd peer participated in.
2. **Consume redirect `addrs`**: widen the two clients' response types and merge the offered addrs before following the redirect.
3. **Surface the silent half**: at `findCluster` admission (`libp2p-key-network.ts:930-936`), count and log loudly when a cohort member is addressless at admission time — keep the don't-shrink decision, kill the clean-logs hang. The reporter's cohort reported healthy membership on every node while replication was structurally impossible.

Trust note for arm 1/2: multiaddrs merged into the peerStore only make a *dial attempt* possible; the dialed peer still authenticates by peer id at the noise handshake, so a lying record can waste a dial but cannot impersonate. Worth stating in a comment at the merge site.

## References

- gotchoices/Optimystic#11 — device evidence (n=4, two Android emulators behind NAT + two host drones; drone logs `NoValidAddressesError` 76x while both emulators hold live relay reservations) and a minimal libp2p-only repro proving reservation state is not discovery.
- `relay-address-propagation.spec.ts` — existing guard for the *directly-connected* (relay's own peerStore) half; the gap here is the third-party half it deliberately does not cover.
- Related sibling tickets: `fix/cohort-topic-streams-rejected-on-limited-relay-connections` (this repo), Fret repo `fix/negotiate-failure-marks-peer-foreign-permanently` and `backlog/feat-address-hints-in-neighbor-exchange`.
