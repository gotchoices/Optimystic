description: A node under memory pressure can throw away a small group's bookkeeping while treating it as empty, so the node briefly forgets that the group has sub-groups beneath it, tells searchers there is nothing more to look for, and forgets which recent instructions it has already carried out.
files:
  - packages/db-p2p/src/cohort-topic/host.ts   # isIdle (1389), evictOneIdle (1391-1417), hasState/hasForwarders (2117-2118), createChildRegistry (1606), createCoordEngine (1673+)
  - packages/db-core/src/cohort-topic/promotion.ts   # PromotionState (94-111): promoted/promotedAt/lowLoadSince/lastEffectiveAt; demotionTriggered gate (318-336)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts   # "coord-engine registry cap" describe (~650) — natural home for the regression test; key-less-permissive link test at ~599
difficulty: hard
repro: verified
----

# A cohort node's memory cap discards bookkeeping it treats as worthless

## Plain summary

Each node keeps a bounded number of small in-memory "cohorts" — one per point on the ring it is
responsible for, capped at 2048. When the cap is reached the node throws away the least-recently-used
cohort it judges *empty*. Its test for "empty" asks exactly one question: does this cohort hold any
participant registrations? A cohort holds more than that, and the rest is discarded silently.

## Confirmed state of the code (verified at HEAD, 2026-09-01)

The eviction predicate, `packages/db-p2p/src/cohort-topic/host.ts:1389`:

```ts
const isIdle = (engine: CoordEngine): boolean => !engine.hasState() && !engine.hasForwarders();
```

and its two inputs at `host.ts:2117-2118`:

```ts
hasState: (): boolean => store.listAll().length > 0,
hasForwarders: (): boolean => coldStart.hasForwarders(),
```

An engine created by `createCoordEngine` (`host.ts:1673`) owns **three** pieces of state, of which the
predicate covers one:

| Engine-owned state | Covered by `isIdle`? | Lost on eviction |
|---|---|---|
| Registration records (`store`) | yes (`hasState`) | — |
| Cold-start forwarders (`coldStart`) | yes (`hasForwarders`) | — |
| Linked child cohorts (`childRegistry`, `host.ts:1606`) | **no** | child set → empty |
| Promotion bookkeeping (`promotion`, `promotion.ts:94`) | **no** | `promoted`, `promotedAt`, `lowLoadSince`, `lastEffectiveAt` → undefined |

## What was observed

Reproduced directly against the existing `coord-engine registry cap` harness in
`host-antidos-coldstart.spec.ts` (probe since removed):

- Host with the engine cap set to 1.
- Create a cohort for a topic and record one child cohort under it (`recordChild`). No participant
  registers — normal for exactly the parent whose participants have all sharded down into its children.
- Engine reports `childCohortCount == 1`, but `hasState() == false` and `hasForwarders() == false`.
- Touch one other coord → the parent engine is evicted.
- Re-resolve the same coord → child count is back to `0`.

So a parent actively responsible for live children is classified as a throwaway cold coord.

## Three consequences, in descending urgency

**1. Matchmaking search escalation is immediately wrong.** Escalation treats `childCohortCount > 0` as
"there is a child tier worth sweeping". A seeker whose query lands on the just-evicted-and-recreated
member is told the topic is not promoted, skips the sweep, and fails to find peers that exist.

**2. Loss of the notice replay high-water mark opens a re-apply window.** `PromotionState.lastEffectiveAt`
(`promotion.ts:103-110`) is documented as "monotonic and **never cleared**" — it is the ordering anchor the
remote-apply path uses to reject a promotion/demotion notice whose `effectiveAt` is not strictly newer.
Eviction clears it anyway. A recreated engine will re-apply a stale or replayed notice it had already
adopted and correctly rejected. This is a broken invariant, not a performance wrinkle, and it is the arm
the original backlog ticket did not name.

**3. The demotion gate can be undermined — but not promptly.** `demotionTriggered` (`promotion.ts:327`)
refuses to demote a parent with live children; a member reading `0` could originate a demotion for a
parent that still has children. Not immediate: the recreated engine's `lowLoadSince` is also undefined, so
demotion cannot fire for another `T_demote` (5 min).

