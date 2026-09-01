description: A node records which recent group-resize instructions it has already carried out, but that record lives only inside a working set the node discards under memory pressure — so after discarding it, an old instruction replayed by anyone on the network gets carried out a second time, leaving the node acting on a group layout that no longer exists.
prereq: bug-coord-engine-eviction-exhaustive-liveness
files:
  - packages/db-p2p/src/cohort-topic/host.ts                          # PromoteGate (~2629-2665), broadcastNotice (~753), handleInboundNotice stale gate (~2891-2908), CoordEngineContext (~569-646), ctx literal (~796-844), createCoordEngine promotion wiring (~1980-2002)
  - packages/db-core/src/cohort-topic/promotion.ts                    # PromotionState.lastEffectiveAt (94-111), stateFor (~393), isPromoted (~231), PromotionDeps (113-139)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts          # highWater tests (~505-611); comment at ~563 to rewrite
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts  # "coord-engine registry cap" describe (~651); promoNoticeFor helper (~772)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts               # test 4 (~173) drives a REAL local promotion — cheap place to assert the origination write
  - packages/db-core/test/cohort-topic/promotion.spec.ts              # add seedTransition unit tests here (harness: lifecycleWith/Knobs)
difficulty: hard
repro: static
----

# Give the promotion replay anchor a lifetime that outlives the engine

**STATUS: investigation complete, zero code written.** A prior run read every relevant site and resolved
all open design questions; this ticket now carries the finished design. The next run can implement
directly from the "Resolved design" section without re-deriving anything. The original problem statement
is preserved below it.

## Resolved design (implement exactly this)

### db-p2p `host.ts`

1. **`AdoptedTransition`** (exported interface, next to `PromoteGate`):
   `{ readonly effectiveAt: number; readonly promoted: boolean }`.

2. **`PromoteGate.highWater: LruMap<string, number>` → `transitions: LruMap<string, AdoptedTransition>`.**
   Rename `PROMOTE_HIGHWATER_MAX_KEYS` → `PROMOTE_TRANSITIONS_MAX_KEYS`, keep 8192.
   Rewrite the doc comment (currently ~2636-2652): the map is the node's durable record of the last
   adopted transition per `(coord, tier, topic)`, written by every adopt path, read by the inbound stale
   gate and by engine seeding; its cap exceeds the 2048-engine registry cap and it is written only on
   adopted transitions (not attacker-growable) — do NOT cite the engine as the idempotency backstop.
   Rename ripple is confined to `host.ts` + `promote-notice.spec.ts` (verified by grep; the other
   "high-water" matches across packages are unrelated prose).

3. **Key helpers** (both exported from host.ts):
   ```ts
   export function transitionKey(cohortCoordB64: string, tier: number, topicIdB64: string): string {
   	return `${cohortCoordB64}|${tier}|${topicIdB64}`;
   }
   export function noticeTransitionKey(notice: PromotionNoticeV1 | DemotionNoticeV1): string {
   	return transitionKey(notice.cohortCoord, "parentCohortCoord" in notice ? notice.tier : notice.fromTier, notice.topicId);
   }
   ```
   (`"parentCohortCoord" in notice` is the discrimination idiom `noticeBroadcastCoords` already uses.)
   For a notice at the engine's own served coord, both `fromTier` (promotion) and `tier` (demotion)
   equal the engine's `treeTier`, so seeding with `treeTier` matches the key — verified.

4. **Shared monotonic writer** (exported, so it is unit-testable):
   ```ts
   export function recordAdoptedTransition(gate: PromoteGate, notice: PromotionNoticeV1 | DemotionNoticeV1): void {
   	const key = noticeTransitionKey(notice);
   	const held = gate.transitions.get(key);
   	if (held === undefined || notice.effectiveAt > held.effectiveAt) {
   		gate.transitions.set(key, { effectiveAt: notice.effectiveAt, promoted: !("parentCohortCoord" in notice) });
   	}
   }
   ```

