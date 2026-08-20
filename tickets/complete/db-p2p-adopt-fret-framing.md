description: The project's peer-to-peer message protocols were moved onto the networking library's new length-prefixed framing helpers, restoring the package after the library removed the helper this code depended on. A review pass followed, which made the "must always reply" rule a compiler-enforced type, added the missing tests for the new framing contract, and corrected the documentation.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/push-state-gossip.ts, packages/db-p2p/src/reactivity/recover-transport.ts, packages/db-p2p/src/matchmaking/query-transport.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/cohort-topic/stream-util-framing.spec.ts, docs/cohort-topic.md
----

# `db-p2p` moved onto FRET's `sendFramed` / `readFramed`

## What shipped

`@optimystic/db-p2p` failed to load because FRET (`p2p-fret`, portal-linked from `../Fret`) removed
its exported `readAllBounded` (read every byte until stream end) in favour of `sendFramed` /
`readFramed` (write/read one varint-length-prefixed frame). Every single-frame protocol in the
package was converted, sender and reader together:

- `cohort-topic/stream-util.ts` — `requestResponse` / `sendOneWay` send via `sendFramed`;
  `requestResponse` and `handleRequestResponse` read via `readFramed`.
- `cohort-topic/host.ts` — the register / cohort-gossip / promote / membership / sign handlers.
- `reactivity/notify-transport.ts`, `reactivity/push-state-gossip.ts` — inbound one-way readers.
- `testing/cohort-topic-mesh-harness.ts` — `MockStreamEnd` widened to carry
  `Uint8Array | Uint8ArrayList` (what `sendFramed` writes) and `MockNode.receive` frames injected
  bytes with `lp.encode.single`. The stub deliberately omits `closeRead` / `addEventListener` / …
  so `readFramed` keeps it on its plain-iterable path.

### The one behavioural change

`readFramed` treats bare end-of-stream as a **truncation error**, so a handler that closed without
writing — the old way of saying "no result" — now reads as a failure at the dialer. The
implementation split by protocol kind:

- `stream-util.ts#handleRequestResponse` (matchmaking query, reactivity recover — every consumer's
  dialer reads a reply): a handler returning `undefined` sends an explicit **zero-length frame**.
  The dialer resolves it as empty bytes, byte-for-byte the same observable result the old
  read-to-end-of-stream produced.
- `host.ts` one-way protocols (cohort-gossip, promote): still send nothing, because their dialers
  used `sendOneWay`, never read, and have typically already closed the stream.

The rejected alternative — catching `FrameTruncationError` at the dialer and mapping it to empty —
would silently classify a genuinely truncated reply (a network failure mid-frame) as a valid
"no result", which is exactly the ambiguity the framing change exists to kill.

Wire compatibility with published v0.24.0 is knowingly broken; the original ticket established that
those peers are already unreachable at the FRET routing layer.

## Review findings

Read the implement diff (`42b1d2e`) first, then the handoff. Checked: framing agreement on both
sides of every converted protocol, the `undefined` no-reply contract against all four
`requestResponse` consumers, error/abort paths, resource cleanup on the stream lifecycle, the test
stubs' fidelity to the real `readFramed` dispatch, docs, source hygiene, lint, unit tests, and the
gated real-libp2p integration suite.

### Fixed in this pass

- **The "must always reply" rule was enforced by a comment, not the type.** `host.ts#makeFrameHandler`
  took a handler returning `Uint8Array | undefined` for *all five* protocols, with a doc comment
  explaining that `undefined` is only legal on the two one-way ones. A future edit that returned
  `undefined` from the register / membership / sign arm would compile fine and break its dialer with
  a truncation error. Split into two constructors — `makeRequestHandler` (handler returns
  `Promise<Uint8Array>`, no opt-out) and `makeOneWayHandler` (handler returns `Promise<void>`) — over
  one shared stream-lifecycle core. The bad state is now unrepresentable rather than documented.
- **The new no-reply contract had no unit coverage.** It was asserted only by the env-gated
  real-libp2p integration spec; the default suite never exercised `handleRequestResponse` at the
  stream layer at all, and `registerPushStateGossipHandler`'s inbound framing had no coverage in any
  tier. Added `test/cohort-topic/stream-util-framing.spec.ts` (6 tests) driving real handlers over
  the in-process duplex: request/reply verbatim round trip, an empty *request* body surviving,
  `undefined` → empty bytes at the dialer, a throwing handler → `FrameTruncationError` (so a real
  failure stays distinguishable from an empty reply), an over-ceiling reply → `PayloadTooLargeError`
  at the prefix, and `sendOneWay` → push-state-gossip delivering the exact frame.
- **Stale comments about the old silent-close behaviour.** `recover-transport.ts` claimed a no-reply
  "aborts the stream" (it never did, before or after) and that "the subscriber falls back" (it does
  not — see the filed ticket below). `query-transport.ts` described the same abort that does not
  happen. Both corrected to state what the code actually does.
