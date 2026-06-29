description: When two databases share machines, a write no longer hands leadership to a node that was never confirmed to belong to this database; it leads the write itself or returns a clear "no leader" error instead of failing with a confusing connection error.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (findCoordinator + filterByMembership, ~lines 383-528 / 740-756)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (describe 'network-membership scoping (protocolPrefix)', ~lines 684-915)
  - packages/db-p2p/docs/cluster.md (Network-Membership Scoping note, ~line 619)
difficulty: medium
----

# Review: `findCoordinator` must not select an `unknown` (possibly cross-network) peer as coordinator

Companion/defense-in-depth sibling to the landed `cross-network-cohort-no-unknown-backfill` (which
closed the `findCluster` cohort-assembly hole). This ticket closes the **coordinator-selection**
(`findCoordinator`) hole so the "fail fast with `NO_NETWORK_COORDINATOR`, never a `could not
negotiate` failure" guarantee also holds when self is **not** the key's coordinator.

## What changed (implemented + verified green)

The whole fix is contained to `libp2p-key-network.ts` (selection logic + comments), the spec, and the
docs note. No control-flow restructuring: self last-resort, solo-bootstrap, cache, reputation ordering,
the `protocolPrefix`-absent no-op, and the self-coordination guard are all preserved.

- **`filterByMembership` (`~lines 740-756`)** — previously returned `{ ranked: [...serves, ...unknown],
  droppedForeign }`, i.e. it ranked `unknown` peers *behind* `serves` but still kept them selectable.
  Now it returns **only `serves`** (self always classifies `serves`) and a renamed flag
  `droppedUnconfirmed` that is true when **any `foreign` OR `unknown`** peer was excluded under
  scoping. The `protocolPrefix == null` early return is unchanged (returns input untouched, no drops),
  so the filter-disabled path is byte-for-byte the same as before.
- **`findCoordinator` (`~lines 383-528`)** — renamed `droppedForeignAnyAttempt` →
  `droppedUnconfirmedAnyAttempt`, set from the new flag in **both** the FRET-path call (`~line 434`)
  and the connected-fallback call (`~line 456`). It gates the existing `NO_NETWORK_COORDINATOR` throw
  (`~line 503`), whose message was broadened from "do not serve this network's cluster/repo protocol"
  to "**are foreign or not-yet-confirmed to serve** this network's cluster/repo protocol." Precedence
  is unchanged: `NO_NETWORK_COORDINATOR` still fires before the generic `NO_COORDINATOR_AVAILABLE` /
  `SELF_COORDINATION_EXHAUSTED` codes, and only when an unconfirmed peer was actually dropped.

### The behavioral consequence

Selection now draws from `serves` peers + self only. An `unknown` peer is never gambled on as
coordinator — but the **unknown→serves flip still works**: `filterByMembership` re-reads the peerStore
on every one of the 3 `maxRetries` attempts, so a genuine same-network peer that completes `identify`
within the retry window is reclassified `serves` and selected normally on that attempt. A peer that
never flips is simply not selected; selection falls to last-resort self-coordination (a correct,
downsized single-coordinator write), or — when self is excluded — to a fast, accurate
`NO_NETWORK_COORDINATOR`. This mirrors the `findCluster` decision in the prereq.

## Use cases / what the reviewer should validate

The two-network-shared-mesh scenarios, each now covered by a test in the
`network-membership scoping (protocolPrefix)` describe block:

| Scenario | Expected | Test |
|---|---|---|
| Self **near** key (serving FRET neighbor), cross-net `unknown` also present | self picked first | `prefers self (serves) over a not-yet-identified cross-network peer` (existing) |
| Same-network `serves` peer present alongside cross-net `unknown` | the `serves` peer picked, never the `unknown` | `never returns a cross-network peer when a same-network peer is available` (existing) |
| Self **not near** key, only a connected cross-net `unknown`, self **NOT excluded** | falls to **self-coordination** (returns self), never the `unknown` | `falls back to self-coordination when self is not near the key…` (**new**) |
| Self **excluded**, only a cross-net `unknown` candidate, HWM>1 | throws `FindCoordinatorError` code `NO_NETWORK_COORDINATOR` | `throws NO_NETWORK_COORDINATOR when the only candidate is a not-yet-confirmed cross-network peer…` (**new**) |
| Self excluded, only a `foreign` candidate, HWM>1 | throws `NO_NETWORK_COORDINATOR` (foreign still dropped) | `throws NO_NETWORK_COORDINATOR when the only candidate serves a different network…` (existing) |
| `protocolPrefix` **absent** | filter disabled, connected `unknown` FRET neighbor still selectable | `with protocolPrefix ABSENT, findCoordinator still returns a connected FRET neighbor` (existing regression guard) |

## Validation results

- **Build**: `yarn workspace @optimystic/db-p2p build` (`tsc`) — clean, no output, exit 0.
- **Targeted**: `network-membership scoping (protocolPrefix)` describe block — **13 passing** (was 11;
  added the two new `findCoordinator` tests above).
- **Full package**: `yarn workspace @optimystic/db-p2p test` — **1058 passing, 37 pending, 0 failing**
  (~36s). The `cohort-topic cold-start: parent registration … failed` console line is a
  deliberately-logged error inside a passing error-path test (`host-antidos-coldstart.spec.ts`), not a
  failure (same benign line the prereq review noted).

Run commands (from `packages/db-p2p`):
```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-key-network.spec.ts" \
  --reporter spec --grep "network-membership scoping"
