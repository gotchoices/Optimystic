description: A node records which recent group-resize instructions it has already carried out, but that record lives only inside a working set the node discards under memory pressure — so after discarding it, an old instruction replayed by anyone on the network gets carried out a second time, leaving the node acting on a group layout that no longer exists.
prereq: bug-coord-engine-eviction-exhaustive-liveness
files:
  - packages/db-p2p/src/cohort-topic/host.ts                          # DONE — all src edits landed (committed)
  - packages/db-core/src/cohort-topic/promotion.ts                    # DONE — all src edits landed (committed)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts          # DONE — rename committed; item 14b edits in working tree (uncommitted)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts  # DONE — item 15 headline test in working tree (uncommitted)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts               # DONE — item 16 assert in working tree (uncommitted)
  - packages/db-core/test/cohort-topic/promotion.spec.ts              # DONE — item 17 tests in working tree (uncommitted)
difficulty: medium
repro: static
----

# Give the promotion replay anchor a lifetime that outlives the engine

**STATUS after run 4: ALL implementation + ALL test edits COMPLETE. Runs 1–3 committed the src and
the item-14 mechanical rename; run 4 landed items 14b/15/16/17 as uncommitted working-tree edits in
the four test files above, then hit BUDGET_WARNING before running validation. The ONLY remaining
work is validation (and any fixups it reveals), then the review/ handoff.** Do NOT redo any edit —
`git diff` shows exactly what run 4 added; everything below describes what is already in the tree.

## Remaining work (validation only)

Run, foreground, no redirection (reporter is `min`, output small):

1. `yarn workspace @optimystic/db-core test`
2. `yarn workspace @optimystic/db-p2p test`  (inner loop if needed: append `--grep "promot"` /
   `--grep "adopted"` — but finish with the FULL suite)
3. `yarn build` then `yarn typecheck` from root.

Fix anything the runs reveal (expect at most small assertion/typing nits — all APIs were verified
against src before writing). Then write the review/ handoff ticket (distilled summary + the
edge-case→test map below), delete this ticket, done.

## What run 4 added (already in working tree — verify with `git diff`, do not redo)

### promote-notice.spec.ts (item 14b)
- Imports: added `recordAdoptedTransition`, `noticeTransitionKey` to the host.js import.
- Added top-level `TOPIC_B` const (32 bytes) next to `TOPIC`.
- `promotionNoticeAtCoord(coord, effectiveAt, topicId = TOPIC)` — optional third param.
- Retitled off "high-water": replay test (~390), advances-record test (~415), per-coord test (~486),
  forged-flood test (~597); reworded the matching inline comments and the dual-role comment (~735)
  to "adopted-transition record".
- NEW test in the anti-abuse-gate describe: `'a notice for topic B is not stale-dropped by topic
  A's record at the same (coord, tier) (per-topic keying)'` — one `remoteTargetAt(COORD)` target,
  `servingRegistry`, trust-all: A@5_000 applied, B@4_000 (same coord) applied (fails on the old
  `coord|tier` key), `isPromoted(TOPIC_B)` true, A replay@5_000 stale.
- NEW describe `'cohort-topic: recordAdoptedTransition (node-level adopted-transition record)'`
  (placed between the gate describe and the bounded-memory section; plain notice literals with
  `thresholdSig: ''`): direction (promotion→true, newer demotion overwrites→false); monotonic
  (older AND equal effectiveAt never overwrite); key equivalence (demo tier 1 === promo fromTier 1).

### host-antidos-coldstart.spec.ts (item 15 — the headline regression test)
- Imports: `type MembershipVerifier` added to the db-core import; `handleInboundNotice`,
  `transitionKey` added to the host.js import.
- Inside the `coord-engine registry cap` describe, after the promotion-ranking test: local
  `trustAll` MembershipVerifier stub, `DUMMY_SIG` (64×7 b64url), `gateNoticeFor(topicId, coord,
  effectiveAt)` (fromTier 0 → toTier 1, DUMMY_SIG, signers `[b64url(topicId)]`, 32-zero epoch —
  passes `decodeInboundNotice` validation, unlike the key-less `promoNoticeFor`).
- NEW test `'an adopted transition survives engine eviction: the recreated engine seeds promoted
  mode and stale-drops the replay'` — cap 2; adopt via `handleInboundNotice` at coord A (assert
  applied + `isPromoted` + map entry deep-equals `{effectiveAt: 10_000, promoted: true}`); rank-1
  companion via `recordChild`; third `forCoord` evicts A (assert gone); `forCoord(A)` again evicts
  the rank-0 spray engine and recreates A (assert `isPromoted(T)` true with NO replay — the seed
  peek); replay the SAME captured frame at now 12_000 → `'stale'`, still promoted; `host.stop()`.
  Rate limiter fine: 2 calls for one (peer, topic) at 11_000/12_000 < default 4/min.

### live-tier.spec.ts (item 16)
- Import: `transitionKey` added alongside `verifyAndApplyNotice`.
- In test 4, between the two promotion waitFors: a `waitFor` polling
  `deciding.host.promoteGate.transitions.get(transitionKey(b64url(coord0), 0, b64url(TOPIC)))?.promoted === true`
  (8s) — proves the ORIGINATION path (`broadcastNotice` → `recordAdoptedTransition`) writes the
  node-level record; `broadcastOver` excludes self so nothing else can write it on that node.

