description: A peer reachable only through a relay can now be talked to in both directions — the side answering the call no longer refuses it. One shared registration helper replaces thirteen hand-written registrations, and a build-time guard stops a future one from forgetting.
files: packages/db-p2p/src/network/register-protocol-handler.ts, packages/db-p2p/test/dial-options-single-site.spec.ts, packages/db-p2p/test/open-protocol-stream-relay.spec.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/push-state-gossip.ts, packages/db-p2p/src/libp2p-node-base.ts
----

# What landed

Some peers — phones, browsers, machines behind a home router — cannot accept incoming network
connections and are reached indirectly through a **relay**. libp2p calls such a connection *limited*
and will not carry a protocol conversation over one unless **both** ends have said they accept
relayed traffic for that protocol. Optimystic said yes when calling out (fixed earlier) and no when
answering. Every one of its protocols was therefore unreachable on any peer that lives behind a
capped relay.

The fix is `packages/db-p2p/src/network/register-protocol-handler.ts` — the mirror of the existing
`open-protocol-stream.ts`. It bakes the opt-in in as a constant rather than an option, so a protocol
added later gets relay support without its author knowing the setting exists. All 13 registration
sites route through it. The settings that legitimately vary (the two stream caps, middleware, force,
signal) stay parameters and are **omitted rather than passed empty** when unset, so libp2p's own
defaults still apply.

The existing structural guard `test/dial-options-single-site.spec.ts` was generalized to cover both
directions: one shared AST walk (`findMemberCalls`) with thin wrappers for the calling half
(`dialProtocol` / `newStream`) and the answering half (`handle`), and per-method failure text so a
violation names the helper the author actually needs. 25 cases.

Two real-socket cases were added to `test/open-protocol-stream-relay.spec.ts` on the existing
relay topology: a protocol registered through the helper is reached over the relay; one registered
the old way never is.

Incidental: a local `registerProtocolHandlers` (plural) in `cohort-topic/host.ts` was renamed to
`registerCohortTopicProtocols` so it no longer sits one character from the imported helper, and a
comment in `libp2p-node-base.ts` was refreshed to name the new function. Both behaviour-neutral.

# Review findings

## Verification of the premise — confirmed independently

The implement handoff's central claims were re-checked from source rather than taken on trust:

- `packages/db-p2p/node_modules/libp2p/dist/src/connection.js:170` — the **answering** path reads
  back `registrar.getHandler(protocol).options.runOnLimitedConnection` and throws if it is not
  `true`. Line 80 is the separate, outbound check. Two independent options objects; both must opt
  in. **Confirmed.**
- `registrar.js:69-75` — the stored options are `{ defaults, ...opts }`, so passing a key with no
  value **does** overwrite a libp2p default. The helper's omit-don't-pass-empty construction is
  therefore load-bearing, not stylistic. **Confirmed, and it matters more than the handoff claimed.**
- The documented defaults (32 inbound / 64 outbound streams) match
  `registrar.js:4-5`. **Confirmed.**

## Tests re-run, plus independent mutation testing

| Command | Result |
| --- | --- |
| `yarn typecheck` (all workspaces) | clean, 13s |
| `yarn lint` | clean |
| `yarn build` | clean |
| `yarn workspace @optimystic/db-p2p test` | 2296 passing, 44 pending, **0 failing** |
| `yarn workspace @optimystic/db-p2p test:integration` | 30 passing, 2 pending, **0 failing** |
| `yarn test` (all workspaces) | passing, **0 failing**, 5m24s |
| guard spec alone (`--grep "exactly one place"`) | 25 passing |
| relay spec alone (`--grep "over a real circuit relay"`) | 6 passing, ~1s |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

The handoff mutation-tested only the negative control. **Both directions were mutation-tested here**,
and both mutations were reverted (working tree verified clean afterwards):

- Flipping the helper's constant to `false` → **2 failing** (both new relay cases). The positive case
  has teeth; it is not passing for an unrelated reason.
- Adding the opt-in to the deliberately-bare control registration → **1 failing** (the control). The
  negative case has teeth too.

The "drive a known-good protocol, then settle 500 ms" fence the handoff asked about is **adequate**:
under the first mutation the fence itself is what fails first, with a legible message, which is the
correct failure mode. No change needed.

## Coverage the tests were checked against

- **Happy path** — served protocol reached over a real circuit. Covered.
- **Negative control** — bare registration never reached, with a liveness fence rather than a sleep.
  Covered, and mutation-proven.
- **Guard unit cases** — bare call, call already passing options, call passing the flag by hand,
  method *definition* named `handle`, plain `handle(...)` invocation, the name inside a comment or a
  string, `unhandle`. Covered.
- **Non-vacuity** — the walk finds the call inside the allowlisted helper. Covered.
- **Exhaustiveness** — counted independently: exactly **13** real call sites, matching the
  assertion and the handoff's table. (A 14th grep hit is prose in a comment, which the AST walk
  correctly ignores — itself evidence the walk is parsing, not scanning text.)

## Findings

