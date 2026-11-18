description: A machine that offers itself for a matchmaking task and then searches for partners on that same task drops out of the list of available machines, because its search registers under the same identity and overwrites its offer; the search should look without registering whenever its machine already holds a registration for the task.
architecture: docs/matchmaking.md#overview
files: packages/db-core/src/cohort-topic/service.ts (`CohortTopicService`), packages/db-p2p/src/matchmaking/query-transport.ts (`createLibp2pMatchmakingTransport`, `createLibp2pMatchmakingSeekerSession`), packages/db-p2p/src/matchmaking/seeker-keep-alive.ts (`SeekerKeepAlive`), packages/db-p2p/src/matchmaking/seeker-manager.ts (`MatchmakingSeekerManager`), packages/db-p2p/test/matchmaking/query-transport-client.spec.ts, packages/db-p2p/test/matchmaking-small-network.integration.spec.ts, packages/db-p2p/src/testing/matchmaking-mesh-harness.ts, docs/matchmaking.md, docs/internals.md
repro: verified
----
# A seeker walk by a provider replaces the provider's own registration

## The defect

A topic's cohort keeps one registration record per (topic, participant), and the participant is the registering machine's peer id (`createRegistrationStore` in `packages/db-core/src/cohort-topic/registration/store.ts`; renew and withdraw frames are matched by the same pair, not by correlation id). A provider registers through the node's `CohortTopicService` (`MatchmakingProviderSession` → `MatchmakingProviderManager`). A seeker walk from the same machine registers through `createLibp2pMatchmakingTransport`, which builds its own `RegisterV1` with `participantCoord` = the node's id and dials the cohort directly, bypassing the service. So the walk's record replaces the provider's: the record's `appState` becomes the seeker payload and the cohort lists the machine as a seeker. When the walk ends, `SeekerKeepAlive.withdraw` sends a withdraw tombstone for the pair and the record is removed outright.

The provider's own renewal loop eventually repairs this: once the record is gone, three failed pings make it re-walk and re-register (`registration/renewal.ts`), so the provider reappears roughly one provider TTL (60–90 s) after the walk ended. Until then it is absent, and during the walk it is listed as a seeker.

The reverse order has the same shape: a provider registering while its machine's walk is hanging out overwrites the walk's record (acceptable — the offer should win), but the walk's later withdraw then removes the provider record.

## Reproduction (run, observed)

On the mock matchmaking mesh (`buildMatchmakingMesh` in `packages/db-p2p/src/testing/matchmaking-mesh-harness.ts`), with providers on nodes 0 and 1 and a seek from node 0 (`mm.provide(0,…)`, `mm.provide(1,…)`, `mm.seek(0, 'task', 'self', 2, { dMax: 1, patienceMs: 1_000 })`): before the walk a query from node 2 listed both providers; the walk found only node 1; a query afterwards listed only node 1. The harness builds its own walk transport, not the libp2p one, and its `seek` doc already warns callers off this case ("a seeker register and a provider register from the same node collide"). On real TCP, one machine at cohort-topic defaults, the same was observed with `createLibp2pMatchmakingSeekerSession` (the original report; the one-machine case of `packages/db-p2p/test/matchmaking-small-network.integration.spec.ts` queries instead of walking because of it).

## Decision: one registration per machine per topic

`docs/matchmaking.md` §Overview says a participant "adopts one of two roles", and the substrate already enforces one live registration per (topic, machine) on the participant side: `CohortTopicService` keys its live renewals by `(topicId, participantId)`, and a second `register` for a topic displaces the first handle (the accepted `NOTE:` in `startRenewal`). The matchmaking walk transport is the one path that registers without going through the service, so it breaks that rule silently. The fix makes it obey the rule rather than changing the record key:

- **A machine holds at most one matchmaking registration per topic.** Whatever registration its `CohortTopicService` holds for the topic (in practice a provider's) is its registration there.
- **A walk from a machine that holds a registration for the topic looks without registering.** Each tier's register goes out as a read-only probe (`RegisterV1.probe: true`, the same frame `CohortTopicService.lookup` sends): the cohort answers with its classification and traffic snapshot exactly as it would to a register, and admits nothing (`handleProbe` in `packages/db-core/src/cohort-topic/member-engine.ts`). Queries are unchanged. The walk then has no seeker record, so it gets no arrival pushes and polls instead, and other seekers do not see it as a seeker. Its own provider record is in every query reply, so the machine finds itself — which is what a coordinator that is also an eligible voter wants (`registerEligibleVoter`, then a quorum walk on the same topic).
- **A walk never renews or withdraws a record its machine registered through the service.** If the service comes to hold a registration for the topic while the walk is live (the reverse order above), the walk's keep-alive stops pinging and its withdraw forgets the registration without sending a tombstone.
- **A brief seeker registration does not displace another of the machine's registrations.** `MatchmakingSeekerManager.register` (through `MatchmakingSeekerSession.register`) refuses with a clear error when the service holds a live registration for the topic that is not this manager's own handle. A provider registering over a brief seeker registration is allowed (the offer wins); the seeker manager's handle then goes stale and its withdraw is already a no-op (`CohortTopicService.withdraw`'s identity guard).