5. **`handleInboundNotice` stale gate** (~2891-2908): replace the `waterKey` build + `highWater.get`
   with `gate.transitions.get(noticeTransitionKey(inbound.notice))`, compare `effectiveAt`; on
   `"applied"` call `recordAdoptedTransition(gate, inbound.notice)` (keeps the advance-only-on-applied
   rule). Update the surrounding comments, the big function doc block (~2819-2855, pipeline diagram says
   "effectiveAt high-water"), the `"stale"` entry in the `InboundNoticeResult` doc (~2616), and the log
   message wording.

6. **`broadcastNotice`** (~753): first line `recordAdoptedTransition(promoteGate, notice);` before the
   fan-out loop. `promoteGate` is declared at ~794, AFTER this closure — that is fine and has precedent:
   the ctx literal's `onCertPublished` captures `verifier` declared below it, with an explanatory
   comment (~825-827). Add the same style of note. Comment content: `broadcastOver` excludes self, so an
   originated notice never arrives inbound — this is the ONLY write for locally-originated transitions;
   keyed off the notice's own `cohortCoord` only (the parent coord a demotion also fans to is
   deliberately outside this ordering — the parent-unlink is ordered by the child registry's per-child
   `lastEffectiveAt`).

7. **`CoordEngineContext`** — add optional narrow reader:
   ```ts
   readonly adoptedTransition?: (coord: RingCoord, tier: number, topicId: Uint8Array) => AdoptedTransition | undefined;
   ```
   Wire it **unconditionally** in the ctx literal (~796-844) — key-less hosts also adopt inbound
   verified notices, and the anti-DoS regression test below runs key-less:
   ```ts
   adoptedTransition: (coord, tier, topicId) =>
   	promoteGate.transitions.get(transitionKey(bytesToB64url(coord), tier, bytesToB64url(topicId))),
   ```

8. **`createCoordEngine`** `createPromotionLifecycle` deps (~1980-2002) — add:
   ```ts
   seedTransition: (topicId: Uint8Array) => ctx.adoptedTransition?.(servedCoord, treeTier, topicId),
   ```

9. **Doc fixes**: `CohortTopicHost.promoteGate` doc (~551-556, says "per-(topic, tier) … high-water");
   host comment ~790-794 (same phrase); `applyDemotionUnlinkAtParent` doc "high-water" wording (~2783-2787,
   content stays true — only rename terms).

### db-core `promotion.ts`

10. **`PromotionDeps.seedTransition?`** — exactly the ticket's signature (inline structural type; db-core
    cannot import `AdoptedTransition` from db-p2p — dependency direction):
    ```ts
    seedTransition?: (topicId: Uint8Array) => { readonly effectiveAt: number; readonly promoted: boolean } | undefined;
    ```

11. **`stateFor(topicId)` → `stateFor(topicId, now)`** (~393). On first creation, if
    `seed = deps.seedTransition?.(topicId)` is defined: set `lastEffectiveAt = seed.effectiveAt`,
    `promoted = seed.promoted`, and when `seed.promoted` also `promotedAt = now` (document: the
    sticky-window anchor is unrecoverable; re-arming delays demotion, never allows an early one).
    `lowLoadSince` stays undefined (rebuilt on next `onParticipantCountChange`) — say so at the site.
    Three call sites all have `now` in scope: `onParticipantCountChange`, `applyPromotionNotice`,
    `applyDemotionNotice` (rename its `_now` → `now`).

12. **`isPromoted` seed peek** (~231) — REQUIRED for the headline regression test: nothing calls
    `stateFor` on a freshly recreated engine before `isPromoted` is read, and `isPromoted` cannot create
    state (no `now` to arm `promotedAt`, and leaving `promotedAt` undefined while promoted would skip the
    sticky gate → early demotion). So:
    ```ts
    isPromoted(topicId) {
    	const state = this.states.get(bytesKey(topicId));
    	if (state !== undefined) return state.promoted;
    	return this.deps.seedTransition?.(topicId)?.promoted ?? false;
    }
    ```
    In-engine state wins when present (it was itself seed-initialized, so divergence means a newer
    transition landed). Document why the peek exists.

