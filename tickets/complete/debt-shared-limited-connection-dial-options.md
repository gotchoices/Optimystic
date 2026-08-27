description: Peers reachable only through a relay — normal for phones and machines behind a home router — were silently unreachable from the block-restoration path, and the code that makes relay peers reachable had been hand-copied into three places; it is now one shared helper, with a build-time guard that fails if a fourth copy is written.
files: packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/open-protocol-stream.spec.ts, packages/db-p2p/test/open-protocol-stream-relay.spec.ts, packages/db-p2p/test/dial-options-single-site.spec.ts
----

# One place opens a libp2p protocol stream

## What landed

**`packages/db-p2p/src/network/open-protocol-stream.ts`** is now the only file in `db-p2p` that
calls libp2p's `dialProtocol` or `newStream`. It exports `openProtocolStream(node, peer, protocol,
options?)`, `isLimitedConnection(conn)`, and `OpenProtocolStreamOptions`, and it:

- throws the caller's `AbortSignal` reason immediately if the signal is already aborted, before
  touching connections;
- filters the peer's connections to open ones with a callable `newStream`, prefers a non-relayed
  connection, falls back to a relayed one when it is the only open path;
- always sets `runOnLimitedConnection: true` — deliberately a module constant, not an option, so a
  future call site gets relay support without its author knowing the flag exists;
- adds `negotiateFully` / `signal` only when the caller passed them, so libp2p sees an absent key
  rather than an explicit `undefined`;
- runs `options.beforeDial?.()` on the fresh-dial path only, which is where
  `libp2p-key-network.ts#assertNotSelfRelayOnly` now rides.

Three call sites collapsed onto it: `cohort-topic/stream-util.ts` (local `openStream`,
`isLimitedConnection`, `STREAM_OPTIONS` deleted), `libp2p-key-network.ts#connect` (now a four-line
delegation; its private `isLimitedConnection` deleted), and the `RestorationCoordinator` wiring in
`libp2p-node-base.ts:1068`, where an inline `{ connect: (pid, protocol) => node.dialProtocol(…) }`
lambda was replaced with the node's real `Libp2pKeyPeerNetwork`.

Two defects closed by that last swap, both read from the code rather than observed at runtime:
Arachnode block restoration could not pull a block from a holder reachable only via relay (the
stream-open failed, `queryPeer` swallowed it, the coordinator moved on as though the peer did not
hold the block); and the lambda dropped the `options?: AbortOptions` parameter, so
`SyncClient.requestBlock`'s 3000 ms dial deadline was ignored in favour of libp2p's 10 000 ms
connection-manager default, per unreachable ring peer, walked sequentially.

Three specs: a six-scenario table driven through all four stream-opening entry points
(`test/open-protocol-stream.spec.ts`, which subsumes and replaces the deleted
`test/cohort-topic/stream-util.spec.ts`); a structural guard that fails the build if a second source
file opens a stream directly (`test/dial-options-single-site.spec.ts`); and an end-to-end spec on
real sockets with a real relay, a browser-shaped relay-only peer, and a control case asserting
libp2p still refuses an un-opted-in stream (`test/open-protocol-stream-relay.spec.ts`).

## Review findings

**Checked:** the full implement-stage diff (`251fe70`) read before the handoff summary; the deleted
spec compared against its replacement (strict superset — no coverage lost); every consumer of the
three collapsed call sites; the sole production `RestorationCoordinator` construction; `IPeerNetwork`
and `SyncClient.requestBlock` to confirm the deadline claim; libp2p's own enforcement of
`runOnLimitedConnection` in `libp2p/dist/src/connection.js`; `docs/internals.md`,
`packages/db-p2p/README.md` and `AGENTS.md` for statements the change invalidates; lint, build,
typecheck and the full root test suite.

