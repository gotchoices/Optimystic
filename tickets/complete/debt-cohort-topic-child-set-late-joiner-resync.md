description: A node that joins the group overseeing a busy topic never learned how many sub-groups already existed under it. Each member now periodically re-announces the sub-groups it knows about, so a late joiner catches up within about 30 seconds.
files:
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts
  - docs/cohort-topic.md
----

# Child-set convergence for a late-joining / rotated-in parent member — complete

## Vocabulary

- **Cohort** — the small node set jointly responsible for one point on the ring; membership comes from the
  routing layer (FRET) and reshuffles as nodes join and leave.
- **Parent / child cohort** — a busy topic *promotes*: child cohorts are created beneath the parent to absorb
  load. The parent must know how many live children it has.
- **Child link** — the message a newly-promoted child sends up saying "you are my parent". FRET delivers it to
  **exactly one** parent member, so that member alone has first-hand knowledge.
- **Gossip round** — each cohort member periodically broadcasts a small frame to its cohort; state changes are
  queued as **deltas** between rounds and drained into the next frame.

## What was wrong, and what now happens

A child-link delta was broadcast exactly once and nothing re-advertised it. A parent member whose engine was
built *after* that delta drained (a membership rotation, or any FRET reshuffle adding a node to the parent
cohort) started with an empty child registry and read `childCohortCount == 0` for children that plainly
existed. Two consumers read that wrong number: the demotion gate
(`packages/db-core/src/cohort-topic/promotion.ts:327` blocks demotion while `childCohortCount > 0`) and
matchmaking search escalation (`childCohortCount > 0` is the "sweep the child tier" signal).

Implemented as **periodic re-advertisement of the linked set**, not the rejected snapshot-pull RPC:

- `ChildRegistry.linkedChildren()` returns every currently-**linked** child across **all** topics (tombstones
  excluded), each at its original `effectiveAt`. `ChildEntry` retains the key's original bytes so the accessor
  needs no key decode. All-topics (not per-topic) is load-bearing: `gossipRound` iterates only
  `residentTopics()`, and a parent whose participants sharded entirely down to its children holds child links
  for a topic it holds no records for.
- `gossipRound` keeps a per-engine `lastChildReadvertAt` clock. Immediately **before** `pending.drain()`, if
  that clock is `undefined` or `ctx.willingnessHeartbeatMs` has elapsed, every `linkedChildren()` entry is
  enqueued via `pending.childLink(...)` at its stored `effectiveAt`; the clock advances only if at least one
  entry was enqueued.
- Routed through `PendingDeltas` rather than straight into the frame, so a same-round fresh local link for the
  same child collapses to one ref instead of two. Sourcing from the registry (not the queue) is what makes the
  unlink direction safe: an already-released child is simply absent from `linkedChildren()`, and nothing
  between the resync block and `drain()` awaits.
- No new config knob — reuses `willingnessHeartbeatMs` (default 30 s, injectable through
  `createCohortTopicHost`). No `log()` on the path; no `canPublish` gate.

Safety is by construction: the receiving merge is last-writer-wins on `effectiveAt`, so a re-advertisement is
a strict no-op on a member that already holds the link and cannot resurrect a released child (its
`effectiveAt` is older than the unlink's, so the tombstone's high-water drops it).

## Deliberate behaviours (do not "fix")

- **A re-advertising round is non-idle on purpose.** `idle` is computed from the drained arrays, so the resync
  builds and broadcasts a frame even for an engine that would otherwise emit nothing. The frame is the carrier.
- **Merged deltas are still never re-gossiped *as deltas*, but they ARE re-advertised.** Once merged, a child
  is part of this member's linked set and goes out on the next throttled round — that is how a late joiner's
  knowledge spreads onward.
- **A missed *unlink* is not healed.** Absence is not advertised. Both consumers fail conservatively (demotion
  stays blocked; a seeker sweeps a no-longer-promoted tier — wasteful, not wrong). Parked as a `NOTE:`
  tripwire at the re-advertisement site.
- **The max-of-siblings fallback in `packages/db-core/src/cohort-topic/traffic.ts:149-159` stays dormant.**
  The child-registry override always wins (`childOverride ?? childCohortCount`; the override returns `0`, not
  `undefined`). Re-enabling the fallback would be a regression.

---

# Review findings

Reviewed the implement diff (`e3f61df8`) before the handoff summary. Checked: correctness of the throttle and
its clock, the last-writer-wins collapse in `PendingDeltas.queueChild`, the frame-build path when a resync
makes an otherwise-idle round non-idle, byte-aliasing introduced by retaining key bytes on `ChildEntry`, the
resync's interaction with engine lifecycle (creation, LRU eviction, key-less mode), comment accuracy, doc
completeness including the §Configuration table, and test coverage against happy path / edge cases / error
paths / regressions.

## Validation

- `yarn lint` — clean.
- `yarn build`, `yarn typecheck` — clean.
- `yarn test` (full workspace) — green, no failures anywhere: db-core 1459 passing, db-p2p **2477** passing /
  49 pending, plus 76 / 58 / 53 / 52 / 12 / 125 / 690 / 6 / 258 across the remaining packages. The known
  intermittent `packages/reference-peer` distributed-diary case (tracked as
  `fix/2-all-lose-conflict-race-wedges-concurrent-first-appends`) passed on this run. Nothing new written to
  `tickets/.pre-existing-error.md`.

## Major — filed

