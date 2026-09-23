description: An app can now tell libp2p how patiently to wait for a connection-health ping reply, through a new `connectionMonitor` node option. A slow phone was being disconnected as dead while it was merely busy, and could never be configured out of it because the node factory built libp2p's options itself.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.connectionMonitor`, and the pass-through in `libp2pOptions`)
  - packages/db-p2p/src/connection-monitor.ts (new — the type re-export)
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts (both entries export it)
  - packages/db-p2p/test/connection-monitor-node-wiring.spec.ts (new)
  - packages/db-p2p/readme.md (React Native section, after the `noiseCrypto` paragraph)
source: gotchoices/Optimystic#21 (kjeib), relayed by the sereus tending session; root cause of sereus#13's slow-phone failure
----
# Complete: node option `connectionMonitor`

## What landed

`NodeOptions.connectionMonitor?: ConnectionMonitorInit`, passed to libp2p as
`connectionMonitor: options.connectionMonitor` with no default of our own — an absent value is
libp2p's own "use my defaults" signal, and substituting anything here would silently override them.
The field is libp2p's own init type, unwrapped and untouched.

`src/connection-monitor.ts` re-exports that type as `Libp2pConnectionMonitorInit`, exported from
both `index.ts` and `rn.ts`, exactly as `noise-crypto.ts` is — so an app can type the option without
taking a direct dependency on `libp2p` at the major this package builds against.

The readme's React Native section gains a paragraph after the `noiseCrypto` one: what the monitor
does, the measured failure, the example `pingTimeout: { minTimeout: 30_000, maxTimeout: 600_000 }`,
which of those two fields actually changes anything, and the requirement that the relay the phone
talks through be given the same setting.

## Why the shape is what it is

libp2p pings every open connection every 10 s and aborts the connection on the first ping whose
reply is late. A phone whose event loop is saturated by pure-JavaScript Noise misses that deadline
while perfectly healthy, is dropped, re-dials, and pays another handshake. The relay half of this
was already configurable because sereus builds its own libp2p there; the client half was
unreachable.

Our default is unchanged. Sereus picks its own value in cadre-core.

## Review findings

### Fixed in this pass