- **Docs did not describe the stream framing at all.** Added a *Stream framing* paragraph to
  `docs/cohort-topic.md` §Protocol IDs stating the one-frame-each-way contract, that end-of-stream is
  not an empty message, and that a responder with no result must send a zero-length frame. Also
  corrected the §Wire formats parenthetical, which claimed the codec's own 4-byte prefix is what
  makes a frame "self-delimiting on a stream" — true before, misleading now that a varint prefix does
  the stream delimiting and the codec prefix rides inside the body.

### Filed as a new ticket

- `tickets/backlog/debt-stream-reply-no-result-untyped.md` — `requestResponse` resolves the same
  `Uint8Array` shape for "the peer declined" and "the peer answered, and the answer was empty", so
  every caller must remember a length check by hand. `recover-transport.ts#exchange` does not, and
  the first cohort member that declines a recover request therefore ends the whole recover walk
  instead of the subscriber trying the next member — contradicting that module's own stated intent.
  Predates this change (the old read-to-end-of-stream path produced the same empty buffer), so it is
  not a regression; filed at the representation rung (make the no-result outcome explicit in the
  return type) rather than as a point fix, because two more callers — `query-transport#dialRegister`
  and `topic-router#register` — are safe today only because their serve handlers happen to always
  return a frame. A `NOTE:` at the recover site points at the ticket.

### Recorded as tripwires, not tickets

- **No backpressure on the write side.** All four `sendFramed` call sites in `stream-util.ts`
  discard the helper's boolean result (`false` = "write accepted, transport buffer now full").
  Harmless while each protocol writes exactly one bounded frame per stream and then closes.
  `NOTE:` in the `stream-util.ts` module header, naming the condition (a caller writing repeatedly
  on one stream) and the fix (await the stream's `'drain'` event, as FRET's `rpcRequest` does).

### Checked and found clean

- **Framing agreement, both directions, every protocol.** Every converted reader has its matching
  converted writer; `grep -rn readAllBounded packages/db-p2p` is empty, doc comments included. The
  cluster / repo / sync / dispute / `protocol-client` streams were already `it-length-prefixed` and
  are correctly untouched.
- **All four `requestResponse` consumers' handling of an empty reply.** `membership-source.fetch`
  (`reply.length > 0`) and the matchmaking query dialer (`frame.length === 0 → emptyReply()`) are
  correct; `dialRegister` and `topic-router#register` do not check but cannot receive an empty frame
  today; `recover-transport#exchange` is the filed finding above.
- **Test-stub fidelity.** `MockStreamEnd` correctly fails FRET's `isMessageStream` duck-type check
  (it has `send` but no `closeRead` / `addEventListener` / `removeEventListener` / `push` / `log`), so
  it stays on the plain-iterable read path as the harness comment claims, and its `abort` closes the
  peer's inbound side so a handler failure surfaces as a truncation error at the dialer rather than
  a hang. Verified by the new throwing-handler test.
- **The `openStream` duplication tripwire from the implement ticket** was honored correctly: FRET now
  exports `openRpcStream`, the local copy stays because FRET's version pins `negotiateFully: false`
  against the accepted tradeoff recorded at `stream-util.ts#STREAM_OPTIONS`, and the header NOTE
  reads as a decision rather than an oversight.
- **Resource cleanup and error paths.** Every handler's catch arm aborts the stream inside its own
  try/catch; `requestResponse` / `sendOneWay` close in `finally` (the double close is a no-op).
- **Source hygiene.** The new code is short and single-purpose; the two new constructors are three
  lines each over a shared core. One observation not filed: `host.ts` is 2910 lines
  (`wc -l packages/db-p2p/src/cohort-topic/host.ts`), which is well past this repo's stated
  small-file standard — but it is pre-existing, this change adds 28 net lines to it, and an unbounded
  "split a 2910-line file" ticket without a decomposition plan would be low-value. Left for a
  deliberate decomposition pass.
- **Handler read deadline.** All inbound handlers take `readFramed`'s default 5s timeout, so a
  stalled dialer holds a stream that long. FRET documents this tradeoff at `readFramed` (with the
  explicit instruction not to reintroduce an idle timer), and db-p2p inherits it unchanged — no new
  exposure from this ticket.

Nothing was found in these areas: performance regressions (the framing adds one varint per message),
type-safety holes in `src/` (no new `any`; the `as any` / `as never` casts are confined to test
stubs), or DRY violations.

## Validation

All from the repo root, all green:

- `yarn workspace @optimystic/db-p2p build` → exit 0
- `npx eslint packages/db-p2p/src packages/db-p2p/test` → exit 0
- `yarn workspace @optimystic/db-p2p test` → **1817 passing, 44 pending, 0 failing** (1811 before
  this pass; the 6 new framing tests account for the delta)
- `OPTIMYSTIC_INTEGRATION=1 yarn workspace @optimystic/db-p2p test:integration` → **30 passing,
  2 pending, 0 failing** (~17s), including the real-socket recover / matchmaking / membership paths
  that first caught the no-reply contract break

Downstream (`../sereus`) was confirmed unblocked during implement; its blocker ticket
`../sereus/tickets/blocked/linked-optimystic-broken-by-fret-framing-change.md` can be cleared on its
own side — no edit was made to that repository.
