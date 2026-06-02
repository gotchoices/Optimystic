description: Correct architecture.md overstatement that reactivity and matchmaking run today to design-only status, and add a Doc Sync Status section.
prereq:
files: docs/architecture.md
effort: low
----

## Context

`docs/architecture.md` §"Cohort Topics, Reactivity, and Matchmaking" (currently L233–240) claims:

> Two applications run on the substrate today:

This is false. Verified against the codebase (2026-06-02): the networked cohort-topic substrate, the reactivity push-tree, and the matchmaking directory are **DESIGN-ONLY**. A repo-wide grep for `RegisterV1`, `PromotionNoticeV1`, `CohortGossipV1`, `MembershipCertV1`, `NotificationV1`, `SubscribeAppPayloadV1`, `ProviderAppPayloadV1`, `QueryReplyV1`, `RouteAndMaybeAct`, etc. returns zero matches. None of the three subsystems exist in code.

What *does* exist is a **local, single-node** change-notification primitive — not the networked reactivity:

- `packages/db-core/src/transactor/change-notifier.ts` — `IBlockChangeNotifier.onCollectionChange` + `CollectionChangeEvent { collectionId, blockIds, actionId, rev }`
- `packages/db-p2p/src/storage/storage-repo.ts` — emits the event when a commit's critical section completes **on that node**
- `packages/db-core/src/transactor/network-transactor.ts` (~L75–80) — forwards to an optional `localChangeNotifier`, else a logged no-op
- `packages/quereus-plugin-optimystic/src/optimystic-module.ts` + `optimystic-adapter/collection-factory.ts` — bridge the local signal into Quereus vtab reactivity

The signal only reaches listeners in the **same process** where the commit was applied. There is no cross-node delivery, no DHT, no cohort. The networked reactivity push-tree must be built on top of this primitive.

## Required edits to docs/architecture.md

1. **Fix the overstatement.** Replace "Two applications run on the substrate today:" with language stating that both reactivity and matchmaking (and the networked cohort-topic substrate itself) are **specified / design-only with zero implementation**, and that a **simulator phase validates the design's quantitative claims before the core protocols land**. Keep the two bullet descriptions of reactivity and matchmaking but reframe them as designed behavior (e.g., "designed to fan out…" rather than "fan out…").

2. **Forward references.** Point readers to [cohort-topic.md](cohort-topic.md), [reactivity.md](reactivity.md), [matchmaking.md](matchmaking.md) for the specs, and to the simulator phase for design validation.

3. **Clarify the local primitive.** Add a short paragraph explaining that the existing `IBlockChangeNotifier` / `change-notifier.ts` / `storage-repo.ts` / `network-transactor.ts` change-notifier is a **single-node, in-process** primitive, and that the networked push-tree is being built **on top of** it (the bridge is a separate implementation ticket, `local-change-notifier-bridge`).

4. **Add a master "Implementation / Doc Sync Status" subsection** (a new `###`-level subsection within this section, or immediately after it). It must list, per subsystem, whether it has:
   - simulator validation
   - mock-tier e2e (mesh-harness)
   - real-libp2p e2e

   All entries start as `pending`. A table is the clearest form, e.g.:

   | Subsystem | Simulator validation | Mock-tier e2e | Real-libp2p e2e |
   |-----------|----------------------|---------------|-----------------|
   | cohort-topic substrate | pending | pending | pending |
   | reactivity | pending | pending | pending |
   | matchmaking | pending | pending | pending |

   Add a sentence noting this table is updated by later implementation/e2e tickets as each milestone lands (the `*-core-module-fret-integration`, `*-e2e-mock-tier`, and `substrate-e2e-real-libp2p-tier` tickets flip these to `done`).

## Out of scope

- The partition-healing Document-Map fix (handled by `audit-partition-healing-doc-links`).
- Any source code or other docs.

## TODO

### Phase 1 — Edit
- [ ] Rewrite the "Two applications run on the substrate today" paragraph in `docs/architecture.md` to design-only status with simulator-phase framing.
- [ ] Reframe the reactivity and matchmaking bullets as designed (not running) behavior; keep forward links.
- [ ] Add the local-primitive clarification paragraph (single-node `IBlockChangeNotifier`, networked push-tree builds on it).
- [ ] Add the "Implementation / Doc Sync Status" subsection with the per-subsystem table (all `pending`) and the note that later tickets update it.

## Done when
- `docs/architecture.md` no longer asserts any of the three subsystems are implemented/running.
- The Doc Sync Status table is present with all-`pending` rows for cohort-topic, reactivity, matchmaking.
- Doc-only change; no build/test impact. (`yarn build` for affected packages remains green since no code changed.)
