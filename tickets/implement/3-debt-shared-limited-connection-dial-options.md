description: Peers that can only be reached through a relay — the normal situation for phones and machines behind a home router — are silently unreachable from one part of the system that forgot an easy-to-miss opt-in, and the correct version of that opt-in is hand-copied in three places; consolidate it into one shared helper that cannot be called wrongly, and add a guard so a fourth copy cannot be written.
files: packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/cohort-topic/stream-util.spec.ts, packages/db-p2p/test/open-protocol-stream.spec.ts, packages/db-p2p/test/dial-options-single-site.spec.ts, packages/db-core/src/network/i-peer-network.ts
difficulty: medium
----

# One place opens a libp2p protocol stream; everywhere else calls it

## Background, in plain terms

A peer behind a NAT (a phone, a laptop on home wifi) usually cannot be dialed directly. It reaches
the network through a **relay** — a third node that forwards traffic. libp2p represents such a
connection as a **limited connection**, and by default it refuses to open a protocol stream over
one. The caller must explicitly opt in by passing `runOnLimitedConnection: true`.

Omitting the flag produces no compile error and no obvious failure — it produces "that peer just
never answers", which reads like an unrelated connectivity problem. This repo has already been bitten
once (all four cohort-topic dial paths, fixed under
`cohort-topic-streams-rejected-on-limited-relay-connections`). One more site is still broken today,
and the correct logic now exists in three hand-written copies.

This ticket does two things: fix the broken site, and collapse the three copies into one helper whose
signature makes the flag impossible to forget.

## The current state of the code — verified, not assumed

`grep -rn "\.dialProtocol(\|\.newStream(" packages/*/src --include=*.ts` returns exactly four lines
(three call sites, one of which has both a warm and a cold path):

| Site | `runOnLimitedConnection` | `negotiateFully` | `signal` | open-status filter | prefers direct |
|---|---|---|---|---|---|
| `cohort-topic/stream-util.ts:62` (`openStream`) | yes | *deliberately unset* | no | yes | yes |
| `libp2p-key-network.ts:637,649` (`connect`) | yes | `false` | yes | yes | yes |
| `libp2p-node-base.ts:1068` (inline lambda) | **no** | no | **dropped** | **no** | **no** |

FRET's `openRpcStream` (`p2p-fret/src/rpc/protocols.ts:706`) is a fourth copy of the same logic, and
— unlike when this ticket was originally filed — it **is** now exported from the package root
(`p2p-fret/src/index.ts:152`, version `1.0.0-beta.3` in this tree). It cannot simply replace all
three, because it pins `negotiateFully: false` with no way to opt out, and one of our sites
deliberately does not set that. See *Decision 1*.

## Decision 1 — a local helper in `db-p2p`, not a direct swap to FRET's `openRpcStream`

`stream-util.ts` carries an accepted-tradeoff `NOTE:` (at `STREAM_OPTIONS`, around line 40) recording
that it deliberately does **not** set `negotiateFully: false`: skipping full multistream-select
negotiation saves a round trip but defers an unsupported-protocol failure from stream-open to the
first read, which would turn `sendOneWay` against a peer lacking the protocol into a silent no-op.
Its stated revisit condition is "if stream-open latency shows up in a profile" — **not tripped**.
`libp2p-key-network.ts#connect` is request/response and always reads a reply, so it can and does take
the cheaper setting.

FRET's helper pins `negotiateFully: false`, so adopting it wholesale would silently reverse a
decision a human already made. It also has no hook for the pre-dial check `connect` needs
(*Decision 2*). So: **one `db-p2p`-local helper**, with `negotiateFully` as its single knob and
`runOnLimitedConnection` baked in.

Tradeoff accepted: `db-p2p` keeps one copy of connection-selection logic that also lives in FRET.
Three copies → one is the win; zero would require FRET to parameterize `negotiateFully`, which is an
upstream change gated on a dependency release. Record this at the new module in a `NOTE:` so the next
reader does not re-derive it, and delete the now-stale FRET paragraph from the `stream-util.ts`
module docblock (it says FRET's helper is the reason the local copy stays — after this change the
local copy *is* the shared helper).

