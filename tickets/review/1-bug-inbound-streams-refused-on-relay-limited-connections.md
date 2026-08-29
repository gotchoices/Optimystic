description: A peer reachable only through a relay can now be talked to in both directions — the side answering the call no longer refuses it. One shared registration helper replaces thirteen hand-written registrations, and a build-time guard stops a future one from forgetting.
files: packages/db-p2p/src/network/register-protocol-handler.ts, packages/db-p2p/test/dial-options-single-site.spec.ts, packages/db-p2p/test/open-protocol-stream-relay.spec.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/push-state-gossip.ts, packages/db-p2p/src/libp2p-node-base.ts
difficulty: medium
----

# What landed

## The premise, now confirmed rather than inferred

The ticket filed this `repro: static`. It is now **verified against libp2p's own source and against a
running relay**:

- `packages/db-p2p/node_modules/libp2p/dist/src/connection.js:170` — on the **incoming** stream path
  libp2p reads back `registrar.getHandler(protocol).options.runOnLimitedConnection` and throws
  `LimitedConnectionError` if it is not `true`. That is a *different* options object from the
  dialer's (checked at line 80), so both sides must opt in independently.
- `packages/db-p2p/node_modules/@libp2p/circuit-relay-v2/dist/src/transport/index.js:283` — the
  **inbound** (STOP) side of a circuit stamps `limits` on its connection too, not just the outbound
  side. So the answering peer really does see a limited connection and really does gate on it.
- The new test case in `test/open-protocol-stream-relay.spec.ts` demonstrates it on real sockets.

An important behavioural detail the original ticket did not state, and which explains why this was
invisible: on the answering side the refusal happens *after* multistream-select has already
acknowledged the protocol. The dialer's stream open **succeeds**, and the stream is then reset with
no reply. From the dialer's seat that is indistinguishable from a peer that simply had nothing.

## The fix

`packages/db-p2p/src/network/register-protocol-handler.ts` — new; the mirror image of
`open-protocol-stream.ts`. `registerProtocolHandler(target, protocol, handler, options?)` bakes
`runOnLimitedConnection: true` in as a **constant, not an option**, so a protocol added later gets
relay support without its author knowing the flag exists. The settings that legitimately vary
(`maxInboundStreams`, `maxOutboundStreams`, `middleware`, `force`, `signal`) stay parameters, and are
**omitted from the object rather than set to `undefined`** when the caller does not supply them, so
libp2p's own defaults still apply — same trick `open-protocol-stream.ts` uses.

`target` is structurally typed (`ProtocolRegistrar`), which is what lets both shapes in this package
go through one helper: a `Libp2p` node (`node.handle`) and the `registrar` component the service
classes are constructed with (`components.registrar.handle`).

All **13** registration sites now route through it. The count matches the re-verification in the
implement ticket, not the 12 the original table implied:

| Protocol | Site |
| --- | --- |
| sync (block restoration) | `sync/service.ts:66` |
| cluster | `cluster/service.ts:191` |
| repo | `repo/service.ts:139` |
| dispute | `dispute/service.ts:61` |
| block transfer | `cluster/block-transfer-service.ts:258` |
| cohort-topic request/response | `cohort-topic/stream-util.ts:102` |
| cohort-topic register / gossip / promote / membership / sign | `cohort-topic/host.ts:2814, 2834, 2843, 2848, 2860` |
| reactivity notify | `reactivity/notify-transport.ts:130` |
| reactivity push-state gossip | `reactivity/push-state-gossip.ts:277` |

`grep -rn "\.handle(" packages/db-p2p/src --include=*.ts` now returns only the helper's own call and
prose in comments.

## Incidental renames

- `cohort-topic/host.ts` had a local `registerProtocolHandlers` (plural). With the singular
  `registerProtocolHandler` now imported into the same file, the two names were one character apart
  and read as the same thing. The local one is now `registerCohortTopicProtocols`. Pure rename, two
  sites, no behaviour change.
