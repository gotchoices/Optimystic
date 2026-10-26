description: Build the offline queue itself in the core library: an in-memory, network-agnostic list of locally committed transactions that it sends to the network one at a time, in order, and reports on until each is committed or has failed.
prereq: offline-sync-typed-commit-failure-classes, offline-sync-collection-segments
architecture: docs/offline-sync.md#draining
files: packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/network/, packages/db-core/src/index.ts, docs/offline-sync.md
difficulty: hard
----

Stage 3 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages). Usable by a `Tree`/`Diary` application without SQL; no plugin change.

## What is wanted

A queue over a set of collections whose entries are the sealed segments stage 2 introduced. It owns:

- **FIFO drain** ([§Order: strictly first in, first out](../../docs/offline-sync.md#order-strictly-first-in-first-out)): one entry at a time, in local commit order; head-of-line blocking accepted.
- **One entry, one network transaction** ([§One entry, one network transaction](../../docs/offline-sync.md#one-entry-one-network-transaction)): a one-collection entry commits via `commitHead`; a multi-collection entry commits through a per-entry `TransactionCoordinator` that pends every collection's head segment, then commits. `TransactionCoordinator` gains a way to commit a named slice (per collection, one segment's actions) instead of everything staged.
- **Classification** of each attempt by the stage-1 predicate, into the transitions of the entry lifecycle diagram ([§Entry lifecycle](../../docs/offline-sync.md#entry-lifecycle)).
- **Identity across attempts** ([§Identity across attempts](../../docs/offline-sync.md#identity-across-attempts)): an entry that has been sent is in doubt until its outcome is established, and is re-sent only under the action id and revision of the attempt that may have landed; a new action id only after a proven non-landing (refused pend, or `TornActionError` with `final: true`). The attempt identity is recorded before sending through a hook the journal (stage 5) will implement.
- **Partial commits** ([§Partial commits](../../docs/offline-sync.md#partial-commits)): `CoordinatorPartialCommitError` → `partially-committed`, keep driving the uncommitted segments; permanent refusal of the remainder → `failed` with `committedTables`.
- **Cascading removal** ([§Removing an entry](../../docs/offline-sync.md#removing-an-entry)): on failure, drop the entry's segments from every collection it wrote, let them replay, fail later entries whose guards now refuse with `causedBy`, and report which collections' visible content changed (the plugin turns that into `notifyExternalChange`).
- **Refusals discovered by a refresh** before submission are reported at once (the stage-2 callback).
- **Status events** with the shapes in [§Following transactions](../../docs/offline-sync.md#following-transactions) that do not need SQL (`queued`, `submitting`, `committed`, `partially-committed`, `failed`), plus queue-wide state, `discard` (refused once sent), `expireAfterMs`, and `whenDrained`.
- **The `ICohortReachability` port** ([§When to submit: the reachability gate](../../docs/offline-sync.md#when-to-submit-the-reachability-gate)): defined in db-core, always reachable for `TestTransactor`; the drain waits on it, woken by a re-check timer with backoff, each new local commit, and an injectable wake signal (db-p2p's connection events in stage 6).

Unclassified failures are treated as transient, logged with the entry id and counted.

## Edge cases the plan must cover

A crash-free in-doubt resolution (attempt sent, response lost, next drain refreshes and finds the own log entry); a refusal at pend of one collection of a multi-collection entry (nothing durable); a cascade three entries deep; `discard` racing the drain picking the entry up; expiry while in doubt (must not be allowed to drop a possibly-landed entry — decide and document); the drain running while a local commit seals a new segment; disposal while an attempt is in flight.

The planner should split this into several implement tickets.

## Done when

Scenario tests on `TestTransactor` (and, where the coordinator's multi-collection path matters, the in-process mesh) pin the lifecycle transitions; docs/offline-sync.md marks the stage implemented and corrects any names the implementation settled differently.
