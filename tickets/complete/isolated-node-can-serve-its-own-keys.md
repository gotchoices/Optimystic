---
description: A node that just lost its last connection used to refuse to handle any of its own data for 30 seconds, failing every query and killing a starting node. It now answers reads from its own copy right away, and completes writes about a second later, instead of failing.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-core/src/network/i-key-network.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, docs/transactions.md, docs/correctness.md
difficulty: medium
---

# Complete: isolated node degrades to serving its own replica

## What shipped

When a node cannot find any other peer to coordinate a key, the self-coordination guard decides
whether it may act on its own. That refusal is now **graded**, and the caller's **intent** is part
of the decision.

**Graded refusals.** `SelfCoordinationDecision` (`packages/db-p2p/src/libp2p-key-network.ts`)
carries a `deferrable?: boolean` on every denial. A *hard* denial fails the caller with
`SELF_COORDINATION_BLOCKED`; a *deferrable* one only means "self is not the preferred coordinator",
and selection falls back to self with a logged warning once every better tier has come up empty.

| reason | write | read |
| --- | --- | --- |
| `disabled` (operator switch) | hard | hard |
| `grace-period-not-elapsed` (a clock, not evidence) | deferrable | deferrable |
| `partition-detected` | hard | deferrable |
| `suspicious-shrinkage` | hard | deferrable |

**Intent plumbed through.** `FindCoordinatorOptions.intent` (`'read' | 'write'`, new exported type
`CoordinatorIntent` in `packages/db-core/src/network/i-key-network.ts`) defaults to `'write'`, so
no existing caller changes behaviour. `NetworkTransactor.get()` is the only path that passes
`'read'`, threading it through `batchesForPayload` and `resolveCoordinator` plus the three inline
`findCoordinator` lambdas. `getStatus()` inherits it by reading through `get()`.

**Consumed at both selection tiers of `findCoordinator`.** The FRET tier admits self early for an
isolated read; the last-resort tier throws only on a hard denial.

Net effect: an isolated **read** resolves from the local replica on the first attempt; an isolated
**write** still spends its ~1s retry window hoping a peer lands, then self-coordinates with a
warning instead of failing outright.

## Review findings

### Fixed in this pass

**The FRET-tier read admission was not gated on isolation** (`libp2p-key-network.ts`, the
`isSelfAdmissible` closure). As implemented, *any* deferrable denial admitted self into the FRET
candidate list for a read — including `partition-detected` and `suspicious-shrinkage`, neither of
which requires zero connections. Self carries no reputation record, so `getScore()` returns 0, the
minimum, and self sorted ahead of every remote candidate in the rank immediately below. A
partitioned node with a live connection therefore handed the read to itself over a reachable FRET
neighbour of the key.