`debt-cohort-topic-child-set-late-joiner-resync` (landed) mitigates arms 1 and 3: every parent member
re-advertises its linked child set once per `T_willingness_heartbeat` (30 s) in `gossipRound`
(`host.ts:2049`), so a recreated engine re-converges from its siblings within roughly one heartbeat.
Permanent loss needs *every* parent member to evict the same engine. It does **not** mitigate arm 2 —
nothing re-advertises another member's `lastEffectiveAt`.

## Root cause

One site, one idea: **the engine's liveness predicate does not cover all the state the engine owns.**
`hasState()` means "holds registration records" but is *used* as "has anything worth losing". Every future
addition of engine-owned state repeats this bug silently; the child registry and the promotion state are
simply the first two instances, already sitting there.

The invariant worth buying: whatever predicate eviction consults is the single, exhaustive answer to
"does this engine hold state that cannot be reconstructed?", and each piece of engine-owned state is
obliged to declare itself into it — so that adding a fourth piece without declaring it is a compile error
or a failing test, not a silent regression.

## The design tension the plan must resolve

Making a child-holding engine un-evictable turns child links into a **pinning primitive**. In live-key
mode a child link is threshold-signed and expensive to forge (`dispatchChildLink` step 2,
`host.ts:2228-2234`). But the key-less interim mode is *permissive* — `verifyChildLinkSig === undefined`
short-circuits the check, and `host-antidos-coldstart.spec.ts:599` pins that behaviour
("key-less-permissive: a well-formed link with matching coords is recorded and acked linked"). So a naive
"count child links as live state" fix reopens exactly the spray vector the 2048-engine cap was built to
close: an attacker sprays well-formed links at 2048 distinct coords, every slot becomes un-evictable, and
legitimate coords are then refused with `CoordEngineRegistryFullError`.

Options to weigh — the plan stage picks one and says why:

- **Verified-only liveness.** Count a child link toward liveness only when it was actually
  signature-verified. Precise in live-key mode; in key-less mode it degrades to today's behaviour, which
  is at least no worse. Needs `recordChild` to carry a verified/unverified bit and the registry to track
  it per link.
- **Rank, don't pin.** Keep child-holding engines evictable but order them *behind* genuinely-cold coords
  in `evictOneIdle`'s victim selection. Preserves the cap's hard guarantee (something is always evictable)
  while making the loss rare. Does not fix arm 2 on its own.
- **Make the state reconstructible instead.** Pull the child set from a sibling on engine creation. The
  plan stage of `debt-cohort-topic-child-set-late-joiner-resync` already considered and rejected a
  snapshot-pull RPC for the *convergence* problem; the tradeoffs may read differently here. Again does
  nothing for `lastEffectiveAt`, which no sibling can supply.

Arm 2 may want a different remedy from arms 1 and 3 — e.g. retaining a small evicted-coord high-water-mark
map (coord → `lastEffectiveAt`) that survives engine eviction, which is cheap, bounded, and sidesteps the
pinning question entirely. The plan should say whether it splits into two implement tickets on that seam
or lands as one.

## Expected behaviour

- A node responsible for live child cohorts under a topic does not silently forget them because it needed
  a registry slot; if it must forget them, the loss is ranked last, not arbitrary.
- A recreated engine never re-applies a promotion/demotion notice it had already adopted.
- The anti-denial-of-service cap remains exactly as hard to exhaust as it is today: under adversarial
  load some engine is always evictable, and a stream of unverified child links cannot make the registry
  refuse legitimate coords.

## Acceptance for the implement ticket(s) the plan emits

- A regression test in `host-antidos-coldstart.spec.ts` asserting eviction does not silently drop a
  linked child set (either not selected, or selected only after every childless engine).
- A test that spraying links in key-less-permissive mode cannot drive the registry to refuse a legitimate
  coord.
- A test that a stale notice replayed at a recreated engine is still rejected.
- Some mechanism — a type, an exhaustive record, or a test — that makes a future fourth piece of
  engine-owned state fail loudly if it does not declare itself to the eviction predicate.
