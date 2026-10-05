description: The cohort-topic design doc now states the number of willing members a cohort needs before taking on a tier (a strict majority, configurable), and why it is deliberately different from the signing threshold; review the wording against the code.
prereq:
files:
  - docs/cohort-topic.md (§Tier ladder → new §Admission quorum; §Willingness bullets; §Promotion; §Demotion; §Cold-start instantiation; §RouteAndMaybeAct usage `minSigs` line; §Configuration → Defaults table)
  - packages/db-core/src/cohort-topic/willingness.ts (`WillingnessConfig.quorum` doc comment only)
  - packages/db-p2p/src/cohort-topic/host.ts (reference: `createCohortTopicHost` passes `cohortSize` = `wantK`, or the root group's size for a root-placed root)
----

# Pin the cohort admission quorum at strict majority — review handoff

## What was decided

Maintainer decision (2026-10-04): the admission quorum — how many cohort members must be willing to serve a tier before the cohort takes it on for a topic — is a strict majority `⌊k/2⌋ + 1` (9 at `k = 16`), computed by `defaultQuorum` in `packages/db-core/src/cohort-topic/willingness.ts`, overridable through `WillingnessConfig.quorum`. It is deliberately separate from the threshold-signature `minSigs = k − x`. The code already implemented this; only the doc lacked it.

## What changed

Documentation only, plus one source comment. No behaviour or test change.

- New `### Admission quorum` subsection at the end of §Tier ladder (anchor `#admission-quorum`) — the single definition. Covers: the value; what is counted (routed member if live-willing + gossiped-willing siblings); the cohort size it is taken of (`wantK` for a FRET cohort, the root group's member count at a root-placed root, read once at engine creation); that a root-placed root signs under `ceil(memberCount × quorumRatio)` but admits under the group majority; that the override exists only for a caller building the check itself — the db-p2p host passes only `cohortSize`, so a host-built node always uses the majority; why it is not `k − x` (a cohort with three Edge members, which never set T2/T3 bits, would count at most 13 willing and answer `UnwillingCohort` while 13 would serve); why not per-tier ratios; and the revisit condition.
- §Tier ladder's "requires a quorum of members" sentence now names the admission quorum and links the subsection.
- §Willingness: the three outcome bullets reordered so the quorum gate comes first, matching `GossipWillingnessCheck.evaluate` (a *willing* routed member in a cohort short of the quorum still returns `UnwillingCohort`). The old third bullet ("gossip indicates no member … will serve") was inaccurate — the trigger is "fewer than the quorum", not "none".
- §Cold-start instantiation's third admission condition links the admission quorum.
- §Promotion / §Demotion: **deviation from the implement ticket's TODO.** The TODO said to make these sections "refer to that one definition", but their "for a quorum of members" is the threshold signature (`minSigs` signers on the notice — see the module header of `packages/db-core/src/cohort-topic/promotion.ts`), not the admission quorum. Pointing them at the admission quorum would have merged the two numbers the decision says must stay apart. They now say `minSigs` members sign the notice, and Promotion says explicitly that this is the signing threshold, not the admission quorum. Wording deliberately avoids claiming endorsers re-check the promotion trigger — the `/sign` endorser (`handleSignRequest` in `packages/db-p2p/src/cohort-topic/host.ts`) does not do that today.
- §RouteAndMaybeAct usage: the `minSigs` bullet notes that registration admission counts the separate admission quorum. (The ticket's "§Wire formats minSigs note" — the only `minSigs` statement about registration is this bullet, in §FRET integration; the wire-format interface comments `signers: … ≥ minSigs` were left alone as correct.)
- §Configuration → Defaults: the `k − x` row now names `minSigs`; a new "admission quorum" row gives the default, the why-not-`k − x` reason, the override, and the revisit condition, linking the subsection.
- `WillingnessConfig.quorum` doc comment: dropped the now-false "Not pinned by `docs/cohort-topic.md`" and points at §Admission quorum.

## Validation

- `yarn lint:docs` — all citations and links resolve (47 documents).
- `yarn workspace @optimystic/db-core build` — rebuilt so the build-freshness guard does not refuse other packages' tests after the comment edit.
- `yarn test -- --grep "willingness"` in `packages/db-core` — 15 passing (includes the existing `defaultQuorum(16) = 9`, `defaultQuorum(4) = 3` assertions).

## Tests

None added. The decision is already pinned by the existing `defaultQuorum` assertions in `packages/db-core/test/cohort-topic/willingness.spec.ts`; this change is prose.

## For the reviewer

- Check the new subsection reads correctly against `GossipWillingnessCheck` (`packages/db-core/src/cohort-topic/willingness.ts`) and the `config: { cohortSize: … }` wiring in `createCohortTopicHost`.
- Judge whether the §Promotion/§Demotion deviation above is the right reading of the decision.
- The pre-existing editor diagnostic "`now` is declared but never read" in `GossipWillingnessCheck.evaluate` is not from this change (interface parameter).
- The simulator (`packages/substrate-simulator/src/willingness.ts`, `backoff.ts`) takes the quorum as a parameter and was not touched.
