description: On two machines that reach each other only through a relay, every network request opens a fresh stream, which costs a full round trip before the request itself, and each consensus operation still costs two requests. A write takes several relay round trips — under a second on a laptop, several seconds on phones. Design ways to cut the count: reusing streams, and fewer requests per write and per read.
architecture: docs/internals.md#commit-path-distributed-consensus
files: packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts, packages/db-p2p/docs/cluster.md, docs/transactions.md
----

# Fewer relay round trips per write and per read

GitHub: [#29](https://github.com/gotchoices/Optimystic/issues/29)

## Reported (sereus 1.12.0, optimystic 1.10.1, public relay, two-member strand, relay-only)

One insert on Node took 610 ms: pend made 2 `cluster/1.0.0` requests and commit 2, each on a fresh stream. Each request is a stream open (one relay round trip, ~70 ms) plus request and reply (~145 ms per request in all). Relay RTT is ~40 ms, so member to member ~80 ms. Block-transfer pushes run alongside, also on fresh streams.

| | Write (sender) | One `cluster` request |
|---|---|---|
| Node | 0.6–0.9 s | ~145 ms |
| Galaxy S21 Ultra ↔ emulator | 1.6–3.0 s | ~450 ms |
| Galaxy S21 Ultra → Galaxy S7 | 3.6 s | 650–965 ms (open 266–475, reply 365–540) |

Reads: a read of a few rows made five sequential `sync` requests (~0.6 s each on the S21, a fresh stream each); an 8-row chat refresh took 3.3 s. Repro: `message-latency.mjs` and `classic-level-driver.mjs` in the issue, run with `DEBUG=optimystic:db-p2p:protocol-client,optimystic:db-core:network-transactor`, `RELAY_ADDR=<relay multiaddr>`, `ROUNDS=4`.

## Already landed after 1.10.1 (in v1.11.0)

- `cluster-commit-round-carries-the-coordinators-commit-vote`: the coordinator pre-signs its own commit vote, so in a two- or three-member cohort the remote applies on receipt; a consensus operation costs each remote member two calls instead of three.
- `single-coordinator-commit-sends-tail-and-blocks-in-one-round` (`commitInOneRound`): the tail and the other blocks go in one commit when one coordinator covers them; measured 4 `/cluster` calls per two-block write on a two-member mesh, versus 6.
- The promise-round pre-vote (`prevoteLocalPromise`) is about race fairness, not call count.

So the reporter's 4 requests is already the floor for this shape after those changes; 1.11.0 helps only where an action needed tail plus sweep. Worth asking the reporter to re-measure on 1.11.0.

## What remains (the reporter's three questions)

1. **Stream reuse.** Every request opens a new stream, and the open costs one round trip even on an open connection: multistream-select waits for the remote's ack, and `@libp2p/multistream-select@7` ignores `negotiateFully: false` (`stream-open-costs-a-round-trip.spec.ts`). Options: a long-lived per-peer, per-protocol stream with request ids; or getting lazy negotiation honoured upstream in libp2p so the open rides with the first request. This halves every request on a relayed link and is the biggest single win.
2. **Two requests per consensus operation.** Each pend and each commit is a promise round then a commit round. Options: pipeline the two rounds, fold pend and commit for a two-member cohort, or one combined promise-and-commit round when the coordinator's member plus one remote is a majority. Needs a correctness argument against docs/correctness.md (Theorem 1, race resolution, durable commit proofs).
3. **Reads.** Skip or batch the per-block `sync` consult when the reader already holds the latest revision (see the lazy read-repair window and `selfReadVerdict` in docs/internals.md; GitHub #25 covers the slow-peer side). Each block's consult opens its own stream to each peer today; docs/transactions.md notes per-peer batching is not done.

Planning should split these into separate tickets; (1) may need an upstream libp2p change.
