description: When a node runs low on memory it throws away the least-useful of its small in-memory working sets, but its test for "useless" only checks one of the four things such a working set can hold — so it can discard a set that still tracks live sub-groups beneath it. Make the test cover everything, and make discarding the still-useful ones a last resort rather than an accident.
files:
  - packages/db-p2p/src/cohort-topic/host.ts                            # CoordEngine iface (342-490), CoordEngineContext (548-614), onCertPublished wiring (~803), isIdle (1389), evictOneIdle (1391-1417), createChildRegistry (1606), createCoordEngine (1673), engine return object (2110-2162)
  - packages/db-core/src/cohort-topic/promotion.ts                      # PromotionState (94-111); add hasAdoptedState()
  - packages/db-core/src/cohort-topic/membership/verifier.ts            # MembershipVerifier iface (69-90), CachingMembershipVerifier.byCoord (~163); add forget()
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts    # "coord-engine registry cap" describe (~650) — home for the new tests
  - docs/cohort-topic.md                                                # two stale "eviction of idle engines (no records, no cold-start forwarder)" passages: 813 and 1009
difficulty: hard
repro: verified
----

# Make the coord-engine eviction predicate exhaustive, and rank instead of pin

## Background for a reader with no context

A cohort-topic node keeps one small in-memory working set — a `CoordEngine` — per ring coordinate it is
responsible for. The served coordinate is a hash over inputs a remote peer chooses, so any peer can make a
node create engines; the registry is therefore hard-capped (`coordEnginesMax`, default 2048) and evicts the
least-recently-used engine it judges disposable when the cap is hit. That cap is the anti-denial-of-service
bound: without it, one peer spraying distinct coordinates forces unbounded allocation.

The bug is in *"judges disposable"*.

## Confirmed state at HEAD (2026-09-01)

`packages/db-p2p/src/cohort-topic/host.ts:1389`:

```ts
const isIdle = (engine: CoordEngine): boolean => !engine.hasState() && !engine.hasForwarders();
```

backed by `host.ts:2117-2118`:

```ts
hasState: (): boolean => store.listAll().length > 0,
hasForwarders: (): boolean => coldStart.hasForwarders(),
```

A `CoordEngine` built by `createCoordEngine` (`host.ts:1673`) owns four pieces of state that eviction
destroys. The predicate covers two:

| Engine-owned state | In `isIdle`? | Lost on eviction |
|---|---|---|
| Registration records (`store`) | yes | — |
| Cold-start forwarders (`coldStart`) | yes | — |
| Linked child cohorts (`childRegistry`, `host.ts:1606`) | **no** | child set → empty |
| Promotion bookkeeping (`promotion`, `promotion.ts:94`) | **no** | `promoted`, `promotedAt`, `lowLoadSince`, `lastEffectiveAt` → undefined |

Reproduced against the existing `coord-engine registry cap` harness: with the cap set to 1, an engine that
holds one recorded child and no registrations reports `childCohortCount == 1` but `hasState() === false`
and `hasForwarders() === false`; touching one other coord evicts it, and re-resolving the same coord
reports `0` children.

### Why the loss matters

- **Search escalation goes wrong immediately.** Matchmaking treats `childCohortCount > 0` as "there is a
  child tier worth sweeping". A seeker whose query lands on the just-recreated engine is told the topic is
  not promoted, skips the sweep, and fails to find peers that exist.
- **The demotion gate can be undermined.** `demotionTriggered` (`promotion.ts:327`) refuses to demote a
  parent with live children; a member reading `0` could originate a demotion for a parent that still has
  them. Not prompt — the recreated engine's `lowLoadSince` is also undefined, so demotion cannot fire for
  another `T_demote` (5 min).
- **A promoted cohort silently forgets it is promoted.** `promoted` drives whether a register gets
  `Promoted(d+1)` (redirect to the child tier) or is admitted here. Nothing re-advertises another member's
  `promoted` flag into the local `PromotionLifecycle` — the gossip `promoted` field lands in the sibling
  `CohortView`, never in local promotion state — so a recreated engine over-admits at tier `d` for a topic
  the tree promoted away. Reachable: promotion needs ≥ 64 direct participants (so the engine has records
  and is not evictable *then*), but once those records shard down to the children and TTL-sweep, the engine
  goes idle with `promoted === true` still set.
- The `lastEffectiveAt` replay anchor is also lost. That arm is **not** this ticket — see
  `bug-promotion-state-survives-engine-eviction`, which lands next and depends on this one.

