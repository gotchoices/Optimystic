description: The project's message protocols were moved onto the networking library's new length-prefixed framing helpers, restoring the package after the library removed the helper this code depended on. Both sending and receiving sides of every affected protocol were converted together, and one silent-close behavior had to be made explicit on the wire.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/push-state-gossip.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/cohort-topic/stream-util.spec.ts, packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts, packages/db-p2p/test/reactivity/notify-transport.spec.ts
----

# Review: `db-p2p` moved onto FRET's `sendFramed` / `readFramed`

## What was done

`@optimystic/db-p2p` failed to load because FRET (`p2p-fret`, portal-linked from `../Fret`) removed
its exported `readAllBounded` (read every byte until stream end) in favour of `sendFramed` /
`readFramed` (write/read one varint-length-prefixed frame). All single-frame protocols in this
package were converted, sender and reader together:

- `src/cohort-topic/stream-util.ts` — `requestResponse` and `sendOneWay` now send via `sendFramed`;
  `requestResponse` and `handleRequestResponse` read via `readFramed`. Header doc rewritten: the
  varint prefix now delimits frames, not stream end-of-file.
- `src/cohort-topic/host.ts` — `makeFrameHandler` (serving register / cohort-gossip / promote /
  membership / sign) reads via `readFramed`, replies via `sendFramed`.
- `src/reactivity/notify-transport.ts` and `src/reactivity/push-state-gossip.ts` — inbound one-way
  readers converted to `readFramed`; their write side is `sendOneWay`, covered above.
- `src/testing/cohort-topic-mesh-harness.ts` — `MockStreamEnd` widened to carry
  `Uint8Array | Uint8ArrayList` (what `sendFramed` writes), `send` returns `true`;
  `MockNode.receive` now frames injected frames with `lp.encode.single` before writing them in.
  The stub deliberately does NOT gain `closeRead`/`addEventListener`/etc., so `readFramed` keeps
  it on its plain-iterable path.

No `readAllBounded` reference remains anywhere in the package, doc comments included.

## One design call made beyond the ticket text — reviewers should scrutinize it

**"No reply" now travels in-band as an explicit zero-length frame in `handleRequestResponse`.**
The old reader returned empty bytes when a handler closed the stream without replying; `readFramed`
correctly treats bare end-of-stream as a truncation error, so silence is no longer a representable
outcome. This surfaced as a real failure in the gated real-libp2p integration suite: a matchmaking
query for an unserved topic (handler declines, replies nothing) made the dialer throw
`FrameTruncationError`.

The fix splits by protocol kind:

- `stream-util.ts#handleRequestResponse` (serves matchmaking query and reactivity recover — every
  consumer's dialer reads a reply): a handler returning `undefined` now sends an explicit
  zero-length frame (`0x00` prefix). The dialer resolves it as empty bytes — byte-for-byte the
  same observable result the old read-to-EOF produced.
- `host.ts#makeFrameHandler` (mixed): `undefined` still sends nothing, because there it only ever
  means a one-way protocol (cohort-gossip, promote) whose dialer used `sendOneWay`, never reads,
  and has typically already closed the stream — writing into it would be at best wasted, at worst
  an error. The reply-reading protocols on this seam (register, membership, sign) always return a
  frame (membership already returned `latest ?? new Uint8Array(0)`). Both seams carry doc comments
  stating the rule.

The alternative — catching `FrameTruncationError` on the dialer and mapping it to empty — was
rejected: it would silently classify a genuinely truncated reply (network failure mid-frame) as a
valid "no result", which is exactly the ambiguity the framing change exists to kill.

## Test changes

- `test/cohort-topic/stream-util.spec.ts` — the shared stream fixture now yields one framed empty
  body (`0x00`) so `requestResponse` resolves; previously it yielded nothing ("EOF = empty").
- `test/reactivity/notify-transport.spec.ts` — the round-trip test unwraps the captured outbound
  frame with FRET's own `readFramed` before comparing/delivering (proves the two framing halves
  agree); both inbound handler fixtures now yield properly framed bytes; the over-ceiling test
  additionally pins `err.name === 'PayloadTooLargeError'` at the prefix, per the ticket's
  suggestion.
- `test/cohort-topic/gossip-cadence.spec.ts` — **not in the ticket's blast-radius list** but needed
  the same fix: its `singleFrameStream` drove the host's real cohort-gossip handler with an
  unframed frame. Now frames with `lp.encode.single`.
- `test/matchmaking/query-transport.spec.ts` and `test/reactivity/recover-transport.spec.ts` —
  confirmed unchanged: they drive the inner `handle` callbacks directly, never the stream layer.
- Other stream-stub suites (`inbound-message-caps`, `inbound-stream-authorization`,
  `block-transfer*`, `spread-on-churn`, `rpc-response-deadline`, …) exercise the cluster/repo
  `it-length-prefixed` seams that were already framed and are out of scope; all pass untouched.

## Validation performed

- `node -e "import('@optimystic/db-p2p')"` → OK (was: `does not provide an export named
  'readAllBounded'`).
- `yarn workspace @optimystic/db-p2p build` → clean.
- `yarn workspace @optimystic/db-p2p test` → **1811 passing, 44 pending, 0 failing**.
- `OPTIMYSTIC_INTEGRATION=1` real-libp2p integration spec
  (`test/substrate-real-libp2p.integration.spec.ts`) → **11 passing, 2 pending, 0 failing** (~5s).
  This was run, and it is what caught the no-reply contract break — the default suite's mocks did
  not. It exercises `readFramed`'s real-stream (`byteStream`) path end-to-end, including the
  send → half-close → read ordering `requestResponse` uses.
- Downstream: `cd ../sereus && node -e "import('@serfab/cadre-core')"` → OK. That repository's
  blocker ticket (`../sereus/tickets/blocked/linked-optimystic-broken-by-fret-framing-change.md`)
  can be cleared on its side; this ticket does not edit that repo.
- `grep -rn readAllBounded packages/db-p2p` → empty.

## What the reviewer should probe (known soft spots)

- **The zero-length-frame no-reply contract.** It is asserted at mock tier and by one real-socket
  integration test (unserved-topic matchmaking query). If you can think of a `handleRequestResponse`
  consumer whose dialer treats empty bytes as anything other than "no result", check it —
  `recover-transport`'s dialer (`exchange`) and `matchmaking/query-transport`'s seeker are the two.
- **Writes into closed one-way streams.** `makeFrameHandler`'s one-way arms send nothing, but
  `handleRequestResponse` now always sends — if a *dialer* of a request-response protocol ever
  fires-and-forgets (none does today), the handler's reply lands in a closed stream and the catch
  arm aborts. Harmless today; worth an eye.
- **Wire compatibility with published v0.24.0 is knowingly broken** — the ticket established those
  peers are already unreachable at the FRET routing layer, so nothing was preserved. If the
  reviewer disagrees with that premise, the decision record is in the original ticket text
  (archived with this file's history).
- The ticket's tripwire was honored: `stream-util.ts#openStream` still duplicates FRET's
  `openRpcStream` because of the accepted `negotiateFully` tradeoff recorded at
  `stream-util.ts:29-34`; the header NOTE now records that FRET exports the helper and why the
  local copy deliberately stays. Verify the NOTE reads as a decision, not an oversight.
