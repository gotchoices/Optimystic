description: db-p2p's own RPC dial deadlines (3 s) cannot open a relayed connection above about 375 ms one-way, and no node option raises them.
files:
  - packages/db-p2p/src/rpc-deadline.ts (`DEFAULT_DIAL_TIMEOUT_MS`)
  - packages/db-p2p/src/libp2p-node-base.ts (the "pushDialTimeoutMs ?? 3000" defaults)
  - packages/db-p2p/src/cluster/spread-on-churn.ts and the other `pushDialTimeoutMs` consumers
source: sereus gardener, follow-up to optimystic #22 (measurement: sereus `relayed-dial-cost-by-latency`)
----
# RPC dial deadlines fail every slow relayed link

Opening a relayed connection costs about eight one-way link delays (sereus measured 26 ms at no delay,
7.3 s at 900 ms one-way, 12.1 s at 1500 ms one-way). `NodeOptions.connectionManager` now lets a
deployment raise libp2p's own `dialTimeout` and `inboundUpgradeTimeout`, but those apply only to dials
without a caller signal. Our RPC clients pass their own: `DEFAULT_DIAL_TIMEOUT_MS = 3000` in
`rpc-deadline.ts` and several `pushDialTimeoutMs ?? 3000` defaults. At 3 s a relayed connection cannot
open above about 375 ms one-way, so on any relayed link those RPCs fail at the dial.

Sereus supports relayed links up to a 3 s round trip (maintainer decision).

## To decide

- One node-level link-latency declaration from which every dial deadline derives, or a per-deadline
  override? A single declaration (e.g. `declaredLinkRoundTripMs`) matches how sereus states its
  requirement and keeps the deadlines from drifting apart.
- Whether an already-open connection should short-circuit the dial deadline (it usually does — the dial
  budget only bites on a cold dial).
