description: A node under memory pressure can throw away a small cohort's bookkeeping while treating it as empty, so the node briefly forgets that the group has sub-groups beneath it and tells searchers there is nothing more to look for.
files:
  - packages/db-p2p/src/cohort-topic/host.ts   # isIdle / evictOneIdle (~1389-1420); hasState (~2115); createChildRegistry (~1604); createCoordEngine's promotion state
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts   # "coord-engine registry cap" describe (~650) — natural home for the regression test
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The obvious fix (count child links as "live state") makes such engines un-evictable, which in the key-less interim mode — where child links are accepted without a threshold signature — hands an attacker a new way to pin every slot in the registry and get legitimate coords refused; a maintainer may reasonably prefer today's lose-and-re-converge behaviour to that.

# A cohort node's memory cap can discard bookkeeping it treats as worthless

## Plain summary

Each node keeps a bounded number of small in-memory "cohorts" (one per point on the ring it is
responsible for), currently 2048. When that cap is reached, the node throws away the least-recently-used
cohort that it judges *empty*. Its test for "empty" only asks one question: does this cohort hold any
participant registrations? But a cohort also holds two other things worth keeping — the list of
sub-groups (child cohorts) created beneath it when the topic got busy, and the record that the topic was
promoted in the first place. Both are silently discarded.

## What was observed

Reproduced directly (a temporary probe against the existing `coord-engine registry cap` harness in
`packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts`, since removed):

- Create a host with the engine cap set to 1.
- Create a cohort for a topic and record one child cohort under it (`recordChild`). No participant
  registers, which is normal — this is exactly the parent whose participants have all sharded down into
  its children.
- The engine reports `childCohortCount == 1`, but `hasState() == false` and `hasForwarders() == false`.
- Touch one other coord. The parent engine is evicted.
- Re-resolve the same coord: the child count is back to `0`.

So the eviction predicate at `packages/db-p2p/src/cohort-topic/host.ts:1389`
(`!engine.hasState() && !engine.hasForwarders()`, where `hasState()` is "holds a registration record")
classifies a parent that is actively responsible for live children as a throwaway cold coord.

## Why it matters, and why it is not urgent

Two consumers read the child count:

- **Matchmaking search escalation** treats `childCohortCount > 0` as "there is a child tier worth
  sweeping". A seeker whose query lands on the just-evicted-and-recreated member is told the topic is not
  promoted and skips the sweep — it fails to find peers that exist. This is immediate and wrong.
- **The demotion gate** (`packages/db-core/src/cohort-topic/promotion.ts:327`) refuses to demote a parent
  with live children. A member reading `0` could originate a demotion for a parent that still has
  children. This one is *not* immediate: the recreated engine's promotion state also resets, so
  `lowLoadSince` is undefined and demotion cannot fire for another `T_demote` (5 min).

`debt-cohort-topic-child-set-late-joiner-resync` (landed) mitigates both: every parent member now
re-advertises its linked child set once per `T_willingness_heartbeat` (30 s), so a recreated engine
re-converges from its siblings within roughly one heartbeat. Permanent loss needs *every* parent member to
evict the same engine — plausible only under the coordinated pressure the cap exists to survive in the
first place. Hence a real defect, but a bounded, self-healing one.

## Root cause, and the shape of a fix

One site, one idea: **an engine's liveness predicate does not cover all the state an engine owns.**
`hasState()` means "holds registration records" but is *used* as "has anything worth losing". Any future
addition of engine-owned state repeats this bug silently — the child registry is simply the first
instance, and the promotion state is the second one already sitting there.

The invariant worth buying is that `hasState()` (or whatever the eviction predicate consults) is the
single, exhaustive answer to "does this engine hold state that cannot be reconstructed?", with each piece
of engine-owned state obliged to declare itself. A test asserting that eviction never selects an engine
with linked children pins it.

The design tension that makes this a ticket rather than a one-line change: making a child-holding engine
un-evictable turns child links into a pinning primitive. In live-key mode a child link is threshold-signed
and expensive to forge, but the key-less interim mode is *permissive* — see
`host-antidos-coldstart.spec.ts:599`, "key-less-permissive: a well-formed link with matching coords is
recorded and acked linked". So a naive fix reopens the spray vector the cap was built to close. Options
worth weighing before implementing:

- Count child links toward liveness only when the link was actually signature-verified.
- Keep child-holding engines evictable but rank them *last*, behind genuinely-cold coords, rather than
  never.
- Leave eviction alone and instead make the child set reconstructible on demand (a pull from a sibling on
  engine creation) — note the plan stage of the resync ticket already considered and rejected a
  snapshot-pull RPC for the *convergence* problem; the tradeoffs may read differently here.

## Expected behaviour

A node that is responsible for live child cohorts under a topic does not silently forget them because it
needed a registry slot; and if it must forget them, the anti-denial-of-service cap remains just as hard to
exhaust as it is today.
