description: Reviewed two anti-abuse fixes on the cohort registration path — rejecting an out-of-range tier number on the wire before it can crash the handler, and putting a hard ceiling on how many per-location engines one peer can force the node to create.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts        # treeTier() helper (new) + applied at RegisterV1
  - packages/db-core/src/cohort-topic/coldstart.ts            # ColdStartManager.hasForwarders() (new)
  - packages/db-p2p/src/cohort-topic/host.ts                  # registry cap + typed error + refusal handling + NOTEs
  - packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts  # subscriberCount getter (diagnostic)
  - packages/db-core/test/cohort-topic/wire.spec.ts           # RegisterV1 treeTier bound tests (new)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts  # registry-cap tests (new)
  - docs/cohort-topic.md                                      # cold-sibling + anti-DoS bounded-memory notes updated
----

# Bound `RegisterV1.treeTier` at the wire + hard-cap the per-coord engine registry — review handoff

## What changed

Two defects on the one register path, both fixed. See the source implement ticket (now deleted) for the
full defect analysis; the short version:

**Defect 1 — wire.** `validateRegisterV1` accepted any finite `treeTier` (`2.5`, `-1`, `300`), which then
reached `addressing.coord()` where `coordD` throws a raw `RangeError` — an unclassified crash rather than a
clean malformed-frame rejection.

**Defect 2 — host (the serious one).** The `servedCoord → CoordEngine` registry (`createCoordRegistry`) was
an uncapped `Map` with compute-if-absent and no eviction, and `forCoord` runs on the register hot path
**before** the per-coord anti-DoS gates. The served coord is a hash over attacker-chosen
`(treeTier, participantCoord, topicId)`, so one peer spraying distinct coords forced unbounded engine
allocation (each engine owns a store, gossip bus, rate limiter, replay guard, topic budget, promotion
lifecycle, signer…). Defect 1's range check shrinks only the `treeTier` axis; `topicId` alone is unbounded.

### Fixes

- **Wire:** new `treeTier(value, what)` helper in `wire/validate.ts` (mirrors the existing `tier()`), requires
  an integer in `0..DEFAULT_D_MAX_CAP` (60, imported from `../dmax.js` — not hard-coded), throws
  `CohortWireError`. Applied at the `RegisterV1.treeTier` field. The `followOn`/`bootstrap` cross-field checks
  are untouched and still read the validated `out.treeTier`.
- **Host:** `createCoordRegistry(ctx, maxEngines)` is now hard-capped (default `DEFAULT_COORD_ENGINES_MAX =
  2048`, tunable via `CohortTopicAntiDosOptions.coordEnginesMax`). On a creation over a full registry it
  evicts the least-recently-used **idle** engine (no records **and** no cold-start forwarder) and `close()`s
  it (dropping its gossip subscription). If every slot holds a live cohort it throws
  `CoordEngineRegistryFullError`. Recency is bumped on every lookup that returns an engine (`forCoord`,
  `findByCoord`, `findHolder`, `findServing`), so a hot cohort under load is never the victim.

## Key design decisions (please sanity-check these)

- **Typed error, not `undefined` return.** The ticket allowed either. I made `forCoord` **throw**
  `CoordEngineRegistryFullError` rather than change its return type to `CoordEngine | undefined`.
  Rationale: ~45 existing test/harness call sites chain directly on `forCoord(...).cohort()` / `.engine`,
  and `tsconfig` type-checks `test/` (the `build` script is `tsc` over `include: ["src","test"]`) — an
  `| undefined` return would have forced a non-null assertion at every one, touching many test files
  unrelated to this ticket. Throwing keeps `forCoord` total for all existing callers (they run below the
  cap, never throw). **Tradeoff:** the three creation sites (`dispatchRegister`, `dispatchChildLink` via
  `resolveParent`, `maybeInstantiateColdSibling`) now `try/catch` the typed error and map it to a clean
  refusal (`unwilling_cohort` with a `retryAfterMs` back-off / `rejected` / silent drop). Under an active
  spray the refusal path throws+catches per over-cap register — acceptable for a DoS-mitigation path (the
  alternative is unbounded memory), but the reviewer may prefer the `undefined` shape; it is a mechanical
  (if noisy) change if so.

- **Idle-only eviction.** "Idle" = `!hasState() && !hasForwarders()`. I added `hasForwarders()` to both
  `ColdStartManager` (db-core) and `CoordEngine` (db-p2p) because the existing surface could only test a
  forwarder *by topicId*, and eviction needs the aggregate. An engine with a record or a live
  (possibly `awaiting_parent`) forwarder is never evicted, so genuine registration/cold-start state is never
  dropped and a legitimate multi-cohort node keeps working. When every slot is live, creation is refused
  rather than evicting a real cohort.