### promotion.spec.ts (db-core, item 17)
- `lifecycleWith(knobs, config?, seed?)` — third param `PromotionDeps['seedTransition']` threaded
  into deps as `seedTransition: seed`.
- Census comment block (pre-`hasAdoptedState` describe) rewritten: ranking is a preference, not the
  safety mechanism; the node-level record re-seeds a recreated engine.
- NEW describe `'cohort-topic / promotion seeded replay ordering (seedTransition)'` (local
  `promoNotice` literal): promoted-seed peek (isPromoted true, zero prior calls); sticky re-arm
  (onParticipantCountChange @t0 with count 0, maybeDemote @t0+STICKY−1 → undefined, non-vacuity
  maybeDemote @t0+T_DEMOTE+STICKY → notice, then isPromoted false); demoted-seed stale-drops
  promoNotice(100); `() => undefined` seed behaves exactly as no seed.

## Learnings (accumulated, all verified — trust these)
- Test runner: mocha via `node --import ./register.mjs`, glob `test/**/*.spec.ts`, reporter `min`.
  `yarn workspace @optimystic/db-core test` / `@optimystic/db-p2p test`.
- **Build**: `yarn build` from root passes at HEAD. db-p2p resolves db-core's BUILT `.d.ts` — build
  db-core before typechecking db-p2p in isolation.
- live-tier.spec.ts has a PRE-EXISTING unused import `bytesEqual` (line 37) — present at HEAD, not
  ours, leave it. If root `yarn typecheck` fails on it, it was failing before this ticket — treat
  per the pre-existing-failure protocol, do not silently "fix" unrelated imports in this ticket.
- Pre-existing, not ours: `slopePredictsCrossing` unused `now` param in promotion.ts — leave it.
- Validators (`db-core/src/cohort-topic/wire/validate.ts` ~221): `validatePromotionNoticeV1` needs
  `toTier === fromTier + 1`, 32-byte b64url `topicId`/`cohortCoord`, `thresholdSig` merely valid
  b64url, `signers` any string array.
- Registry eviction (host.ts ~1435-1580): `(rank, recency)`-least candidate; records/forwarders
  pinned; children + adopted promotion rank 1; cold rank 0. `forCoord`/`findByCoord` bump recency.
- Engine treeTier must match notice `fromTier` for the seed key (`forCoord(coord, 0 as Tier, …)` →
  treeTier 0 → matches `gateNoticeFor`'s fromTier 0).
- Harness `waitFor(pred, timeoutMs)` (db-p2p mesh harness) returns Promise<boolean>; db-core/test
  `waitFor(pred, { description })` is a different signature — don't mix.
- host.promoteGate is exposed on CohortTopicHost (host.ts ~557); `adoptedTransition` wired at ~863;
  `seedTransition` at ~2023; `recordAdoptedTransition` origination write at ~770.

## Edge cases to preserve (mapped to tests — for the review/ handoff)
- Replay after eviction+recreation → `"stale"`, state unchanged (headline test step 4).
- Correct `promoted = true` survives eviction with no replay (headline test step 4, first assert).
- Locally-originated transitions write the map (live-tier test 4 assert).
- Two topics at one coord: independent orderings (promote-notice per-topic test).
- Two sibling cohorts for one `(topic, tier)`: coord stays in the key (existing ~486, retitled).
- Forged notices write nothing (existing forged-flood test, renamed).
- Map LRU eviction beyond cap (existing cap test, rewritten).
- Parent-unlink stays outside this ordering — `"unlinked"` must not regress to `"stale"` (existing
  dual-role test ~710, untouched).
- Seeded demotion still rejects stale promotion replay (seedTransition describe, third test).
- Key-less composition works (headline test runs on the key-less anti-DoS harness).
- recordAdoptedTransition monotonicity incl. equal effectiveAt (unit describe).

## Original problem statement (context, unchanged)

Cohort-topic groups split when busy, merge when quiet; each transition is a threshold-signed
`PromotionNoticeV1`/`DemotionNoticeV1` stamped `effectiveAt`. Signatures never expire — ordering is
the only replay defense. Pre-fix, two anchors each cited the other as backstop: the node-level
`PromoteGate.highWater` (written ONLY on verified inbound applies, keyed `coord|tier` — conflating
topics) and the engine-level `PromotionState.lastEffectiveAt` (living in a `CoordEngine` the
registry evicts under memory pressure). A node that ORIGINATES transitions never wrote its own water
(`broadcastOver` excludes self), so originate promote@100 / demote@200, evict the engine, and anyone
replaying the captured promote@100 re-promotes a demoted cohort; symmetrically, eviction discarded a
CORRECT `promoted = true`. The fix (landed in src): the gate map stores `{effectiveAt, promoted}`
keyed `coord|tier|topic`, written on BOTH adopt paths, and seeds a freshly created engine's
per-topic state (one-way: map → engine).
