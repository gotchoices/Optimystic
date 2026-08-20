description: A helper this project borrowed from its networking library was removed and replaced with a different pair of functions that put a small length marker in front of every message. Nothing here was updated, so the package no longer loads at all. Move the affected message protocols onto the replacement, changing both the sending and receiving side of each one together.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/push-state-gossip.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/cohort-topic/stream-util.spec.ts, packages/db-p2p/test/reactivity/notify-transport.spec.ts, ../Fret/packages/fret/src/rpc/protocols.ts, ../Fret/packages/fret/src/index.ts
difficulty: hard
repro: verified
----

# Move `db-p2p`'s single-frame protocols onto FRET's `sendFramed` / `readFramed`

## Current state (verified)

`@optimystic/db-p2p` does not load, and its test suite does not compile:

```
$ cd packages/db-p2p && node -e "import('@optimystic/db-p2p').then(()=>console.log('OK')).catch(e=>console.log('FAIL: '+e.message))"
FAIL: The requested module 'p2p-fret' does not provide an export named 'readAllBounded'

$ node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/stream-util.spec.ts"
Exception during run: src/cohort-topic/stream-util.ts(19,10): error TS2305: Module '"p2p-fret"' has no exported member 'readAllBounded'.
```

Root `resolutions` pins `p2p-fret` to `portal:../Fret/packages/fret`, and `../Fret` commit `f5f2eb6`
removed the exported `readAllBounded`, exporting `sendFramed` / `readFramed` in its place. The whole
`db-p2p` test suite is red for this one reason — there is no partial baseline to preserve.

`../sereus` links `@optimystic/db-p2p` through its own `resolutions`, so its build is down for the same
reason; it has the blocker recorded at `tickets/blocked/linked-optimystic-broken-by-fret-framing-change.md`
and cannot fix it from its side.

## Decision: adopt FRET's framing (not an inlined copy, not a compatibility alias)

The originating `fix/` ticket left three options open. Adopt the framing. The evidence:

**The wire-compatibility objection does not survive inspection.** The argument against framing was that
published `db-p2p` v0.24.0 peers would stop interoperating. But `f5f2eb6` also converted FRET's *own*
four RPC protocols — `maybeAct`, `ping`, `neighbors`, `leave` — from bare `stream.send` + read-to-end
onto `sendFramed` / `readFramed`. Since `db-p2p` always compiles against that working tree, a node
built today already cannot talk to a v0.24.0 node at the FRET routing layer, and cohort-topic depends
on FRET routing to locate cohort members at all. Preserving cohort-topic's wire format buys
interoperability with peers that are already unreachable.

**Framing is already this repository's convention.** `protocol-client.ts`, `cluster/service.ts`,
`repo/service.ts`, `sync/service.ts`, `dispute/service.ts` and `cluster/block-transfer-service.ts` all
encode with `it-length-prefixed` (`lpEncode`/`lpDecode`) — the identical varint-prefix format
`sendFramed`/`readFramed` produce. Adopting it makes cohort-topic and reactivity consistent with the
rest of `db-p2p` rather than the lone exception. **Those files are out of scope** — they already frame
correctly and pair with each other; do not touch them.

**The alternatives are worse.** Inlining the pre-`f5f2eb6` `readAllBounded` re-adopts the end-of-stream
polling bug FRET's own `readFramed` doc-comment records fixing (it polled stream-level EOF every 20 ms
while delivered bytes could still sit in two buffers below that state, raising a spurious truncation
error on a healthy connection). Asking FRET for a compatibility alias runs against the design decision
recorded verbatim in `../Fret/packages/fret/src/index.ts:150-152`.

**Correct one stale doc claim while you are in there.** `stream-util.ts:4-7` says these protocols
"exchange a single self-delimiting cohort frame each way (the db-core wire codec already
length-prefixes the body)". The body's internal codec prefix is not what the reader used —
`readAllBounded` delimited on stream EOF, not on any prefix. After this change the varint prefix is
what actually delimits the frame. Rewrite the paragraph to say that.

## How the replacement differs