13. **Doc updates**: `PromotionState.lastEffectiveAt` (94-110) — no longer "the" durable anchor; it is
    the in-engine layer seeded from the node-level adopted-transition record (db-p2p's promote gate
    `transitions` map). Soften `hasAdoptedState`'s "a transition it cannot rebuild" (~177-180 and the
    census comment ~249-258 in promotion.spec.ts): the node-level record now backstops it; ranking is a
    preference, not the safety mechanism. Module header §Remote apply path (~35-44) can stay; add one
    sentence naming the seed.

### Tests

14. **`promote-notice.spec.ts`** — mechanical rename (`highWater`→`transitions`,
    `PROMOTE_HIGHWATER_MAX_KEYS`→`PROMOTE_TRANSITIONS_MAX_KEYS`); the cap test (~549) sets values
    directly — change to `{ effectiveAt, promoted: true }` objects. Rewrite the ~563 test's comment
    (assertions unchanged — no engine is evicted there): the MAP is the authority, the engine is the
    same-process second layer. The forged-flood test (~595) needs only the rename. Add:
    - `recordAdoptedTransition` unit tests: monotonic per key (older/equal effectiveAt does not
      overwrite), direction recorded (promotion→true, demotion→false), demotion keys off `notice.tier`.
    - **Two topics, one (coord, tier)**: apply a notice for topic A via `handleInboundNotice`
      (trust-all verifier pattern already in file at ~317), then a topic-B notice at the same coord with
      `effectiveAt <=` A's — must be `"applied"`, not `"stale"` (this FAILS on today's key; it is the
      key-conflation fix's proof). Build a topic-parameterized variant of `promotionNoticeAtCoord`.
    - Existing parent-unlink replay test (~704-733) must stay green (same topic, so key change is
      invisible to it).

15. **`host-antidos-coldstart.spec.ts`**, in the `coord-engine registry cap` describe — the headline
    regression test. The harness is key-less; adopt via `handleInboundNotice` with a local trust-all
    verifier (copy the ~5-line stub from promote-notice.spec.ts) so the map gets written — the real
    `host.registry` satisfies the registry param and `host.promoteGate` the gate param; the existing
    `promoNoticeFor` helper (~772) builds the notice (needs `signers: [<any b64>]`? — current helper uses
    `signers: []`; `handleInboundNotice` maps signers before verify, empty array maps fine, and trust-all
    verifier accepts). Sequence, cap = 2:
    1. `forCoord(A)`; adopt promotion for topic T at A (effectiveAt 10_000) through `handleInboundNotice`
       → `"applied"`, engine promoted, map written.
    2. `forCoord(B)`; `B.recordChild(...)` → B is rank-1 too (prereq landed: promotion-holders are
       rank-1, so a rank-0 spray alone will NEVER evict A — B must match rank and out-recency it).
    3. `forCoord(C)` → evicts A (rank-1, older recency than B). Assert `findByCoord(A) === undefined`.
    4. `forCoord(A)` again → recreates (evicts C, the rank-0). Assert
       `engine.isPromoted(T) === true` (survives with NO replay — the second arm of the bug), then
       replay the SAME/older notice through `handleInboundNotice` → `"stale"`, state unchanged.

16. **`live-tier.spec.ts` test 4** (~173, real keys, real local promotion on `deciding`): after the
    existing `waitFor(decidingEngine.isPromoted)` add a `waitFor` on
    `deciding.host.promoteGate.transitions.get(transitionKey(bytesToB64url(coord0), 0, bytesToB64url(TOPIC)))`
    being defined with `promoted === true` — proves the origination path (host `broadcastNotice`) writes
    the map on a real node (self-exclusion means nothing else can have). `waitFor`, not direct read:
    `onNotice` fires after the threshold-sign resolves.

