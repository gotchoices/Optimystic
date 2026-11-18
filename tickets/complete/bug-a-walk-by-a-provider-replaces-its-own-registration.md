description: A machine that offers itself for a matchmaking task and then searches for partners on that same task used to drop out of the list of available machines; its search now looks without registering whenever its machine already holds a registration for the task, and never withdraws that registration.
architecture: docs/matchmaking.md#overview
files: packages/db-core/src/cohort-topic/service.ts (`CohortTopicService.holds`, `CohortTopicService.isLive`), packages/db-p2p/src/matchmaking/query-transport.ts (`createLibp2pMatchmakingTransport`, `createLibp2pMatchmakingSeekerSession`), packages/db-p2p/src/matchmaking/seeker-keep-alive.ts (`SeekerKeepAlive`, `stillOurs`), packages/db-p2p/src/matchmaking/seeker-manager.ts (`MatchmakingSeekerManager`, `TopicRegistrationHeldError`), packages/db-p2p/src/matchmaking/module.ts (`MatchmakingSeekerSession.register`), packages/db-p2p/test/matchmaking/query-transport-client.spec.ts, packages/db-p2p/test/matchmaking/managers.spec.ts, packages/db-p2p/test/matchmaking-small-network.integration.spec.ts, docs/matchmaking.md, docs/internals.md
repro: verified
----
# A seeker walk by a provider no longer replaces the provider's own registration

## What was wrong

A topic's cohort keeps one registration record per (topic, machine), keyed by the machine's peer id; renew and withdraw frames are matched by that pair alone (`onRenew` in `packages/db-core/src/cohort-topic/registration/renewal.ts`). A matchmaking seeker walk registered through `createLibp2pMatchmakingTransport` with its own `RegisterV1` under the same id, bypassing the node's `CohortTopicService`, so the walk's record replaced the machine's provider record and its closing withdraw removed it. The provider reappeared only when its own renewal loop gave up and re-walked, about one provider TTL later.

## What changed

The rule is one registration per machine per topic (`docs/matchmaking.md` §Overview).

- `CohortTopicService.holds(topicId)` and `CohortTopicService.isLive(handle)` say whether the machine holds a live registration for a topic, and whether a handle is still it.
- The walk transport takes a required `localRegistrations` (the session fills it from its `service`). While it holds a registration for the topic, every tier's register goes out as a read-only probe (`RegisterV1.probe`, no bootstrap, evidence or payload), the walk keeps nothing alive, and a walk that starts that way subscribes to no arrival pushes.
- `SeekerKeepAlive` checks `stillOurs` before each renew and withdraw, and forgets the walk's registration without sending anything once the machine has registered for the topic another way.
- `MatchmakingSeekerManager.register` refuses with `TopicRegistrationHeldError` while the machine holds another live registration for the topic; a provider registering over a brief seeker registration is allowed.
- Docs: `docs/matchmaking.md` §Overview states the rule and what a provider's walk gives up; `docs/internals.md` §Public module carries one sentence.

The work landed as `ticket(implement): bug-a-walk-by-a-provider-replaces-its-own-registration`, with the review changes below on top.

## Review findings

**Checked.** Read the implement diff first, then the cohort side it relies on: `StoreCohortMemberEngine.handleProbe` (a probe admits nothing, never instantiates, and answers `accepted`/`promoted`/`no_state` as a register would, so `SeekerWalkClient` drives it unchanged), `registerSigningPayload` (signs `probe`) and `validateRegisterV1` (probe is mutually exclusive with bootstrap and follow-on, which the probe frame respects), `onRenew` (withdraw matches (topic, participant) only, which confirms the premise), and `CohortTopicService.withdraw`'s identity guard. Traced the mid-walk transitions (holds turning true after an accepted register, and false again before the next tier) through `walkTransport` and the keep-alive; none sends something it should not. Checked every caller of `createLibp2pMatchmakingTransport` (tests only; no composition root builds a seeker session yet) and every `CohortTopicService` test double.

