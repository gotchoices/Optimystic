description: When two databases share machines, a write can still pick a node from the other database to lead it and then fail to connect. Make write-leader selection skip nodes not yet confirmed to belong to this database, falling back to leading the write itself or returning a clear "no leader" error.
prereq: cross-network-cohort-no-unknown-backfill
files:
  - packages/db-p2p/src/libp2p-key-network.ts (findCoordinator + filterByMembership, ~lines 383-528 / 740-754)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (describe 'network-membership scoping (protocolPrefix)', ~lines 690-867)
  - packages/db-p2p/docs/cluster.md (Network-Membership Scoping note, ~line 619)
difficulty: medium
----

# Defense-in-depth: `findCoordinator` must not select an `unknown` (possibly cross-network) peer as coordinator

## Context

Companion to `cross-network-cohort-no-unknown-backfill`, which closes the **cohort-assembly**
(`findCluster`) hole. This ticket closes the **coordinator-selection** (`findCoordinator`) hole so the
acceptance "fails fast with `NO_NETWORK_COORDINATOR` — never a `could not negotiate` failure" holds
even when self is **not** the key's coordinator.

`filterByMembership` ranks candidates `[...serves, ...unknown]` and drops only `foreign`. So when no
serving peer is available, an `unknown` peer is still selected:

```ts
// packages/db-p2p/src/libp2p-key-network.ts  (current)
return { ranked: [...serves, ...unknown], droppedForeign }
```

Two selection paths consume this:

1. **FRET path** (~line 433): `connectedFretIds` includes self only when self is a FRET neighbor of
   the key; self ranks first as `serves`. When self is *not* a neighbor, only remote peers remain — a
   cross-network `unknown` can be picked.
2. **Connected-fallback** (~lines 448-460): `connectedCandidates` is built from connected **remote**
   peers and **does not include self**, so even when self is a serving peer it is bypassed here — a
   connected cross-network `unknown` is picked *before* the last-resort self-coordination block ever
   runs.

In both cases the coordinator dial then fails with `could not negotiate
/optimystic/<other-network>/cluster/1.0.0`. Cross-network peers are `unknown` (empty protocol list),
never `foreign`, so the current `droppedForeign` flag stays false and `NO_NETWORK_COORDINATOR` is
never surfaced for them.

## Design decision (resolved)

**Under membership scoping, `unknown` peers are not eligible to be *selected* as coordinator** (in
either the FRET path or the connected-fallback). Selection draws from `serves` peers and self only.

The unknown→serves **flip still works**: `filterByMembership` re-reads the peerStore on every one of
the existing `maxRetries` attempts, so a genuine same-network peer that completes `identify` within
the retry window is reclassified `serves` and selected normally. A peer that never flips within the
window is simply not gambled on — selection falls through to last-resort self-coordination, or, when
self is excluded, to a fast, accurate `NO_NETWORK_COORDINATOR`.

Why not keep the `unknown` last-resort: it is a pure gamble (an `unknown` is either a fresh
same-network peer *or* a permanent cross-network contaminant, indistinguishable at an instant), and
the safe alternatives are strictly better — self-coordination + downsize produces a correct
single-coordinator write, and a genuine same-network peer self-corrects into the `serves` tier on a
later write. This mirrors the `findCluster` decision in the prereq ticket.

### Failure-signal coordination

Extend the existing tracking so the membership filter records when it dropped an **unconfirmed**
candidate (`foreign` OR — newly — `unknown` under scoping), not just `foreign`. When self is excluded
and selection finds no eligible (`serves`) peer while having dropped at least one unconfirmed peer,
throw `FIND_COORDINATOR_ERROR_CODES.NO_NETWORK_COORDINATOR` (the code already exists, ~line 42) with a
message that covers both cases — e.g. "the remaining candidate peer(s) are foreign or not-yet-confirmed
to serve this network's cluster/repo protocol." This preserves the existing foreign-only behavior and
adds the cross-network-`unknown` case. `NO_NETWORK_COORDINATOR` must take precedence over the generic
`NO_COORDINATOR_AVAILABLE` / `SELF_COORDINATION_EXHAUSTED` codes as it does today.

Last-resort self-coordination (when self is **not** excluded) is unchanged and remains gated by
`shouldAllowSelfCoordination()`; a blocked guard still throws `SELF_COORDINATION_BLOCKED` (also a
fail-fast, not a negotiate failure).

### Out of scope (note, do not implement here)

The existing retry **delay** only runs when `connected.length === 0`. With a *connected* cross-network
`unknown` and self not near the key, the three attempts run without delay and fall to
self-coordination — correct, but it does not give a slow same-network peer extra time to flip into the
coordinator role (self-coordinates instead; self-corrects on the next write). Adding a bounded
retry-delay when "connections exist but no `serves` candidate yet" is a possible later optimization;
it is **not** required for acceptance and is deliberately excluded to keep this change focused.

