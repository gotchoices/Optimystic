description: An application looking for matchmaking partners from a node that happens to sit in its own topic's cohort has no supported way to let that node answer its own registrations, renewals and queries, so it either fails loudly or quietly loses its place in the queue; the node should offer that hook ready-made.
architecture: docs/matchmaking.md#arrival-push-on-provider-arrival
files: packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/matchmaking/query-transport.ts, packages/db-p2p/src/matchmaking/module.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
tradeoffs: It widens the node's public attachment surface with a matchmaking-specific handle, and in small deployments the cost today is only a fallback to slower polling (renew) or a loud error the application can catch (register/query), so a maintainer could defer it until a real application hits it.
----
# The node offers a ready-made matchmaking self-serve binding

## The situation

A seeker's libp2p walk transport (`createLibp2pMatchmakingTransport` in `packages/db-p2p/src/matchmaking/query-transport.ts`, and the `createLibp2pMatchmakingSeekerSession` built on it) sends its register, query, renew and withdraw messages to whichever cohort member the routing names. libp2p cannot dial its own node, so when that member is the seeker's own node the transport needs an in-process answer: the optional `MatchmakingSelfServe` hooks (`register`, `query`, `renew`). Without them a self-routed register or query throws, and a self-routed renew or withdraw is logged and skipped.

In a small deployment every node is in every cohort, so this is the ordinary case, not an edge. With arrival push now live (ticket `matchmaking-arrival-push-wiring-and-e2e`), a push-path walk hangs out for up to its whole patience, and a skipped renew lets its seeker record lapse after one 10 s TTL — after which no member selects it for pushes and the walk degrades to its safety poll.

The only way to build those hooks today is to reach the node's cohort-topic host through an untyped cast — `(node as unknown as { cohortTopicHost }).cohortTopicHost` — and bind `renew` to `resolveRenew(host.registry, r, now)` from `packages/db-p2p/src/cohort-topic/host.ts`. The real-socket test case 5d in `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts` does exactly that, and a production application would have to copy it. `cohortTopicHost` is deliberately not on `OptimysticNodeAttachments` (see backlog `debt-node-attachment-reads-bypass-typed-surface`, "Out of scope").

## What should be true

- A node built with `cohortTopic.enabled` offers, on its typed attachment surface beside `matchmakingArrivalPush`, a `MatchmakingSelfServe` that serves all three self-routed messages from that node's own cohort engines — register through the same admission path an inbound `/register` frame takes, query through the same handler an inbound `/query` frame takes, renew/withdraw through `resolveRenew`.
- `createLibp2pMatchmakingSeekerSession` (or the transport) uses it by default when built over such a node, so an application gets correct self-routed behavior without wiring anything.
- Case 5d drops its cast.

## Notes

- The self-served answers must be indistinguishable from the remote ones — same admission, rate-limit and validation — or a seeker that is its own cohort member gets a different matchmaking result from one that is not.
- Related: `feat-matchmaking-real-libp2p-sweep-ports` needs the same self-serve binding for a swept shard whose primary is the seeker itself.
