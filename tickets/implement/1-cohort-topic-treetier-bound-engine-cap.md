description: A malformed registration can crash the remote handler, and a single peer can force the node to create unlimited per-location engines (each with its own memory) before any anti-abuse check runs; add a range check on the wire field and a hard cap on the engine registry.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts        # RegisterV1: treeTier validated only as finite number (L193); tier() helper L138 is the pattern
  - packages/db-core/src/cohort-topic/dmax.ts                  # DEFAULT_D_MAX_CAP = 60 (L31); re-exported via cohort-topic/index.ts
  - packages/db-core/src/cohort-topic/addressing.ts            # coordD throws RangeError for non-int / <1 / >255 (L88-102)
  - packages/db-p2p/src/cohort-topic/host.ts                   # dispatchRegister L915-935 (forCoord before gate); createCoordRegistry L1281-1324; CoordEngine.close() L437
  - packages/db-core/src/utility/lru-map.ts                    # LruMap — no eviction callback (L23-34)
  - packages/db-core/test/cohort-topic/wire.spec.ts            # RegisterV1 validation tests; gossip treeTier tests L344-353 are the pattern
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts   # host anti-DoS test home
difficulty: medium
----

# Bound `RegisterV1.treeTier` at the wire layer + hard-cap the per-coord engine registry

## Background — what's actually wrong

Two defects, one root registration path. Both confirmed by reading the code.

### Defect 1 — remote crash on an out-of-range `treeTier`

`validateRegisterV1` (`wire/validate.ts:193`) accepts `treeTier` via `reqFiniteNumber`, which only
checks `typeof === "number" && Number.isFinite`. No integer or range check — unlike the sibling
`RegisterV1.tier`, which goes through the `tier()` helper (`validate.ts:138`, clamps to an integer
`0..3`), and unlike `CohortGossipV1.treeTier`, which is already checked as a non-negative integer
(`validate.ts:472-475`).

A `treeTier` of `2.5`, `-1`, or `300` therefore passes wire validation and reaches
`addressing.coord(reg.treeTier, ...)` in `dispatchRegister` (`host.ts:921`). `HashTierAddressing.coordD`
(`addressing.ts:88-94`) throws a `RangeError` for a non-integer `d`, `d < 1`, or `d > 255`. That throw
escapes the register dispatch as an unclassified exception rather than a clean `CohortWireError`
malformed-frame rejection.

(`treeTier: 0` dispatches to `coord0`, which ignores the tier, so only non-integer / negative / `>255`
crash today — but the fix is a positive range check, not an enumeration of the crashing values.)

### Defect 2 — unbounded, attacker-keyed engine creation (the serious one)

`dispatchRegister` calls `registry.forCoord(servedCoord, ...)` (`host.ts:922`) **before**
`coordEngine.engine.handleRegister(...)` (`host.ts:934`) — and `handleRegister` is where the per-coord
anti-DoS gates (rate limiter, replay guard, topic budget) run. `createCoordRegistry`
(`host.ts:1281-1324`) is a plain `Map<servedCoord, CoordEngine>` with compute-if-absent and **no cap and
no eviction** (see the existing `NOTE`s at `host.ts:796-798` and `host.ts:764-771`, and
`docs/cohort-topic.md:795`).

Each engine owns its own store, gossip bus, rate limiter, replay guard, topic budget, promotion
lifecycle, member engine, cert publisher, and threshold signer — real per-engine memory. The served
coord is `addressing.coord(treeTier, participantCoord, topicId)`: a hash over attacker-chosen inputs. So
one peer that sprays distinct valid `(treeTier, topicId)` pairs (or distinct `participantCoord` at
`d >= 1`) forces the node to allocate an unbounded number of engines, and the allocation happens before
any rate-limit / budget check can reject the register. Defect 1's range check shrinks the `treeTier`
axis but does **not** fix this — `topicId` alone is an unbounded axis.

## Expected behavior

- **Wire:** `validateRegisterV1` rejects a `treeTier` that is not an integer in `0..DEFAULT_D_MAX_CAP`
  (60), throwing `CohortWireError` — the same class every other malformed-frame rejection uses — so an
  out-of-range value never reaches `addressing.coord()`. Use `DEFAULT_D_MAX_CAP` from `../dmax.js`
  (do not hard-code 60). Add an analogous helper to the existing `tier()` (`validate.ts:138`); keep the
  `followOn`/`bootstrap` cross-field checks (`validate.ts:220`) intact.
- **Host:** the per-coord engine registry is bounded by a hard cap with LRU eviction of **idle** engines.
  Engine creation can no longer be driven unbounded by attacker-chosen coords. An evicted engine must be
  torn down cleanly — at minimum `engine.close()` (tears down the gossip subscription; `host.ts:437`), so
  eviction does not leak the gossip bus subscription.

## Design notes / decisions to make

**Wire bound value.** The ticket specifies `0..DEFAULT_D_MAX_CAP` (60), matching the review doc
(`docs/review.html:380`). `coordD` itself tolerates up to 255, but `d_max` is the walk start tier and 60
is the substrate's own hard ceiling on useful depth, so 60 is the right semantic bound for a register —
a `treeTier` above `d_max` cannot correspond to a real walk position. Keep the wire check at
`DEFAULT_D_MAX_CAP`.