Rejected alternative: let one machine hold a provider and a seeker record on one topic at once, by adding a role (or registration) discriminator to the record key. It needs a new field on `RegisterV1` and `RenewV1` (both signed images), in gossip deltas and handoff inventories, in the store and its indexes, and in the service's live-renewal map — a cohort-topic wire change for every application — to buy arrival pushes for a machine that is searching its own topic. Reversibility: the chosen rule changes no wire format or stored state, so adopting the alternative later replaces it without a migration.

## Expected behaviour after the fix

- A provider that walks its own topic stays listed as a provider for the whole walk and after it; its walk returns its own entry among the providers.
- A walk that started before its machine registered as a provider does not remove the provider record when it ends.
- `docs/matchmaking.md` §Overview states the one-registration-per-machine-per-topic rule and what a provider's walk gives up (arrival push, being visible as a seeker).

## Design notes for the implementer

- **The node-level source of truth is the service.** Add a read to `CohortTopicService`, e.g. `holds(topicId): boolean` ("this machine holds a live registration for the topic") and `isLive(handle): boolean` (the existing private `liveRenewal` check), documented on the interface. `renewals` is keyed by `recordKey(topicId, participantId)`, so `holds` is one map lookup.
- **The transport needs that read.** `Libp2pMatchmakingTransportDeps` gains a field carrying it (e.g. `localRegistrations: Pick<CohortTopicService, "holds">`); `createLibp2pMatchmakingSeekerSession` fills it from `deps.service`. Prefer making it required: an optional field defaulting to "holds nothing" reproduces this defect for any caller that forgets it. Callers today: `createLibp2pMatchmakingSeekerSession`, `packages/db-p2p/test/matchmaking/query-transport-client.spec.ts`, `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`, `packages/db-p2p/test/matchmaking-small-network.integration.spec.ts`.
- **Probe, not register, per tier.** In `walkTransport`'s `register`, read `holds(topicId)` on each call (so the reverse order is covered from the next tier on). When held, build the frame with `probe: true`, no `bootstrap`, no bootstrap evidence and no `appPayload` (`registerSigningPayload` already covers `probe`), send it through the same `dialRegister` (a self-routed probe goes through `selfServe.register`, whose routed admission path branches on `probe` first), and do not call `keepAlive.accepted`. Log once per walk that the walk is looking without registering and why.
- **Keep-alive guard.** Give `SeekerKeepAlive` a predicate (e.g. `stillOurs(): boolean`, bound to `() => !holds(topicId)`) checked before every renew ping and before the withdraw: when false, `renew` sends nothing and `withdraw` forgets the live registration without sending, logging that the machine's own registration replaced the walk's record.
- **Push subscription.** When `holds(topicId)` is already true at `walkTransport()` construction, build the walk without a push receiver (poll path) rather than subscribing to pushes that cannot come. A walk whose machine registers mid-walk keeps its subscription; its safety poll covers the missing pushes.
- **Mock mesh harness.** `buildWalkTransport` in `packages/db-p2p/src/testing/matchmaking-mesh-harness.ts` has its own register path and does not go through the libp2p transport. Leave it as it is (its `seek` doc already tells callers to pick a non-provider node) unless mirroring the probe rule there is cheap; do not add a mesh test that exercises only the harness's copy of the rule.

## Tests

- **Reproduction at the transport.** In `packages/db-p2p/test/matchmaking/query-transport-client.spec.ts`, using its existing self-routed `selfServe` pattern: with `holds` true, a walk register sends a frame with `probe: true` and no `appPayload`, and `close()` sends no withdraw; with `holds` false, the register is a normal register and `close()` withdraws (one test per branch, or one table-driven test). A case where `holds` turns true after an accepted register, asserting the withdraw is not sent, covers the reverse order.
- **The seeker manager refusal** gets one unit case if `packages/db-p2p/test/matchmaking/managers.spec.ts` can drive it with its existing service double; skip it if that needs a new double of the service.
- **End to end.** In `packages/db-p2p/test/matchmaking-small-network.integration.spec.ts`, remove the one-machine `query` branch so that case walks like the two- and three-machine ones, and after the walk assert a one-shot query still lists the provider. It is env-gated (`OPTIMYSTIC_INTEGRATION=1`); run it with `yarn workspace @optimystic/db-p2p test:integration --grep "smaller than one cohort"` if wall-clock allows, and say in the handoff whether it ran.

## TODO

- Add `holds(topicId)` and `isLive(handle)` to `CohortTopicService` (interface + implementation) in `packages/db-core/src/cohort-topic/service.ts`.
- Add the registrations read to `Libp2pMatchmakingTransportDeps`; wire it in `createLibp2pMatchmakingSeekerSession`; update the other callers.
- In `walkTransport`: probe instead of register while the machine holds a registration for the topic; no push receiver when it already holds one at construction; log once.
- Add the ownership predicate to `SeekerKeepAlive`; skip renew pings and the withdraw tombstone when the record is no longer the walk's.
- `MatchmakingSeekerManager.register`: refuse when the service holds a live registration for the topic that is not this manager's own handle.
- Tests as above; rebuild db-core before running db-p2p tests (the build-freshness guard refuses a stale build).
- `docs/matchmaking.md` §Overview: state the rule and what a provider's walk gives up; mention the voting coordinator that is also a voter. Update the *Public module* paragraph of `docs/internals.md` §Matchmaking subsystem in one sentence. Run `yarn lint:docs`.
- Remove the comment in the small-network spec that points at this ticket.
