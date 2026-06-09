description: A coord engine with no resident topics is "idle" and skips gossip entirely, so it never advertises its willingness. But multi-member admission needs a quorum of *gossiped* sibling willingness — so a brand-new multi-node cohort whose members are all idle can never admit its first registration (no one gossips willingness → no quorum → no admission → stays idle). Resolve the cold-start chicken-and-egg, e.g. a willingness heartbeat that gossips even when idle, or an admission-policy adjustment.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (buildCohortGossip returns undefined when topicSummaries/records/evicted all empty — the idle skip)
  - packages/db-p2p/src/cohort-topic/host.ts (gossipRound skips broadcast on an undefined frame)
  - packages/db-core/src/cohort-topic/willingness.ts (GossipWillingnessCheck — quorum is gossiped-willing siblings + self)
  - docs/cohort-topic.md (§Gossip, §Registration acceptance / admission quorum)
----

# Bootstrap willingness gossip for a cold (topic-less) multi-node cohort

## Problem

`buildCohortGossip` (gossip-cadence driver) returns `undefined` — and the host's `gossipRound` skips the
broadcast — when an engine is **idle**: no resident topics and no pending record/eviction deltas. The
intent is sound (an empty engine shouldn't spend a gossip round). But willingness/load ride on the same
frame, so an idle engine also never advertises that it is **willing** to serve a tier.

Multi-member admission (`GossipWillingnessCheck`, db-core `willingness.ts`) gates on a **quorum** of
willing cohort members, counted as *gossiped-willing siblings + self*. A brand-new multi-node cohort
starts with every member idle (no topics yet). So:

- every member is idle → no member gossips willingness →
- no member sees a sibling quorum of willingness →
- the first registration is rejected (`UnwillingCohort`) → no topic is admitted →
- every member stays idle. 

A chicken-and-egg: the cohort cannot admit its first topic until a sibling already has a topic to gossip
about. The gossip-cadence ticket wired the cadence but did not resolve this; its tests seed sibling
willingness explicitly (`deliverGossip(... willingnessBits: 'f' ...)`) to step around it. The
per-coord-scoping ticket flagged the same thing ("multi-member admission awaits the willingness-gossip
wiring").

## Expected behavior

A fresh multi-node cohort with no resident topics should still converge on each other's willingness so
the first registration routed to it can be admitted (assuming members are genuinely willing). Bringing up
N willing nodes for a new coord and registering once should succeed without any pre-seeding.

## Notes / shape (design question — may need a human decision)

Two candidate directions, not mutually exclusive:

- **Willingness heartbeat.** Let an idle engine still emit a minimal willingness/load frame on some
  (slower) cadence — i.e. don't treat "willing but topic-less" as idle. Needs a rate that isn't a flood
  for the many-empty-cohort case (a node serves many coords); perhaps a longer heartbeat interval than
  the record-gossip round, or only while the node is actually willing for the tier.
- **Admission-policy adjustment.** Reconsider whether first-registration admission must require a
  *gossiped* sibling quorum, or whether a cold cohort can bootstrap from a member's own live willingness
  plus membership-cert evidence. Overlaps with `cohort-topic-admission-quorum-semantics` (which pins the
  quorum *number*); this ticket is about the *bootstrap* path, not the count.

Pick after deciding the heartbeat-cost vs. admission-latency tradeoff; the heartbeat interval is a new
`docs/cohort-topic.md` §Configuration knob if that route is taken.

## Review provenance

Filed from the review of `cohort-topic-gossip-cadence` (gap 2 in that ticket's "Known gaps"). Distinct
from `cohort-topic-admission-quorum-semantics` (that pins the quorum number; this resolves the cold-start
bootstrap so the quorum can ever be met for a topic-less cohort).
