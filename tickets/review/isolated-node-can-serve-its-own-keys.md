---
description: A node that just lost its last connection used to refuse to handle any of its own data for 30 seconds, failing every query and killing a starting node. It now answers reads from its own copy right away, and completes writes about a second later, instead of failing.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-core/src/network/i-key-network.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, docs/transactions.md, docs/correctness.md
difficulty: medium
---

# Review: isolated node degrades to serving its own replica

## What changed

The self-coordination guard (`shouldAllowSelfCoordination()` in
`packages/db-p2p/src/libp2p-key-network.ts`) used to return a flat `{ allow: false, reason }`, and
`findCoordinator`'s last-resort tier turned *any* refusal into a thrown
`SELF_COORDINATION_BLOCKED`. That failed a node outright for up to 30 seconds after it lost its
last connection — even though the same node, with the same information, self-coordinates freely the
moment the grace period elapses.

Three coordinated changes:

**1. Denials are now graded hard vs. deferrable.** `SelfCoordinationDecision` gained a
`deferrable?: boolean`, set on every denial branch. `shouldAllowSelfCoordination()` takes an
`intent: 'read' | 'write'` parameter defaulting to `'write'`.

| reason | write | read |
| --- | --- | --- |
| `disabled` | hard | hard |
| `grace-period-not-elapsed` | deferrable | deferrable |
| `partition-detected` | hard | deferrable |
| `suspicious-shrinkage` | hard | deferrable |

**2. Read/write intent is carried into `findCoordinator`.** `FindCoordinatorOptions` in
`packages/db-core/src/network/i-key-network.ts` gained `intent?: CoordinatorIntent`
(`'read' | 'write'`, new exported type), defaulting to `'write'` when unset so no existing caller
changes behaviour. `NetworkTransactor.get()` is the only path that passes `'read'`; it threads it
through `batchesForPayload` (new trailing `intent` param) and `resolveCoordinator` (new trailing
`intent` param), plus the three inline `findCoordinator` lambdas at `network-transactor.ts:133`,
`:187`, `:197`. `pend` / `commit` / `cancel` / `cancelBatch` / `consolidateCoordinators` are
untouched and stay on the write default. `getStatus()` needed nothing — it reads through
`this.get()`.

**3. `findCoordinator` consumes the classification at both tiers.**
- FRET tier (`isSelfAdmissible`, ~`libp2p-key-network.ts:519`): admits self when the guard allows
  **or** when the denial is deferrable *and* intent is `'read'`. A write keeps dropping self
  exactly as before.
- Last-resort tier (~`:594`): throws `SELF_COORDINATION_BLOCKED` only when
  `!decision.allow && decision.deferrable !== true`. On a deferrable denial it returns self and
  logs `findCoordinator:self-selected-degraded key=… coordinator=… reason=… intent=…`.

Net effect: a disconnected **read** resolves immediately from the local replica (no retry sleep);
a disconnected **write** still spends the existing ~1s retry window hoping a peer lands, then
self-coordinates with a warning instead of failing.

## Use cases to exercise

The behaviour worth poking at, in rough order of how load-bearing it is:

- **Isolated read is instant.** Node with high-water mark 10, zero connections, last disconnect
  2.3s ago, FRET reporting no partition / no shrinkage and self as the key's only neighbour.
  `findCoordinator(key, { intent: 'read' })` returns self in well under one 500ms retry delay.
- **Isolated write completes, late.** Same node, default intent. Returns self after the full
  3-attempt / 2×500ms window — it does **not** throw, and it does **not** short-circuit.
- **A peer arriving mid-retry still beats self on a write.** This is the guard against the FRET-tier
  read admission leaking into the write path. Peer connects ~600ms into the lookup; the third
  attempt must pick the peer, not degraded self.
- **Partition splits the two intents.** `detectPartition() === true` → a write still throws
  `SELF_COORDINATION_BLOCKED`; a read still returns self.
- **`allowSelfCoordination: false` blocks both.** The one verdict that is an operator switch rather
  than an inference.
- **Guard-verdict shape.** `shouldAllowSelfCoordination()` with no argument still means write;
  its `allow` verdicts are unchanged from before this ticket — only `deferrable` is new, and only
  how `findCoordinator` consumes it changed.

## Validation performed

- `yarn build` + `yarn test` in `packages/db-core`: **1337 passing**.
- `yarn build` + `yarn test` in `packages/db-p2p`: **1504 passing, 44 pending**.
- `yarn build` from repo root (all packages, including `quereus-plugin-optimystic` and
  `reference-peer`): clean.
