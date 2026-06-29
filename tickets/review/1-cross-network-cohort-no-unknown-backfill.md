description: Verify the fix that stops a write's helper group from being built out of nodes which were never confirmed to belong to this database, so a write no longer fails by accidentally pulling in a node from a different database sharing the same machines.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (findCluster — membership-scoping block, ~lines 565-611)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (describe 'network-membership scoping (protocolPrefix)', ~lines 690-880)
  - packages/db-p2p/docs/cluster.md (Network-Membership Scoping note, ~line 619)
difficulty: medium
----

# Review: `findCluster` no longer backfills `unknown` (possibly cross-network) peers into a write cohort

## What was implemented

Residual hardening from `multi-coordinator-cross-network-coordinator-selection`. When two
Optimystic networks run coordinator-eligible (`storage`) nodes over a shared mesh, a peer from the
*other* network can land in this network's FRET routing ring. Its network-namespaced `identify`
never completes here, so its peerStore protocol list stays empty forever — classified `unknown`,
indistinguishable from a fresh *same-network* peer mid-`identify`.

Previously `findCluster` backfilled `unknown` peers to meet a viability floor of `min(2, clusterSize)`.
That floor (≤ 2) only fired when `serves` was empty — i.e. **self is the sole serving member**. In
exactly that case the backfill pulled a cross-network `unknown` peer into the cohort; the coordinator
then dialed its `/optimystic/<other-network>/repo/1.0.0`, which cannot negotiate, and the write died
with `Failed to get super-majority: 1/2 approvals (needed 2) … could not negotiate …`.

**The change (Option 3 — floor relaxation, contained to `findCluster`):** drop the `unknown` backfill
entirely under membership scoping. The cohort is now `self + (serves, nearest-first, capped at
clusterSize-1)`. No `unknown` peer is ever admitted.

### Exact diff surface

- `packages/db-p2p/src/libp2p-key-network.ts` — `findCluster`, the `if (this.protocolPrefix != null)`
  block (~565-611). Replaced:
  ```ts
  const nonSelfTarget = Math.max(0, this.clusterSize - 1)
  const viabilityFloor = Math.min(2, this.clusterSize)
  let others = serves.slice(0, nonSelfTarget)
  if ((others.length + 1) < viabilityFloor) {
      others = [...others, ...unknown.slice(0, nonSelfTarget - others.length)]
  }
  ids = Array.from(new Set([selfId, ...others]))
  ```
  with:
  ```ts
  const nonSelfTarget = Math.max(0, this.clusterSize - 1)
  const others = serves.slice(0, nonSelfTarget)
  ids = Array.from(new Set([selfId, ...others]))
  ```
  The `serves`/`unknown`/`foreignDropped` classification loop is untouched; `unknown.length` is still
  computed and emitted in the `findCluster:membership` log line. Over-fetch, self-inclusion, address
  backfill, and the `protocolPrefix == null` no-op path are all untouched. Surrounding comments updated
  to describe the new behavior.
- `packages/db-p2p/test/libp2p-key-network.spec.ts` — rewrote one test, added one (see below).
- `packages/db-p2p/docs/cluster.md` — Network-Membership Scoping note updated.

## Why this is safe (the load-bearing assumption to scrutinize)

A genuine same-network peer's protocol dial **succeeds even before its `identify` completes** —
libp2p multistream-select negotiates the protocol on the stream directly. So the only peers whose
repo dial actually fails are cross-network ones. A legitimately-joining same-network peer is therefore
not permanently starved: it is admitted as `serves` on a later write once `identify` completes (and
the coordinator/batch retry re-runs `findCluster`); in the meantime a self-only downsized write
succeeds under `allowClusterDownsize: true` (the default, `libp2p-node-base.ts:456,522`), where
`peerCount == 1` ⇒ `superMajority == ceil(1 * threshold) == 1` ⇒ `1/1`.

**Reviewer: this is the claim most worth an adversarial check.** If a same-network peer's repo/cluster
dial could in fact fail while `unknown`, this change would convert a recoverable wait into a dropped
member. Confirm the multistream-select-negotiates-before-identify behavior against the real dial path
(`Libp2pNodeBase` / repo client), not just the mock.

## Use cases for validation