17. **`promotion.spec.ts` (db-core)** — `lifecycleWith` gains an optional `seed` param feeding
    `deps.seedTransition`. Tests:
    - seeded `{effectiveAt: 200, promoted: true}` → `isPromoted` true with zero prior calls (the peek);
    - seeded promoted + `onParticipantCountChange(t0)` then `maybeDemote` inside `t0 + sticky` window
      with low count → undefined (promotedAt re-armed at seed);
    - seeded `{effectiveAt: 200, promoted: false}` → `applyPromotionNotice(effectiveAt 100)` is a no-op
      (ordering does the rejecting, not direction);
    - no seed / seed returning undefined → behavior identical to today (existing suite is the guard).

### Validation

- `yarn workspace @optimystic/db-core test` and `yarn workspace @optimystic/db-p2p test` (inner loop:
  `--grep "promot"`), `yarn build` + `yarn typecheck` from root. Foreground, no redirection.

## Original problem statement (unchanged)

Cohort-topic groups split when busy, merge when quiet; each transition is a threshold-signed
`PromotionNoticeV1`/`DemotionNoticeV1` stamped `effectiveAt`. Signatures never expire — ordering is the
only replay defense. Two anchors each cite the other as backstop: the node-level `PromoteGate.highWater`
(written ONLY on verified inbound applies) and the engine-level `PromotionState.lastEffectiveAt`
(documented "never cleared" but living in a `CoordEngine` the registry evicts under memory pressure).

Reachable failure: `broadcastOver` excludes self, so a node that ORIGINATES transitions never writes its
own water. Originate promote@100 then demote@200; topic drains; engine evicted (memory pressure or coord
spray — served coord hashes attacker-chosen inputs); engine recreated by any traffic; anyone replays the
captured promote@100 → no water, signature verifies, fresh engine has `lastEffectiveAt === undefined` →
adopts `promoted = true`. Node redirects registrations to a child tier that was demoted away. Second,
attacker-free arm: eviction discards a CORRECT `promoted = true`; recreated engine over-admits at tier d
against an already-split tree — so the fix must restore direction, not just the timestamp. The prereq
(landed, in review) only makes such engines last-evicted; it does not make the anchor durable.

Root cause: the node's record of adopted transitions lives only in an object whose lifetime is a
memory-pressure decision; the structure that DOES outlive engines is scoped as an inbound-only
optimisation, missing local originations and storing no direction.

Fix: promote the gate map to the node's record — store `{effectiveAt, promoted}`, key
`` `${cohortCoord}|${tier}|${topicId}` `` (today's key conflates topics at one coord: an applied notice
for topic A stale-drops topic B), write on BOTH adopt paths, seed a freshly created engine's per-topic
state from it (one-way: map → engine). Correct the two wrong-reasoning comments (`host.ts`
PromoteGate doc; `promote-notice.spec.ts` ~563).

## Edge cases to preserve (from original — all covered by the test plan above)

- Replay after eviction+recreation → `"stale"`, state unchanged (test 15).
- Correct `promoted = true` survives eviction with no replay (test 15 step 4).
- Locally-originated transitions write the map (test 16).
- Two topics at one coord: independent orderings (test 14).
- Two sibling cohorts for one `(topic, tier)`: coord stays in the key (existing test ~486 renamed).
- Forged notices write nothing (existing test ~595 renamed).
- Map LRU eviction beyond cap (existing test ~549 against new value type).
- Parent-unlink stays outside this ordering — `"unlinked"` must not regress to `"stale"` (existing ~704).
- Seeded demotion still rejects stale promotion replay (test 17).
- Key-less composition: `seedTransition`/`adoptedTransition` optional; anti-DoS harness is key-less and
  must work (test 15 relies on it).
- Prereq interaction: promotion-holders are rank-1 — eviction in tests must be forced via a rank-1
  companion, never assumed (test 15 step 2).