**What "idle" means for eviction.** `LruMap` (`utility/lru-map.ts`) evicts silently with no callback, so
the registry cannot simply swap its `Map` for an `LruMap` — it must run its own eviction so it can call
`close()` on the victim. More importantly, **do not evict an engine that holds live state**: an engine
with `hasState() === true`, a live forwarder (`forwarder(topicId)`), or that is mid-serving a real cohort
is not a throwaway. Evicting it would drop genuine registration records / cold-start forwarder state and
could strand the verifier trust-lock (see the tripwire below). Prefer evicting only engines that are
idle (no resident records, no forwarder). Decide the policy:

  - Simplest correct option: cap the map; on overflow evict the least-recently-touched engine **whose
    `hasState()` is false and that holds no forwarder**; if no idle engine exists (every slot is a live
    cohort), do not evict — instead reject the new `forCoord` for that register (surface it to the
    caller as a capacity refusal, mirroring how the topic budget refuses). This keeps a legitimate
    multi-cohort node working while capping attacker-driven cold engines.
  - Track "recently used" on `forCoord`/`findByCoord`/`findServing`/`findHolder` touches so a hot engine
    is not evicted under load.

  Pick one, document the tradeoff in the review handoff. The cap should be a named constant with a sane
  default (align with the existing anti-DoS defaults — e.g. the topic-budget `topics_max = 2048` order of
  magnitude — and make it tunable, ideally via `CohortTopicAntiDosOptions`).

**Registry API.** `forCoord` currently always returns a `CoordEngine`. If the cap can refuse creation,
its signature/return must express that (return `undefined`, or throw a typed capacity error) and both
call sites — `dispatchRegister` (`host.ts:922`) and `childLinkDeps.resolveParent` (`host.ts:972`), plus
`maybeInstantiateColdSibling` (`host.ts:821`) — must handle a refusal without crashing (turn it into a
clean reply / drop, not an unhandled throw). The gossip-instantiated cold-sibling path (`host.ts:799-822`)
is itself an unbounded-per-co-member-coord creation site the same cap now covers — make sure it routes
through the same capped creation.

## Tripwires (record, do NOT file as tickets)

- **Verifier trust-lock on eviction.** `host.ts:764-772` (`onCertPublished` → `verifier.cache`) documents
  that evicting/reclaiming an engine that had published a cert should also drop the verifier's trust-lock
  for that coord (`verifier.forget(coord)` / downgrade), which does not exist yet. Engine eviction is
  exactly the "engine reclaim" that NOTE was waiting on. If you only evict **idle** engines (`hasState()
  === false`, never published a cert) you sidestep this; if the policy ever evicts an engine that
  published a cert, the stale trust-lock reappears. Leave a `NOTE:` at the eviction site stating this, and
  index it in the review findings. Do not build `verifier.forget` in this ticket unless eviction of
  cert-publishing engines is unavoidable.
- **Cold-sibling permanence.** The existing `NOTE` at `host.ts:796-798` (gossip-instantiated engines never
  reclaimed) is resolved-in-passing by this cap; update or remove that NOTE to reflect the new bound
  rather than leaving a now-stale comment.

## TODO

**Phase 1 — wire validation (db-core)**
- Add a `treeTier(value, what)` helper in `wire/validate.ts` (mirror `tier()` at L138) that requires an
  integer in `0..DEFAULT_D_MAX_CAP`, importing `DEFAULT_D_MAX_CAP` from `../dmax.js`.
- Apply it at `validate.ts:193` (`treeTier: treeTier(reqFiniteNumber(obj, "treeTier", what), what)`).
  Confirm the `followOn`/`bootstrap` cross-field logic at L220 still reads `out.treeTier` correctly.
- Add tests to `packages/db-core/test/cohort-topic/wire.spec.ts` in the RegisterV1 block: reject
  `treeTier: 2.5`, `-1`, `300`; accept `0` and `DEFAULT_D_MAX_CAP`. Mirror the gossip treeTier tests at
  L344-353.

**Phase 2 — host registry cap (db-p2p)**
- Add a hard-cap + idle-LRU-eviction policy to `createCoordRegistry` (`host.ts:1281-1324`): named-constant
  default cap, tunable via `CohortTopicAntiDosOptions`; touch-tracking on lookups; evict only idle engines
  and `close()` the victim; refuse creation cleanly when every slot is a live cohort.
- Thread the refusal through `dispatchRegister` (`host.ts:922`), `resolveParent` (`host.ts:972`), and
  `maybeInstantiateColdSibling` (`host.ts:821`) so a refusal is a clean reply/drop, never an unhandled
  throw.
- Add a `NOTE:` at the eviction site for the verifier trust-lock tripwire; update the now-stale
  `host.ts:796-798` cold-sibling NOTE.
- Add a host test (extend `host-antidos-coldstart.spec.ts` or add a sibling): spraying many distinct
  `(treeTier, topicId)` registers from one peer keeps `registry.all().length` at or below the cap, and
  the evicted engines are `close()`d; a legitimate multi-cohort node below the cap is unaffected.

**Phase 3 — validate**
- `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/dbcore-test.log` (wire.spec).
- `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/dbp2p-test.log` (host anti-DoS + scale specs).
- Type-check both packages. Stream output (`| tee`), never silent redirect.