**Coord-engine LRU eviction discards the child registry (and the promotion state) because its liveness
predicate only counts registration records.** `host.ts:1389` defines `isIdle` as
`!engine.hasState() && !engine.hasForwarders()`, and `hasState()` is "holds a registration record". A parent
engine holding linked children but no registrations — precisely the "participants sharded entirely down to
the children" case this diff's own `linkedChildren()` doc names as the motivating one — is therefore
classified as a throwaway cold coord and evicted.

Reproduced with a temporary probe against the existing `coord-engine registry cap` harness (probe removed;
working tree left byte-identical): a parent with `childCohortCount == 1` reports `hasState() == false` and
`hasForwarders() == false`, is evicted on the next coord touch, and reads `0` when re-resolved.

Impact is bounded and partly *mitigated by this very ticket*: the new resync re-converges a recreated engine
from its siblings within one `T_willingness_heartbeat`, and the demotion gate cannot fire for another
`T_demote` (5 min) because the recreated engine's `lowLoadSince` also resets. Matchmaking escalation is the
one immediately-wrong consumer. Permanent loss needs every parent member to evict the same engine.

Climbed the architecture ladder before filing: the root is rung 3, a boundary invariant — the eviction
predicate does not cover all engine-owned state, so the *next* piece of engine state added repeats this
silently (the promotion state is already the second instance). Not fixed inline: the obvious fix makes
child-holding engines un-evictable, and in key-less interim mode child links are accepted *without* a
threshold signature (`host-antidos-coldstart.spec.ts:599`), which would hand an attacker a fresh way to pin
every registry slot. That tension needs a design call, not a review-pass edit.

Filed as `tickets/backlog/bug-engine-eviction-forgets-child-links-and-promotion-state.md`
(`repro: verified`, `severity: wrong-result`, `likelihood: unusual`). No existing ticket claimed the site —
`debt-cohort-topic-host-eviction-teardown-test` covers the *topic-budget* `onEvict` closure, a different
mechanism.

## Minor — fixed in this pass

- **`gossipRound`'s resync comment justified the design with an unreachable case.** It claimed routing through
  `pending` lets "a same-round unlink at a newer `effectiveAt` supersede" the re-advertisement, then argued two
  sentences later that an unlinked child is never re-advertised at all — so there is nothing to supersede.
  Rewritten to state the real reason (collapsing a same-round fresh *local* link to one ref) and the real
  safety argument (the registry is the source, and nothing between the resync block and `drain()` awaits).
- **`ChildEntry`'s new doc said the bytes are retained "at the single `apply` call site".** `apply` has two
  callers and the retention happens only on first insert. Corrected.
- **`LinkedChild`'s byte fields alias the registry's own arrays** with nothing saying so. Marked the fields
  `readonly` and documented the aliasing on the interface. (Registry callers all decode fresh arrays today, so
  this is a contract statement, not a live bug.)
- **`docs/cohort-topic.md` §Configuration still described `T_willingness_heartbeat` as purely the idle
  willingness knob.** The prose sections were updated by the implementer but the table row — the place a
  reader tuning the knob actually looks — was not. Rewritten to name both re-advertisements it paces, the
  widened cost tradeoff, and the coupling to `gossip_round` in both directions.

## Minor — tests added (closing two gaps the handoff flagged as "argument, not evidence")

Both in `packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts`; suite went 2475 → 2477 passing.

- *a gossip interval longer than the heartbeat makes every round a resync round* — four rounds 40 s apart,
  each carrying the link. The handoff called the `gossipIntervalMs` / `willingnessHeartbeatMs` interaction
  untested and "worth reasoning about". The throttle is wall-clock, not a round counter, so a long interval
  never *lengthens* convergence; it only makes every round a resync round. Now pinned rather than argued.
- *a key-less (verify-only) engine still re-advertises its linked child set* — a host built without a
  `privateKey` drains its own link, emits an unsigned frame, and re-advertises at the next heartbeat boundary
  at the original `effectiveAt`. The handoff correctly noted the code adds no key gate but that nothing proved
  it.

## Considered and not filed

- **The handoff's remaining gaps are acceptable.** No multi-tier integration test drives a real `ChildLinkV1`
  through FRET dispatch *and* a rotation together; the dispatch path is covered in the lifecycle spec and the
  rotation path here, and wiring the two would cost far more than the seam it covers. The throttle assertions
  are synchronous on the returned frame while inbound merges use `waitFor` — correct, since the only async
  surface is `deliverGossip` → bus merge.
- **`packages/db-p2p/src/cohort-topic/host.ts` is 2998 lines** (`wc -l`), and this diff added 79. Large, but
  the repo states no file-size convention, nothing here measures it as causing harm, and splitting a file this
  central is a project rather than an arm on this ticket. Recorded here so the next reviewer has the number
  rather than re-measuring it.
- **Steady-state re-advertisement is O(members × live children) per heartbeat cohort-wide** — every converged
  parent member re-advertises the full union, and each receiver merges N−1 redundant copies as pure map
  lookups. With realistic cohort sizes and live child counts this is a handful of small refs per 30 s. Not
  filed and not parked as a tripwire: the existing `NOTE:` above `createChildRegistry` already names live
  child count as the quantity that bounds re-advertisement traffic, so a future reader meets the concern at
  the right site.

## Tripwires (parked by the implementer, verified in place — analysis lives at the sites)

- `packages/db-p2p/src/cohort-topic/host.ts`, inside the `gossipRound` resync block: a missed **unlink** is
  not healed by re-advertisement; if over-counting ever needs healing, advertise tombstones too.
- `packages/db-p2p/src/cohort-topic/host.ts`, above `createChildRegistry`: released children are kept forever
  as tombstones; if child churn on a long-lived parent ever makes that map large, age them out past a
  demotion horizon.