**Major — one, filed.** FRET has the identical defect and this fix does not close it.
`../Fret/packages/fret/src/rpc/protocols.ts:161` — `registerRpcHandler` (the single site all FRET
protocols register through) omits the opt-in, while its calling counterpart at :719 passes it. All
five FRET protocols are affected: `neighbors`, `neighbors/announce`, `maybeAct`, `leave`, `ping` —
the ring-maintenance and routing calls Optimystic uses to *find* which peer holds what. A relay-only
peer therefore remains effectively unroutable even with this ticket landed. Verified by reading both
sites. The handoff flagged this; the review verified it, counted the blast radius, and found a
**second arm at the same site** (the same pass-an-empty-key trap the db-p2p helper deliberately
avoids — currently harmless, one refactor from silently discarding libp2p's defaults).

Filed to `tickets/blocked/fret-inbound-rpc-refused-on-relay-connections.md` rather than `backlog/`:
the code is in a different repository reached through a `portal:` resolution, published consumers
get `p2p-fret` from npm, and whether/when that release happens is a human's decision. Site-claim
grep over the whole board found nothing already claiming it.

**Minor — one, fixed in this pass.** The new helper told a reader "we accept relayed streams" but
not that a stock relay caps the *whole* relayed connection at 128 KiB / 2 minutes — which one cohort
frame (512 KiB) can exhaust on its own. Accepting the stream is necessary but not sufficient. That
cap was already documented, but only at the relay-operator seam (`NodeOptions.relayServerInit` in
`libp2p-node-base.ts:186-194`), where a reader arriving at the handler helper would not meet it. Added
a short cross-reference to the helper's docblock. No duplicate `NOTE:` was added, since the concern
already has a home.

**Tripwires — none new.** The one candidate (relay data/duration caps truncating a transfer that now
gets accepted instead of refused) is already recorded at the site above; the fix was to link to it,
not to restate it.

**Accepted tradeoffs — one encountered, respected.** `open-protocol-stream.ts` carries a
`NOTE: accepted tradeoff` explaining why db-p2p duplicates FRET's dial helper rather than delegating
to it. That decision covers *dialling* only and does not pre-decide the FRET finding above, which is
about FRET's own answering side. Not re-litigated.

## Implementer's open questions — answered

- **Does `ProtocolRegistrar` accept every registrar shape without an `any` escape hatch?** Yes.
  `yarn typecheck` is clean across all workspaces with no cast at any of the 13 sites. The mesh
  harness's `MockNode.handle` takes two parameters and is assignable to the three-parameter
  structural type; it ignores the extra argument at runtime, which is correct for an in-process
  double. The loose `any` component types the handoff worried about (gap 5) are pre-existing and
  unchanged; the AST guard, not the type system, is what holds this invariant, and the handoff is
  right to say so.
- **Is the 500 ms fence strong enough?** Yes — see the mutation result above.
- **Does the `>= 13` count assertion earn its keep?** Yes, keep it. It is the only assertion in the
  file that catches a registration site *silently disappearing* — a refactor that drops a
  `registerProtocolHandler` call leaves the protocol unserved, and the `.handle(` assertion above it
  says nothing about that. The cost (a deliberate protocol removal must edit the number down) is the
  right cost: removing a served protocol should be a conscious edit.
- **Where does the FRET gap go?** `blocked/`, as above.

## Checked and found clean — stated explicitly rather than assumed

- **Completeness of the migration surface.** `grep` over the whole repo (excluding `node_modules`
  and `dist`) finds no `.handle(` under any package's `src` outside the helper itself.
  `packages/db-p2p` remains the only package with a direct libp2p dependency, so the guard's
  `src`-only walk is still correct; the docblock says to widen it if that changes.
- **Transitive coverage.** The refreshed comment in `libp2p-node-base.ts` claims all four
  `register*Handler` helpers now route through the new function. Verified: `registerRecoverHandler`
  and `registerMatchmakingQueryHandler` reach it through `handleRequestResponse` in
  `cohort-topic/stream-util.ts`. The claim is accurate.
- **Test-side registrations.** Three specs register handlers with a bare `.handle(` outside the
  guarded tree. Each was checked: `circuit-relay-long-lived.spec.ts:113` already passes the opt-in;
  `foreign-peer-interop` and `identify-push-propagation` are direct-connection paths where it is
  irrelevant; the one in `open-protocol-stream-relay.spec.ts:148` is the deliberate negative control.
- **Security seam.** Inbound authorization (`inbound-authorization.ts`) gates on
  `connection.remotePeer`, which is transport-authenticated and identical over a relay. Accepting
  relayed streams does not widen or bypass it.
- **Resource cleanup.** All five service classes still `unhandle` on stop; the helper adds no
  cleanup obligation.
- **Docs.** Every `.md` mentioning relays or limited connections was read. `docs/internals.md`
  § Third-Party Address Learning, `packages/db-p2p/docs/cluster.md` § Access Control, and both
  READMEs discuss relay *addressing*, not the stream opt-in, and none of them made a claim this
  change falsifies. No documentation file names either helper, which is consistent with how the
  dial-side helper shipped — the invariant is documented in the helper docblocks and the guard's
  own docblock, which is where someone about to violate it will actually be reading.

## Noted, deliberately not changed

`test/dial-options-single-site.spec.ts` now guards two invariants but its filename names only the
dialling one. Renaming would leave a dangling reference in the archived
`tickets/complete/debt-shared-limited-connection-dial-options.md`, and the discoverability gap is
already closed by the file's own docblock, both `describe` titles, and the two helper docblocks that
name the spec by path. Left as is; recorded here so the next reader knows it was weighed.
