description: A machine that offers itself for a matchmaking task and then looks for partners on that same task silently drops out of the list of available machines, because its search registers under the same identity and overwrites its own offer.
architecture: docs/matchmaking.md#overview
files: packages/db-core/src/cohort-topic/registration/store.ts, packages/db-p2p/src/matchmaking/query-transport.ts (`createLibp2pMatchmakingTransport`, the walk's `register`), packages/db-p2p/src/matchmaking/seeker-keep-alive.ts (`SeekerKeepAlive.withdraw`), packages/db-p2p/src/matchmaking/seeker-manager.ts, packages/db-p2p/test/matchmaking-small-network.integration.spec.ts, docs/matchmaking.md
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: The fix needs a design call (whether one peer may hold both roles on a topic, and how the record is keyed), and the defect only bites a peer that provides and seeks on one topic, so a maintainer may first want to know whether any application does that.
----
# A seeker walk by a provider replaces the provider's own registration

## What happens

A cohort's registration store keeps one record per (topic, participant) (`createRegistrationStore` in `packages/db-core/src/cohort-topic/registration/store.ts`), and the participant is the registering peer's id. A provider registers through `MatchmakingProviderSession` under its node's peer id. A seeker walk from the same node (`createLibp2pMatchmakingSeekerSession` → `createLibp2pMatchmakingTransport`, whose walk registers a seeker `RegisterV1` with `participantCoord` = the node's own id) registers under that same id, so its record replaces the provider's: the provider's `appState` becomes the seeker's payload and the cohort stops listing the node as a provider. When the walk ends it withdraws its registration (`SeekerKeepAlive.withdraw`), which removes the record outright.

Observed on one real node at the cohort-topic defaults (found while writing `packages/db-p2p/test/matchmaking-small-network.integration.spec.ts`): after the provider registered, a `QueryV1` listed it; after a seeker walk on the same node for the same topic, the walk returned no providers and a second `QueryV1` listed neither a provider nor a seeker.

## Who meets it

- Every one-machine deployment that both offers and looks for a task: the only provider is itself, and looking removes it.
- Any node that is both a provider and a seeker on one topic, at any network size. The voting use case is the likely one: a coordinator that is also an eligible voter registers as a provider on the quorum topic (`registerEligibleVoter`) and then assembles the quorum by walking the same topic, which drops it from the quorum it is assembling.

## Expected behaviour

A node's search must not silently remove its own offer. `docs/matchmaking.md` §Overview says a participant "adopts one of two roles" but not whether one peer may hold both on one topic, so the first step is that decision. Either one peer can hold a provider and a seeker registration on one topic at once (records distinguished by more than the participant id), or it cannot, and the seeker side then refuses or skips registering where its node holds a provider registration for the topic, saying so, rather than overwriting it.

The small-network spec queries instead of walking at one machine because of this; once fixed, that case can walk like the others.