| | removed `readAllBounded(stream, maxBytes, timeoutMs?, opts?)` | current `readFramed(stream, maxBytes, timeoutMs?, opts?)` |
| --- | --- | --- |
| reads | every byte until the source ends | exactly one varint-length-prefixed frame |
| paired writer | bare `stream.send(body)` | `sendFramed(stream, body)` |
| empty result | a source that yields nothing returns an empty `Uint8Array` | a source that yields nothing throws `FrameTruncationError`; only an explicit `0x00` prefix returns empty |
| over-ceiling | generic `Error` | `PayloadTooLargeError`, raised at the prefix before any body byte is pulled |
| timeout | 5 s default | same 5 s default (`RPC_TIMEOUT_MS`), unchanged for call sites that pass only `(stream, maxBytes)` |

Two details that shape the work:

**`readFramed` dispatches on what the stream is.** `../Fret/packages/fret/src/rpc/protocols.ts:349`
duck-types a libp2p stream by requiring *all six* of `closeRead`, `addEventListener`,
`removeEventListener`, `send`, `push`, `log` to be functions. Real libp2p streams match and take the
`byteStream` path; every test stub and the mesh harness's `MockStreamEnd` matches none of them and
takes the `lp.decode` iterable path. Both paths are supported and both are correct here — but do **not**
add any of those six methods to a mock while fixing types, or it silently switches paths.

**The error identities are not importable.** `../Fret/packages/fret/src/index.ts` exports only
`validateTimestamp, sendFramed, readFramed, openRpcStream, releaseRpcStream` — the
`FrameTruncationError` / `PayloadTooLargeError` classes and their `isFrameTruncationError` /
`isPayloadTooLargeError` predicates are **not** re-exported from the package root. If a test needs to
assert an identity, match on `err.name === 'PayloadTooLargeError'`; the classes set a stable `name`
precisely for this cross-realm case. Do not deep-import into `p2p-fret` — its `exports` map exposes
only the root entry.

## Complete sender / reader pairing

Every send that a converted read consumes, so nothing desyncs. This map was traced end-to-end; it is
the checklist.

```
  requestResponse (stream-util:78 send) ──────────► handleRequestResponse (stream-util:120 read)
                                                    makeFrameHandler      (host:2877 read)

  handleRequestResponse (stream-util:123 reply) ──► requestResponse (stream-util:80 read)
  makeFrameHandler      (host:2880 reply) ────────►

  sendOneWay (stream-util:97 send) ───────────────► registerNotifyHandler          (notify-transport:132 read)
    ▲ used by Libp2pReactivityNotifyTransport.send  registerPushStateGossipHandler (push-state-gossip:279 read)
      (notify-transport:83) and by
      FretCohortGossipTransport.broadcastOver
      (cohort-gossip-transport:56) — the only
      outbound path for push-state gossip

  MockNode.receive (mesh-harness:231 raw send) ───► whichever handler is registered for the protocol
```

`push-state-gossip.ts` has no `.send` of its own; it rides `broadcastOver`, so converting `sendOneWay`
covers its write side.

## Test blast radius

- `test/cohort-topic/stream-util.spec.ts` — its `makeStream()` fixture (`:20`) yields nothing back,
  documented as "so `readAllBounded` returns empty". Under framing that is a truncated frame, so
  `requestResponse` now rejects and all six of its connection-selection assertions fail. The fixture
  must yield one *valid* framed empty body.
- `test/reactivity/notify-transport.spec.ts:210` — the over-ceiling test's stub yields a raw unframed
  `NotificationV1` with `maxBytes: 4`. It will likely still go green by accident (the frame's first
  byte gets read as a varint that probably exceeds 4), but it would be asserting the wrong mechanism.
  Frame the fixture properly so it tests the real over-ceiling rejection.
- Six files consume `cohort-topic-mesh-harness`, and there are four `.receive(` call sites. Those ride
  on the harness fixes below rather than needing individual edits.
- `test/matchmaking/query-transport.spec.ts` and `test/reactivity/recover-transport.spec.ts` mention
  the helpers only in comments and exercise the inner `handle` callback directly, never the stream
  layer — expected to need no change; confirm rather than assume.
- `test/substrate-real-libp2p.integration.spec.ts` drives real libp2p with both ends converted
  together, so it should pass. It is gated behind `OPTIMYSTIC_INTEGRATION=1` and is not in the default
  run; its runtime has not been measured, so treat it as optional here and say in the handoff whether
  you ran it.

## A tripwire that has now tripped, and must NOT be acted on

