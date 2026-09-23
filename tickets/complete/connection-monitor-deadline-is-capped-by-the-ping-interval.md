description: Our React Native guidance told a slow phone to give peers 30 seconds to answer a keepalive ping, but the setting could never deliver more than 10, because a second ping starting while the first is still waiting kills the connection. The guidance now says to space the pings further apart than the deadline, a test on two real nodes shows both halves, and the setting the rule depends on carries a note so a future change to it cannot silently falsify the guidance.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.connectionMonitor` doc comment; the `NOTE:` at `ping: ping()`)
  - packages/db-p2p/readme.md (the React Native connection-monitor paragraphs)
  - packages/db-p2p/test/connection-monitor-ping-overlap.spec.ts (new)
  - packages/db-p2p/test/connection-monitor-node-wiring.spec.ts (cross-reference only)
source: sereus review of libp2p 3.1.3; reproduced here on two optimystic nodes at libp2p 3.1.3 / @libp2p/ping 3.0.10
----
# The connection monitor's deadline is capped by its ping interval

No production behaviour changed. Two documents were telling deployments to configure something that does not work; they now state the rule that does, a spec on two real nodes reproduces both halves of it, and the third-party setting the rule rests on carries a note at its own site.

## What the defect was

libp2p's connection monitor opens a ping stream on a fixed interval whether or not the previous ping has answered, and it pings on the same protocol the `@libp2p/ping` service serves — a service every node here registers, and which allows one outbound ping stream per connection. So a second ping to a peer still owing an answer is refused before it leaves the node, the monitor cannot tell that refusal from a late reply, and it aborts the connection. A peer therefore gets `min(pingTimeout.minTimeout, pingInterval)` to answer. Our React Native guidance raised `minTimeout` to 30 s and left the interval at its 10 s default, so it bought 10 s.

The correction in both documents is the working shape — `{ pingInterval: 35_000, pingTimeout: { minTimeout: 30_000, maxTimeout: 30_000 } }` — the mechanism behind it, and what it costs (a dead peer is reclaimed within about `pingInterval + minTimeout`, not held for a `maxTimeout`-long grace period, which is the reading the old `maxTimeout: 600_000` example invited).

## Review findings

### What was checked

The implement diff was read first, then every factual claim in it was re-derived from the dependencies as installed, rather than taken from the handoff:

- `libp2p@3.1.3` `connection-monitor.js` — the ping loop is a bare `setInterval` with no wait on the previous ping, on `/${protocolPrefix ?? 'ipfs'}/ping/1.0.0`, and it never calls `AdaptiveTimeout.cleanUp`. Both claims hold.
- `libp2p@3.1.3` `connection.js` — `findOutgoingStreamLimit` reads `maxOutboundStreams` off the registrar's handler options and falls back to the caller's only when the protocol is unhandled, so the ping service's limit does govern the monitor's streams. `newStream` runs multistream-select *before* counting, which is why the far side sees the refused ping too.
- `@libp2p/ping@3.0.10` — `MAX_OUTBOUND_STREAMS = 1`, `MAX_INBOUND_STREAMS = 2`.
- `@libp2p/utils` — `AdaptiveTimeout` clamps into `[minTimeout, maxTimeout]` and reads zero while the moving average is zero; `MovingAverage`'s weight is `1 - exp(-dt/span)` over `interval`, default 5 000 ms. The handoff's decay arithmetic (about 87 % of a new sample at a 10 s interval, essentially all of it at 35 s) is correct.

Beyond the diff: the whole tree was swept for any other place that configures a connection monitor (`connectionMonitor`, `pingTimeout`, `pingInterval`). Nothing else sets one — no bootstrap, relay, demo or React Native composition root carries the broken shape — so there was no in-repo deployment to fix and no third document to correct. The only other file that discusses the option is the wiring spec's header, which the implement stage already cross-referenced.

Run, all clean, before and after the edits below: `yarn lint`, `yarn lint:docs`, `yarn lint:deps`, `yarn workspace @optimystic/db-p2p typecheck`, `yarn workspace @optimystic/db-p2p build`, and the full `db-p2p` suite (3111 passing, 63 pending, 0 failing, ~2 min). The new spec was additionally run four times standalone — 2 passing, 3 s, stable each time. `yarn lint:deps` closes one of the handoff's own "not run" caveats; `test:integration` and `check:rn` were still not run, and still cannot be affected, since after this review the diff is comments, one spec file and one readme section.

### Found, and fixed in this pass (minor)

- **Both documents contradicted themselves about libp2p 3.3.** One paragraph said the recommended shape sets `maxTimeout` equal to `minTimeout` so the deadline stays pinned there once libp2p starts adapting; the next said the move to 3.3 "starts the deadline adapting upward from `minTimeout` toward `maxTimeout`". Read on its own — which is how a reader arriving at a `NOTE:` reads it — the second says the recommended shape adapts, when the equal clamp is precisely what stops it. Both now say the adaptation is what a `maxTimeout` left *above* `minTimeout` buys, and that the recommended shape pins the deadline on 3.3 as well.
- **`ping: ping()` carried nothing.** The whole documented rule rests on that construction being bare, so that `@libp2p/ping`'s `maxOutboundStreams: 1` is what the registrar reports for the protocol. A later change there — an application wanting parallel pings is the obvious reason — would silently retire the rule and falsify both documents and the new spec, with nothing at the site to say so. It now carries a `NOTE:` naming the three things to re-check.
- **`maxInboundStreams: 2` in the new spec was an unexplained number** in a spec whose whole subject is stream limits, where a reader can easily take it for the limit under test. It is neither: it restates `@libp2p/ping`'s own inbound default, which the `force` re-registration would otherwise drop back to the registrar's, and two is what the overlap arm needs because select runs on the far side before the dialer refuses its own second stream. Said so in the helper's comment.

### Tests

Both arms were weighed for whether they pay for themselves, and both were kept; none were cut and none added.

- The **overlap arm** is the reproduction of the defect the ticket exists for, at the lowest layer that reproduces it — two real nodes, no mock of anything this repository owns. It is the tripwire that fires when a libp2p upgrade makes the documented rule unnecessary or untrue.
- The **patient arm** was the weaker of the two on the handoff's own reckoning, and is kept because it pins the shape both documents now instruct deployments to use: its content is that with the interval above the deadline the abort is a timeout rather than an overlap. Its `elapsedMs >= deadline` bound is deliberately the tight one given where the clock starts — the dialer's ping interval is already running when the connection registers, so the first ping can fire immediately after the dial, and a bound tied to `interval + deadline` would be the flaky one.

The one place the spec reaches into third-party internals — shadowing `Connection.abort` on the instance — was examined and left alone. It is the only seat from which the error the monitor gives up on is visible, and its failure mode is honest: an upgrade that stops routing the error through `conn.abort` fails the spec on a missing abort with a named message, not a false pass.

### Declined, with reasons

- **Nothing was filed as a ticket.** Every finding was minor and fixed in place; nothing reached the filing bar, and nothing turned out to be a latent defect in our own code — this ticket's subject is a third-party interaction we configure around.
- **`libp2p-node-base.ts` is 2 054 lines** (`wc -l`), up 28 from 2 026 before this ticket, all of it doc comment. Size-debt on a file a doc-only ticket touched is not this ticket's to file, and a comment is not the kind of length that motivates a split.
- **The readme section and the `NodeOptions.connectionMonitor` doc comment now carry near-identical prose.** That duplication predates this ticket, the audiences differ (an app author reading the readme, a caller reading the type), and the existing mitigation — each document telling the reader to re-check the other on a libp2p move — is the right weight for it. Not worth a ticket, and not worth collapsing into a pointer.
- **The libp2p 3.3 figures remain inherited rather than measured**, as the handoff said: this tree is pinned at 3.1.3, so nothing here exercises 3.3. What was verified is the mechanism, from the installed `@libp2p/utils`; the "4 of 4 intermittent stalls still dropped" figure is the ticket's own 3.3.11 measurement and is attributed as such in the `NOTE:`. Re-measuring it would mean installing a libp2p this repository does not run.
- **No tripwire was parked in a `docs/` file.** The one concern that needed parking has a single exact code site, which is where it went.
