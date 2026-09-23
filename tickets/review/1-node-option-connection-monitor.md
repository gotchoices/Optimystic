description: An app can now tell libp2p how patiently to wait for a connection-health ping reply, through a new `connectionMonitor` node option. A slow phone was being disconnected as dead while it was merely busy, and could never be configured out of it because the node factory built libp2p's options itself.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.connectionMonitor`, and the pass-through in `libp2pOptions`)
  - packages/db-p2p/src/connection-monitor.ts (new — the type re-export)
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts (both entries export it)
  - packages/db-p2p/test/connection-monitor-node-wiring.spec.ts (new)
  - packages/db-p2p/readme.md (React Native section, after the `noiseCrypto` paragraph)
source: gotchoices/Optimystic#21 (kjeib), relayed by the sereus tending session; root cause of sereus#13's slow-phone failure
----
# Review: node option `connectionMonitor`

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
and the requirement that the relay the phone talks through be given the same setting.

## Why the shape is what it is

libp2p pings every open connection every 10 s and aborts the connection on the first ping whose
reply is late. The deadline is adaptive but floors at 5 s (`DEFAULT_MIN_TIMEOUT` in
`@libp2p/utils`'s adaptive timeout). A phone whose event loop is saturated by pure-JavaScript Noise
misses that floor while perfectly healthy, is dropped, re-dials, and pays another handshake. The
relay half of this was already configurable because sereus builds its own libp2p there; the client
half was unreachable.

Our default is unchanged. Sereus picks its own value in cadre-core.

## Tests

One spec added, `test/connection-monitor-node-wiring.spec.ts`, following
`noise-crypto-node-wiring.spec.ts` — two real nodes over loopback TCP, one connection, one 2 s
observation window:

| test | what it verifies |
| --- | --- |
| `pings on the supplied interval` | the dialer, given `{ pingInterval: 250 }`, has an `rtt` on its side of the connection inside the window — so the supplied init reached libp2p's monitor |
| `leaves a node that supplied nothing on libp2p's own default interval` | the listener, given no `connectionMonitor`, has no `rtt` in that same window — so an omitted value leaves libp2p's defaults in place rather than a default of ours |

`Connection.rtt` is written only by libp2p's `ConnectionMonitor`, which is what makes it a clean
observation point. Both arms were checked non-vacuous by hand before the handoff: deleting the
pass-through fails the first test only (`expected undefined to be a number`), and replacing it with
`options.connectionMonitor ?? { pingInterval: 250 }` fails the second only (`expected 17 to equal
undefined`).

## Validation run

- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/db-p2p test` — 3111 passing, 63 pending, 0 failing.
- `yarn check:rn` from root — passed (Metro 6.6 s, hermesc 12.8 s). The RN entry changed, so this was
  the gate that mattered.
- `yarn lint`, `yarn lint:docs`, `yarn lint:deps` — clean.
- `yarn test:integration` and the rest of `yarn check` were not run.

## Known gaps, for the reviewer to weigh

- **The spec proves the object arrives, not that `pingTimeout` specifically does.** `pingInterval` is
  the field the spec observes; `pingTimeout` is the field a deployment actually sets. They ride in
  one object that is passed as one value, so an interval arriving does establish the object arrived —
  but observing a `pingTimeout` behaviourally would mean inducing a late ping, which is testing
  libp2p's own monitor, and the ticket ruled that out. Worth confirming that reasoning holds.
- **The negative arm bounds, it does not measure.** It proves the unset node's interval exceeds 2 s,
  not that it is exactly libp2p's 10 s — deliberately, since the exact default is libp2p's to change.
  A future libp2p that shortened its default below 2 s would fail this test; that is arguably the
  right outcome (the readme's claim about the default would also be wrong) but it is a coupling.
- **The spec's observation point is a libp2p internal fact.** `ConnectionMonitor` being the sole
  writer of `Connection.rtt` is true of libp2p 3.1.3 (the only two assignments in the tree are in
  `connection-monitor.js`). Parked as a tripwire `NOTE:` in the spec's header comment, naming the
  fallback observation (a distinctive `protocolPrefix` plus a counting handler on the far side) if a
  later libp2p stamps rtt from the transport or the upgrader too.
- **Cost of the spec.** Two node boots plus a fixed 2 s sleep, on a suite that currently runs ~2 min.
  The sleep is a fixed window rather than a poll because the negative arm needs a window to have
  elapsed, not a condition to have been met.
- **The readme's measured numbers are the reporter's, not reproduced here.** 0/3 stock, 2/3 relay
  only, 4/4 both ends, ~90 s each — from Optimystic#21. Nothing in this repo re-measures them.
- **Nothing forces the relay and the client to agree.** The readme says both ends need the setting
  and the doc comment repeats it, but a deployment that configures only one end gets the same
  half-fixed behaviour the reporter measured as 2 of 3. That is an operator concern rather than
  something this option can enforce; no guard was added.