**Found and fixed: a seeker session could not re-register its own topic (correctness, minor).** `MatchmakingSeekerSession.register` builds a new `MatchmakingSeekerManager` on every call, so the manager's exemption for re-registering over its own handle never applied in practice: the second `register` of one topic on one session found the first registration held, not by this manager, and threw `TopicRegistrationHeldError`. The implementer's test exercised the exemption by calling `register` twice on one manager, which is not the path the session takes. Fixed by `MatchmakingSeekerManagerOptions.replaces`: the session passes its previous manager's registration, and the manager treats it as its own while it is still the live registration for the same topic (topic compared with `bytesEqual`, so a live handle for another topic never exempts). The test's second arm now goes through the session; it failed before the fix with `TopicRegistrationHeldError` and passes after.

**Found and fixed: duplicated frame construction (DRY, minor).** `buildSeekerRegister` and the new `buildSeekerProbe` repeated the frame's common fields and its signing. Extracted `seekerFrameBody` and `signRegisterFrame` inside `createLibp2pMatchmakingTransport`; the probe builder is now one expression.

**Tripwire parked.** A probe counts against the cohort's probe rate limit, and an over-rate probe ends the walk with `unwilling_cohort`; one probe per tier per walk is far under it. `NOTE:` at `buildSeekerProbe` in `packages/db-p2p/src/matchmaking/query-transport.ts`.

**Accepted as handed off, not re-filed.**
- A register still walking is not "held", so a walk started while the same machine's provider `register` is in flight registers over it. Narrow (concurrent calls from one machine); already a `NOTE:` at `holds` in `packages/db-core/src/cohort-topic/service.ts`.
- A walk whose machine registers as a provider mid-walk keeps its push subscription; its safety poll covers the pushes it loses (comment in `walkTransport`).
- When the keep-alive stops on `stillOurs`, a walk record left at a different tier's cohort than the one the provider landed at lingers until the seeker TTL (10 s) instead of being withdrawn. That is the safe direction: the walk cannot tell which cohort the provider landed at, and a withdraw at the same cohort would remove the provider.
- The mock mesh harness (`buildWalkTransport` in `packages/db-p2p/src/testing/matchmaking-mesh-harness.ts`) keeps its own register path without the rule; `docs/matchmaking.md` says so.
- `holds` counts any registration the service holds, so a session's own brief seeker registration makes that session's walks probe. That is the rule as written: that registration is the machine's registration there.

**Tests.** The implementer's transport table test (three cases, each frame checked wire-valid and correctly signed) is the reproduction at the lowest layer and stays. The manager test's own-handle arm was replaced by the session-level arm above. No other test was added or cut; the updates to the other test doubles are interface conformance only.

**Docs.** Re-read `docs/matchmaking.md` §Overview and `docs/internals.md` §Public module against the final code; both still hold (the refusal is of "another" registration, which the `replaces` fix makes true for a session). No other doc lists the `CohortTopicService` interface.

**Validation.** db-p2p `tsc --noEmit` (src and test) clean; eslint on every changed file clean; db-p2p rebuilt; full db-p2p unit suite (`yarn workspace @optimystic/db-p2p test`) 3722 passing, 84 pending. Integration, with `OPTIMYSTIC_INTEGRATION=1`, over `substrate-real-libp2p.integration.spec.ts` (the run the handoff said was missing; every matchmaking case passes, including the push-opted walk that now passes `localRegistrations`) and `matchmaking-small-network.integration.spec.ts` (1, 2 and 3 machines pass): 15 passing, 2 pending (existing unimplemented or covered-elsewhere markers).

**Empty categories, with reasons.** Resource cleanup: nothing new to release (the probe path subscribes to nothing, and the keep-alive's forget path drops its only state). Performance: `holds` is one map lookup per tier; nothing else added. Type safety: no `any` and no casts added.