`debt-cohort-topic-child-set-late-joiner-resync` (landed) softens the child-set arm: every parent member
re-advertises its linked child set once per `T_willingness_heartbeat` (30 s) in `gossipRound`
(`host.ts:2049`), so a recreated engine re-converges from its siblings within roughly one heartbeat.
Permanent loss needs *every* parent member to evict the same engine. It does nothing for the promotion arm.

## Root cause

**The eviction predicate is a hand-rolled conjunction over two of the engine's four state holders.**
`hasState()` means "holds registration records" but is *used* as "has anything worth losing". Every future
addition of engine-owned state repeats the bug silently. Fix the shape, not the two instances.

## The design tension, and the call

Making a child-holding engine un-evictable would turn child links into a **pinning primitive**. In live-key
mode a child link is threshold-signed and expensive to forge (`dispatchChildLink` step 2,
`host.ts:2228-2234`), but the key-less interim mode is deliberately permissive — `verifyChildLinkSig ===
undefined` short-circuits the check, pinned by the test at `host-antidos-coldstart.spec.ts:599`. An attacker
who can pin would spray well-formed links at 2048 distinct coords (`parentServedCoord` is
`coord_{childTier-1}(childParticipantCoord, topicId)`, both attacker-chosen), make every slot un-evictable,
and legitimate coords would then be refused with `CoordEngineRegistryFullError`. That is the exact vector
the cap exists to close.

**Decision: rank, do not pin.** Eviction keeps *every* engine that holds no records and no forwarders as a
candidate, but orders child-holding / promotion-holding engines strictly behind genuinely-cold ones.

- The cap's hard guarantee is untouched: under any spray, the sprayed cold coords are rank 0 and are
  consumed first; the registry refuses a new coord in exactly the situations it refuses one today (every
  slot holds records or a forwarder).
- The realistic loss is fixed: a handful of real parent/promoted engines sitting among ~2000 attacker-cold
  ones are now the *last* to go, instead of being picked purely by LRU age.
- Rejected — **verified-only liveness** (count a child link toward liveness only when signature-verified):
  it degrades to today's broken behaviour in key-less mode, which is the interim mode actually running, and
  it costs a verified/unverified bit through `recordChild` and the child registry.
- Rejected — **reconstruct from a sibling on engine creation**: a snapshot-pull RPC was already considered
  and rejected in the plan for `debt-cohort-topic-child-set-late-joiner-resync`; the throttled
  re-advertisement that shipped instead already covers this arm, and neither helps the promotion arm.

## The invariant to buy

Whatever predicate eviction consults is the single, exhaustive answer to *"does this engine hold state that
cannot be reconstructed?"*, and each piece of engine-owned state declares itself into it — so that adding a
fifth piece without declaring it fails at compile time or in a test, never silently.

### Shape

In `host.ts`, beside the `CoordEngine` interface:

```ts
/**
 * The classes of engine-owned state that evicting a {@link CoordEngine} destroys. **Exhaustive by
 * contract**: every piece of state a `CoordEngine` owns and eviction would lose must appear here, and
 * every consumer indexes it as a total `Record`, so adding a member without ranking it is a compile error.
 */
export type EngineStateKind = "records" | "forwarders" | "children" | "promotion";

/** Which state classes an engine currently holds. Total — one boolean per kind, never partial. */
export type EngineLiveness = Readonly<Record<EngineStateKind, boolean>>;
```

`CoordEngine` gains `liveness(): EngineLiveness` as the single source of truth;
`hasState()` / `hasForwarders()` stay on the interface (existing callers and specs use them) but become
derivations — `hasState: () => liveness().records` — so the two can never disagree.

The registry replaces `isIdle` with a rank table and a lexicographic `(rank, recency)` victim pick:

```ts
/**
 * Eviction rank per state class. `"pinned"` — an engine holding it is not an eviction candidate at all.
 * A number — the engine IS a candidate, but only after every candidate whose worst rank is strictly lower;
 * higher = evicted later. An engine holding nothing is rank 0: the genuinely-cold attacker-sprayed coord
 * the cap exists for.
 *
 * `children` / `promotion` are deliberately NOT pinned. A child link is peer-supplied input — key-less-
 * permissive mode records one without any signature check — so pinning on it would let any peer make all
 * `coordEnginesMax` slots un-evictable and drive `CoordEngineRegistryFullError` for legitimate coords,
 * reopening the spray vector the cap closes. Ranking keeps the hard guarantee (some engine is always
 * evictable) while making the loss rare.
 *
 * EXHAUSTIVE: a new `EngineStateKind` with no rank here does not typecheck.
 */
const EVICTION_RANK: Record<EngineStateKind, "pinned" | number> = {
	records: "pinned",
	forwarders: "pinned",
	children: 1,
	promotion: 1,
};
```

