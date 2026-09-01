description: When a node runs low on memory it throws away the least-useful of its small in-memory working sets, but its test for "useless" only checked one of the four things such a working set can hold. The code fix has landed; what remains is the test suite, two documentation passages, and a full build/test validation run.
files:
  - packages/db-p2p/src/cohort-topic/host.ts                            # DONE — EngineStateKind/EngineLiveness (~338), CoordEngine.liveness (~370), EVICTION_RANK + evictOne (~1390-1505), onEngineEvicted wiring (~815-820), engine liveness impl (~2190)
  - packages/db-core/src/cohort-topic/promotion.ts                      # DONE — PromotionLifecycle.hasAdoptedState (iface ~175, impl ~240)
  - packages/db-core/src/cohort-topic/membership/verifier.ts            # DONE — MembershipVerifier.forget (iface ~78, impl ~215)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts    # TODO — new tests in "coord-engine registry cap" describe (~650)
  - packages/db-core/test/cohort-topic/promotion.spec.ts                # TODO — hasAdoptedState unit tests
  - packages/db-core/test/cohort-topic/membership.spec.ts               # TODO — forget releases the trust-lock unit test
  - docs/cohort-topic.md                                                # TODO — stale eviction passages at ~813-821 and ~1007-1010
difficulty: medium
repro: verified
----

# Coord-engine eviction: rank-based liveness — CONTINUATION (code landed, tests + docs remain)

A prior run implemented the full source-code fix for this ticket and ran out of budget before
writing tests and docs. **Do not re-derive the design — it is implemented.** Read the original
analysis in `tickets/complete/` history if needed; the short version and exact remaining work are
below.

## What the bug was

`createCoordRegistry`'s eviction predicate (`isIdle` = no records && no forwarders) covered only two
of the four state classes a `CoordEngine` owns, so an engine holding only linked child cohorts or
adopted promotion state was evicted as "idle", silently zeroing `childCohortCount` and forgetting
`promoted`. Separately, the eviction path's stated safety claim ("an idle engine never published a
membership cert, so no verifier trust-lock to drop") was false — on a keyed node `pumpMembership`
runs for *every* engine — so eviction could strand a verifier trust-lock.

## What is ALREADY IMPLEMENTED (verify, don't redo)

All in the current working tree, uncommitted by this ticket's prior run:

- `packages/db-p2p/src/cohort-topic/host.ts`:
  - `EngineStateKind = "records" | "forwarders" | "children" | "promotion"` and
    `EngineLiveness = Readonly<Record<EngineStateKind, boolean>>`, both exported, declared just
    above the `CoordEngine` interface.
  - `CoordEngine.liveness(): EngineLiveness` added; `hasState()` / `hasForwarders()` kept but now
    derive from `liveness()` in the engine return object (single census, cannot drift).
  - Exported `EVICTION_RANK: Record<EngineStateKind, "pinned" | number>` =
    `{ records: "pinned", forwarders: "pinned", children: 1, promotion: 1 }`, with the full
    rationale comment (why children/promotion are ranked, not pinned: pinning would let a key-less
    child-link spray make every slot un-evictable → `CoordEngineRegistryFullError` for legitimate
    coords).
  - `isIdle`/`evictOneIdle` replaced by `evictionRank(engine)` (`undefined` = pinned, else max rank
    over held kinds, 0 if nothing held) and `evictOne()` with a `(rank, recency)` lexicographic
    victim pick. Teardown unchanged (`close()` + `recency.delete`), and `evictOne` now fires
    `ctx.onEngineEvicted?.(victim.servedCoord)` for every victim.
  - `CoordEngineContext.onEngineEvicted?: (coord: RingCoord) => void` added; host wires it to
    `verifier.forget(bytesToB64url(coord))` (unconditional — no "did it publish" tracking).
  - Both stale "no records → never published a cert" NOTEs rewritten (at the `onCertPublished`
    wiring and at the eviction path); related doc comments updated (`coordEnginesMax`,
    `CoordRegistry.forCoord`, `createCoordRegistry`, cold-sibling block).
  - Engine `liveness()` impl: `records` from `store.listAll().length > 0`, `forwarders` from
    `coldStart.hasForwarders()`, `children` from `childRegistry.linkedChildren().length > 0`
    (linked set — tombstones excluded), `promotion` from `promotion.hasAdoptedState()`.
- `packages/db-core/src/cohort-topic/promotion.ts`: `PromotionLifecycle.hasAdoptedState()` — true
  iff any topic state has `promoted === true` or `lastEffectiveAt !== undefined` (growth samples /
  `lowLoadSince` deliberately excluded — they rebuild from the store).