- `yarn lint` from repo root: clean.

New tests in `packages/db-p2p/test/libp2p-key-network.spec.ts`:
- `shouldAllowSelfCoordination()` describe: existing "blocks when HWM>1 and only 1 isolated session"
  now also asserts `reason === 'grace-period-not-elapsed'` and `deferrable === true`; two new specs
  pin the partition (hard write / deferrable read) and disabled (hard both) rows of the table.
- New describe `findCoordinator() — isolated node degrades to its own replica`: the five use cases
  above, built on a `justDisconnectedNode()` helper that reproduces the exact scenario from the fix
  ticket.

Reworked: `honours the self-coordination guard on the FRET path` previously used a grace-period
denial — precisely the case this ticket stops turning into a throw. It now uses a **partition**
denial with the grace period long elapsed, so it still pins its real intent (self must not slip past
a *hard* guard verdict just because it sits in the key's FRET neighbourhood).

## Known gaps — please probe these

**The two originally-reported symptoms were not re-verified end to end.** The fix ticket cited a
query failing at `convergence-stress.integration.ts:395` and a cold-start node dying inside
control-schema DDL with `Module 'optimystic' create failed for table 'Revocation'`. Both live in
the env-gated integration tier (`OPTIMYSTIC_INTEGRATION=1` / `yarn test:integration`), which was
**not run** — it spins real TCP meshes and its wall-clock is not agent-runnable inside a ticket.
The unit-level reproduction was fixed and pinned; the end-to-end claim rests on the causal chain,
not on an observed green run. Worth confirming out of band.

**One timing assertion could be flaky on a loaded machine.** The isolated-read spec asserts
`< 400ms`. It is measuring "did not enter a 500ms sleep", so the true separation is large, but it is
still wall-clock. (The write spec's `>= 500ms` floor is set by a real `setTimeout`, so that
direction is safe.) The peer-arrives-mid-retry spec likewise depends on a 600ms `setTimeout` landing
inside the second inter-attempt sleep — a genuinely stalled event loop could push the arrival past
attempt 2 and pick degraded self instead of the peer.

**The write path still costs the ~1s retry window per isolated lookup.** That is deliberate (it is
what lets an arriving peer win the key), and lookups for the blocks of one operation run
concurrently via `Promise.all` in `createBatchesForPayload`, so it is ~1s per operation rather than
per block. Still, on a node that stays isolated, every write operation pays it. Not addressed here.

**Intent is threaded, not enforced.** Nothing stops a future write path from passing
`intent: 'read'`. The only callers today are the four in `NetworkTransactor.get()`; there is no
type-level or runtime guard tying intent to the operation actually being performed.

## Explicitly out of scope (from the fix ticket, unchanged)

- **Not extending the retry loop to wait out the grace period.** The default grace period (30s)
  equals the default transaction budget (30s), so the wait cannot fit — it would convert a fast
  failure into a slow one.
- **Not plumbing `SelfCoordinationConfig`.** Still `undefined` at every construction site. Recorded
  as a `NOTE:` at the defaults in `libp2p-key-network.ts` (see tripwires below) rather than a
  ticket — this fix shrank what that knob controls from "the node is unusable for 30s" to "a write
  spends its ~1s retry window", which removed the urgency.
- **Not changing `allowClusterDownsize`.** Whether a self-only cohort may commit at all is the real
  split-brain question and is governed by that flag, not by this guard. This fix does not make it
  worse: a write unblocked at second 2 is a write that already committed at second 35.

## Docs updated

- `docs/transactions.md` — the "Self-Coordination Guard (Design)" walkthrough now describes the
  hard/deferrable split (with the reason×intent table), the `shouldAllowSelfCoordination(guard,
  intent)` pseudocode, the two-tier consumption in `findCoordinator`, and why the retry loop is
  deliberately not extended. The "Read vs Write Considerations" table now states behaviour rather
  than recommendations. The partition-recovery caveat list gained the in-grace-period write case.
- `docs/correctness.md:116` — the self-coordination guard sentence in Theorem 2 now says the guard
  blocks a lone **write** (graded hard vs. deferrable) and that reads are never refused their own
  replica except by the explicit switch.

## Tripwires parked in code

- `packages/db-p2p/src/libp2p-key-network.ts` (~`:158`, at the `selfCoordinationConfig` defaults) —
  `NOTE:` recording that no construction site in the repo passes a `SelfCoordinationConfig`, so the
  defaults are always in force and no operator can tune `gracePeriodMs`; naming the four sites that
  would have to thread it through if that ever changes.