`evictionRank(engine): number | undefined` — `undefined` when any held kind is `"pinned"` (not a
candidate), else the maximum numeric rank over held kinds, or `0` when nothing is held.

`promotion` is held when the lifecycle carries adopted transition state for any topic. Add to
`PromotionLifecycle` (`packages/db-core/src/cohort-topic/promotion.ts`):

```ts
/**
 * True iff any topic carries adopted promotion/demotion state — a `promoted` flag or a `lastEffectiveAt`
 * high-water. Growth samples / `lowLoadSince` alone do not count: they are reconstructed from the store on
 * the next `onParticipantCountChange`. Read by the host's engine-eviction ranking, which must not discard
 * an engine holding a transition it cannot rebuild.
 */
hasAdoptedState(): boolean;
```

Implementation: any state whose `promoted === true` or `lastEffectiveAt !== undefined`.

## Third arm at the same site — the stranded verifier trust-lock

`evictOneIdle` carries a NOTE (`host.ts:1383-1388`) saying eviction is safe *because* "an idle engine
(`hasState() === false`) has never published a membership cert — so there is no verifier trust-lock to
drop", and it instructs: do not widen this policy without adding `verifier.forget(coord)`. The same claim
is repeated at the `onCertPublished` wiring (`host.ts:804`).

**That premise is already false at HEAD.** `publishMembership` (`host.ts:1837`) gates only on `canPublish`
(the node has a key) — never on `hasState()` — and the gossip-cadence driver calls `pumpMembership` for
*every* engine in `registry.all()` (`host.ts:1068-1077`). So on a keyed node a record-less engine can and
does publish a cert, which `onCertPublished` feeds to `verifier.cache(cert)` as a *trusted* entry; evicting
that engine strands the lock. The consequence is bounded and self-recovering (the verifier's strike counter
re-enters TOFU, and its own LRU can evict the entry — it documents the lock as best-effort under memory
pressure), but the code's stated safety argument is wrong and this ticket widens the policy the NOTE warns
about. Fix it here rather than leaving a landmine:

- Add `forget(cohortCoord: string): void` to `MembershipVerifier` (drop the `byCoord` entry and any strike
  counter for that coord).
- Add `onEngineEvicted?: (coord: RingCoord) => void` to `CoordEngineContext`, symmetric with the existing
  `onCertPublished`, wired at the host to `verifier.forget(bytesToB64url(coord))`.
- Call it from the eviction path for **every** evicted engine — unconditional and a cheap no-op for a coord
  that never published. Do not try to track "did this engine publish": that is another
  declare-yourself-or-be-forgotten trap of exactly the kind this ticket exists to remove.
- Replace both stale comments with the true reasoning.

## Edge cases & interactions

- **Attacker child-link spray must not cause refusal.** 2048 distinct well-formed key-less links → every
  slot is a rank-1 candidate → the registry still evicts and still admits a legitimate coord. This is the
  headline safety test.
- **Registry genuinely full of live cohorts still refuses.** Every slot pinned (records or forwarder) →
  `CoordEngineRegistryFullError`, unchanged, and `dispatchRegister` still turns it into a clean
  `unwilling_cohort` rather than an unhandled throw (existing tests at `~712` and `~739` must stay green).
- **Rank ties fall back to LRU.** Two rank-1 engines evict oldest-first, exactly as today within a rank.
- **A hot engine is still never the victim.** Recency is bumped by `forCoord` / `findByCoord` /
  `findHolder` / `findServing`; ranking is applied *before* recency, so a hot rank-1 engine loses to a cold
  rank-1 engine but a hot rank-0 engine is still evicted before any rank-1 one — that is intended, keep the
  existing "hot engine survives" test green by keeping its engines at the same rank.
- **Tombstones are not children.** `childRegistry.linkedChildren()` excludes `linked = false` tombstones, so
  a parent whose every child demoted away is rank 0 again and reclaimable. Derive the `children` flag from
  the *linked* set, never from map size.
- **Demotion does not release the engine.** A demoted engine keeps its forwarder / records / budget slot
  (see the NOTE in `promotion.ts` `demote`), so it stays pinned until the topic actually drains — the
  promotion-rank case only arises after that drain.
