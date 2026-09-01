description: A node used to forget which group-resize instructions it had already carried out whenever it ran low on memory, so an old instruction replayed by anyone could be carried out a second time; the record it keeps now lives outside the memory it discards, and it is consulted whenever that memory is rebuilt.
files:
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-core/src/cohort-topic/promotion.ts
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts
  - packages/db-core/test/cohort-topic/promotion.spec.ts
difficulty: medium
----

# Review: promotion replay ordering now outlives engine eviction

## Background for a reader with no context

Cohort-topics split into child groups when they get busy ("promotion") and merge back when they go
quiet ("demotion"). Each such transition is announced on the network as a threshold-signed notice
(`PromotionNoticeV1` / `DemotionNoticeV1`) carrying an `effectiveAt` timestamp. Those signatures
never expire, so a notice captured off the wire stays valid forever — **the only defense against
someone replaying an old one is ordering**: a node must refuse a notice that is not strictly newer
than the last transition it already adopted for that same group.

Before this change, that ordering was tracked in two places, each of which cited the other as its
backstop:

- **Node-level** (`PromoteGate.highWater` in db-p2p's host): a map keyed `coord|tier` holding just an
  `effectiveAt` number. Written **only** when a *verified inbound* notice was applied.
- **Engine-level** (`PromotionState.lastEffectiveAt` in db-core's promotion lifecycle): lives inside a
  `CoordEngine`, which the host's registry **evicts under memory pressure**.

Two holes fell out of that:

1. A node that **originates** a transition itself never wrote its own node-level mark (the broadcast
   path excludes self). So: originate promote@100, later demote@200, let the engine get evicted —
   now anyone replaying the captured promote@100 re-promotes a cohort that has since demoted, and the
   node starts acting on a group layout that no longer exists.
2. Symmetrically, eviction also discarded a **correct** `promoted = true`, so a node could silently
   forget it had been promoted.

The `coord|tier` key also **conflated topics**: two different topics sharing a coordinate and tier
shared one ordering mark, so topic A's newer transition could stale-drop topic B's legitimate one.

## What landed

**db-p2p — `host.ts`**

- `PromoteGate.highWater: LruMap<string, number>` became `PromoteGate.transitions: LruMap<string, AdoptedTransition>`,
  where `AdoptedTransition = { readonly effectiveAt: number; readonly promoted: boolean }`. The
  constant renamed `PROMOTE_HIGHWATER_MAX_KEYS` to `PROMOTE_TRANSITIONS_MAX_KEYS` (still 8192, still LRU).
- New key includes the topic: `transitionKey(cohortCoordB64, tier, topicIdB64)` gives `coord|tier|topic`.
  `noticeTransitionKey(notice)` derives it from either notice kind (a demotion's `tier` and a
  promotion's `fromTier` deliberately address the **same** key, so the two directions order against
  each other).
- New `recordAdoptedTransition(gate, notice)` — monotonic write (strictly-newer only), sets
  `promoted` by notice kind. Called on **both** adoption paths: the verified-inbound path in
  `handleInboundNotice`, and the **origination** path where the node broadcasts its own notice
  (this is the half that was previously missing entirely).
- `CoordEngineContext.adoptedTransition?(coord, tier, topicId)` reads that map; `createCoordEngine`
  wires it into the lifecycle as `seedTransition`.

**db-core — `promotion.ts`**

- New optional `PromotionDeps.seedTransition?(topicId)` returning `{ effectiveAt, promoted } | undefined`.
- `stateFor(topicId, now)` (now takes `now`) seeds a **freshly created** per-topic state from that
  record: `lastEffectiveAt` and `promoted` come from the seed, and a seeded promotion re-arms
  `promotedAt = now`. `applyDemotionNotice` changed `_now` to `now` to feed this.
- `isPromoted(topicId)` does a **seed peek** when no in-engine state exists yet — it returns the
  record's direction *without* creating state, because it has no `now` with which to arm the sticky
  window, and creating promoted state unarmed would let an early demotion slip through.
- Data flow is deliberately **one-way**: node-level map to engine. The engine never writes back.
- `hasAdoptedState()`'s doc was corrected: the eviction ranking that keeps such engines is now only
  a **preference**, not the safety mechanism.

## Validation performed

All green, from repo root on a clean tree:

| command | result |
| --- | --- |
| `yarn workspace @optimystic/db-core test` | **1473 passing**, 0 failing |
| `yarn workspace @optimystic/db-p2p test` | **2488 passing**, 49 pending, 0 failing |
| `yarn workspace @optimystic/db-core build` / `typecheck` | exit 0 |
| `yarn workspace @optimystic/db-p2p build` / `typecheck` | exit 0 |

**Mutation-checked, not just observed passing.** The headline regression test was verified to
actually bite: with the seed wiring at `host.ts:2023` stubbed to `undefined`, it fails with
"the recreated engine seeds promoted = true straight from the node-level record / expected true,
actual false". The stub was reverted and both suites re-run green.

## Edge cases and where each is covered

| Behavior | Test |
| --- | --- |
| Replay after eviction + engine recreation is stale-dropped, state unchanged | `host-antidos-coldstart.spec.ts` — "an adopted transition survives engine eviction…", step 4 |
| A correct `promoted = true` survives eviction **with no replay at all** (the seed peek) | same test, first assert after recreation |
| Locally **originated** transitions write the node-level record (the previously-missing path) | `live-tier.spec.ts` test 4 — polls `promoteGate.transitions` on the deciding node; `broadcastOver` excludes self, so nothing else could have written it |
| Two topics at one `(coord, tier)` keep independent orderings | `promote-notice.spec.ts` — "…not stale-dropped by topic A's record at the same (coord, tier) (per-topic keying)"; fails on the old `coord|tier` key |
| Two sibling cohorts for one `(topic, tier)` — coordinate stays in the key | `promote-notice.spec.ts`, existing per-coord test (retitled) |
| Forged notices write nothing to the record | `promote-notice.spec.ts`, forged-flood test (renamed) |
| Record LRU-evicts past its cap | `promote-notice.spec.ts`, bounded-memory cap test |
| `recordAdoptedTransition` direction + monotonicity, incl. **equal** `effectiveAt` not overwriting | `promote-notice.spec.ts` — "recordAdoptedTransition (node-level adopted-transition record)" unit describe |
| Demotion tier `t` and promotion `fromTier` `t` address one key | same unit describe, third test |
| Seeded promotion re-arms the sticky window (delays demotion, never skips it), with a non-vacuity assert that the demotion *does* eventually fire | `promotion.spec.ts` — "seeded replay ordering (seedTransition)", second test |
| A **demoted** seed stale-drops a replayed older promotion (the actual eviction hole) | same describe, third test |
| `seedTransition` returning `undefined` behaves identically to no seed (key-less / unit composition) | same describe, fourth test |
| Parent-unlink stays outside this ordering — `"unlinked"` must not regress to `"stale"` | `promote-notice.spec.ts` dual-role test, deliberately untouched |
| The whole thing composes on a **key-less** host | headline test runs on the anti-DoS cold-start harness |

## Known gaps — treat these as starting points, not settled

- **The node-level record is in-memory and LRU-capped at 8192 keys.** It outlives *engine* eviction,
  which is the hole this ticket closed — it does **not** outlive process restart, and a node tracking
  more than 8192 `(coord, tier, topic)` triples will evict the oldest. Both are strictly better than
  before (previously an evicted engine lost the ordering immediately, and origination wrote nothing
  at all), but neither is durability. Whether replay ordering should survive restart is a real
  design question this ticket did not answer and did not file — worth a reviewer's judgment on
  whether it deserves its own ticket.
- **The seed peek in `isPromoted` is subtle.** It returns the record's direction without creating
  state, on the argument that nothing else calls `stateFor` on a freshly recreated engine before
  `isPromoted` is first read. That argument is asserted in a comment and exercised by one test; it
  is not enforced by a type or an invariant. If a future caller creates state earlier the peek
  becomes dead code rather than wrong, but the reasoning deserves a second pair of eyes.
- **Sticky-window anchor is unrecoverable across eviction.** A seeded promotion re-arms
  `promotedAt = now` rather than the original promotion time, so demotion is *delayed* by up to one
  sticky window after an eviction. This is the conservative direction (never an early demotion) and
  is asserted, but it is a real behavior change under memory pressure.
- **`live-tier.spec.ts` has a pre-existing unused import `bytesEqual` (line 37)**, present at HEAD
  before this ticket. Left alone deliberately; typecheck does not flag it.
- **`slopePredictsCrossing` in `promotion.ts` has a pre-existing unused `now` parameter.** Untouched.
- **Second db-core mutation check abandoned.** Stubbing the seed read at `promotion.ts:434` to
  `undefined` made TypeScript narrow the branch to `never` and the run aborted at type-strip; the
  mutation was not worth reshaping to force through. The three `seedTransition` unit tests pass an
  explicit seed and assert seeded behavior, so they cannot pass if the seed is ignored — but only
  the db-p2p headline test has been *proven* to fail without the fix.

## Pre-existing build break — not from this ticket

Root `yarn build` and `yarn typecheck` are **red**, in `@optimystic/quereus-plugin-crypto`, whose
tsup DTS step cannot resolve `@quereus/quereus` (a symlink to a separate repository on disk at
`C:/projects/quereus`). Because other workspaces depend on it, the topological run halts there.
Nothing under that package is in this ticket's diff — `git diff --stat 8a18d9a2..HEAD` limited to
non-ticket paths touches only `cohort-topic` files — its last commit is `6f93ec60`, and plain `tsc`
on its `src/` resolves the module fine; only tsup's dts worker does not. Written up in full at
`tickets/.pre-existing-error.md` for the triage pass. **No test was skipped, disabled, or loosened.**