**The documentation described a deadline that adapts, and recommended a field that does nothing.**
Both the `NodeOptions.connectionMonitor` doc comment and the readme paragraph said the ping deadline
"adapts to the round trips it observes" and floors at 5 s. The floor is right; the adaptation is not.
libp2p's `ConnectionMonitor` builds an `AdaptiveTimeout` and asks it for a deadline on every ping,
but it never calls that timeout's `cleanUp` — the only method that feeds an observed duration back
in. The moving average the deadline is computed from therefore stays at its initial zero forever, and
the deadline is always exactly `minTimeout`. Verified by reading both dependencies
(`ConnectionMonitor` and `AdaptiveTimeout` in the installed libp2p 3.1.3 / `@libp2p/utils`, no
`cleanUp` call anywhere in libp2p's tree) and by running the timeout directly: five successive
`getTimeoutSignal()` calls on `{ minTimeout: 30_000, maxTimeout: 600_000 }` all returned 30000, and
the default returned 5000.

That is a real trap for the reader the ticket was written for. An operator told the deadline "widens
toward `maxTimeout`" would reasonably set `{ maxTimeout: 600_000 }` alone, get no change at all —
still a flat 5 s — and have no way to tell from the docs why. The recommended example is kept
verbatim, because it is the configuration the field measurements in the readme actually ran with, but
both sites now say plainly that `minTimeout` is the only field that changes the deadline and that
`maxTimeout` is never reached. A `NOTE:` tripwire at the doc comment records what the claim rests on
and what to re-check if a later libp2p starts reporting ping times back.

**Cut the spec's negative arm, and replaced its fixed sleep with a bounded wait.** The handoff
flagged this arm for weighing and the weighing came out against it. `leaves a node that supplied
nothing on libp2p's own default interval` asserted that a node given no `connectionMonitor` had no
`rtt` after a fixed 2 s window. That bounds rather than measures — "no ping in 2 s" is equally
consistent with the monitor being disabled outright or set to any interval above 2 s — so it did not
establish the claim in its name, while costing the spec's entire 2 s sleep and coupling the suite to
libp2p's default ping interval, which is libp2p's to change. The contract it stood for ("we
substitute no default of our own") is a single line of code with a comment on it. The surviving
positive arm now polls for `Connection.rtt` up to 5 s instead of sleeping 2 s flat — deliberately
under libp2p's 10 s default, so a dropped pass-through cannot be rescued by the default's first ping.
The spec runs in ~300 ms. Mutation-checked: deleting `connectionMonitor: options.connectionMonitor`
fails it with `expected undefined to be a number`; the line was restored and re-verified present.

### Checked, nothing found

- **The pass-through of an explicit `undefined`.** libp2p gates on `init.connectionMonitor?.enabled
  !== false` and defaults the constructor's `init` to `{}`, so a present-but-undefined key is exactly
  equivalent to an absent one. The surrounding code uses the conditional-spread idiom for
  `connectionGater`; the unconditional form is kept here because it states "we never substitute"
  more directly, which is the property the comment above it is defending.
- **Both entry points reach it.** `createLibp2pNode` (RN) forwards `NodeOptions` wholesale to
  `createLibp2pNodeBase`, so the option is live on the entry the reporting deployment uses. The
  type-only `connection-monitor.ts` re-export is exported from `index.ts` and `rn.ts`; the RN bundle
  check passes, so Metro and Hermes accept the module that compiles to an empty one.
- **The readme's other technical claims.** The 10 s ping interval, the 5 s default deadline, and
  "aborts on the first late reply" (libp2p's `abortConnectionOnPingFailure` defaults to true) all
  check out against the installed source.
- **Docs that should have been touched.** `noiseCrypto` — the closest analogue, and the paragraph
  this one sits beside — is documented only in `packages/db-p2p/readme.md`; no options table,
  `docs/` file or `internals.md` section enumerates `NodeOptions`. The readme is the whole surface,
  and it is current.
- **Site claims on the board.** Several open tickets name `libp2p-node-base.ts` (it is a 2000-line
  hub); none touches the connection monitor, so nothing needed an arm appended.

### Noticed and parked

- **File size.** `packages/db-p2p/src/libp2p-node-base.ts` is 2000 lines (`wc -l`), of which this
  work added 21 (net 30 after the review's doc-comment expansion). The theme is already claimed by
  `tickets/backlog/debt-node-factory-wiring-steps-own-their-teardown.md`, which names the same file
  and the single 1283-line function inside it; that ticket's own measurement is now stale (it
  recorded 1651 lines) but re-measuring another ticket's body is not this review's business. No new
  ticket — the Nth instance of a claimed class is evidence, not a ticket.
- **The `Connection.rtt` observation point** is a libp2p internal fact. The tripwire `NOTE:` the
  implementer left in the spec's header comment is kept, naming the fallback observation (a
  distinctive `protocolPrefix` plus a counting handler on the far side) if a later libp2p stamps
  `rtt` from the transport or the upgrader too.

### Weighed and left alone

- **The spec proves the object arrives, not that `pingTimeout` specifically does.** The handoff asked
  for this reasoning to be confirmed, and it holds: the init is passed as one value, so an arriving
  `pingInterval` establishes the object arrived. Observing a `pingTimeout` behaviourally would mean
  inducing a late ping, which tests libp2p's own monitor.
- **The readme's measured numbers are the reporter's** (0/3 stock, 2/3 relay only, 4/4 both ends,
  ~90 s each, from Optimystic#21) and nothing in this repo re-measures them. They are attributed as
  measurements of a deployment, not as a property of this code, which is the honest framing.
- **Nothing forces the relay and the client to agree.** A deployment that configures only one end
  gets the half-fixed behaviour the reporter measured as 2 of 3. That is an operator concern this
  option cannot enforce — the relay is another repository's libp2p — and the readme and doc comment
  both say so. No guard added.

## Validation run

- `yarn workspace @optimystic/db-p2p build` — clean (its `tsconfig` includes `test`, so the spec
  typechecks here).
- `yarn workspace @optimystic/db-p2p test` — 3110 passing, 63 pending, 0 failing (3111 before; one
  fewer test is the cut negative arm).
- `yarn check:rn` from root — passed (Metro 7.8 s, hermesc 14.7 s).
- `yarn lint`, `yarn lint:docs`, `yarn lint:deps` — clean.
- `yarn test:integration` and the rest of `yarn check` were not run.
