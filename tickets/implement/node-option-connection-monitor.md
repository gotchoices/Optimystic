description: An app cannot set how patiently libp2p's connection monitor waits for a ping reply, because the node factory hardcodes its libp2p options. On a slow phone running pure-JS Noise the default (ping every 10 s, drop the connection on the first reply slower than about 5 s) drops a busy but healthy peer. The peer then re-dials and pays another handshake, and a sync never converges. Add a `connectionMonitor` node option, passed straight through to libp2p, with the same shape as `noiseCrypto`.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions`, `libp2pOptions`)
  - packages/db-p2p/src/noise-crypto.ts (the re-export pattern to mirror)
  - packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts (exports)
  - packages/db-p2p/test/noise-crypto-node-wiring.spec.ts (the wiring-spec pattern to mirror)
  - packages/db-p2p/readme.md (the React Native section beside the `noiseCrypto` paragraph)
source: gotchoices/Optimystic#21 (kjeib), relayed by the sereus tending session; root cause of sereus#13's slow-phone failure
----
# Node option: connectionMonitor

## Why

libp2p's connection monitor pings each connection every 10 s and aborts the connection on the first
ping that times out. The timeout adapts, but its floor is 5 s. A phone whose event loop is saturated by
pure-JS Noise (see the `noiseCrypto` option) misses that deadline. It is dropped, re-dials, and pays a
full handshake again, and the spiral is the divergence reported in sereus#13. The reporter measured this
at full device crypto cost:

- stock: 0 of 3 runs pass
- relay only, `pingTimeout: { minTimeout: 30000, maxTimeout: 600000 }`: 2 of 3
- relay and clients both configured: 4 of 4, about 90 s each (slow but correct)

The relay can be configured already, because sereus builds its own libp2p there (sereus PR #15). The
client half is unreachable: `createLibp2pNodeBase` builds `libp2pOptions` itself and exposes no monitor
setting.

## What to build

The same shape as `noiseCrypto`:

- `NodeOptions.connectionMonitor?: ConnectionMonitorInit`. `ConnectionMonitorInit` is exported as a type
  from `libp2p` 3.1.x (`export type { … ConnectionMonitorInit … }` in its `index.d.ts`). Pass it
  as `connectionMonitor: options.connectionMonitor` in `libp2pOptions`. Unset must mean exactly today's
  behaviour: libp2p treats an undefined `connectionMonitor` as its default, so do not substitute our own
  default. The doc comment says what the monitor does, why a slow peer wants a longer `pingTimeout`,
  and that the value is libp2p's own init, passed through unchanged.
- A type re-export so an app does not need to depend on `libp2p` at our major. For example, a small
  `src/connection-monitor.ts` with `export type { ConnectionMonitorInit as Libp2pConnectionMonitorInit } from 'libp2p';`,
  exported from both `index.ts` and `rn.ts`, as `noise-crypto.ts` is.
- One spec, following `noise-crypto-node-wiring.spec.ts`: a value passed as `connectionMonitor` reaches
  the libp2p node's monitor (for example, a distinctive `pingInterval` or `protocolPrefix`, or `enabled: false`
  observed on the built node), and leaving it unset keeps libp2p's default. Read how the noise spec
  observes the wiring and do the same; do not test libp2p's own monitor behaviour.
- In `packages/db-p2p/readme.md`, add a short paragraph after the `noiseCrypto` one in the React Native
  section. It says that a slow phone should also be given a patient `connectionMonitor.pingTimeout`,
  names the measured failure and the example value above, and says the relay it talks through needs the
  same setting.

Our default stays unchanged. Sereus picks its own value in cadre-core.

## TODO

- Add the option, its doc comment and the pass-through in `libp2p-node-base.ts`.
- Add the type re-export and export it from `index.ts` and `rn.ts`.
- Add the wiring spec.
- Add the readme paragraph.
- Rebuild db-p2p. Run `yarn test` in db-p2p and `yarn check:rn` from the root, since the RN entry changes.