- `libp2p-node-base.ts:1619` — a NOTE that named `node.handle(...)` was refreshed to name
  `registerProtocolHandler(...)`. Comment only; the fire-and-forget concern it describes is
  unchanged and still open by design.

## The guard

`test/dial-options-single-site.spec.ts` (already a TypeScript-AST walk over `packages/db-p2p/src`)
now guards **both** directions. The scanner was generalized to `findMemberCalls(file, source,
methods)`; `findDirectStreamOpens` and the new `findDirectHandlerRegistrations` are thin wrappers,
and `describeViolations` dispatches per-method so a failure names the helper the author actually
needs. Two allowlists, one file each. 25 cases, all passing.

# How to validate

## Run it

```bash
# The guard, both halves (fast, no sockets)
yarn workspace @optimystic/db-p2p test --grep "exactly one place"

# The real-relay proof, both halves (four libp2p boots, ~1 s)
yarn workspace @optimystic/db-p2p test --grep "over a real circuit relay"

# Everything
yarn workspace @optimystic/db-p2p test
yarn workspace @optimystic/db-p2p test:integration
```

## What was actually run, and the results

| Command | Result |
| --- | --- |
| `yarn build` (all workspaces) | clean |
| `yarn typecheck` (all workspaces) | clean |
| `yarn lint` | clean |
| `yarn workspace @optimystic/db-p2p test` | 2296 passing, 44 pending, 0 failing |
| `yarn workspace @optimystic/db-p2p test:integration` | 30 passing, 2 pending, 0 failing |
| `yarn test` (all workspaces) | ~5000 passing, 0 failing, 6m23s |

The integration suite includes `Multi-coordinator write over a relay (limited inter-coordinator
stream)`, which passes.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## The two new real-relay cases, and why they mean something

In `test/open-protocol-stream-relay.spec.ts`, on the existing topology (relay `R` with
`applyDefaultLimit: true`, browser-shaped peer `C` reachable only through the circuit, service peer
`S`), two protocols are registered **on `C`**:

- `SERVED_PROTOCOL` — through `registerProtocolHandler`. `S` opens it; the handler runs. *Positive
  control: if this ever stops firing, the negative case below proves nothing.*
- `UNSERVED_PROTOCOL` — through a bare `client.handle(...)`, exactly what all 13 sites looked like
  before. `S` opens it; the handler **never** runs.

The negative case does not sleep on a hope. It fences on observed liveness: after touching the
unserved protocol it drives the served one (known good on that very connection) and waits for *its*
handler, then adds a 500 ms settle. A working inbound path has therefore had at least as much
wall-clock as the unserved one.

**The negative control was mutation-tested.** Adding `{ runOnLimitedConnection: true }` to the
`UNSERVED_PROTOCOL` registration makes it fail with `-1 / +0` — so the assertion has teeth and is not
passing for some unrelated reason. That mutation was reverted; re-run it yourself if you want to see
it.

## Manual / topology validation the tests do not cover

Nothing here exercises a **third-party or default-configured relay** end to end, only a locally
spawned one with `applyDefaultLimit: true`. If you want real-world confidence: point a
`reference-peer` at a stock libp2p relay (or drop the `{ reservations: { applyDefaultLimit: false } }`
override at `packages/reference-peer/src/cli.ts:389`) and confirm block restoration from a relay-only
holder now returns the block instead of "no peer had this block".

# Known gaps — read this part

## 1. FRET has the identical bug, one line, and this fix does not close it

The ticket scoped `p2p-fret` out as "an upstream question". It is worth knowing that the question has
an answer, and it is not a good one:

- `../Fret/packages/fret/src/rpc/protocols.ts:719` — FRET's **dial** helper passes
  `runOnLimitedConnection: true`, with a comment saying it is REQUIRED for the relayed path.
