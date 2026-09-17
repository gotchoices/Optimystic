description: In a two-machine group where one machine is a phone behind a relay, saving one row takes 50 to 130 network back-and-forths, and the other machine asks the phone for data again on every read even when nothing changed. Over a real relay that makes chat messages take one to four minutes to appear. Separately, when the non-phone machine runs as a storage node, some concurrent writes fail outright.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (live read arm calls `Tree.update()` before every read, ~line 1215)
  - packages/db-core/src/collection/collection.ts (`updateInternal`)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`collectPromises`, the "Failed to get super-majority" shortfall)
  - packages/db-p2p/src/repo/coordinator-repo.ts (commit path)
  - backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold.md (possibly the same class as the storage-node failures)
  - backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds.md (same live-read refresh)
repro: verified
----

# Strand reads and commits cost dozens of round trips, which a relay turns into minutes

Reported from sereus (`tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md` there, which holds the full measurement notes).

## Seen on a device

Sereus device run on 2026-09-16 (sereus `tickets/complete/rn-cross-party-relay-run.md`). A Galaxy Note 9 on the `transaction` profile founded a two-party chat strand. A PC party on the `storage` profile joined it. Every connection between them went through a loopback relay. The phone ran optimystic `7cd71341`.

- Messages converged in both directions, with no errors.
- PC → phone: 8–16 s. Phone → PC: 59–80 s, rising to 163–260 s when both sides sent at once.
- PC inserts took 6.5–16 s, and once 237 s. PC reads of an unchanged table took 18–24 s.

Part of this was sereus's fault: its chat screen polled every 2 s without waiting for the previous read, and that is now fixed. What remains is what one read or one commit costs.

## Measured headless (2026-09-17, sereus `25a5010`, optimystic `ab67fa47`)

Two single-node parties with `listenAddrs: []`, connected only through a dedicated loopback relay. Chat schema (`Participant`, and `Message` with a foreign key to `Participant`). Party A, in the phone's role, on `transaction`. A's relay socket went through a counting TCP proxy. Each operation ran alone. "Exchanges" means direction changes on A's relay socket, roughly two per request/response.

Both parties on `transaction`, no added delay:

| Operation | Time | Exchanges on A's link | Streams opened |
|---|---|---|---|
| A inserts a message | 220–250 ms | 48–64 | 9 `/cluster`, 0–3 `/repo`, 0–2 `/db-p2p/sync` |
| B inserts a message | 300–620 ms | 84–130 | 9 `/cluster`, 12 `/repo`, 0–20 `/db-p2p/block-transfer` |
| B reads `App.Message` (unchanged) | 45–80 ms | 18–30 | 2–7 `/repo` from B |
| B reads `App.Participant` (unchanged) | 32–70 ms | 16–18 | 4 `/repo` from B |
| A reads a table B just wrote | 5–14 ms | 0 | none (B's commit had already pushed to A) |

With 150 ms added each way on A's link, reads took 2–33 s and commits 6–45 s.

## Failures when B runs as a storage node

With B on `storage` and A on `transaction`:

- **No proxy, 3 runs:** 2 passed, and their concurrent commits took 0.9–3.2 s against 0.3 s sequential. 1 failed on a concurrent insert pair with `TornActionError: collection default/app/Data: action … is torn at rev 7 — its log entry is stored but block(s) … do not hold that revision, and the write cannot be finished: stale revision`.
- **Through the proxy, 4 runs:** all 4 failed, 3 with `Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)` and 1 with `cohort-unreachable` on a read. This is weaker evidence, because A also had a connection gater refusing direct dials to the relay port.
- **Traffic:** one A insert set off 32 `/db-p2p/sync` and 15 `/db-p2p/block-transfer` streams from B.

## Questions

1. Must a live read refresh every tree from the network on every statement? It could skip the refresh when a recent refresh, or a push from the cohort, already showed the tree is current. The joiner's 2–9 requests per unchanged read are what polling multiplies.
2. Why does a commit in a two-member cohort need 9 `/cluster` streams and up to 15 `/repo` fetches? Can those round trips be batched?
3. Are the storage-node commit failures, especially the `TornActionError` with no proxy, the same bug as `bug-a-two-member-cohort-refuses-a-commit-both-members-hold`, or a new one?

## Reproducing

In sereus, copy `packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts` and replace its "Data BOTH ways" section with timed inserts and reads. For delayed runs, point A's `relayAddrs` at a local TCP proxy in front of the relay's WebSocket port, delaying each chunk in order. Watch the proxy's byte counter, because A can start dialing the relay directly and bypass the proxy.