## Decision 2 — `runOnLimitedConnection` is not a parameter

The whole point is that a new call site gets relay support without its author knowing the flag
exists. So the helper takes no `runOnLimitedConnection` option at all — it is a constant inside the
module. The two things that legitimately vary become explicit parameters, and the pre-dial check
`connect` performs becomes a callback.

New module: `packages/db-p2p/src/network/open-protocol-stream.ts`

```ts
export interface OpenProtocolStreamOptions {
  /** Forwarded to libp2p so a caller's deadline cancels both the reuse and the dial. */
  signal?: AbortSignal;
  /**
   * Omit for libp2p's default (full multistream-select negotiation at stream-open).
   * Pass `false` to save the round trip, accepting that an unsupported-protocol failure
   * is deferred to the first read — only safe when the caller always reads a reply.
   */
  negotiateFully?: boolean;
  /**
   * Runs immediately before a FRESH dial and never on the connection-reuse path.
   * Throwing aborts the open. This is the seam for checks that are only meaningful
   * when no connection exists yet.
   */
  beforeDial?: () => Promise<void> | void;
}

/** True for a circuit-relay ("limited") connection. */
export function isLimitedConnection(c: Connection): boolean;

export async function openProtocolStream(
  node: Libp2p,
  peer: PeerId,
  protocol: string,
  options?: OpenProtocolStreamOptions,
): Promise<Stream>;
```

Behavior, lifted from the two correct existing copies:

