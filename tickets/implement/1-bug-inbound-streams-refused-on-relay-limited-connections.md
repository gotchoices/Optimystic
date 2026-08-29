description: A peer that can only be reached through a relay still cannot be talked to, because the side that answers refuses the call — the recent fix taught our code to place the call but not to accept one.
files: packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/push-state-gossip.ts, packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/test/dial-options-single-site.spec.ts
difficulty: medium
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: The deployment this repo actually ships (`reference-peer`) configures its relays to impose no caps, and libp2p does not gate connections through such a relay — so on that topology the bug is dormant and a maintainer could reasonably wait until a third-party or default-configured relay is in the picture.
----

# Opening a stream over a relay needs both sides to opt in; we only do one

## Background

Some peers — phones, laptops behind a home router, browsers — cannot be dialled directly. They are
reached through a **relay**: a third machine both parties can talk to, which forwards traffic. When
a relay puts a cap on how much data it will forward or for how long, libp2p marks the resulting
connection **limited** and, by default, refuses to carry application traffic over it. Either side
can lift that refusal, but only for itself, and only by asking explicitly.

Ticket `debt-shared-limited-connection-dial-options` fixed the **dialling** side: every place this
package opens a stream now asks for permission to use a limited connection, and a build-time guard
(`test/dial-options-single-site.spec.ts`) stops a future call site from forgetting.

The **answering** side was never touched. Every protocol this package serves is registered without
that opt-in, so the peer being called refuses the stream libp2p just let the caller open. The two
halves have to agree; today they do not.

## Why this is a real defect and not a hypothetical

libp2p performs the same check in both directions
(`libp2p/dist/src/connection.js` — line 80 for the outgoing side, line 170 for the incoming one):
if the connection carries limits and the relevant options do not say `runOnLimitedConnection: true`,
it throws `LimitedConnectionError`. On the incoming side the options it consults are the ones passed
when the protocol handler was registered.

Every registration in `packages/db-p2p/src` omits it:

| Protocol | Registered at |
| --- | --- |
| sync (block restoration) | `sync/service.ts:58` |
| cluster | `cluster/service.ts:190` |
| repo | `repo/service.ts:138` |
| dispute | `dispute/service.ts:60` |
| block transfer | `cluster/block-transfer-service.ts:140` |
| cohort-topic request/response | `cohort-topic/stream-util.ts:101` |
| cohort-topic register / gossip / promote / membership / sign | `cohort-topic/host.ts:2813, 2833, 2842, 2847, 2859` |
| reactivity notify | `reactivity/notify-transport.ts:129` |
| reactivity push-state gossip | `reactivity/push-state-gossip.ts:276` |

The one place in the tree that *does* pass it is a test helper
(`test/open-protocol-stream-relay.spec.ts`), which is why the new relay spec passes while production
would not.

## When a user hits it

Whether a relayed connection carries caps is the relay operator's choice, and libp2p's own default
is to impose them. So:

- **Hit:** any node relayed through a stock libp2p relay, a third-party relay, or a node built with
  `createLibp2pNode({ relay: true })` and no `relayServerInit` override.
- **Not hit:** the `reference-peer` deployment, whose CLI passes
  `{ reservations: { applyDefaultLimit: false } }` (`packages/reference-peer/src/cli.ts:389`) to lift
  the caps. With no caps there is nothing to gate, so neither side's opt-in matters.

The user-visible effect on a hit is silence that reads as absence: block restoration reports "no
peer had this block" when a peer did have it; a cohort member appears not to answer. Nothing errors
in a way an operator can act on.

## Expected behavior

A peer reachable only through a limited relay connection can both make and serve every Optimystic
protocol call, exactly as a directly-connected peer does.

## Shape of the fix

Mirror the shape the dialling side just landed rather than sprinkling one more flag across nine
call sites:

- One registration helper in `db-p2p` — the counterpart of
  `src/network/open-protocol-stream.ts` — that every protocol registers through, with the limited-
  connection opt-in baked in as a constant rather than an option, so a new protocol gets it without
  its author knowing the flag exists. The per-protocol settings that legitimately vary
  (`maxInboundStreams` / `maxOutboundStreams`, the inbound-authorization wrapper, middleware) stay
  parameters.
- Extend `test/dial-options-single-site.spec.ts` (already a TypeScript-AST walk over
  `packages/db-p2p/src`) to also treat a direct `.handle(` on a libp2p node or registrar as a
  violation outside that helper. That is what makes this the last time either half of the pair is
  forgotten.

**Confirming it first.** The claim above is read from libp2p's source, not observed. What would
confirm it: in `test/open-protocol-stream-relay.spec.ts` (which already builds a relay with caps
applied), register a second protocol on the relay-only peer **without** the opt-in and assert the
dialer's stream never reaches the handler, alongside the existing flagged protocol as the positive
control. Worth landing as part of the fix regardless — it pins the premise the way
`test/relay-third-party-address-gap.spec.ts` pins its own.

## Out of scope

FRET (`p2p-fret`) registers its own protocol handlers and is a separate package; whether its
handlers opt in is an upstream question, not this ticket's.