That is outside what the change set out to do — the whole rationale ("answering from our own
replica is what an isolated node must accept anyway") only holds while the node is isolated. Fixed
by requiring `connected.length === 0` for the early admission. This costs a connected read nothing:
the inter-attempt sleep is itself gated on zero connections, so with peers present the remaining
attempts and the last-resort degrade run back-to-back with no delay, and a read is still never
refused its own replica. Pinned by a new spec, `a READ still prefers a reachable peer over degraded
self while any connection is live`, which was confirmed to fail against the pre-fix code (it
returned self) and pass after. `docs/transactions.md` corrected in both places that stated the
unqualified rule.

**Both flaky wall-clock assertions the handoff flagged, replaced with a deterministic attempt
count.** The FRET mock now counts its own invocations — `findCoordinator` consults FRET exactly
once per retry attempt — so `serves a READ ... without paying the retry loop` asserts
`attemptCount() === 1` instead of `< 400ms`, and the write spec asserts `=== 3` instead of
`>= 500ms`. Neither reads the clock any more.

The third spec, `a peer that lands during the write retry window`, genuinely simulates a real-time
arrival and still uses a timer, but is materially safer: the arrival moved from 600ms (which had to
land before attempt 2 at ~1000ms — 400ms of slack) to 50ms, deep inside attempt 0's 500ms sleep,
where the only assumption left is that attempt 0's body takes under 50ms (measured at ~1ms). It
also now asserts `attemptCount() === 2`, so a machine stalled enough to break that fails loudly
rather than passing for the wrong reason.

An attempt to make that third spec fully deterministic via an attempt-boundary hook was tried and
reverted — it fired *inside* an attempt rather than between attempts, which tripped the snapshot
desync recorded as a tripwire below and made the test assert the artifact instead of the behaviour.

**Missing table row in the tests.** The `suspicious-shrinkage` row (hard write / deferrable read)
was the one of four the guard-verdict specs never exercised. Added.

### Checked, nothing found

- **Intent coverage of every `findCoordinator` call site.** All ten in `packages/` reviewed. The
  four in `NetworkTransactor.get()` pass `'read'`; `pend`, `commit`, `cancel`, `cancelBatch`,
  `consolidateCoordinators` and `batch-coordinator.ts` correctly stay on the write default.
  `getStatus()` verified to route through `this.get()` as claimed, so it needs nothing.
- **No denial branch omits `deferrable`.** All four set it explicitly; the three `allow: true`
  branches (`bootstrap-node`, `hwm-decay`, `extended-isolation`) are unaffected.
- **Write-path behaviour is genuinely unchanged.** Verified by reading, and pinned by the
  peer-arrives-mid-retry spec.
- **Docs.** `docs/transactions.md` and `docs/correctness.md` re-read in full against the shipped
  code; accurate after the two corrections above. `docs/partition-healing.md` and
  `docs/internals.md` were checked for stale claims — partition-healing.md's only mention is a
  cross-reference pointing at internals.md for the guard, and internals.md does not in fact
  document the guard at all. That pointer was already broken before this change and asserts nothing
  contradicted by it, so it was left alone. `docs/review.html` is an archived past-review artifact,
  not living documentation.
- **Source hygiene.** `libp2p-key-network.ts` is 958 lines and `network-transactor.ts` is 908
  (`wc -l`); this change added ~130 and ~15 lines respectively, all inside existing functions. Both
  files were already at that scale before the change and no split is created or made materially
  worse by it, so no size-debt ticket is filed.
- **Resource cleanup / error handling.** The new paths allocate nothing and add no `catch`; the
  degraded return is a plain `return self` on a path that previously threw.

### Filed as tickets

None. The one real defect found was a one-condition fix at a single site with a test, resolved
inline.

### Parked as tripwires

- **`packages/db-p2p/src/libp2p-key-network.ts`, at the `deferrable` field** — `NOTE:` that the
  field is optional, so a *fifth* denial reason added later would silently read as hard
  (`findCoordinator` tests `deferrable !== true`). Safe for a write, but for a read that reinstates
  exactly the defect this ticket fixed. Names the discriminated-union refactor that would make the
  omission a compile error. Conditional on a future branch existing, so not a ticket.
- **`packages/db-p2p/src/libp2p-key-network.ts`, at `isSelfAdmissible`** — `NOTE:` that the guard
  re-reads `getConnections()` live while the candidate filter uses a snapshot taken at the top of
  the attempt. A connection landing between the two lifts the guard's grace-period denial while the
  new peer is still invisible to the filter, so self can win *that* attempt on evidence the attempt
  cannot use. Bounded to one attempt (the next re-snapshots and prefers the peer) and self picks are
  never cached, so the cost is at most one lookup's routing. Discovered while building the
  attempt-boundary hook above.
- The handoff's earlier `NOTE:` at the `selfCoordinationConfig` defaults (no construction site in
  the repo passes a `SelfCoordinationConfig`) was reviewed and left in place — still accurate.

### Not verified

**The two originally-reported end-to-end symptoms remain unconfirmed by an observed run.** The fix
ticket cited a query failing at `convergence-stress.integration.ts:395` and a cold-start node dying
inside control-schema DDL with `Module 'optimystic' create failed for table 'Revocation'`. Both
live in the env-gated integration tier (`OPTIMYSTIC_INTEGRATION=1` / `yarn test:integration`),
which spins real TCP meshes and whose wall-clock exceeds what is runnable inside a ticket. It was
not run in the implement stage and was not run here either. The unit-level reproduction is fixed
and pinned; the end-to-end claim still rests on the causal chain. Worth confirming out of band —
this is the one open item on the change.

### Known cost, accepted

An isolated **write** still pays the ~1s retry window per lookup. That is deliberate — it is what
lets an arriving peer win the key, as the peer-arrives spec pins — and per-operation rather than
per-block, since `createBatchesForPayload` resolves a payload's blocks concurrently. Extending the
retry loop to wait out the grace period was explicitly rejected upstream: the default grace period
(30s) equals the default transaction budget (30s), so waiting converts a fast failure into a slow
one. Unchanged by this review.

## Validation

From the repo root: `yarn build` clean (all packages), `yarn lint` clean (exit 0).

- `packages/db-core`: `yarn test` — **1337 passing**.
- `packages/db-p2p`: `yarn test` — **1506 passing, 44 pending** (up from 1504: two specs added by
  this review).

The new `a READ still prefers a reachable peer over degraded self` spec was additionally run
against the pre-fix condition and confirmed to fail, so it is known to pin the fix rather than pass
vacuously.

Integration tier (`yarn test:integration`) not run — see *Not verified*.
