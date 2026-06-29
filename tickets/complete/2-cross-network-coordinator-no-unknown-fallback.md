description: When two databases share machines, a write no longer hands leadership to a node that was never confirmed to belong to this database; it leads the write itself or returns a clear "no leader" error instead of failing with a confusing connection error.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (findCoordinator + filterByMembership, ~lines 383-535 / 736-766)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (describe 'network-membership scoping (protocolPrefix)')
  - packages/db-p2p/docs/cluster.md (Network-Membership Scoping note, ~line 619)
difficulty: medium
----

# Complete: `findCoordinator` must not select an `unknown` (possibly cross-network) peer as coordinator

Defense-in-depth sibling to the landed `cross-network-cohort-no-unknown-backfill`. Closes the
**coordinator-selection** hole so the "fail fast with `NO_NETWORK_COORDINATOR`, never a `could not
negotiate` failure" guarantee also holds when self is **not** the key's coordinator.

## What landed

- `filterByMembership` (`libp2p-key-network.ts:754`) now returns **only `serves`** peers (self always
  classifies `serves`) plus a renamed flag `droppedUnconfirmed` — true when any `foreign` OR `unknown`
  peer was excluded under scoping. The `protocolPrefix == null` early return is unchanged (returns the
  input untouched, no drops), so the filter-disabled path is byte-for-byte identical to before.
- `findCoordinator` (`libp2p-key-network.ts:383`) renamed the tracking flag to
  `droppedUnconfirmedAnyAttempt`, set from the new flag in both the FRET-path and connected-fallback
  calls. It gates the existing `NO_NETWORK_COORDINATOR` throw, whose message was broadened to "are
  foreign or not-yet-confirmed to serve this network's cluster/repo protocol." Precedence is unchanged.
- `docs/cluster.md` Network-Membership Scoping note updated to the new "never select `foreign` **or**
  `unknown`" wording.

Selection now draws from `serves` peers + self only. The `unknown`→`serves` flip still works because
`filterByMembership` re-reads the peerStore on every one of the 3 retry attempts. A peer that never
flips falls to last-resort self-coordination, or — when self is excluded — to a fast, accurate
`NO_NETWORK_COORDINATOR`.

## Review findings

**Process:** Read the implement-stage diff (`git show 75be871`: source, docs, tests) with fresh eyes
before the handoff summary. Scrutinized selection control flow, the rename's caller graph, edge cases,
the behavioral tradeoff, docs accuracy, and test coverage. Ran build + full package suite.

### Correctness / consistency — checked, no defects

- **Rename caller graph is complete.** `filterByMembership` has exactly one caller (`findCoordinator`,
  two call sites). `findCluster` uses its own independent inline membership classification (`~lines
  585-617`) and was untouched. Grepped the whole package: no stale `droppedForeign` references remain
  in `src/`. The `{ ranked, droppedUnconfirmed }` destructuring matches the new return shape at both
  call sites.
- **No false `NO_NETWORK_COORDINATOR`.** Excluded and banned peers are filtered *before*
  `filterByMembership` (lines 423-424 / 455), so they never reach the membership filter and cannot set
  `droppedUnconfirmed` — the distinct error only fires when a genuinely unconfirmed (`foreign`/
  `unknown`) peer was the reason the candidate set emptied. Verified by the two existing self-excluded
  throw tests (foreign and unknown cases).
- **Self handling intact.** `filterByMembership` excludes self from the protocol prefetch (line 757) but
  `membershipOf` short-circuits self to `serves` (line 729) before the protocol check, so self stays
  eligible in the FRET path. The `protocolPrefix == null` no-op return is preserved.
- **Control flow preserved.** Cache hit, self last-resort + `shouldAllowSelfCoordination` guard,
  solo-bootstrap `SELF_COORDINATION_EXHAUSTED`, and `NO_COORDINATOR_AVAILABLE` precedence are all
  unchanged; only the unknown-peer eligibility and the flag name/meaning changed.
- **Behavioral tradeoff reviewed and accepted.** Where the old code would gamble on an `unknown`
  same-network peer mid-`identify` (which would actually dial successfully), the new code refuses it
  and either self-coordinates or throws `NO_NETWORK_COORDINATOR` for the caller to retry. This is the
  intended, documented consequence and mirrors the `findCluster` prereq decision — not a regression.

### Test coverage — one gap found and fixed inline (minor)

- **Gap:** the load-bearing claim — that an initially-`unknown` peer becomes selectable once it flips to
  `serves` on a *later retry attempt* (because the filter re-reads the peerStore each attempt) — had no
  direct test. Every existing membership-scoping test holds the peerStore static, so a regression that
  cached the first read or permanently barred `unknown` peers would have passed all of them.
- **Fix (minor, applied this pass):** added
  `findCoordinator selects a peer once it flips from unknown to serves within the retry window` to the
  `network-membership scoping (protocolPrefix)` block. It uses a stateful mock peerStore that reports
  empty protocols on the first attempt's reads and the serving protocols thereafter, with **self
  excluded** so the only non-error outcome is selecting the flipped peer (proving the flip path, not
  self-coordination). Confirmed it is a meaningful guard: a "never re-reads / permanently bars unknown"
  regression makes it throw `NO_NETWORK_COORDINATOR` and fail.

### Docs — checked, accurate

`docs/cluster.md:619` is the only doc referencing this behavior; its wording now matches the new
"never select `foreign` **or** `unknown`, re-read peerStore each retry, fall to self-coordination"
reality. No other doc describes the old findCoordinator unknown-fallback.

### Major findings → new tickets

**None.** The two out-of-scope items the implementer flagged are pre-existing and correctly deferred,
not new work this ticket introduces:
- Sereus `strand-formation-e2e` Phase 2 / `strand-membership-closed-strand` acceptance is owned in the
  separate Sereus repo and cannot run from this monorepo; the libp2p-level cause is fixed here.
- Any residual cross-network e2e red is the domain of the distinct FRET ring-admission follow-up
  `network-scoped-ring-admission` (preventing cross-network peers entering the ring at all), already a
  known separate concern.
- The "no retry-delay when connected-but-unconfirmed" and `downsize: false` self-only-cohort rejection
  are both intentional/out-of-scope (the latter is a cohort-side concern owned by the prereq).

### Validation

- **Build:** `yarn workspace @optimystic/db-p2p build` (`tsc`) — clean, exit 0.
- **Targeted:** `network-membership scoping (protocolPrefix)` — **14 passing** (was 13; +1 flip test).
- **Full package:** `yarn workspace @optimystic/db-p2p test` — **1059 passing, 37 pending, 0 failing**
  (~34s). The `cohort-topic cold-start: parent registration … failed` console line is a
  deliberately-logged error inside a passing error-path test (`host-antidos-coldstart.spec.ts`), not a
  failure.
- **Lint:** not configured for this repo (root `lint` script is an `echo` placeholder).
- **No `.pre-existing-error.md` filed** — nothing failed. (The prereq-noted `TS5101 downlevelIteration`
  deprecation under `npx tsc --noEmit` does not surface via the package `build`/`test` scripts, which
  both pass.)

## Acceptance

- ✅ Two-network shared-mesh write where the writer is the only serving peer and self is not the key's
  FRET neighbor reaches a self-coordinated cohort, or — when self is excluded — fails fast with
  `NO_NETWORK_COORDINATOR`; never a `could not negotiate /optimystic/<other-network>/...` failure
  (selection-level tests; full dial owned out-of-repo).
- ✅ A fresh same-network peer is still selectable once it flips to `serves` within the retry window
  (now directly tested); single-network behavior and the `protocolPrefix`-absent no-op path unchanged.
- ⏳ Sereus `strand-formation-e2e` Phase 2 and `strand-membership-closed-strand` — run by the out-of-repo
  e2e owner; any residual is the domain of `network-scoped-ring-admission`.
- ✅ `yarn workspace @optimystic/db-p2p test` passes, including the new/updated coordinator tests.
