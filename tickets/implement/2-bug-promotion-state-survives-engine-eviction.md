description: A node records which recent group-resize instructions it has already carried out, but that record lives only inside a working set the node discards under memory pressure — so after discarding it, an old instruction replayed by anyone on the network gets carried out a second time, leaving the node acting on a group layout that no longer exists.
prereq: bug-coord-engine-eviction-exhaustive-liveness
files:
  - packages/db-p2p/src/cohort-topic/host.ts                          # DONE — all src edits landed (committed)
  - packages/db-core/src/cohort-topic/promotion.ts                    # DONE — all src edits landed (committed)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts          # PARTIAL — mechanical rename DONE + build green; new tests (item 14b) TODO
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts  # TODO — headline regression test (item 15)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts               # TODO — origination-write assert in test 4 (item 16)
  - packages/db-core/test/cohort-topic/promotion.spec.ts              # TODO — seedTransition unit tests (item 17)
difficulty: hard
repro: static
----

# Give the promotion replay anchor a lifetime that outlives the engine

**STATUS after run 3: src COMPLETE (committed at HEAD), item 14 mechanical rename COMPLETE
(uncommitted in promote-notice.spec.ts), `yarn build` from root passes GREEN with those edits.**
Two prior runs were budget-stopped. Remaining: the four NEW-test items below, then validation.
Do not redo the rename — `git diff` shows it; build was verified green after it.

## What already landed (verify with `git log`/`git diff`, do not redo)

### Committed at HEAD (runs 1–2) — src implementation, design items 1–13
- db-p2p `host.ts`: `AdoptedTransition` (~2656), `PromoteGate.transitions: LruMap<string, AdoptedTransition>`
  (~2695), `PROMOTE_TRANSITIONS_MAX_KEYS = 8192` (~2704), `transitionKey(coordB64, tier, topicB64)` =
  `` `${coord}|${tier}|${topic}` `` (~2712), `noticeTransitionKey` (demotion → `notice.tier`, promotion →
  `notice.fromTier`) (~2723), `recordAdoptedTransition` (monotonic per key: strictly-greater effectiveAt
  overwrites; direction from notice shape) (~2733). `handleInboundNotice` stale gate reads
  `gate.transitions` and records only on `"applied"` (~2972-2984). `broadcastNotice` first line records
  the origination (~770). `CoordEngineContext.adoptedTransition` wired unconditionally (~863);
  `createCoordEngine` passes `seedTransition` into promotion deps (~2023).
- db-core `promotion.ts`: `PromotionDeps.seedTransition?` (~155, inline structural type), `stateFor`
  seeds on first creation + re-arms `promotedAt = now` when seeded promoted (~424-445), `isPromoted`
  seed peek when no in-engine state (~251-264). Docs updated.

### Uncommitted working-tree edits (run 3) — promote-notice.spec.ts mechanical rename, build-verified
- Import: `PROMOTE_HIGHWATER_MAX_KEYS` → `PROMOTE_TRANSITIONS_MAX_KEYS` (nothing else added — do NOT
  import `recordAdoptedTransition`/`noticeTransitionKey` until the tests using them exist, unused
  imports fail the build).
- Cap test (~549): retitled; sets `gate.transitions.set(`coord|0|topic-${i}`, { effectiveAt: 1_000 + i,
  promoted: true })`; `has()` keys match.