- `../Fret/packages/fret/src/rpc/protocols.ts:129` — FRET's **registration** helper
  (`registerRpcHandler`, already the single-site shape) passes **no options at all**.

Same asymmetry, same package-wide blast radius, and FRET already has the one place to fix it, so it
is a one-line change upstream. `db-p2p` depends on FRET for ring/routing RPC, which means **a
relay-only peer is still partially cut off after this ticket lands** — its Optimystic protocols now
answer, but its FRET RPC still refuses. Do not let the green suite here read as "relay-only peers
work now".

Not filed as a ticket from this stage: it is a different repository (`../Fret`, wired in through the
`p2p-fret` `portal:` resolution), and routing cross-repo work is a call for the review stage or a
human. Flagging it with the exact site so that decision is cheap.

## 2. The guard matches `handle` by name

The AST walk carries no type information, so it cannot tell libp2p's `handle` from a future unrelated
object's. Today every `.handle(` under `src` is a libp2p registration, so the name is exact — but a
genuinely unrelated `.handle(` introduced later trips a **false positive**. That is the deliberate
direction to err in (this flag's failure mode is silence, so a noisy guard is the cheap side), and it
is written up in the spec's docblock. Method *definitions* named `handle` — `MockNode` in
`src/testing/cohort-topic-mesh-harness.ts` has one — are structurally distinct and do not trip it;
there is a case pinning that. Dynamic dispatch (`node['handle'](…)`) is still a false negative, same
as for the dial half.

## 3. The guard still walks only `packages/db-p2p/src`

Unchanged from the dial-side guard, and correct today — `db-p2p` is the only package with a direct
libp2p dependency (`grep -rn "\.handle(" packages/*/src` outside `db-p2p` returns nothing). Noted in
the docblock: widen `srcRoot` if a second package ever takes one.

## 4. This is dormant on the topology this repo ships

`reference-peer` passes `{ reservations: { applyDefaultLimit: false } }`
(`packages/reference-peer/src/cli.ts:389`), so its relays impose no caps, libp2p does not mark those
connections limited, and neither side's opt-in matters. The new relay spec is the **only** place the
gated behaviour is exercised — it sets `applyDefaultLimit: true` explicitly for exactly that reason.
Keep that in mind when weighing the change: the guard and the spec are most of the durable value.

## 5. Loose component types around the registrar

`sync/service.ts` and `block-transfer-service.ts` declare their registrar as
`{ handle: (...args: any[]) => Promise<void> }`, and `cluster` / `repo` / `dispute` as
`(protocol: string, handler: StreamHandler, options: any)`. Nothing type-checks the options object
the helper hands them. That is tolerable *because* there is now exactly one site constructing it and
a guard keeping it that way — but it is why the AST guard, not the type system, is what actually
holds this invariant. No change made; recording the reasoning so a reviewer does not mistake the
`any`s for an oversight.

## 6. Not added to the package's public entry points

`register-protocol-handler.ts` is not exported from `src/index.ts` or `src/rn.ts` — matching
`open-protocol-stream.ts`, which is also internal. Both are reachable from the react-native entry via
their importers, so both keep type-only libp2p imports. `entry-parity.spec.ts` passes unchanged.

# Suggested review focus

- The `ProtocolRegistrar` structural type: does it accept every registrar shape without an `any`
  escape hatch anywhere it matters? (It typechecks today with no casts at any call site.)
- The negative-control fence in the relay spec — is "drive a known-good protocol, then settle 500 ms"
  a strong enough happens-after for CI, or should it be a longer fixed budget? It was chosen over a
  bare sleep to keep the file's runtime near its documented ~0.4 s.
- Whether the `expect(calls).to.be.greaterThanOrEqual(13)` case in the guard earns its keep. It is a
  belt-and-braces check that the migration was exhaustive; the `.handle(` assertion above it already
  catches a regression, so it is arguably redundant.
- Gap 1 (FRET) — decide whether it becomes a ticket, and where.