| Scenario | Expected cohort | Covered by test |
|---|---|---|
| Self alone + cross-network `unknown` nearer the key (**the bug**) | `[self]` only | ✅ new: "keeps a self-only cohort when self is the sole serving peer and a cross-network peer sits nearer the key" |
| No serving peers, two `unknown` members (fresh mesh) | `[self]` only | ✅ rewritten: "does NOT backfill not-yet-identified members (self-only cohort)" |
| `serves` peer present + `unknown` contaminant | self + serves, `unknown` excluded | ✅ existing: "excludes a cross-network cohort member when a serving cohort already exists" |
| 3 serving peers, clusterSize 2 | exactly 2 (self + nearest serving) | ✅ existing: "sizes the cohort to clusterSize" |
| `foreign` member, self alone | `[self]` only | ✅ existing: "always drops a foreign cohort member" |
| `protocolPrefix` absent | filter disabled, member retained | ✅ existing: two regression-guard tests |
| `clusterSize == 1` | self-only (`nonSelfTarget == 0`) | implicitly correct; **no dedicated test** (gap — see below) |

## How to run

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-key-network.spec.ts" \
  --colors --reporter spec --grep "network-membership scoping"
```
Or the whole package: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min`.

## Results

- Membership-scoping describe block: **10 passing** (8 prior + rewritten + new).
- Full `@optimystic/db-p2p` suite: **1055 passing, 37 pending, 0 failing** (~37s). The
  `cohort-topic cold-start: parent registration … failed` line in output is a deliberately-logged
  error inside a passing error-path test, not a failure.

## Known gaps / honesty notes (treat tests as a floor)

- **Mock-only coverage of the safety claim.** All tests drive `findCluster` against a mock libp2p +
  mock peerStore. They prove the cohort *composition* is correct, but **not** that a same-network
  peer's dial succeeds pre-`identify` (the assumption that makes "drop the unknown, retry later" safe
  rather than starving). No integration test exercises the real two-network shared-mesh write end to
  end. The originating Sereus repro (`strand-formation-e2e` Phase 2, `strand-membership-closed-strand`)
  lives outside this repo and was not run here.
- **No `clusterSize == 1` test.** Behavior is correct by construction (`nonSelfTarget == 0`) but
  unasserted.
- **`downsize: false` is out of scope and still broken by design here.** When `allowClusterDownsize`
  is false and a fresh same-network mesh is mid-`identify`, a self-only cohort is rejected by
  `minRequiredSize`. The intended fail-fast signal (`NO_NETWORK_COORDINATOR`) for that path is the
  sibling ticket `cross-network-coordinator-no-unknown-fallback` (`tickets/implement/2-…`), NOT this
  one. This ticket fully fixes only the **default** `downsize: true` config — which is the observed
  Sereus case. Reviewer should not treat the `downsize: false` self-only rejection as a regression
  introduced here.
- **Pre-existing, NOT mine — `npx tsc --noEmit` in `packages/db-p2p` fails** with
  `tsconfig.json(19,3): error TS5101: Option 'downlevelIteration' is deprecated …`. This is a
  toolchain/config deprecation in `tsconfig.json` line 19 (`downlevelIteration: true`), a file this
  ticket never touched; it reproduces on a clean tree and is independent of the source edits (no errors
  are reported for `libp2p-key-network.ts` itself). The package's own `test` script uses Node
  type-stripping, not `tsc`, and passes. Not filed as `.pre-existing-error.md` because it is a build
  deprecation, not a test failure; flagged here so the reviewer/CI can address the config separately.
- **`describe`-block header comment** (~line 688) still reads "only fall back to 'unknown' when nothing
  serving exists" — left intentionally, as it now describes `findCoordinator` (still falls back to
  `unknown`; the coordinator hole is the sibling ticket), not `findCluster`. Worth a second opinion on
  whether that comment should be split per-function for clarity.

## Acceptance (from the implement ticket — all met under default config)

- ✅ Two-network shared-mesh write where the writer is the only serving peer reaches a self-only cohort
  under `downsize: true`; never a `could not negotiate /optimystic/<other-network>/repo/1.0.0`
  super-majority failure (verified by cohort-composition tests; end-to-end dial not re-run here).
- ✅ Fresh same-network peer still admitted as `serves` on a later write; single-network behavior and
  the `protocolPrefix`-absent no-op path unchanged.
- ✅ `@optimystic/db-p2p` test command passes including rewritten + new membership-scoping tests.