- **`close()` on eviction still runs**, so the gossip-bus subscription is still dropped. The existing
  `subscriberCount` leak assertion must stay green.
- **Multi-cohort node.** A node serving several sibling coords for one topic ranks each engine
  independently; evicting one must not disturb another's child set or promotion state.
- **Key-less composition.** `hasAdoptedState()` on a key-less node is reachable via
  `applyPromotionNotice` (the remote-apply path needs no local key), so ranking must work without
  `privateKey`. `onEngineEvicted` is optional in `CoordEngineContext` for unit composition.

## Expected behaviour

- An engine that holds only a linked child set, or only adopted promotion state, is evicted **only after
  every engine that holds nothing** — never merely because it is the oldest.
- Under a spray of unverified child links the registry never refuses a legitimate coord: eviction still
  always finds a victim while any unpinned engine exists.
- Evicting an engine drops the node's verifier trust-lock for its coord.
- Adding a fifth piece of engine-owned state without ranking it does not compile.

## TODO

- Add `EngineStateKind` / `EngineLiveness` and `CoordEngine.liveness()` in `host.ts`; make `hasState()` and
  `hasForwarders()` derive from it so they cannot drift.
- Implement `liveness()` in `createCoordEngine`'s return object: `records` from `store.listAll().length > 0`,
  `forwarders` from `coldStart.hasForwarders()`, `children` from `childRegistry.linkedChildren().length > 0`,
  `promotion` from `promotion.hasAdoptedState()`.
- Add `hasAdoptedState()` to `PromotionLifecycle` + `CohortPromotionLifecycle` in
  `packages/db-core/src/cohort-topic/promotion.ts`, with the doc comment above.
- Replace `isIdle` / `evictOneIdle` with `EVICTION_RANK`, `evictionRank(engine)`, and a
  `(rank, recency)` lexicographic victim pick. Keep the function's "returns true iff a slot was freed"
  contract and the `close()` + `recency.delete` teardown.
- Add `MembershipVerifier.forget(cohortCoord)` in `packages/db-core/src/cohort-topic/membership/verifier.ts`
  (drop the cached entry and its strike count); add `CoordEngineContext.onEngineEvicted` and wire it at the
  host to `verifier.forget`; call it on every eviction.
- Rewrite the two stale "no records → never published a cert" comments (`host.ts:1383-1388` and
  `host.ts:803-807`) to state the real reasoning: `pumpMembership` runs for every engine on a keyed node, so
  eviction forgets the trust-lock unconditionally.
- Update `docs/cohort-topic.md:813` and `:1009` — eviction is no longer "idle engines (no records, no
  cold-start forwarder)"; describe the rank order and say explicitly why child links are ranked, not pinned.
- Tests in `packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts`, inside the existing
  `coord-engine registry cap` describe (its harness already builds hosts with a small `coordEnginesMax` and
  drives `host.registry.forCoord` / `findByCoord` directly):
  - *a child-holding engine is evicted only after every childless one*: cap `N`, create `N` engines, record
    a child on the oldest, then force `N` evictions' worth of new coords; assert the child-holder survives
    while every childless engine is reclaimed, and that its `childCohortCount` is still `1`.
  - *a promotion-holding engine outranks a cold one*: same shape, using `applyPromotionNotice` (no key
    needed) to give one engine adopted state; assert it survives and `isPromoted` is still true.
  - *a child-link spray cannot refuse a legitimate coord*: fill the cap with engines that each hold one
    recorded child, then create one more coord; assert it succeeds and does **not** throw
    `CoordEngineRegistryFullError` — and that the registry is still exactly at the cap.
  - *a full-of-pinned registry still refuses*: the existing test at `~712` unchanged.
  - *eviction forgets the trust-lock*: publish a cert for a coord (or call the wired `onCertPublished`
    seam), evict its engine, assert the verifier no longer holds a trusted entry for that coord.
  - *exhaustiveness guard*: assert `Object.keys(EVICTION_RANK)` equals the key set of a
    `liveness()` result — so a new `EngineStateKind` added to the liveness record but not the rank table
    fails here even where TypeScript's `Record` check cannot see it.
- Run `yarn test` in `packages/db-p2p` and `packages/db-core`, plus `yarn build` + `yarn typecheck` from
  root. Grep-narrow with `yarn test -- --grep "registry cap"` for the inner loop.