## Target change (sketch)

- `filterByMembership`: return only `serves` (plus self, which classifies as `serves`) as `ranked`;
  report a flag such as `droppedUnconfirmed` that is true when any `foreign` **or** `unknown` peer was
  excluded under scoping. Keep the `protocolPrefix == null` no-op early return (returns input
  unchanged, no drops) so the filter-disabled path is untouched.
- `findCoordinator`: rename/extend `droppedForeignAnyAttempt` → `droppedUnconfirmedAnyAttempt`, set
  from the new flag in both the FRET-path and connected-fallback calls. Use it to gate the
  `NO_NETWORK_COORDINATOR` throw. No other control-flow changes (self last-resort, solo-bootstrap,
  cache, reputation ordering all preserved).

## Edge cases & interactions

- **Self is a serving FRET neighbor:** self picked first (unchanged — existing "prefers self over
  not-yet-identified cross-network peer" test).
- **Self not near key, only connected cross-network `unknown`, self NOT excluded:** must fall to
  self-coordination (downsize → correct single-coordinator write), not pick the `unknown`.
- **Self excluded, only `unknown`/`foreign` remain:** throw `NO_NETWORK_COORDINATOR` (fast, accurate)
  — never select the peer and never return a generic code.
- **Existing `foreign` + self-excluded test:** still throws `NO_NETWORK_COORDINATOR` (foreign still
  dropped; flag still set).
- **Fresh same-network peer that flips to `serves` within the retry window:** selected normally on the
  flipping attempt — the unknown→serves flip must keep working.
- **`protocolPrefix` absent:** filter disabled → `unknown` peer still selectable as before (the
  existing "still returns a connected FRET neighbor" regression guard must stay green).
- **Solo/bootstrap exhausted (`SELF_COORDINATION_EXHAUSTED`) and `SELF_COORDINATION_BLOCKED` paths:**
  unchanged; `NO_NETWORK_COORDINATOR` only takes precedence when an unconfirmed peer was actually
  dropped.
- **Reputation ordering within the `serves` tier:** preserved (sort happens before filtering, filter
  is stable within tier).

## Acceptance

- A two-network shared-mesh write where the writer is the only serving peer present and self is *not*
  the key's FRET neighbor reaches a correct self-coordinated cohort, or — when self is excluded — fails
  fast with `NO_NETWORK_COORDINATOR`; never a `could not negotiate /optimystic/<other-network>/...`
  failure.
- A fresh same-network peer is still selectable once it flips to `serves` within the retry window;
  single-network behavior and the `protocolPrefix`-absent no-op path are unchanged.
- With the prereq ticket landed, Sereus `strand-formation-e2e` Phase 2 and
  `strand-membership-closed-strand` e2e pass on the default `downsize: true` config (or, if any
  residual is gated on the separate FRET ring-admission cure `network-scoped-ring-admission`, that is
  documented in the review handoff).
- `yarn workspace @optimystic/db-p2p test` passes, including the new/updated coordinator tests below.

## TODO

### Phase 1 — implementation
- Make `filterByMembership` exclude `unknown` from `ranked` under scoping and report a
  `droppedUnconfirmed` flag (true for any dropped `foreign` or `unknown`). Keep the no-op early
  return when `protocolPrefix == null`.
- Thread the flag through both `findCoordinator` membership calls; extend the `NO_NETWORK_COORDINATOR`
  trigger to fire on dropped-unconfirmed (foreign or unknown) when self is excluded and no `serves`
  pick exists. Broaden the error message accordingly.

### Phase 2 — tests (`packages/db-p2p/test/libp2p-key-network.spec.ts`)
- **Add**: self NOT a FRET neighbor, a connected cross-network `unknown` is the only candidate, self
  NOT excluded → `findCoordinator` returns `selfPeerId` (self-coordination), never the `unknown`.
- **Add**: self excluded, only a cross-network `unknown` candidate (HWM>1 so not solo-exhausted) →
  throws `FindCoordinatorError` with code `NO_NETWORK_COORDINATOR`.
- Confirm green: "never returns a cross-network peer when a same-network peer is available";
  "prefers self (serves) over a not-yet-identified cross-network peer"; the existing `foreign` +
  self-excluded `NO_NETWORK_COORDINATOR` test; both `protocolPrefix`-absent regression guards.

### Phase 3 — docs
- Update the **Network-Membership Scoping** note in `packages/db-p2p/docs/cluster.md` (~line 619):
  state that `findCoordinator` never selects a `foreign` **or** `unknown` peer; an unconfirmed peer
  becomes selectable only once `identify` flips it to `serves` within the retry window; otherwise
  selection falls to self-coordination, and `NO_NETWORK_COORDINATOR` is surfaced when self is excluded
  and only foreign/unconfirmed peers remain.
