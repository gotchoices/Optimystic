---
description: A node that is alone no longer waits a full second per block hoping another machine shows up; it now waits only when it can point to something that could actually arrive.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, docs/transactions.md, packages/db-p2p/docs/cluster.md
difficulty: medium
---

# Review: coordinator retry window is now evidence-gated

## What shipped

`Libp2pKeyPeerNetwork.findCoordinator` runs up to 3 selection attempts and sleeps 500 ms between
them when an attempt found no candidate **and** the node holds zero connections. That sleep is now
paid only when a peer could plausibly arrive during it.

`canRetryImprove(fretNeighborIds)` — which tested `networkMode` (frozen at construction) and
`networkHighWaterMark` (monotonic), so it kept the window open forever on nodes that could never
fill it — is replaced by `retryCouldImprove(candidateIds)`
(`packages/db-p2p/src/libp2p-key-network.ts:329`), which reads only live state:

- a non-self id in `candidateIds` → keep the window;
- otherwise `dialsInFlight() > 0` (`queued`/`active` entries in `libp2p.getDialQueue()`) → keep the
  window;
- neither → break to the last-resort tier on this attempt.

The call site (~line 700) builds `candidateIds` as the FRET neighbour list **filtered by exclusions
and bans only** — the network-membership filter is deliberately not applied, because an `unknown`
(not-yet-identified) neighbour is precisely the peer that may flip to `serves` inside the window.
The `retry-futile` log line now carries `neighbors=` and `dialsInFlight=` alongside the (now
diagnostic-only) `mode=` and `hwm=`.

Nothing about the *decision* changed: the break falls into the same last-resort tier, which calls
`shouldAllowSelfCoordination(intent)` exactly as before. Every `FIND_COORDINATOR_ERROR_CODES` value
stays reachable; a partitioned write still fails with `SELF_COORDINATION_BLOCKED`, ~1 s sooner.

Two `NOTE:` tripwires were parked in code (see *Review findings*), plus doc updates in
`docs/transactions.md` (3 sites) and `packages/db-p2p/docs/cluster.md` (one bullet next to
"Self-Coordination Is Never Memoized").

## How to validate

```
cd packages/db-p2p
npx tsc --noEmit -p tsconfig.json
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min
```

Both were run: typecheck clean, **1563 passing / 44 pending / 0 failing**. The
`collection-factory-key-network.spec.ts` in `quereus-plugin-optimystic` (the other
`Libp2pKeyPeerNetwork` construction site) also passes — 3 passing. No pre-existing failures
surfaced, so no `.pre-existing-error.md` was written. Integration specs
(`OPTIMYSTIC_INTEGRATION=1`) were **not** run.

Attempt counting is the primary assertion idiom: the FRET mock's `getNeighbors` call counter
(`attemptCount()`) stands in for "did the lookup enter the retry loop", clock-free. Only the one
pre-existing wall-clock assertion ("three solo lookups stay well under one 500ms retry delay",
spec ~line 702) remains, and still passes.

### Behaviours the new specs pin

In `findCoordinator() — isolated node degrades to its own replica` (mock helper
`justDisconnectedNode` gained `dialInFlight`, `highWaterMark`, `networkMode`, `neighbors` options;
`createMockLibp2p` gained `dialQueue`):

- futile isolated **write** (zero connections, self-only FRET, empty dial queue, HWM 10) → degraded
  self in **1** attempt (was 3);
- same shape with a `'joining'` node at HWM 1 and an empty FRET neighbourhood → self in 1 attempt —
  the reported case, a node configured with a bootstrap address it never reached;
- same node with `dialInFlight: true` → still **3** attempts, still degraded self;
- the arrival spec (a peer landing 50 ms into attempt 0's sleep wins the key on attempt 2) now runs
  with `dialInFlight: true`, which is both what buys the sleep and the realistic reason a peer shows
  up mid-window;
- isolated **read** → self, 1 attempt (unchanged);
- futile + `detectPartition: () => true` → write throws `SELF_COORDINATION_BLOCKED`, read returns
  self, both in 1 attempt (the `hwm-decay` consistency check: the denial survives, only the delay
  goes);
- futile + self excluded + HWM 1 → `SELF_COORDINATION_EXHAUSTED` in 1 attempt;
- futile + self excluded + HWM 10 → `NO_COORDINATOR_AVAILABLE` in 1 attempt;
- an **excluded** non-self FRET neighbour does not keep the window open → self in 1 attempt.

The `retryCouldImprove()` unit block replaces the old `canRetryImprove()` block: self-only + empty
queue → false; empty list + empty queue → false; `active` dial → true; `queued` dial → true; only
`error`/`success` entries → false; non-self id → true; `'joining'` + HWM 10 + self-only + empty
queue → **false** (the regression the ticket is about).

### Proof the specs bite

The old two tests (`networkMode !== 'forming'` / `hwm > 1` → `true`) were temporarily re-added at
the top of `retryCouldImprove` and the suite re-run: **6 of the 7** new/changed assertions failed
(counting 3 where 1 is expected, and the unit case returning `true`). The one that passed under
both is `SELF_COORDINATION_EXHAUSTED` (HWM 1 + `'forming'`), which the old test also short-circuited
— expected, and it is kept as a guard that the error stays reachable through the new break. The
simulation was then removed; final state is the shipped implementation.

## Known gaps / where to look hardest

- **No real-libp2p coverage of the dial-queue signal.** Every assertion runs against a mock
  `getDialQueue`. The shape of a real bootstrap dial (does a failing bootstrap dial linger as
  `active`, retry, or leave the queue promptly?) is unverified here — if libp2p keeps a retrying
  bootstrap dial permanently `queued`, a phone with an offline server address would keep paying the
  window, which is the motivating case only half-fixed. `test/real-libp2p.integration.spec.ts` is
  the place that could settle it; it was not extended.
- **`justDisconnectedNode` grew to six options.** The helper is now doing a fair amount of shaping;
  a reviewer may reasonably want it split or a couple of the new specs moved to their own fixture.
- **The confirming `'joining'` spec uses an empty FRET neighbourhood, not a self-only one** (the
  ticket suggested self-only). With self-only FRET at HWM 1 the guard allows self at the FRET tier
  and the lookup already returned on attempt 0 *before* this change, so a self-only variant would
  not have bitten. Empty-FRET is the shape that isolates the `networkMode` arm. Worth confirming
  that reading is right.
- **`dialsInFlight()` is called twice on the futile path** — once inside `retryCouldImprove`, once
  for the log line. It is a synchronous array filter on a path taken at most once per lookup, so it
  was left readable rather than threaded through a return value.
- **`networkMode` is now dead weight for decisions** and survives only for the log line, guarded by
  a `NOTE:`. If a reviewer would rather see it deleted, that is a constructor-signature change
  across ~50 spec construction sites — the ticket explicitly settled on keeping it.

## Review findings

- Tripwire parked at `retryCouldImprove` (`packages/db-p2p/src/libp2p-key-network.ts:318`): the
  accepted regression — an *inbound* connection arriving during a sleep that is now skipped loses
  one lookup's routing to self (self picks are never cached, so the next lookup picks the peer up) —
  plus the recorded decision not to scan the peerStore.
- Tripwire parked at the `networkMode` field declaration (`:149`): the field no longer participates
  in any decision and should be dropped or re-derived when the constructor becomes an options bag.
- Tripwire parked at `dialsInFlight()` (`:334`): the dial queue is read over-inclusively (it may
  hold dials to excluded, banned, or foreign-network peers), which keeps the window conservatively;
  cross-referencing was judged more expensive than the sleep it would save.
