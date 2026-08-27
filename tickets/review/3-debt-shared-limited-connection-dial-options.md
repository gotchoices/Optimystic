description: Peers reachable only through a relay — normal for phones and machines behind a home router — were silently unreachable from the block-restoration path, and the code that makes relay peers reachable had been hand-copied into three places; it is now one shared helper, with a test that fails the build if a fourth copy is written.
files: packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/open-protocol-stream.spec.ts, packages/db-p2p/test/open-protocol-stream-relay.spec.ts, packages/db-p2p/test/dial-options-single-site.spec.ts
difficulty: medium
----

# Review handoff: one place opens a libp2p protocol stream

## What shipped

**New module — `packages/db-p2p/src/network/open-protocol-stream.ts`.** Exports
`openProtocolStream(node, peer, protocol, options?)`, `isLimitedConnection(conn)`, and
`OpenProtocolStreamOptions`. It is now the only file in `packages/db-p2p/src` that calls libp2p's
`dialProtocol` or `newStream`.

Behavior, as specified in the plan:

- Throws the caller's `AbortSignal` reason immediately if the signal is already aborted, before
  looking at connections.
- Filters `node.getConnections?.(peer) ?? []` down to entries with `status === 'open'` and a
  callable `newStream`; prefers a non-relayed connection; falls back to the relayed one when it is
  the only open path.
- Builds stream options as `{ runOnLimitedConnection: true }` plus `negotiateFully` and `signal`
  **only when the caller passed them** — the keys are absent, not present-and-`undefined`.
- Reuse path calls `chosen.newStream(...)`; otherwise runs `options.beforeDial?.()` and then
  `node.dialProtocol(...)`.
- `runOnLimitedConnection` is deliberately **not** an option. It is a constant in the module, so a
  future call site gets relay support without its author knowing the flag exists.
- Imports are type-only, so the react-native entry (`src/rn.ts` → `libp2p-key-network.js` → this
  module) is unaffected. The existing `testing-entry-runtime-deps.spec.ts` guard still passes.
- Carries the `NOTE:` recording why this duplicates FRET's `openRpcStream` (FRET pins
  `negotiateFully: false` with no opt-out; `cohort-topic/stream-util.ts` deliberately omits that
  option) with the revisit condition: delete this module if FRET ever parameterizes it.

**Three call sites collapsed to one.**

- `cohort-topic/stream-util.ts` — local `openStream`, `isLimitedConnection`, and `STREAM_OPTIONS`
  deleted; `requestResponse` and `sendOneWay` both call `openProtocolStream(node, peer, protocol)`
  with no `negotiateFully`. The accepted-tradeoff `NOTE:` explaining that omission moved into the
  module docblock (one shared spot in the module, as the plan permitted) with a one-line pointer at
  each call site. The stale FRET paragraph is gone. `handleRequestResponse`, the `sendFramed`
  backpressure `NOTE:`, and both public signatures are untouched.
- `libp2p-key-network.ts#connect` — now a four-line delegation passing `signal`,
  `negotiateFully: false`, and `beforeDial: () => this.assertNotSelfRelayOnly(...)`. The private
  `isLimitedConnection` method is deleted (nothing else in the class used it; the now-unused
  `Connection` type import went with it). `assertNotSelfRelayOnly` and its `peerStore`-cost `NOTE:`
  are unchanged, and both of its documented properties are preserved by construction: `beforeDial`
  never runs on the reuse path, and its post-read `throwIfAborted()` is still inside the method.
- `libp2p-node-base.ts:1068` — the inline `{ connect: (pid, protocol) => node.dialProtocol(...) }`
  object literal handed to `RestorationCoordinator` is replaced with `keyNetwork`, the node's real
  `Libp2pKeyPeerNetwork`. `RestorationCoordinator.queryPeer` still catches every error
  unconditionally and returns `undefined`, so the newly-possible `SelfRelayOnlyAddressesError`
  surfaces as "this peer did not have it", same as any other failure.

**Two defects that closes** (both were `static` — read from the code, not observed at runtime; the
new real-relay spec below now covers the transport half of the first one):

1. Arachnode block restoration could not pull a block from a holder reachable only via relay. The
   stream-open failed, `queryPeer` swallowed it, and the coordinator moved on as though the peer
   did not hold the block.
2. The lambda dropped the `options?: AbortOptions` parameter, so `SyncClient.requestBlock`'s
   3000 ms `dialTimeoutMs` was ignored and an unreachable peer instead cost libp2p's 10 000 ms
   connection-manager default — 3.3× the intended deadline, multiplied by however many unreachable
   ring peers `RestorationCoordinator.restore` walks sequentially.

## Tests

Run: `yarn workspace @optimystic/db-p2p test` → **2012 passing, 0 failing, 44 pending**.
Also clean: `yarn build`, `yarn typecheck`, `yarn lint` from the repo root.

