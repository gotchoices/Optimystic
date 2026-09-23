description: Our React Native guidance told a slow phone to give peers 30 seconds to answer a keepalive ping, but the setting could never deliver more than 10, because a second ping starting while the first is still waiting kills the connection. The guidance now says to space the pings further apart than the deadline, and a test on two real nodes shows both halves.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.connectionMonitor` doc comment)
  - packages/db-p2p/readme.md (the React Native connection-monitor paragraphs)
  - packages/db-p2p/test/connection-monitor-ping-overlap.spec.ts (new)
  - packages/db-p2p/test/connection-monitor-node-wiring.spec.ts (cross-reference only)
source: sereus review of libp2p 3.1.3; reproduced here on two optimystic nodes at libp2p 3.1.3 / @libp2p/ping 3.0.10
----
# The connection monitor's deadline is capped by its ping interval

No production code changed. This ticket corrected two documents that were telling deployments to do something that does not work, and added the reproduction that backs them.

## What was confirmed, and how

The defect was confirmed by reading the installed dependencies and then reproducing it on two real nodes.

Reading, at `libp2p@3.1.3` and `@libp2p/ping@3.0.10` as installed:

- `ConnectionMonitor` (libp2p) opens a ping stream every `pingInterval` inside a bare `setInterval`, with no wait on the previous ping, on `/${protocolPrefix ?? 'ipfs'}/ping/1.0.0`.
- `@libp2p/ping` — registered by `createLibp2pNodeBase` as `ping: ping()` — serves that same protocol and registers it with `maxOutboundStreams: 1`.
- libp2p's `Connection.newStream` resolves the outbound limit from the **registrar's** handler options (`findOutgoingStreamLimit`), so the ping service's `1` governs the monitor's streams. A second stream while the first is open throws `TooManyOutboundProtocolStreamsError`, the monitor's single `catch` cannot distinguish it from a late reply, and `abortConnectionOnPingFailure` (default on) aborts the connection.

Reproduced, in `packages/db-p2p/test/connection-monitor-ping-overlap.spec.ts` — two `createLibp2pNode` nodes over loopback TCP, the listener's ping handler replaced with one that accepts the stream and never echoes:

| arm | `pingInterval` | `minTimeout` | abort observed at | abort error |
| --- | --- | --- | --- | --- |
| overlap | 300 ms | 5 000 ms | ~680 ms | `TooManyOutboundProtocolStreamsError`, message `Too many outbound protocol streams for protocol "/ipfs/ping/1.0.0" - 2/1` |
| patient | 2 000 ms | 700 ms | ~2 700 ms | `AbortError`, message `This operation was aborted` |

So on our own stack a peer gets `min(minTimeout, pingInterval)` to answer, and raising the interval above the deadline restores the deadline in full.

## What changed

- **`NodeOptions.connectionMonitor` doc comment** (`packages/db-p2p/src/libp2p-node-base.ts`) — now states the interval rule and the mechanism behind it, carries the working shape `{ pingInterval: 35_000, pingTimeout: { minTimeout: 30_000, maxTimeout: 30_000 } }`, says a dead peer is reclaimed within about `pingInterval + minTimeout`, and points at the new spec.
- **The readme's React Native section** (`packages/db-p2p/readme.md`) — same correction, the example updated to the working shape, and one honest note: the phone measurement quoted there ran with the default 10 s interval, so the deadline it actually bought was 10 s, not the 30 s its `minTimeout` reads like.
- **The 3.3 tripwire NOTE** — was "from then on one slow peer lengthens the deadline for every connection on the node", which over-promises. It now says 3.3's adaptation lasts a single ping: the moving average decays over `pingTimeout.interval` (5 s by default, read off the installed `@libp2p/utils` `AdaptiveTimeout` and `MovingAverage`), shorter than any ping interval a patient deadline can use, so the next fast reply puts the deadline back at `minTimeout`. The 4-of-4 intermittent-drop figure is carried over from the ticket's 3.3.11 measurement.
- **`connection-monitor-node-wiring.spec.ts`** — one sentence, cross-referencing the new spec, since its header said `pingTimeout` behaviour is "deliberately not tested here" and now part of it is.

Unchanged on purpose, both per the ticket: the package still substitutes no `connectionMonitor` default of its own, and `ping()` is still constructed with no `maxOutboundStreams` override.

## Tests

One new spec file, two tests, ~3 s total:

- `packages/db-p2p/test/connection-monitor-ping-overlap.spec.ts` → *"aborts the connection at the ping interval, not at the configured deadline"* — reproduces the defect: the abort error is `TooManyOutboundProtocolStreamsError` and it lands inside the configured deadline.
- same file → *"gives the peer the whole deadline once the interval is longer than it"* — pins the shape both documents now recommend: with the interval above the deadline the pings do not overlap and the peer gets the whole deadline.

Both bounds are one-sided in the safe direction (the overlap arm bounds from above with roughly 7x headroom, the patient arm from below), and the clock starts before the dial so neither depends on a timer being punctual. Ran 5 times, stable.

## Validation run

- `yarn build` — clean.
- `yarn test` (root, full fan-out) — 6m 44s, every workspace passing, no failures. Log at `tickets/.logs/connection-monitor-ping-interval.test.log` (git-ignored, self-pruning).
- `yarn lint`, `yarn lint:docs`, and `typecheck` in `db-p2p` — clean.
- Not run: `yarn test:integration`, `yarn check:rn`, `yarn lint:deps`. No dependency changed and the only source edit is a doc comment, so none of the three can be affected — but they were not run, so a reviewer should not read this as "the full `yarn check` gate passed".

## Known gaps, for the reviewer

- **The libp2p 3.3.x claims are inherited, not measured here.** This tree is pinned at `libp2p@3.1.3` / `@libp2p/ping@3.0.10`, so nothing in the new spec exercises 3.3. What was verified by reading the installed `@libp2p/utils` is the *mechanism*: `AdaptiveTimeout` clamps to `minTimeout` while its moving average is zero, and `MovingAverage`'s span is `pingTimeout.interval`, default 5 s, with weight `1 - exp(-dt/span)` — so at a 10 s interval a new sample carries about 87% and at 35 s essentially all of it. The "4 of 4 intermittent stalls still dropped" and "34.6 s reclaim" figures come from the ticket's own 3.3.11 measurement, taken on a node that did **not** register the ping service.
- **The 34.6 s figure is deliberately absent from both documents.** It was measured without the ping service registered, so it does not describe an optimystic node; quoting it would have implied a reclaim time our stack does not have under the old configuration. The documents state the `pingInterval + minTimeout` formula instead, which the patient arm demonstrates at 2 s / 0.7 s but which nothing here measures end-to-end at the recommended 35 s / 30 s — that spec would burn about 65 s of wall clock, over the cheapness bar the ticket set.
- **"The phone measurement actually ran with a 10 s deadline" is inference, not a re-measurement.** It follows from the phone running the ping service and the interval being left at its default, and it is the same inference the whole ticket rests on, but nobody re-ran the phone.
- **The spec observes through a monkey-patched `Connection.abort`.** The error the monitor gives up on is passed there and retained nowhere else. If a libp2p upgrade stops routing it through `conn.abort`, the spec fails on the absence of an abort (with a named message) rather than passing for the wrong reason — but it is an instance-level shadow of a third-party method, and a reviewer may reasonably want a different seat.
- **The new spec pins third-party behaviour, not ours.** Its header says so and names the three upgrades that would break it (monitor awaits its previous ping, monitor moves off the ping service's protocol, ping service raises `MAX_OUTBOUND_STREAMS`) — each of which is the signal to re-check both documents, not to relax the assertion. If the reviewer judges that this belongs in prose rather than in a spec, the second arm is the one with the weaker claim to exist: the first is the reproduction of the defect, the second pins the recommendation.
