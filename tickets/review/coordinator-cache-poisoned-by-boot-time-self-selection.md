---
description: A node used to lock onto itself as the handler for a piece of data when it made that choice while still alone at startup, and keep serving its own stale copy for half an hour afterwards. It now forgets such a choice as soon as real peers show up, and every path that can pick itself first checks the safety rule that says whether going it alone is allowed.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/docs/cluster.md
difficulty: medium
---

# Review: boot-time self-selection no longer poisons the coordinator cache

All three changes from the implement ticket landed in
`Libp2pKeyPeerNetwork` (`packages/db-p2p/src/libp2p-key-network.ts`). Build clean,
`packages/db-p2p` suite green at **1448 passing, 41 pending, 0 failing** (baseline was
1442/41/0 — the six new tests are the delta).

## Vocabulary (for a reader without the implement-stage context)

- **Coordinator** — the single peer chosen to drive a read/write for a given key.
  `findCoordinator(key)` picks it.
- **Coordinator cache** — a 30-minute in-memory map from key → chosen coordinator,
  consulted *ahead of every selection tier*, so a cached entry fully short-circuits
  selection until it expires.
- **Self-coordination guard** — `shouldAllowSelfCoordination()`. It refuses to let a node
  act as its own coordinator when the node has previously seen a larger network but is
  currently isolated, so a partitioned node cannot silently serve its own stale data.
- **FRET tier** — the first selection tier; picks from the key's nearest routing-table
  neighbors. Self can appear in that neighbor set. There is also a **connected-peer
  fallback tier** (remote peers only) and a **last-resort self tier**.

## What changed

Three edits, all inside `findCoordinator` and its supporting members:

**A — a self pick is never written to the coordinator cache** (`libp2p-key-network.ts`,
FRET-tier success branch). `recordCoordinator` is skipped when the pick equals this node's
own peer id; the pick is still returned. Rationale in the code comment: caching self buys
nothing (self is always reachable and the tier re-derives it from a local table lookup with
no retry sleep), and it now matches the last-resort self tier, which already returned self
without caching.

**B — self-valued cache entries are purged when connections arrive**
(`updateNetworkObservations()`, inside the existing `connections.length > 0` branch, which
is what `connection:open` drives). Needed because `recordCoordinator` is public and is also
called from outside the class on redirect responses — `RepoClient` (`src/repo/client.ts`),
`ClusterClient` (`src/cluster/client.ts`), `NetworkTransactor`
(`packages/db-core/src/transactor/network-transactor.ts`) — so a redirect naming self can
seed an entry change A cannot prevent.

**C — the FRET tier consults the self-coordination guard before admitting self.** The
candidate filter was split into two passes: excludes/bans first, then
`connectedSet.has(id) || (id === selfStr && isSelfAdmissible())`. `isSelfAdmissible()` is a
per-attempt memoized closure — evaluated **lazily** (only when self actually appears in the
neighbor list, so an all-remote neighborhood never pays `detectPartition()` /
`getNetworkSizeEstimate()`) and **freshly per retry attempt** (a connection can land during
the 500ms inter-attempt sleep and legitimately flip the answer). On refusal self is *dropped*
from the candidate list, not thrown on — the connected-peer fallback still gets its chance,
and only if that also comes up empty does the last-resort tier raise
`SELF_COORDINATION_BLOCKED` with the accurate reason.

Also: a defensive comment at the connected-peer fallback tier noting it is remote-only and
therefore needs neither the guard check nor the no-cache-self carve-out.

## Test / validation surface

New block in `packages/db-p2p/test/libp2p-key-network.spec.ts`:
`describe('findCoordinator() — boot-time self-selection and cache')`. It uses a local
`createMutableMock` helper (the shared `createMockLibp2p` closes over a fixed `connections`
array; these tests need a peer to arrive mid-test).

| Test | Pins |
|---|---|
| does not cache a boot-time self pick, so a peer connecting takes over the key | ARM 1 — the end-to-end symptom |
| writes no cache entry at all for a self pick | change A directly (`coordinatorCache.size === 0`) |
| purges an externally-seeded self cache entry once connections arrive | change B (`recordCoordinator(key, self)` → `updateNetworkObservations()` → routes to the peer) |
| honours the self-coordination guard on the FRET path (self is a neighbor of the key) | ARM 2 — throws `SELF_COORDINATION_BLOCKED` |
| drops self on the FRET path but still selects a connected peer rather than throwing | change C's fall-through, not fail-fast, behavior |
| a genuinely solo node still self-coordinates on every call without entering the retry sleep | regression guard: three lookups under 400ms |

**Each of the first five was verified failing against the pre-fix source.** I copied
`git show HEAD:packages/db-p2p/src/libp2p-key-network.ts` over the working file, ran the new
block (`1 passing, 5 failing`), then restored the fixed file and re-ran build + the full
suite green. The sixth (solo no-thrash) passes both before and after by design — it exists
to catch a regression *introduced* by removing the cache entry, not to reproduce the bug.

Existing tests were **not** edited. Both tests the ticket named as canaries —
`findCoordinator prefers self (serves) over a not-yet-identified cross-network peer` and
`returns self on first call when no excludes` — still pass unchanged (both run at
high-water mark ≤ 1, where the guard returns `bootstrap-node` / allow).

## Known gaps — reviewer should probe these

- **Purge is verified only through a direct `updateNetworkObservations()` call**, not through
  a real `connection:open` event dispatch. `createMockLibp2p` stores `addEventListener`
  handlers in a `listeners` map it never exposes, so an event-driven test would need that
  helper extended. The wiring itself (`setupConnectionTracking()` →
  `updateNetworkObservations()`) is unchanged and untested here as before.
- **No integration-level confirmation.** The originating reproduction lives in a *different*
  repo (`sereus/packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts`,
  which failed roughly four runs in five) and was not run as part of this ticket. Whether the
  Sereus scenario is now stable is unverified from here; the Sereus ticket
  `transactor-key-network-ignores-network-scoping` sits in that repo's `tickets/blocked/`
  waiting on this fix.
- **Change B purges by scanning the whole cache.** Correct but O(cache size) per
  `connection:open`; see the tripwire below.
- **Ordering assumption in the ARM 1 test.** It relies on `Array.prototype.sort` being stable
  (ES2019+) so that two candidates with equal reputation score keep FRET's proximity order and
  the nearer peer wins over self. True on Node's V8, but it is an implicit dependency worth a
  reviewer's eye — the production selection order rests on the same property, which predates
  this change.
- **`packages/quereus-plugin-optimystic` has one failing test** (`327 passing, 11 pending,
  1 failing`) — a Quereus function-registration API drift in a sibling checkout, entirely
  outside this diff. Recorded in `tickets/.pre-existing-error.md`; not skipped, not touched.

## Tripwires parked in code

- `NOTE:` at the purge loop in `updateNetworkObservations()` — the purge scans the whole
  coordinator cache (bounded at `MAX_CACHE_ENTRIES = 1000`) on every `connection:open`. Fine
  now; if connection churn ever makes it show up in a profile, track self-valued entries in a
  side set instead of scanning.

## Documentation

`packages/db-p2p/docs/cluster.md` gained a **Self-Coordination Is Never Memoized** bullet
under *Access Control*, next to the existing network-membership scoping bullet: self picks
are never cached, externally-seeded self entries are purged when connections arrive, and every
tier that can select self clears `shouldAllowSelfCoordination()` first.

## Reproduce locally

```
cd packages/db-p2p
yarn build && yarn test           # 1448 passing, 41 pending, 0 failing
```
