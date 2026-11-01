description: On a slow link, the replies to cohort-topic requests (register, renew, membership, sign, query) are still read under a fixed 5-second limit, so a node that declared a long link round trip can give up on an honest reply. Derive that limit, and the server-side budgets tuned to fit under it, from the declared round trip.
architecture: packages/db-p2p/README.md
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/cold-quorum-wait.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/push-state-gossip.ts, packages/db-p2p/src/rpc-deadline.ts
tradeoffs: Only matters on links whose round trip approaches a few seconds with cohort topics enabled, and the server-side budgets (cold-quorum wait, sign fan-out) must move in step, so it is a coordinated change for a case no deployment has reported failing yet.
----
# Cohort-topic reply reads follow the declared link

Split from `fret-receives-the-link-round-trip`, which hands `NodeOptions.linkRoundTripMs` to FRET's own maintenance deadlines.

Every single-frame read in the cohort-topic, matchmaking and reactivity protocols goes through `readFrame` in `packages/db-p2p/src/cohort-topic/stream-util.ts`, which calls `p2p-fret`'s `readFramed` with its default timeout, `RPC_TIMEOUT_MS` (5 s). That covers the dialer reading a reply in `requestResponse` and every handler reading its request (`handleRequestResponse`, the host's handler in `host.ts`, `notify-transport.ts`, `push-state-gossip.ts`). `readFramed` already takes a `timeoutMs` argument; nothing here passes one.

The server side is tuned against the same 5 s: the host's cold-quorum wait (`cold-quorum-wait.ts`) and the "keep it well under 5 s" note in `host.ts` size their own waits so a reply lands inside the participant's 5 s read. On a 3 s round trip, a register whose handler gathers threshold signatures from the cohort needs several round trips and cannot fit.

## Expected behaviour

- With `linkRoundTripMs` declared, the reply read in `requestResponse` waits long enough for one request/reply round trip plus the handler's own work at that link, derived in `resolveLinkDeadlines` beside the other deadlines and floored at today's 5 s; undeclared, nothing changes.
- The server-side budgets that are sized to fit inside the reply read (cold-quorum wait, sign fan-out) derive from the same number, so the relationship "server answers before the participant gives up" holds at any declared round trip.
- A handler's read of its incoming request frame is a separate question (a stalled sender holds the stream that long) and may keep a shorter bound; decide and document which.
- The README's "Slow relayed links" table lists the new derived values.