# whole package:
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min
```

## Reviewer focus areas / known gaps (be adversarial here)

- **Mock-only coverage — same caveat as the prereq.** Every `findCoordinator` test drives a mock libp2p
  + mock peerStore and proves *selection*, not real multistream-select dial behavior. The load-bearing
  claim (a cross-network peer's coordinator dial genuinely cannot negotiate, while a same-network peer
  mid-`identify` is dialable) rests on libp2p's documented `dialProtocol` semantics, validated for real
  only in the out-of-repo Sereus e2e harness. Worth a skeptical read of whether the mock faithfully
  models the `unknown` classification (empty peerStore protocol list) it depends on.
- **Sereus e2e acceptance is owned out-of-repo and was NOT run here.** The ticket's acceptance names
  `strand-formation-e2e` Phase 2 and `strand-membership-closed-strand` on the default `downsize: true`
  config — those live in the separate Sereus repo and cannot run from this monorepo. The libp2p-level
  cause is fixed here; confirm the e2e pass with whoever owns that harness. The ticket also flags that
  any *residual* failure may be gated on the separate FRET ring-admission cure
  `network-scoped-ring-admission` (preventing cross-network peers entering the ring at all) — that is a
  distinct follow-up, not part of this change, and is the right place to point any remaining e2e red.
- **No retry-delay when "connections exist but no `serves` yet" — intentionally out of scope.** With a
  *connected* cross-network `unknown` and self not near the key, the three attempts run without the
  500ms delay (that delay is gated on `connected.length === 0`) and fall straight to self-coordination.
  This is correct (self-coordinates now, a slow same-network peer self-corrects into `serves` on the
  next write) but does not give that peer extra time to flip *this* write. Adding a bounded delay for
  the "connected-but-unconfirmed" case is a possible later optimization, deliberately excluded to keep
  this change focused. Verify you agree it isn't required for acceptance.
- **`downsize: false` interaction.** Last-resort self-coordination produces a self-only single
  coordinator; under `allowClusterDownsize: false` the downstream cohort step can still reject a
  self-only cluster via `minRequiredSize`. That rejection path is the cohort-side concern (prereq), not
  coordinator selection — confirm this ticket isn't expected to change it.
- **No `.pre-existing-error.md` filed.** Nothing failed for me. Note the prereq review flagged a
  pre-existing `npx tsc --noEmit` deprecation (`TS5101 downlevelIteration`) in `tsconfig.json`; the
  package `build`/`test` scripts (which use plain `tsc` emit and Node type-stripping respectively) both
  pass, so it did not surface here.

## Acceptance (libp2p-level: met; e2e: owned out-of-repo)

- ✅ Two-network shared-mesh write where the writer is the only serving peer and self is not the key's
  FRET neighbor reaches a self-coordinated cohort, or — when self is excluded — fails fast with
  `NO_NETWORK_COORDINATOR`; never a `could not negotiate /optimystic/<other-network>/...` failure
  (selection-level tests; full dial owned out-of-repo).
- ✅ A fresh same-network peer is still selectable once it flips to `serves` within the retry window;
  single-network behavior and the `protocolPrefix`-absent no-op path are unchanged.
- ⏳ Sereus `strand-formation-e2e` Phase 2 and `strand-membership-closed-strand` on default
  `downsize: true` — run by the out-of-repo e2e owner; any residual is the domain of
  `network-scoped-ring-admission` (documented above).
- ✅ `yarn workspace @optimystic/db-p2p test` passes, including the new/updated coordinator tests.