- `packages/db-core/src/cohort-topic/membership/verifier.ts`: `MembershipVerifier.forget(cohortCoord:
  string)` — deletes `byCoord` entry + `staleGapStrikes`; **keeps `lastFetchAt` on purpose** (it is
  anti-amplification state, so a forget cannot reset a flood-exposed coord's refetch budget).
- Test fakes updated for the widened interface: `promote-notice.spec.ts` (two literal verifiers),
  `reactivity/managers.spec.ts` (`FixedVerifier`). `cohort-topic/service.spec.ts`'s fake is cast
  `as unknown as MembershipVerifier` and needs nothing.

Known state: IDE diagnostics in db-p2p specs referencing `forget` on `MembershipVerifier` come from
**stale `db-core` dist typings** — build `db-core` first and they clear. No source-level
inconsistency was left behind.

## TODO (the remaining work)

- Tests in `packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts`, inside the existing
  `coord-engine registry cap` describe (~line 650; its harness builds key-less hosts with a small
  `coordEnginesMax` and drives `host.registry.forCoord` / `findByCoord` directly — see the existing
  four tests there for the pattern, incl. `topicAt(i)` for distinct coords):
  - *a child-holding engine is evicted only after every childless one*: cap `N`, create `N` engines,
    `recordChild` on the oldest, spray new coords; the child-holder survives (rank 1 vs rank 0),
    every original childless engine is reclaimed, and its `childCohortCount` is still `1`. Note the
    freshly-sprayed engines are themselves rank-0 candidates, so after the originals are consumed
    the spray eats its own tail — the child-holder still survives.
  - *a promotion-holding engine outranks a cold one*: same shape, using
    `ce.applyPromotionNotice(notice, now)` (no key needed; build a full `PromotionNoticeV1` literal —
    only `topicId`/`effectiveAt` are consumed by the lifecycle) — assert it survives and
    `isPromoted(topic)` is still true.
  - *a child-link spray cannot refuse a legitimate coord*: fill the cap with engines each holding one
    recorded child (all rank 1), create one more coord; assert no `CoordEngineRegistryFullError`,
    the new coord resolves, and `host.registry.all().length` is still exactly the cap.
  - *eviction forgets the trust-lock*: `host.service.verifier()` returns the SAME verifier instance
    the host wires (`service.spec` pattern) — monkey-patch `forget` on it to record calls
    (instance-property shadowing works; the wiring reads `verifier.forget` at call time), spray past
    the cap, assert `forget` was called with the evicted coord's `bytesToB64url` key.
  - *exhaustiveness guard*: assert `Object.keys(EVICTION_RANK).sort()` deep-equals
    `Object.keys(engine.liveness()).sort()` for a real engine — catches a new `EngineStateKind`
    added to the liveness record but not the rank table where TS's `Record` check cannot.
  - The existing tests (full-of-pinned refuses at ~712, clean `unwilling_cohort` at ~739, hot-engine
    survival at ~690) must stay green unchanged — the hot-engine test's engines are all rank 0, so
    rank-before-recency does not disturb it.
- db-core unit tests:
  - `promotion.spec.ts`: `hasAdoptedState()` — false when empty; false after
    `onParticipantCountChange` below every trigger (growth samples only); true after a promote /
    `applyPromotionNotice`; still true after `applyDemotionNotice` (the `lastEffectiveAt` high-water
    survives demotion by design).
  - `membership.spec.ts`: `forget()` — cache a trusted cert (trust-locks the coord), show an
    un-anchored refetched cert is rejected (`untrusted` message), then `forget(coordKey)` and show
    the same refetch now TOFU-accepts (`verified`). The `MockSource`/`buildCert` harness at the top
    of the file has everything needed; coord key is `bytesToB64url(COORD)`.
- `docs/cohort-topic.md`: two stale passages describing eviction as "idle engines (no records, no
  cold-start forwarder)":
  - ~813-821 (the "Cost (tripwires)" block): also delete/replace the now-false sentence "Eviction is
    idle-only, so it never strands a verifier trust-lock (an idle engine never published a cert)" —
    replace with the rank order (records/forwarders pinned; child-/promotion-holding engines rank 1,
    evicted only after rank-0; ties by LRU), why child links are *ranked not pinned* (key-less spray
    would otherwise pin all slots), and that eviction now drops the verifier trust-lock via
    `verifier.forget`.
  - ~1007-1010 ("hard-capped … with LRU eviction of idle engines"): same correction, briefer.
- Validation (in this order — db-p2p typecheck needs fresh db-core dist):
  `yarn workspace @optimystic/db-core build`, then root `yarn build` + `yarn typecheck`, then
  `yarn workspace @optimystic/db-core test` and `yarn workspace @optimystic/db-p2p test`
  (inner loop: `yarn test -- --grep "registry cap"`).
- Then write the review/ handoff for the WHOLE ticket (code + tests) and delete this file. Flag in
  the handoff: `hasState()` now allocates via the full `liveness()` census per call (was a bare
  `store.listAll()` check) — same asymptotics, worth a reviewer's glance at call-site frequency.
