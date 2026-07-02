description: Every member of a parent group now agrees on how many child groups it has (converged by gossip, not just the one member a child registered with), and a shrinking child cleanly un-registers from its parent so the parent's child count drops and the parent can shrink in turn.
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (ChildLinkRefV1; CohortGossipV1.childLinks/childUnlinks)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateChildLinkRefV1)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (cohortGossipSigningPayload covers child deltas)
  - packages/db-core/src/cohort-topic/gossip/bus.ts (onChildDeltas merge callback, epoch-independent)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (PendingDeltas child link/unlink; buildCohortGossip)
  - packages/db-p2p/src/cohort-topic/host.ts (ChildRegistry unrecordChild; applyDemotionUnlinkAtParent; handleInboundNotice parent-unlink)
  - docs/cohort-topic.md
----

# Complete: cohort-topic child-link replication + unlink on demotion

## What shipped

Two gaps left by `cohort-topic-parent-child-link` are closed:

1. **Cohort-wide convergence (union, not max).** Each parent member gossips its own child link/unlink
   **deltas** (`CohortGossipV1.childLinks` / `childUnlinks`) and merges inbound ones straight into its
   per-engine child registry (last-writer-wins by `effectiveAt`, keyed by child coord). After one gossip
   round every parent member holds the same converged **union**, so `childCohortCount` (the demotion gate,
   gossip summary, traffic snapshot) is consistent cohort-wide instead of a single-member shard.
2. **Unlink on demotion.** A demoting child threshold-signs a `DemotionNoticeV1` fanned to both its own
   served coord (siblings adopt `promoted = false`) and its `parentCohortCoord`. At the parent,
   `handleInboundNotice` runs a second, independent apply (`applyDemotionUnlinkAtParent`): verify against the
   **child** cohort cert, then `unrecordChild`. That release gossips across the parent cohort like the link
   does, so every member's count falls and the parent can shrink in turn.

Implementation detail lives in the implement commit (`git show 49230ff`) and `docs/cohort-topic.md`
(§Topic traffic signal, §Demotion, §Cohort gossip).

## Review findings

**Verdict: ship as implemented.** Build + tests green on both packages; no minor fixes needed inline; no new
major tickets — the one production-reachable gap was already filed as debt by the implementer. Adversarial
pass covered the aspects below.

### Checked — clean

- **Wire / signing (db-core).** `ChildLinkRefV1` + the two new gossip arrays are validated
  (`validateChildLinkRefV1`, array-shape guards) and — critically — **covered by
  `cohortGossipSigningPayload`**, so a MITM cannot strip/inject a link/unlink. `wire.spec.ts` asserts
  round-trip, base64url rejection, array-type rejection, and that link/unlink/absent produce *distinct*
  signed images. Signatures are recomputed per verify (never persisted), so appending fields is safe.
- **Bus `onChildDeltas` (db-core).** Fires only for **our-coord** frames, **after** the `verifyInbound`
  authenticity gate (`bus.ts:174`), and merges **regardless of epoch match** — correct, because the child set
  is keyed by child coord, not the parent epoch (record deltas *are* epoch-gated; child deltas must not be).
  `gossip.spec.ts` covers our-coord fire, epoch-drift fire, empty-delta skip, and foreign-coord drop.
- **Delta queue (db-p2p).** `PendingDeltas.childLink/childUnlink` collapse to newest `effectiveAt` per child;
  a link+unlink for one child in a round collapses to one drained delta; a child delta marks the frame
  non-idle. Covered by `gossip-cadence.spec.ts`.
- **Registry `apply` (db-p2p).** Freshness-ordered, idempotent, never-seen-unlink tombstone, and
  returns-changed so the engine re-gossips **only real changes** and a gossip-merged delta is a direct write
  (never re-enqueued — verified by the "a merged child link is not re-gossiped" assertion). Ordering/tombstone
  cases covered by the real-registry test.
- **Notice path (db-p2p).** `applyDemotionUnlinkAtParent` verifies against the child cohort cert (same coord +
  `notice.tier` as the sibling-adopt — confirmed both branches verify against the child coord), and the
  parent-unlink runs **outside** the sibling-adopt high-water (that water is keyed by the child coord and would
  stale-drop the parent-coord copy of the frame). `promote-notice.spec.ts` covers parent-only, dual-role,
  forged-rejected, no-parent, and high-water independence on replay.