- Eviction test (~563): retitled ("an evicted transition record lets a stale replay re-verify but the
  resident engine idempotently no-ops it"); comment REWRITTEN to the new authority framing (map =
  node's replay-ordering authority; resident engine = same-process second layer); fillers now
  `gate.transitions.set(`filler|9|${i}`, { effectiveAt: i, promoted: true })`. Assertions unchanged.
- Forged-flood test (~595): `gate.transitions.size` + message reworded.
- NOT yet done from item 14: dual-role comment ~735 ("advanced the COORD high-water") reword; titles at
  ~390/~415/~486 still say "high-water" (cosmetic — optional reword); and ALL new tests (item 14b).

## Learnings for the next run (accumulated, all verified)
- **Build**: `yarn build` from root now passes with the working tree as-is. db-p2p resolves db-core's
  BUILT `.d.ts`, so build db-core before typechecking db-p2p in isolation.
- **Validators** (`db-core/src/cohort-topic/wire/validate.ts` ~221): `validatePromotionNoticeV1` needs
  `toTier === fromTier + 1`, 32-byte b64url `topicId`/`cohortCoord`, `thresholdSig` merely valid b64url
  (`b64urlField` — a 64-byte DUMMY_SIG works; empty string untested, avoid), `signers` any string array.
  So a gate-path fixture with `thresholdSig: DUMMY_SIG, signers: [<any b64url>]` passes
  `decodeInboundNotice`.
- **DUMMY_SIG TDZ**: in promote-notice.spec.ts `DUMMY_SIG` is declared at ~508, referenced by
  `promotionNoticeAtCoord` (~324). Safe — only invoked inside `it` bodies after module eval. Same
  pattern fine for new helpers.
- **Registry eviction** (host.ts ~1435-1580): evicts the `(rank, recency)`-least candidate;
  records/forwarders pinned; children + adopted promotion are rank 1; cold = rank 0. `forCoord` and
  `findByCoord` both bump recency (monotonic seq).
- **Headline-test choreography confirmed viable** (cap 2): create engine A; adopt via
  `handleInboundNotice` (bumps A); create B + `B.recordChild(...)` (rank 1, more recent than A);
  `forCoord(C)` → both A,B rank 1, no rank 0 → LRU A evicted. `forCoord(A)` again → C is rank-0 →
  C evicted, A recreated. Engine treeTier 0 must match notice `fromTier: 0` for the seed key.
- **Trust-all verifier stub shape** (copy from promote-notice.spec.ts ~317):
  `{ cache: () => undefined, forget: () => undefined, verifyMessage: () => Promise.resolve('verified') }`
  typed `MembershipVerifier`.
- **Rate limiter**: default 4/min per (peer, topic) — the headline test's 2 inbound calls for one
  (peer, topic) fit; keep `now` values inside one window or use `{ ratePerWindow: 10_000 }`.
- Pre-existing, not ours: `slopePredictsCrossing` unused `now` param in promotion.ts — leave it.
- host-antidos-coldstart.spec.ts is key-less; its `promoNoticeFor` (~772, `thresholdSig: ''`) is only
  fed straight to `applyPromotionNotice`, never through `decodeInboundNotice` — don't reuse it for the
  gate path; add a DUMMY_SIG helper.
- live-tier test 4: `deciding.host.promoteGate` is only ever written by ORIGINATION on that node
  (`broadcastOver` excludes self, so the deciding node never sees its own notice inbound). `promote()`
  sets engine state BEFORE the host calls `broadcastNotice`, so `waitFor` (not a direct read) on the
  map entry.

## Remaining work

### 14b. promote-notice.spec.ts — new tests (+ leftover comment rewords)
- Reword dual-role comment ~735: "advanced the COORD high-water" → "advanced the COORD
  adopted-transition record". Optionally retitle ~390/~415/~486 off "high-water".
- Add `recordAdoptedTransition` unit tests (new describe; import `recordAdoptedTransition`,
  `noticeTransitionKey` from host.js when adding). Plain notice literals (`thresholdSig: ''` fine —
  no validation on this path): monotonic per key (older AND equal effectiveAt never overwrite);
  direction recorded (promotion → `promoted: true`, demotion → `false`); key equivalence —
  `noticeTransitionKey(demotion{tier: 1})` === `noticeTransitionKey(promotion{fromTier: 1})` at the
  same coord/topic.
- Add **two topics, one (coord, tier)** test in the anti-abuse-gate describe (~338): extend
  `promotionNoticeAtCoord(coord, effectiveAt)` (~324) with an optional `topicId = TOPIC` param; add a
  32-byte `TOPIC_B` const. One `remoteTargetAt(COORD)` target serves both topics. Apply topic-A at
  effectiveAt 5_000 via `handleInboundNotice` + `trustAllVerifier` → `"applied"`; topic-B at the same
  coord with effectiveAt 4_000 (≤ A's) → must be `"applied"`, not `"stale"` (fails on the old
  `coord|tier` key); `a.life.isPromoted(TOPIC_B)` true; sanity: replay of A at 5_000 → `"stale"`.
  Existing parent-unlink replay test (~710) must stay green.

### 15. host-antidos-coldstart.spec.ts — the headline regression test
In the `coord-engine registry cap` describe (~651). Imports: add `handleInboundNotice`, `transitionKey`
to the host.js import (~27); add `type MembershipVerifier` to the db-core import (~6). Local trust-all
stub + `const DUMMY_SIG = bytesToB64url(Uint8Array.from({ length: 64 }, () => 7))` + helper
`gateNoticeFor(topicId, cohortCoord, effectiveAt)`: `{ v: 1, topicId, fromTier: 0, toTier: 1,
cohortCoord, effectiveAt, thresholdSig: DUMMY_SIG, signers: [bytesToB64url(topicId)], cohortEpoch:
bytesToB64url(new Uint8Array(32)) }` (b64url the byte fields). Test, cap = 2, `T = topicAt(0)`,
`A = addressing.coord0(T)`:
1. `forCoord(A, 0 as Tier, participant)`; `handleInboundNotice(encodeCohortMessage(gateNoticeFor(T, A,
   10_000)), participant, host.registry, trustAll, host.promoteGate, 11_000)` → `"applied"`; assert
   `host.registry.findByCoord(A)!.isPromoted(T)` true and
   `host.promoteGate.transitions.get(transitionKey(bytesToB64url(A), 0, bytesToB64url(T)))` deep-equals
   `{ effectiveAt: 10_000, promoted: true }`.
2. `const B = forCoord(coord0(topicAt(1)))`; `B.recordChild(topicAt(1), coord0(topicAt(500)), 1_000)`.
3. `forCoord(coord0(topicAt(2)))` → evicts A. Assert `findByCoord(A) === undefined`.
4. `forCoord(A)` again (evicts rank-0 C). Assert recreated `isPromoted(T) === true` with NO replay
   (seed peek), then replay the SAME frame via `handleInboundNotice` at now 12_000 → `"stale"`,
   `isPromoted(T)` still true. `await host.stop()`.

### 16. live-tier.spec.ts test 4 (~211)
After `waitFor(() => decidingEngine.isPromoted(TOPIC), ...)` (line ~210, before the sibling waitFor is
also fine after): add
`waitFor(() => deciding.host.promoteGate.transitions.get(transitionKey(bytesToB64url(coord0), 0, bytesToB64url(TOPIC)))?.promoted === true, 8_000)`
→ expect true, message: proves the ORIGINATION path writes the node-level record (self-exclusion means
nothing else can have written it on that node). Import `transitionKey` alongside `verifyAndApplyNotice`
(~57).

### 17. promotion.spec.ts (db-core)
`lifecycleWith(knobs, config?)` (~43) gains optional third param `seed?: PromotionDeps['seedTransition']`
threaded into deps. Tests (new describe, e.g. "seeded replay ordering (seedTransition)"):
- seed `() => ({ effectiveAt: 200, promoted: true })` → `isPromoted(TOPIC)` true with ZERO prior calls
  (the peek).
- same seed + `onParticipantCountChange(TOPIC, t0)` with low count (arms state at t0, promotedAt = t0)
  then `maybeDemote(TOPIC, t0 + DEFAULT_T_PROMOTE_STICKY_MS - 1)` → undefined (sticky re-armed at
  seed); non-vacuity: `maybeDemote(TOPIC, t0 + DEFAULT_T_DEMOTE_MS + DEFAULT_T_PROMOTE_STICKY_MS)` →
  a notice (knobs: treeTier 1, children 0, count ≤ DEFAULT_CAP_DEMOTE, lowLoadSince = t0).
- seed `() => ({ effectiveAt: 200, promoted: false })` → `applyPromotionNotice(promoNotice(100), 1_000)`
  is a no-op (`isPromoted` false).
- seed `() => undefined` → identical to today: `isPromoted` false, `applyPromotionNotice(promoNotice(100))`
  applies. (Existing suite guards the no-seed default.)
- Update the census comment block (~249-258): node-level record now backstops eviction; ranking is a
  preference, not the safety mechanism.

### Validation
`yarn workspace @optimystic/db-core test` and `yarn workspace @optimystic/db-p2p test` (inner loop:
`--grep "promot"`), then `yarn build` + `yarn typecheck` from root. Foreground, no redirection.

## Edge cases to preserve (mapped to tests)
- Replay after eviction+recreation → `"stale"`, state unchanged (test 15 step 4).
- Correct `promoted = true` survives eviction with no replay (test 15 step 4, first assert).
- Locally-originated transitions write the map (test 16).
- Two topics at one coord: independent orderings (test 14b).
- Two sibling cohorts for one `(topic, tier)`: coord stays in the key (existing ~486).
- Forged notices write nothing (existing ~595, renamed — DONE).
- Map LRU eviction beyond cap (existing ~549, rewritten — DONE).
- Parent-unlink stays outside this ordering — `"unlinked"` must not regress to `"stale"` (existing ~710).
- Seeded demotion still rejects stale promotion replay (test 17, third bullet).
- Key-less composition: anti-DoS harness is key-less and must work (test 15 relies on it).
- Prereq interaction: promotion-holders are rank-1 — force eviction via a rank-1 companion (test 15
  step 2), never assume.

## Original problem statement (context, unchanged)

Cohort-topic groups split when busy, merge when quiet; each transition is a threshold-signed
`PromotionNoticeV1`/`DemotionNoticeV1` stamped `effectiveAt`. Signatures never expire — ordering is the
only replay defense. Pre-fix, two anchors each cited the other as backstop: the node-level
`PromoteGate.highWater` (written ONLY on verified inbound applies, keyed `coord|tier` — conflating
topics) and the engine-level `PromotionState.lastEffectiveAt` (living in a `CoordEngine` the registry
evicts under memory pressure). A node that ORIGINATES transitions never wrote its own water
(`broadcastOver` excludes self), so originate promote@100 / demote@200, evict the engine, and anyone
replaying the captured promote@100 re-promotes a demoted cohort; symmetrically, eviction discarded a
CORRECT `promoted = true`. The fix (landed in src): the gate map stores `{effectiveAt, promoted}`
keyed `coord|tier|topic`, written on BOTH adopt paths, and seeds a freshly created engine's per-topic
state (one-way: map → engine).
