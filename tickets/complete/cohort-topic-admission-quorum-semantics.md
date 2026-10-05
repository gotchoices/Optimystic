description: The cohort-topic design doc now states how many willing members a cohort needs before it takes on a tier (a strict majority, configurable) and why that number is deliberately different from the signing threshold.
files:
  - docs/cohort-topic.md (§Tier ladder → §Admission quorum; §Willingness; §Promotion; §Demotion; §Cold-start instantiation; §RouteAndMaybeAct usage; §Configuration → Defaults)
  - packages/db-core/src/cohort-topic/willingness.ts (`WillingnessConfig.quorum` doc comment)
  - packages/db-core/src/cohort-topic/coldstart.ts (`ColdStartTrigger.quorumWilling`, `shouldInstantiate` doc comments)
  - packages/db-core/src/cohort-topic/member-engine.ts (`CohortMemberEngineDeps.quorumWilling` doc comment)
----

# Pin the cohort admission quorum at strict majority

## Summary

Maintainer decision (2026-10-04): the admission quorum (how many cohort members must be willing to serve a tier before the cohort takes it on for a topic) is a strict majority `⌊k/2⌋ + 1`, 9 at `k = 16`. It is computed by `defaultQuorum` in `packages/db-core/src/cohort-topic/willingness.ts` and can be overridden through `WillingnessConfig.quorum`. It is deliberately separate from the threshold-signature `minSigs = k − x`. The code already did this. The work was documentation: the implement pass (`ticket(implement): cohort-topic-admission-quorum-semantics`) added `docs/cohort-topic.md` §Admission quorum, reordered the §Willingness outcomes to match `GossipWillingnessCheck.evaluate`, made §Promotion and §Demotion name `minSigs` signers rather than "a quorum", added a Defaults row, and updated the `WillingnessConfig.quorum` comment. No behaviour changed.

## Review findings

Checked against the code: `GossipWillingnessCheck.evaluate` and `defaultQuorum` (willingness.ts); the `createWillingnessCheck` wiring in `createCohortTopicHost` (packages/db-p2p/src/cohort-topic/host.ts), which passes `cohortSize = wantK`, or the root group's size for a root-placed root; `StoreCohortMemberEngine.handleRegister`, `admitOrDecline` and `decideOnceMembersAnswer` (member-engine.ts); `shouldInstantiate` (coldstart.ts); and the promotion.ts module header.

- **Correct as written:** the quorum value; what gets counted (the routed member if it is live-willing, plus siblings whose gossip says they are willing); quorum-first ordering in §Willingness, including a willing member in a short cohort getting `UnwillingCohort`; the root-placed root signing under `ceil(memberCount × quorumRatio)` while admitting under the group majority; the override existing only for callers that build the check themselves; and the Edge arithmetic (16 − 3 = 13 < 14).
- **The implement pass changed §Promotion and §Demotion differently from what its ticket asked, and it was right to.** promotion.ts states that the promotion "quorum" is enforced by the threshold signature (`minSigs` signers). Pointing those sections at the admission quorum would have merged the two numbers the decision keeps apart.
- **Fixed inline (minor, but a false claim): the cold-start gate does not check the admission quorum.** The new subsection, and the third condition in §Cold-start instantiation (that wording predates this ticket), said the cold-start admission gate requires the admission quorum. In the code it does not. The host wires `quorumWilling` to `ctx.profile.willingTiers.has(tier)`, which only asks whether the routed member's own profile serves the tier. The forwarder is instantiated first. After that, `admitOrDecline` applies the admission quorum to the register. The code has to work this way: the cold-start quorum wait needs the forwarder to exist already (`decideOnceMembersAnswer` checks `serves(topicId)`), and the doc's own "Convergence" paragraph describes instantiation happening before the quorum check. Corrected:
  - §Admission quorum now says the quorum decides the register that cold-starts a forwarder, but is not part of the instantiation gate, and gives the reason.
  - §Cold-start instantiation's third condition now reads "the routed member is itself willing", followed by a paragraph saying the admission quorum then decides the register, and why instantiation comes first.
  - The implementation note now calls `shouldInstantiate` the "instantiation gate" instead of the "admission gate".
  - The opening sentence of *Bootstrapping a cold multi-node cohort* now refers to admitting the register that passed the gate.
  - The doc comments on `ColdStartTrigger.quorumWilling`, `shouldInstantiate` and `CohortMemberEngineDeps.quorumWilling` no longer say "a quorum of members". The field name `quorumWilling` is still misleading. I left it alone: renaming it touches three source files and three spec files for no behaviour change, and the corrected comments now describe what it means.
- **Tripwire, not filed:** if a cold start's register is declined, the forwarder it instantiated stays behind with no participants. The registration gate is unaffected, because every later register goes through `admitOrDecline` again, and the topic budget evicts a forwarder with zero participants first. So the cost is one budget slot until eviction. §Tier ladder's "doesn't take on T duties … at all" is true of registrations, not of forwarder state. I added no `NOTE:`, because the "Convergence" paragraph already describes this lifecycle.
- **Tests:** none added or cut. `defaultQuorum` is already pinned by `packages/db-core/test/cohort-topic/willingness.spec.ts`, and every change here is prose or comments.
- **Docs:** `yarn lint:docs` passes (47 documents, every citation resolves). docs/internals.md does not describe the admission quorum and needed no change. The simulator (`packages/substrate-simulator`) takes the quorum as a parameter and needed no change.
- **Other aspects (performance, resource cleanup, error handling, type safety):** nothing to check. No executable code changed.

Validation: `yarn lint` passes, `yarn lint:docs` passes, `yarn workspace @optimystic/db-core build` passes, and `yarn test` in packages/db-core passes (1866).
