description: A node that has a signing key now starts a new network watch by signing a small endorsement of its own request instead of solving a proof-of-work puzzle a phone cannot finish in time; the puzzle remains only for participants with no key. The documents now say what actually limits cold starts.
architecture: docs/cohort-topic.md#anti-dos
files: packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts, packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts, docs/cohort-topic.md, docs/reactivity.md, docs/debugging.md
----
GitHub: [#31](https://github.com/gotchoices/Optimystic/issues/31). Maintainer decision (2026-10-07): option A. Honest nodes sign their own endorsement, and proof of work stays only as the fallback for participants with no key. The thread-blocking half of #31 landed earlier (`pow-mint-yields-the-thread-and-stops-before-its-timestamp-goes-stale`).

## What changed

Only the participant side changed. The verifier, the policy and the wire format are untouched. Security is the same as before, because the free path (a self-vouch from a never-seen key) was already open to anyone who read the verifier. Before this change, our own builder chose proof of work, so only honest nodes paid for it.

**Builder** (`createBootstrapEvidenceBuilder`, `bootstrap-evidence-builder.ts`):

| tier | `endorse` supplied | `endorse` absent |
| --- | --- | --- |
| ≤ `maxNoPowTier` (T0/T1) | `undefined` (was a self-endorsement) | `undefined` |
| > `maxNoPowTier` (T2/T3) | `{ v: 1, reputation }` with no proof-of-work search (was proof of work) | proof of work, unchanged |

- T0/T1 no longer endorses, because the policy reads only a parent reference at those tiers.
- A tripwire `NOTE:` sits at the T2/T3 endorse branch. A serving group that has the key banned or deprioritized refuses the endorsement, and the builder does not fall back to proof of work.
- The module header and the `endorse` and `maxNoPowTier` field docs were rewritten to match.

**Host** (`createCohortTopicHost`, `host.ts`): when `options.privateKey` is set, `endorse` signs the bound image with `signPeer(nodeKey, …)` and names the referee `bytesToB64url(selfMemberBytes)`. That is the same identity and key the register is signed with. The block comment and the module header's anti-DoS sentence were rewritten. `ReputationEvidenceV1` is now imported as a type from db-core.

**Verifier** (`createReputationVerifier`): no behaviour change. An accepted-tradeoff `NOTE:` in its doc comment says a fresh-key self-vouch is free. Its revisit condition is real fresh-key cold-start abuse, in the form of topic-budget eviction of live topics or the coordinate-engine cap refusing coordinates. The fix then would be option B: a "trusted" reputation level plus proof of work that phones can pay. That needs a rollout note.

**Docs:**
- `docs/cohort-topic.md` §Anti-DoS: the "Cold-start requires evidence" bullet now says:
  - a node with a key self-endorses and a node without one mints proof of work;
  - neither costs an abuser anything, because a fresh key is free;
  - what does bound cold starts is the rate limit, `topics_max`, `coordEnginesMax`, the replay guard and reputation bans;
  - proof of work cannot be lowered per device.

  The Proof-of-work and Reputation-endorsement implementation sub-bullets were rewritten too, and one "uses PoW for T2/T3" became "uses an endorsement or PoW".
- `docs/reactivity.md`, Attach bullet: the register carries the subscriber's self-endorsement, or proof of work on a node with no key. The 0.3–17 s figures were removed because they measured the proof. No new number was added, since none was measured. The 22–111 ms cohort-wait figure stays.
- `docs/debugging.md`, `cohort-topic` row: the abandoned-mint log line is now described as a key-less participant's, and the row notes that a node with a key never mints.

## Tests

- **Replaced**, in `bootstrap-evidence-verifiers.spec.ts` (`createBootstrapEvidenceBuilder`): the old "mints a self-vouch … for T0/T1" test is now "with an endorse capability, self-endorses at T2 without searching for a proof-of-work, and offers nothing at T0/T1". The test makes proof of work impossible (`bits: 256`, `maxIterations: 1 << 30`) and sets `timeBudgetMs: 500`, so a regression back to proof of work fails fast on the "self-endorses" assertion instead of hitting mocha's timeout. It checks three things:
  - the T2 envelope has `reputation` and no `pow`;
  - `createReputationVerifier` accepts it;
  - T0 and T1 return `undefined`.
- The keyless tests are unchanged: T0/T1 → `undefined` with no endorse, plus the proof-of-work mint, iteration-cap and time-budget tests.
- The host wiring has no separate test, by design. It is covered indirectly by the integration suites, whose real nodes have a key and a reputation view.

## Validation run

- `yarn workspace @optimystic/db-p2p build`: clean.
- `yarn test` in `packages/db-p2p`: 3274 passing, 70 pending.
- `yarn lint:docs`: all citations resolve.
- `eslint` on the four changed db-p2p files: clean.
- `yarn test:integration` in `packages/db-p2p`: 50 passing, 2 pending. This includes the reactivity-watch and matchmaking real-socket cold starts, which now self-endorse.
- `yarn test:integration` in `packages/quereus-plugin-optimystic`: 1007 passing, 8 pending.
- The root `yarn check` was not run as a whole. Its other parts (build of other packages, `check:rn`, `lint:deps`) cover nothing this diff touches.

## Edge cases checked (by inspection)

- **Keyless host.** `endorse` is undefined, so T2/T3 mints proof of work exactly as before.
- **A serving node with verifier overrides but no reputation view.** Its reputation verifier denies, so a self-endorsement is refused. Production always wires `reputation` (`libp2p-node-base.ts`). Of the test harnesses:
  - `reactivity-mesh-harness.ts` and `matchmaking-mesh-harness.ts` set `antiDos` with no reputation view and no override. Per `createBootstrapEvidencePolicy` that is *unconfigured*, and so permissive at every tier.
  - `host-antidos-coldstart.spec.ts` builds its evidence by hand.
  - The `cohort-topic-scale-antiflood.spec.ts` banned-reputation case runs at T0, where the builder already returned `undefined`.
- **Self-scoring.** `PeerReputationService` refuses reports about its own node, so a node serving its own register scores itself 0.
- **Follow-on cold start** (`followOn: true` at a deeper tier). The service calls the same builder with the application tier (`body.tier`), so it endorses the same way.
- **Mixed versions.** An old serving node runs the same reputation verifier, and a new serving node still accepts an old participant's proof of work.
- **Matchmaking.** Providers and seekers now self-endorse at T2/T3 too. This is intended.

## Known gaps / for the reviewer

- No measurement was taken of the new first-attach latency on the reactivity mesh. The docs deliberately give no figure. Someone could measure it on the three-machine mesh if a number is wanted in `docs/reactivity.md`.
- A participant whose key is banned or deprioritized at the serving group now cannot cold-start at T2/T3, where before it could pay proof of work. This is recorded as the builder `NOTE:` tripwire and was accepted in the plan. The register reply (`unwilling_cohort`) does not say the refusal came from the evidence.
- The keyless test name "returns undefined for T0/T1 with no endorse capability (parent-reference origination is the follow-on)" still names the follow-on loosely. It was left alone because the ticket said to keep it as is.