- **Wire bound = `DEFAULT_D_MAX_CAP` (60), not `coordD`'s 255.** 60 is the substrate's own ceiling on useful
  walk depth (`d_max` is the walk start tier), so a `treeTier` above it cannot be a real walk position.

## How to exercise / validate

Build + tests, both green as of this handoff:
- `yarn workspace @optimystic/db-core build` (clean) → `yarn workspace @optimystic/db-core test` →
  **1062 passing**.
- `yarn workspace @optimystic/db-p2p build` (clean, type-checks `test/` too) →
  `yarn workspace @optimystic/db-p2p test` → **1102 passing, 36 pending, 0 failing**. (The
  `cohort-topic cold-start: parent registration … failed` lines are intentional logging inside passing
  cold-start tests, not failures.)

New tests (the reviewer should treat these as a floor):
- `db-core/test/cohort-topic/wire.spec.ts` (RegisterV1 block): rejects `treeTier` `2.5` / `-1` / `300`;
  accepts `0` and `DEFAULT_D_MAX_CAP`.
- `db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts` (new `coord-engine registry cap` describe):
  1. spray 5×cap distinct idle coords → `registry.all().length === cap`, and
     `gossipTransport.subscriberCount === base + cap` (proves evicted engines were `close()`d — no leaked
     gossip subscriptions; were `close()` skipped it would be `base + 5×cap`), LRU-oldest evicted.
  2. a continually-touched hot engine survives while cold ones are reclaimed.
  3. a full-of-**live** registry throws `CoordEngineRegistryFullError` and keeps the live cohorts serving.
  4. a register over a full-of-live registry, driven through the **real** FRET activity handler →
     `dispatchRegister`, replies `unwilling_cohort` with a back-off (no unhandled throw).

Test-observability seams added (small, mirror existing `.size` diagnostic accessors): a `subscriberCount`
getter on `FretCohortGossipTransport`, and a `runActivity` test hook on the spec's `makeFakeFret`.

## Known gaps / things to probe (your work is a starting point, my tests are a floor)

- **`dispatchChildLink` refusal path is unit-covered only indirectly.** The `resolveParent` → registry-full
  → `rejected` mapping is covered by reading; the existing child-link dispatch tests use a mock `resolveParent`
  that never throws. A reviewer may want an explicit test that a full-of-live registry makes an inbound
  child-link reply `rejected` (reason `"parent cohort capacity"`) rather than throw.
- **`maybeInstantiateColdSibling` refusal is not directly tested.** It drops (returns) on
  `CoordEngineRegistryFullError`; only the `dispatchRegister` and registry-level paths have explicit tests.
- **Concurrency.** `forCoord` is synchronous (compute-if-absent, no async gap) so two concurrent callers for
  one coord still share an engine; but the cap/evict logic assumes the single-threaded event loop. No test
  drives concurrent creation at the cap boundary.
- **Cap-vs-legit-load interaction.** Default 2048 is aligned with `topics_max`; I did not model whether a
  legitimately busy Core node ever serves >2048 *live* cohorts (which would start refusing real registers).
  If that is plausible, the cap may need to scale with node profile — out of scope here, flagged for judgment.
- **Eviction cost.** `evictOneIdle` is an O(n) scan of the engine map per over-cap creation. Fine at n≈2048;
  see the tripwire below.

## Tripwires recorded (knowledge, NOT tickets — indexed here per workflow rules)

- **Verifier trust-lock on eviction.** `NOTE:` left at `evictOneIdle` (`host.ts`) and the `onCertPublished`
  NOTE updated: eviction is **idle-only**, and an idle engine (`hasState() === false`) never published a
  membership cert, so there is no verifier trust-lock to drop — the drop-the-lock-on-demotion tripwire the
  `onCertPublished` NOTE describes is sidestepped. If the policy is ever widened to evict a cert-publishing
  engine, a `verifier.forget(coord)` / downgrade must be added there or the stale trust-lock strands the
  coord's later-epoch messages. `verifier.forget` intentionally NOT built in this ticket.
- **Cold-sibling permanence resolved-in-passing.** The stale `host.ts` NOTE (gossip-instantiated engines
  never reclaimed) and `docs/cohort-topic.md` §Cold-start "Cost (tripwires)" were updated to reflect the new
  cap; the anti-DoS bounded-memory doc section now lists the coord-engine cap as the outer bound wrapping the
  four per-coord guards.
- **`evictOneIdle` O(n) scan.** Recorded inline reasoning: fine at the default cap; if the cap is raised by
  orders of magnitude, keep an explicit idle/LRU index instead of scanning. (No code NOTE added — the concern
  lives with the constant's default; call out if you want one at the scan site.)