`stream-util.ts:11-14` carries a `NOTE:` saying that if FRET ever exports `openRpcStream`, the local
`openStream` duplicate should be deleted in favour of it. FRET now does export it. **Do not make that
swap in this ticket.** `stream-util.ts:28-34` records an accepted tradeoff — deliberately *not* setting
`negotiateFully: false`, because it defers an unsupported-protocol failure from stream-open to the
first read, which would turn `sendOneWay` against a peer lacking the protocol into a silent no-op — and
FRET's `openRpcStream` does set that flag. Swapping would quietly reverse a decision a human already
made. Update the `NOTE:` text to record that the export now exists and that the accepted tradeoff is
why we still keep the local copy, and leave the code alone.

## Definition of done

`node -e "import('@optimystic/db-p2p')"` resolves, `yarn workspace @optimystic/db-p2p build` and
`yarn workspace @optimystic/db-p2p test` both pass, and no `readAllBounded` reference remains in
`packages/db-p2p` (including doc comments).

## TODO

### Phase 1 — production senders and readers

- Convert `src/cohort-topic/stream-util.ts`: import `readFramed, sendFramed` in place of
  `readAllBounded`; `requestResponse` `:78` send and `:80` read; `sendOneWay` `:97` send;
  `handleRequestResponse` `:120` read and `:123` reply.
- Convert `src/cohort-topic/host.ts`: the `:60` import (keep `hashPeerId`), and `makeFrameHandler`'s
  `:2877` read and `:2880` reply.
- Convert `src/reactivity/notify-transport.ts`: the `:26` import and the `:132` read. Its write side is
  `sendOneWay`, already covered.
- Convert `src/reactivity/push-state-gossip.ts`: the `:43` import and the `:279` read. Its write side is
  `broadcastOver` → `sendOneWay`, already covered.
- Verify no `.send(` remains in `src/cohort-topic/` or `src/reactivity/` that feeds a converted reader.

### Phase 2 — the in-process mesh harness

- Widen `MockStreamEnd` in `src/testing/cohort-topic-mesh-harness.ts` to carry what `sendFramed`
  actually writes: `sendFramed` calls `stream.send(lp.encode.single(body))`, which is a
  `Uint8ArrayList`, not a `Uint8Array`. Widen `send`'s parameter, the `inbox` array, and the async
  iterator's yield type to `Uint8Array | Uint8ArrayList`, and return `true` from `send` so its
  signature matches what `sendFramed` passes through.
- Fix `MockNode.receive` (`:231`), which writes a **raw** frame straight into a handler that now
  expects framing. This is the one genuine desync in the harness — miss it and every one-way
  inbound-injection mesh test breaks. Frame it the same way `sendFramed` does.
- Do not add `closeRead` / `addEventListener` / `removeEventListener` / `push` / `log` to
  `MockStreamEnd`; the harness must stay on `readFramed`'s iterable path.
- Update the harness comments at `:100` and `:105`, which describe end-of-stream as the delimiter.

### Phase 3 — tests

- Fix `test/cohort-topic/stream-util.spec.ts`'s `makeStream()` (`:20`) to yield one valid framed empty
  body so `requestResponse` resolves, and rewrite its doc comment.
- Fix `test/reactivity/notify-transport.spec.ts:210` to yield a properly framed oversized frame, so the
  over-ceiling rejection is what is actually being exercised. Asserting the `PayloadTooLargeError`
  identity via `err.name` is a worthwhile strengthening while you are in the fixture.
- Confirm `test/matchmaking/query-transport.spec.ts` and `test/reactivity/recover-transport.spec.ts`
  need no change.

### Phase 4 — docs and verification

- Rewrite the `stream-util.ts:4-7` header paragraph: the varint prefix now delimits the frame, not
  stream EOF, and the reference to reusing `readAllBounded` is stale.
- Update the `:62` NOTE's mention of `readAllBounded` self-timing-out at 5 s — the 5 s bound still
  holds under `readFramed`, only the name changes.
- Update the `notify-transport.ts:12` doc reference.
- Update the `stream-util.ts:11-14` `openStream` NOTE per the section above — text only, no code swap.
- `grep -rn readAllBounded packages/db-p2p` must come back empty.
- Run `yarn workspace @optimystic/db-p2p build` then `yarn workspace @optimystic/db-p2p test`, both in
  the foreground with no redirection.
- Confirm the downstream recovery, since that is where the outage is loudest:
  `cd ../sereus && node -e "import('@serfab/cadre-core').then(()=>console.log('OK'))"`. If `../sereus`
  is not present or its install is stale, say so in the handoff rather than treating it as a failure —
  it is a separate repository and this ticket does not edit it.