**Major — one, filed as `bug-inbound-streams-refused-on-relay-limited-connections` (backlog).**
The fix is one-sided. libp2p checks `runOnLimitedConnection` in *both* directions — outgoing at
`connection.js:80`, incoming at `connection.js:170`, where it reads the options the protocol handler
was registered with. Not one of the nine protocol registrations in `packages/db-p2p/src` passes it
(sync, cluster, repo, dispute, block-transfer, cohort-topic request/response, the five cohort-topic
protocols in `host.ts`, both reactivity protocols). So against a relay that applies caps — libp2p's
own default, and any relay this node did not configure — the caller now opens a stream that the
callee refuses, and the headline defect this ticket set out to fix is still live. The only place in
the tree that passes the flag on registration is the new relay spec's test helper, which is why that
spec passes while production would not. The implementer flagged the neighbouring symptom (bullet (a)
of their "push on this" list: the relay spec needs `applyDefaultLimit: true`, which is not this
repo's posture) but read it as the fix's benefit being narrower rather than as a missing half. The
filed ticket takes the architectural rung: one registration helper with the opt-in baked in, plus
widening the existing guard to `.handle(`, so neither half can be forgotten again — not a flag
sprinkled across nine sites.

**Minor — two, both fixed in this pass.**

- `isLimitedConnection` read the connection through `(c as { limits?: unknown }).limits`. `Connection`
  declares `limits?: ConnectionLimits` (`@libp2p/interface/dist/src/connection.d.ts:123`), so the cast
  only erased a type that was already there — against `AGENTS.md` § General ("don't be type lazy").
  Now `c.limits != null`.
- `test/dial-options-single-site.spec.ts` scanned source with a hand-rolled 30-line comment/string
  stripper plus a `\.(dialProtocol|newStream)\s*\(` regex — a hand-rolled parser where a real one was
  a devDependency away, against `AGENTS.md` § General. Replaced with a TypeScript AST walk
  (`ts.createSourceFile` + `isCallExpression`/`isPropertyAccessExpression`). This is not only tidier:
  it closes the two false-negative soft spots the implementer documented (a quote inside a regex
  literal blanking the rest of a file; comments and strings generally) and one they did not — the
  regex could not see `node?.dialProtocol(…)`, an optionally-chained call, which the AST does. Four
  synthetic cases added for exactly those shapes; the "flags a method *definition*" and "ignores
  prose in comments" cases are preserved and still pass. The full-tree scan and the
  not-vacuously-passing case are unchanged.

**Tripwires — one, parked as a `NOTE:` at the site, not filed.** The guard walks
`packages/db-p2p/src` only. No other package depends on libp2p today
(`.dialProtocol(`/`.newStream(` across `packages/*/src` returns only the two lines inside the
allowlisted helper), so this is fine now and becomes work only *if* a second package takes a libp2p
dependency. Recorded in the spec's docblock with the action ("widen `srcRoot`").

**Considered and left alone — four.** (a) `isLimitedConnection` returns true for any `/p2p-circuit`
address even where libp2p would not gate the connection; that is the conservative direction (we pass
a flag libp2p ignores), it is what both original copies did, and it is documented at the function.
(b) `requestResponse` / `sendOneWay` still take no `AbortSignal`; the helper supports one on both
paths now, the cohort-topic signatures were explicitly out of scope, and the existing `NOTE:` at the
site already points at `openProtocolStream`'s `signal`. (c) The `libp2p-node-base.ts` swap has no
direct test — but the regression it guards against is a structural one: any future inline
`node.dialProtocol(…)` adapter there now fails `dial-options-single-site.spec.ts` at build time,
which is stronger than a unit test of that wiring block would be. (d) `getConnections?.()` uses an
optional call on a method the `Libp2p` type declares as required — defensive rather than
type-lazy, and covered by a test; left as-is.

**Docs — checked, nothing stale.** `docs/internals.md:891` describes
`Libp2pKeyPeerNetwork.connect` consulting `classifySelfDialability` "once on the cold path", which
remains exactly true now that it rides `beforeDial` (which never runs on the reuse path).
`packages/db-p2p/README.md` documents the node's public surface and never described internal
stream-opening, so it needs no edit. `AGENTS.md` has no db-p2p source layout to update. No doc
anywhere mentions `runOnLimitedConnection`, `openStream`, or `dialProtocol`.

**Not done, and knowingly so.** There is still no end-to-end restoration test (a live relay plus a
relay-only peer actually *holding* a block, restored by an arachnode peer). The new relay spec
covers the transport layer the fix acts on; it does not drive `RestorationCoordinator`. Given the
major finding above, such a test would fail today for the inbound reason — it belongs with that
ticket, not here.

## Validation

From the repo root, after the review fixes: `yarn lint` (clean), `yarn build`, `yarn typecheck`, and
`yarn test` — every package green, **0 failing**. `@optimystic/db-p2p` reports 2016 passing / 44
pending (2012 before this pass; the four added are the new AST-scanner cases). The env-gated
`yarn test:integration` tier was not run.