**`test/open-protocol-stream.spec.ts`** (new; replaces `test/cohort-topic/stream-util.spec.ts`,
which was deleted as subsumed — `test/cohort-topic/stream-util-framing.spec.ts` was left alone).
A four-row table — `openProtocolStream`, cohort-topic `requestResponse`, cohort-topic `sendOneWay`,
and `Libp2pKeyPeerNetwork.connect` — driven through six connection-selection scenarios each
(reuse sets the flag, dial sets the flag, relayed-only is used, direct beats relayed, non-open is
skipped, all-closed dials fresh). A new call site joins the sweep by adding one row. Plus
helper-only cases: `negotiateFully` absent vs. `false`, `signal` absent vs. forwarded on both
paths, missing `getConnections`, a connection whose `newStream` is not callable, already-aborted
signal (rejects with the caller's own reason, opens nothing, does not run `beforeDial`),
`beforeDial` ordering/once/never-on-reuse/throw-propagates, and `isLimitedConnection` by `limits`
stamp, by `/p2p-circuit`, and on a connection with no `remoteAddr`.

**`test/dial-options-single-site.spec.ts`** (new). Walks `packages/db-p2p/src/**/*.ts`, strips line
and block comments (preserving line numbers, and tracking string literals so a `//` inside one is
not read as a comment), and matches member-call syntax `/\.(dialProtocol|newStream)\s*\(/`. The
allowlist is the one-element set `{ src/network/open-protocol-stream.ts }`. The scan function is
also unit-tested on synthetic sources: a planted second call site is reported with its file and
line and a pointer to `openProtocolStream`; a *method definition* (the shape
`src/testing/cohort-topic-mesh-harness.ts` uses for its `MockNode`) is not flagged; names inside
line and block comments are not flagged; a `//` inside a string literal does not swallow the rest
of the line. One case asserts the allowlisted file itself yields both method names, so the sweep
cannot pass vacuously if the comment stripper ever starts eating real code.

**`test/open-protocol-stream-relay.spec.ts`** (new — this is the end-to-end spec the plan said to
weigh; **I added it**). Real sockets, no stubs: a relay `R`, a browser-shaped peer `C` whose only
listen address is a circuit through `R`, and a service peer `S` that can reach `C` only through
that circuit. It asserts the connection really is limited, that reuse over it opens a stream, and
that a *fourth* node taught only `C`'s circuit address (the cohort case, via `peerStore.merge`)
opens one on a cold dial. The control case asserts that the same stream opened **without** the
flag is refused by libp2p, with an error naming the limited-connection reason — without that
control, the primary cases would pass for the wrong reason.

## Things the reviewer should push on

- **The relay spec needs `applyDefaultLimit: true` to test anything, and that is not the posture
  this repo's relays run in.** With `applyDefaultLimit: false` (what `libp2p-node-base.ts` uses for
  trusted clusters, and what the other relay specs pass) the connection is still a circuit but
  carries no `Limit`, so libp2p does not mark it `limited` and lets a stream through with no flag —
  I confirmed that by running the spec both ways; the control case passes only with `true`. The
  spec now uses `true` with a comment saying why. Two consequences worth a second opinion: (a) the
  spec exercises libp2p's default relay posture rather than this repo's, and (b) it means the
  production benefit of `runOnLimitedConnection` on an Optimystic-operated relay is narrower than
  the ticket assumed — it matters against relays that *do* apply limits, which includes any relay
  this node did not configure. I did not chase that further; it may deserve its own ticket.
- **`isLimitedConnection` and libp2p's own notion of "limited" are not the same predicate.** Ours
  returns true for any `/p2p-circuit` address even when libp2p would not gate streams on it. That
  is the conservative direction (we pass a flag libp2p ignores) and it is what both original copies
  did, so it is preserved as-is — but it is worth knowing they are not interchangeable.
- **The guard only scans `packages/db-p2p/src`.** Other packages are not covered; today none of
  them call libp2p directly (`grep -rn "\.dialProtocol(\|\.newStream(" packages/*/src --include=*.ts`
  returns only the two lines inside the allowlisted helper). If a second package ever takes a
  libp2p dependency the guard will not notice.
- **The comment stripper does not track regex literals.** A regex containing a lone quote character
  would put the scanner into string mode and blank out code after it. That direction is a false
  negative, never a false positive, and the "finds the calls inside the allowlisted file" case pins
  that it has not started swallowing the tree — but it is a known soft spot.
- **`requestResponse` / `sendOneWay` still take no `AbortSignal`.** The helper now supports one on
  both paths, so threading it through is a one-line change, but the cohort-topic signatures were
  explicitly out of scope and are unchanged. Their existing `NOTE:` about this was updated to point
  at `openProtocolStream`'s `signal` rather than the deleted local `openStream`.
- **The `libp2p-node-base.ts` swap is not covered by a test.** It is a one-token change inside the
  arachnode wiring block, which the unit suite does not construct. Type-checked and built, but the
  claim "restoration now reaches relay-only holders" rests on `Libp2pKeyPeerNetwork.connect` being
  correct (which the table above does cover) rather than on an integration run of the coordinator.
- Backlog ticket `debt-stream-reply-no-result-untyped` also targets `stream-util.ts`, at the return
  type of `requestResponse`. It had not landed at the time of this change and no conflict is
  expected — that seam was not touched.

## Not done

- No end-to-end restoration test (live relay + relay-only peer *holding a block* + an arachnode
  peer restoring it). The new relay spec covers the transport layer this fix acts on; it does not
  drive `RestorationCoordinator`.
- Nothing was exported from `src/index.ts` or `src/rn.ts` — the helper is internal to the package
  and the public surface is unchanged.