- **Docs.** Read every touched doc section; §Topic traffic signal, §Demotion, §Cohort gossip, the
  `CohortGossipV1` schema block, and the status footnotes all reflect the new union/unlink reality (the stale
  "single-member / follow-on" language is gone). The two `it.skip` multi-tier lifecycle tests were correctly
  **not** un-skipped — their reason strings now say the *mechanism* is implemented + unit/integration-covered
  and only the live-mesh instantiation is deferred to the real-libp2p tier.

### Edge cases independently traced and cleared (no code change)

- **Silent high-water advance.** `recordChild` with a newer `effectiveAt` but unchanged `linked` state
  advances `lastEffectiveAt` locally yet returns `false` (not re-gossiped), so member high-waters can diverge
  after a link-retry-with-new-effectiveAt (link RPC retry on lost ack). Traced whether a later stale unlink
  could then converge inconsistently: it cannot — every real unlink originates from demotion
  (`effectiveAt = Date.now()` at demotion time) and is therefore strictly newer than *all* link effectiveAts,
  and forged unlinks are verify-rejected. There is no source of an unlink older than the newest link for a
  live child, so the divergence has no trigger and any transient gap self-heals on the newest unlink. Safe.
- **Tombstone growth.** Unlink tombstones (`linked = false`) are never pruned, but child coords are
  deterministic shard positions (`coord_d(participantCoord, topicId)`), so distinct tombstones per topic are
  bounded by the fanout `F`, and topic cardinality is already bounded by the store the node holds. Not an
  unbounded leak — no ticket.
- **Parent-unlink verify on replay.** The parent-unlink path has no pre-verify freshness gate (unlike the
  sibling-adopt, which stale-drops before verify), so a replayed demotion always reaches `verifyMessage` on a
  parent-only node. Bounded acceptably: the `(from, topicId)` rate limiter runs first, and the verify uses the
  `PROMOTE_REFETCH_MIN_INTERVAL_MS`-bounded cached-cert path (no dial). Marginal cost is one in-memory sig
  verify per rate-limited frame — matches the implementer's acknowledged "redundant verify" note. No action.
- **`onChildDeltas` topicId trust.** A cohort member could gossip child links for topics it doesn't parent,
  inflating `childCohortCount`. Within the existing cohort semi-trust model (identical to record-delta
  gossip); not a new exposure.

### Major (filed, not fixed)

- **Late-joiner / rotation resync.** A child link/unlink is broadcast **once** (drained from the delta queue);
  there is no periodic re-advertisement, so a parent member that instantiates its engine *after* a child's
  delta drained (a membership rotation) reads a stale `childCohortCount` until the next local record/unrecord
  re-broadcasts. Production-reachable and could let a rotated-in member originate a spurious demotion. Filed by
  the implementer as `tickets/backlog/debt-cohort-topic-child-set-late-joiner-resync.md` (verified present and
  well-scoped — re-advertisement vs pull-on-instantiation, with acceptance criteria). Dormant in-agent (mock
  tiers don't rotate live-key cohorts; demotion endorsement doesn't yet check child count either). Reviewer
  concurs with **ship-with-debt**: filing it as debt rather than blocking is correct given the ticket's
  explicit one-shot-delta-broadcast design and the dormancy.

### Tripwires (parked, not tickets)

- `NOTE:` on the `ChildRegistry` interface doc in `host.ts` (`host.ts:1409`) — the one-shot delta broadcast
  does not re-sync a member that joins after a delta drained; points at
  `debt-cohort-topic-child-set-late-joiner-resync`. Verified present.
- (Pre-existing, still valid) `NOTE:` at the `childOverride` read in `db-core/.../traffic.ts` — the
  max-of-siblings loop stays dormant while the registry override is wired; the override now genuinely
  converges cohort-wide, so the doc's "authoritative on every member" is true. No change needed.

### Deferred (not run here)

- **Live multi-tier e2e** (drive a topic past `cap_promote` so a real tier-1 child instantiates, links, and
  later demotes over a live walk) stays deferred to the real-libp2p tier / CI — the routed parent member
  frequently cannot yet resolve the child cohort cert in the mock mesh, so the live-key child-link RPC stays
  `awaiting_parent` (a known prereq limitation). The convergence + unlink *logic* is fully covered by the
  two-node integration and notice-path unit tests. Highest-value future addition, but not agent-driveable.

## Validation

- `packages/db-core`: `yarn build` clean; `yarn test` → **1031 passing, 0 failing**.
- `packages/db-p2p`: `yarn build` clean; `yarn test` → **1097 passing, 36 pending, 0 failing**.
- No lint script in either package; `build` (tsc) is the type-check gate and passed. The 36 pending are the
  pre-existing `it.skip` multi-tier / deferred cases (unchanged in count).