- Throw immediately if `options.signal` is already aborted (with the signal's own reason), before
  touching connections. FRET's helper does this; neither of ours does today. Harmless improvement —
  both old and new paths end in an abort error, only the throw site moves.
- Take `node.getConnections?.(peer) ?? []`, keep entries with `status === 'open'` **and** a callable
  `newStream`.
- Prefer a non-limited connection; fall back to the limited one only when it is the only open path.
- Build the stream options as `{ runOnLimitedConnection: true }` plus `negotiateFully` **only when
  the caller passed it** and `signal` **only when the caller passed it** — omit the keys rather than
  setting them to `undefined`, so libp2p sees its own defaults.
- If a connection was chosen, `chosen.newStream([protocol], streamOptions)`.
- Otherwise `await options?.beforeDial?.()`, then `node.dialProtocol(peer, [protocol], streamOptions)`.

`isLimitedConnection` keeps both existing detections: libp2p stamps a relayed connection with
`limits`, and we additionally sniff `/p2p-circuit` in the remote multiaddr for transports/versions
that leave `limits` unpopulated.

The module must stay import-clean for the react-native entry (`src/rn.ts`) — type-only imports from
`libp2p` / `@libp2p/interface`, nothing node-specific.

## Decision 3 — the broken site loses its lambda entirely, rather than gaining the flag

`packages/db-p2p/src/libp2p-node-base.ts:1068` builds the `RestorationCoordinator` with an inline
object literal standing in for `IPeerNetwork`:

```ts
{ connect: (pid, protocol) => node.dialProtocol(pid as Parameters<typeof node.dialProtocol>[0], [protocol]) }
```

`keyNetwork` — a real `Libp2pKeyPeerNetwork`, which `implements IKeyNetwork, IPeerNetwork` — is
already in scope in the same `try` block (constructed at `libp2p-node-base.ts:730`), and the sibling
`fetchArchiveFromPeer` at `libp2p-node-base.ts:755` already passes it to a `SyncClient`. Replace the
literal with `keyNetwork`. This is strictly better than patching the flag into the lambda: it removes
a divergent implementation instead of documenting one, and fixes the second defect below for free.

**Two live defects this closes:**

1. **No `runOnLimitedConnection`.** Arachnode block restoration cannot pull a block from a holder
   reachable only via relay. The stream-open fails and `RestorationCoordinator.queryPeer`
   (`storage/restoration-coordinator.ts:143-159`) catches it and returns `undefined`, so the
   coordinator moves on as though that peer did not have the block — a silent false negative.

2. **The `options?: AbortOptions` parameter is dropped.** The interface is
   `connect(peerId, protocol, options?)` (`packages/db-core/src/network/i-peer-network.ts:7`), and
   the caller does supply one: `SyncClient.requestBlock` applies `withRpcDeadlineDefaults`
   (`src/rpc-deadline.ts`), which sets `dialTimeoutMs: 3000`, and `ProtocolClient.processMessage`
   (`src/protocol-client.ts:81-84`) turns that into `{ signal: dialSignal }` on the `connect` call.
   The lambda ignores it, so an unreachable peer falls back to libp2p's connection-manager default
   `dialTimeout` — `10_000` ms (`libp2p/dist/src/connection-manager/constants.defaults.js`;
   `libp2p-node-base.ts:497` sets `maxConnections` and `inboundUpgradeTimeout` but does **not**
   override `dialTimeout`). That is 3.3× the intended per-peer deadline, and
   `RestorationCoordinator.restore` walks ring peers **sequentially** — my transaction ring, then
   every inner ring — so the cost multiplies by the number of unreachable candidates.

Both are `static`: established by reading the code and comparing the two implementations of the same
interface method, not by observing a failed restoration.

After the swap, `RestorationCoordinator` also gains the address-book seeding (`recordPeerAddresses`,
optional on the interface — it never calls it, harmless) and can now see
`SelfRelayOnlyAddressesError`. `queryPeer` catches every error and returns `undefined`, so that
surfaces as "this peer did not have it", the same as any other failure. Confirm that catch is still
unconditional when you make the change.

## Decision 4 — a guard so a fourth copy cannot be written

The helper alone does not stop the next author from calling `node.dialProtocol` directly; nothing in
TypeScript can forbid a method on a third-party type. So add a source-scan guard test, modeled on the
existing `packages/db-p2p/test/testing-entry-runtime-deps.spec.ts` (same package, same shape: walk
source files, assert a structural rule).

`packages/db-p2p/test/dial-options-single-site.spec.ts`:

- Walk `packages/db-p2p/src/**/*.ts`.
- Strip `//` line comments and `/* … */` block comments before matching, so prose that mentions the
  method names does not trip it (several docblocks in `stream-util.ts` and `libp2p-key-network.ts`
  legitimately do).
- Match member-call syntax `/\.(dialProtocol|newStream)\s*\(/`. This deliberately does **not** match
  a *method definition* — `src/testing/cohort-topic-mesh-harness.ts:214` defines
  `dialProtocol(peer, protocols)` on its `MockNode` with no leading dot, and must keep passing.
- Allowlist exactly one file: `src/network/open-protocol-stream.ts`. Any other hit fails with a
  message naming the file, the line, and pointing at `openProtocolStream`.

This is the weakest rung of the ladder on its own, but paired with the helper it is what actually
catches copy #4 — and the allowlist being a one-element set is the readable statement of the rule.

## Call-site rewrites

**`cohort-topic/stream-util.ts`** — delete the local `openStream`, `isLimitedConnection`, and
`STREAM_OPTIONS`; call `openProtocolStream(node, peer, protocol)` with no `negotiateFully`. Move the
accepted-tradeoff `NOTE:` about `negotiateFully` from `STREAM_OPTIONS` to the two call sites (or one
shared spot in this module) — it explains why *this* module omits the option, so it must stay next to
the omission, not migrate to the shared helper. Delete the stale FRET paragraph from the module
docblock as described in *Decision 1*. Leave the `requestResponse` / `sendOneWay` signatures and the
`NOTE:` about `sendFramed` backpressure alone.

**`libp2p-key-network.ts#connect`** (around line 617) — becomes:

```ts
async connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream> {
  return await openProtocolStream(this.libp2p, peerId, protocol, {
    signal: options?.signal,
    negotiateFully: false,
    beforeDial: () => this.assertNotSelfRelayOnly(peerId, protocol, options),
  })
}
```

Keep `assertNotSelfRelayOnly` and its `NOTE:` about the extra `peerStore.get` exactly as they are.
Preserve the two documented properties of that check: it runs **only** on the cold path (a warm
connection to a self-relay-only peer is still usable), and it calls
`options?.signal?.throwIfAborted()` after its `peerStore` read so a caller that cancelled mid-read
gets its own reason. Delete the now-unused private `isLimitedConnection` method (line 600) — or
re-export the helper's if anything else in the class uses it; check before deleting.

**`libp2p-node-base.ts:1068`** — `keyNetwork` in place of the object literal, per *Decision 3*.

## Edge cases & interactions

The implementer must cover these; the reviewer will check for them.

**Connection selection**
- No connections at all → fresh dial, `beforeDial` runs first.
- Only a limited (relayed) connection open → reuse it, with the flag set.
- Direct and limited both open → direct wins, limited is untouched.
- A connection libp2p has not yet evicted but whose `status` is `closing` / `closed` → skipped; a
  healthy sibling is used instead.
- Every indexed connection non-open → fresh dial, `beforeDial` runs.
- A connection object without a callable `newStream` → skipped (the current filter already does
  this; keep it — mocks and half-torn-down entries hit this).
- `node.getConnections` absent entirely → treat as `[]` and dial. `libp2p-key-network.ts` guards with
  `?.` today and mocks rely on it.

**Options construction**
- `negotiateFully` omitted by the caller → the key must be **absent** from the object passed to
  libp2p, not present-and-`undefined`.
- Same for `signal`.
- `runOnLimitedConnection` present on **both** the reuse path and the dial path. The existing spec
  asserts this per-path for a reason: the first fix in this class got the dial path and missed reuse.

**Cancellation**
- Signal already aborted at entry → throw the signal's reason before selecting a connection or
  dialing; nothing is opened.
- Signal aborts during `beforeDial` → `assertNotSelfRelayOnly`'s post-read `throwIfAborted()` must
  still fire.
- `beforeDial` throws `SelfRelayOnlyAddressesError` → propagates to the caller, and **no** dial
  happens.
- `beforeDial` must not run when a connection is reused.

**Cross-subsystem**
- `src/testing/cohort-topic-mesh-harness.ts` `MockNode` returns `getConnections() => []` and defines
  `dialProtocol(peer, protocols)` with **two** parameters; the helper passes three arguments. JS
  ignores the extra, so the harness keeps working — but run the cohort-topic harness specs and
  confirm, rather than assuming.
- The react-native entry (`src/rn.ts`) must still build; keep the new module's imports type-only.
- `RestorationCoordinator.queryPeer` must still catch every error from `connect` (it now sees a new
  error type).
- Backlog ticket `debt-stream-reply-no-result-untyped` also targets `stream-util.ts`, but at a
  different seam (the return type of `requestResponse`). No conflict expected; if it has landed by
  the time you work this, rebase around it rather than reverting it.

## Tests

Replace `packages/db-p2p/test/cohort-topic/stream-util.spec.ts` with a package-level
`packages/db-p2p/test/open-protocol-stream.spec.ts`. The existing file is already the right shape — a
table of helpers (`requestResponse`, `sendOneWay`) driven through one set of scenarios, with
connection stubs that record the options they were handed. Generalize the table to every entry point
that opens a stream, so a new call site joins the sweep by adding one row:

- `openProtocolStream` itself
- `requestResponse` (cohort-topic)
- `sendOneWay` (cohort-topic)
- `Libp2pKeyPeerNetwork.prototype.connect` — needs a constructed instance; `test/libp2p-key-network.spec.ts`
  and `test/relay-self-relay-only-dial.spec.ts` already build the node stub (`peerId`,
  `addEventListener`, `getConnections`, `peerStore`, `dialProtocol`) — reuse their pattern rather
  than inventing a third.

Scenarios × every row, each asserting the observable outcome:

- reuse path sets `runOnLimitedConnection: true` → the chosen connection's recorded options
  `deep.include({ runOnLimitedConnection: true })`
- dial path sets `runOnLimitedConnection: true` → the node's recorded dial options likewise
- relayed connection is the only open path → it is the one opened, with the flag
- direct preferred over relayed → direct opened, relayed untouched
- non-open indexed connection skipped → healthy sibling opened
- all indexed connections closed → fresh dial happens

Plus scenarios that only make sense on the helper (single row, not the table):

- `negotiateFully` omitted → the key is absent from the recorded options object
  (`expect(recorded).to.not.have.property('negotiateFully')`)
- `negotiateFully: false` → present and `false`
- `signal` omitted → key absent; `signal` supplied → forwarded on both paths
- already-aborted signal → rejects with the signal's reason; nothing opened, `beforeDial` not called
- `beforeDial` runs exactly once before a fresh dial, and zero times when a connection is reused
- `beforeDial` throws → rejection propagates and `dialProtocol` was never called

And the guard, `test/dial-options-single-site.spec.ts`:

- passes on the post-change tree with a one-element allowlist
- fails when a `.dialProtocol(` is planted in a second `src` file (assert the failure message names
  the offending path — write this as a unit check over the scan function, not by editing the tree)
- does **not** trip on `src/testing/cohort-topic-mesh-harness.ts`'s method definition, nor on
  comments mentioning the names

## TODO

Phase 1 — the shared helper

- Add `packages/db-p2p/src/network/open-protocol-stream.ts` with `openProtocolStream`,
  `isLimitedConnection`, and `OpenProtocolStreamOptions` per *Decision 2*.
- Carry a `NOTE:` recording why this duplicates FRET's `openRpcStream` (it pins `negotiateFully:
  false`; one of our sites deliberately does not set it) with the revisit condition: drop the local
  copy if FRET ever parameterizes that option.
- Keep imports type-only so the react-native entry is unaffected.

Phase 2 — collapse the copies

- Rewrite `cohort-topic/stream-util.ts#openStream` to delegate; delete its local
  `isLimitedConnection` and `STREAM_OPTIONS`; relocate the `negotiateFully` accepted-tradeoff `NOTE:`
  to the call sites; delete the now-stale FRET paragraph from the module docblock.
- Rewrite `libp2p-key-network.ts#connect` to delegate with `negotiateFully: false` and
  `beforeDial: () => this.assertNotSelfRelayOnly(...)`; delete the now-unused private
  `isLimitedConnection` after confirming nothing else in the class uses it.
- Replace the inline `IPeerNetwork` literal at `libp2p-node-base.ts:1068` with `keyNetwork`.

Phase 3 — tests and guard

- Add `test/open-protocol-stream.spec.ts` with the generalized table plus the helper-only scenarios;
  delete `test/cohort-topic/stream-util.spec.ts` (subsumed). Leave
  `test/cohort-topic/stream-util-framing.spec.ts` alone.
- Add `test/dial-options-single-site.spec.ts` with a one-element allowlist, comment stripping, and a
  unit check over the scan function for the failure message.

Phase 4 — validate

- `yarn workspace @optimystic/db-p2p build` (or the repo's build script) and `yarn typecheck`.
- `yarn workspace @optimystic/db-p2p test` in the foreground, no redirection. Confirm the
  cohort-topic harness specs, `restoration-coordinator.spec.ts`, `libp2p-key-network.spec.ts`,
  `relay-self-relay-only-dial.spec.ts`, and `protocol-client-dial-timeout.spec.ts` all pass.
- Note in the review handoff that the relay behavior itself is **not** exercised end-to-end here:
  confirming it needs a live relay, a relay-only peer holding a block, and an arachnode peer
  restoring it. `packages/db-p2p/test/util/relay-topology.ts` has the scaffolding (`spawnRelayNode`,
  `spawnTcpServicePeer`, `spawnCircuitOnlyPeer`, `waitForCircuitListen`) used by the `RUN_LONG_TESTS`-gated specs; say
  plainly whether you added such a spec or left it to the reviewer to weigh.
