description: A node's record of the writes it is in the middle of agreeing on is thrown away when the process stops, unless the host wires up a separate store for it by hand — and no host does, so a write interrupted by a restart is never picked back up. Keep that record in the store the node already keeps its other bookkeeping in, so it is always there.
architecture: packages/db-p2p/docs/cluster.md, docs/correctness.md
files: packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.transactionStateStore`, `resolveKvStore`, `logIgnoredServingOptions`, `prepareServingStore`, the `recoverTransactions` block), packages/db-p2p/src/cluster/persistent-transaction-state-store.ts, packages/db-p2p/src/storage/node-kv-namespaces.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/docs/cluster.md, packages/db-p2p/docs/storage.md, docs/correctness.md
difficulty: medium
----

# A node keeps its transaction state where it keeps the rest

## Why

A serving node agrees on every write with the other machines holding the block. While that agreement is in flight, two parties hold state that only matters across a restart: the **member** holds the record it promised on, and the **coordinator** holds the record it is broadcasting, with how far the broadcast got.

`PersistentTransactionStateStore` (`packages/db-p2p/src/cluster/persistent-transaction-state-store.ts`) stores both in any `IKVStore`, and `ClusterMember.recoverTransactions` and `ClusterCoordinator.recoverTransactions` read them back. Nothing builds it. The only way in is `NodeOptions.transactionStateStore`, which no host in this repository supplies, so on every node alive today:

- every `saveParticipantState`, `saveCoordinatorState`, `markExecuted` and `deleteCoordinatorState` call returns without writing — each is guarded by a test for the absent store;
- `createLibp2pNodeBase` skips both `recoverTransactions` calls entirely, since it makes them only when the option is present;
- so a coordinator whose process stops between promising a write and finishing its commit broadcast comes back owing nothing, and the members that promised are left holding a pending record no one will ever resolve.

The node already keeps exactly this kind of node-local state in a durable key-value store — the under-replication ledger, the clock's high-water mark, the blob records — and `PersistentTransactionStateStore`'s three key prefixes are **already** declared in `NODE_KV_NAMESPACES` (`COORDINATOR_STATE_KEY_PREFIX`, `PARTICIPANT_STATE_KEY_PREFIX` and `EXECUTED_KEY_PREFIX`, listed in `packages/db-p2p/src/storage/node-kv-namespaces.ts`), so a file-backed store sharing the block store's directory already keeps them out of its block listing. The wiring is the only thing missing, and the `NOTE:` on `resolveKvStore` says so in as many words.

This ticket does that wiring and nothing else. It lands ahead of `a-node-takes-all-its-storage-as-one-value` so that the one storage value that ticket introduces carries the three stores a host must open, rather than four with the fourth derivable from one of the others.

## What to build

**The node builds its own transaction-state store.** It constructs `new PersistentTransactionStateStore(kvStore)` over the key-value store it already resolved, hands it to `clusterMember` and to the `coordinatorRepo` factory in place of `options.transactionStateStore`, and always calls `member.recoverTransactions()` and then `coordinator.recoverTransactions()` before the node accepts requests. `NodeOptions.transactionStateStore` is removed: there is nothing left for a host to supply, and backwards compatibility is not a concern in this repository yet.

Build it on a serving node only — a client (`servesBlocks: false`) runs neither a member nor a coordinator, so it has nothing to persist. The natural home is `prepareServingStore`, which already takes the resolved key-value store and is the one function a client skips; put the store on `ServingStore` beside `underReplicationLedger` and read it from there where `options.transactionStateStore` is read today. `transactionStateStore` then comes off the list in `logIgnoredServingOptions`, because it is no longer an option.

`ITransactionStateStore` stays optional on `ClusterMemberComponents` and on the `coordinatorRepo` factory: both are constructed directly by specs and by `createMesh`, which have no key-value store and want no persistence. `MemoryTransactionStateStore` stays too — it is what those specs inject (`packages/db-p2p/test/cluster-repo.spec.ts`, `packages/db-p2p/test/transaction-state-store.spec.ts`).

**Say what it costs, in the handoff.** This turns four write paths from no-ops into writes on the agreement path, so the reviewer must be told what was measured rather than left to guess:

- a member writes the whole `ClusterRecord` under `participant/<messageHash>` once per `update` call that leaves the transaction live — twice per transaction in the ordinary pend-then-commit shape — and deletes it when the transaction clears;
- a coordinator writes the whole record under `coordinator/<messageHash>` at `promising`, at `committing`, and again per commit-broadcast retry round;
- a member writes one small `executed/<messageHash>` marker per applied record once that apply is durable, kept for `ExecutedTransactionTtlMs` (10 minutes, in `packages/db-p2p/src/cluster/cluster-repo.ts`);
- `wasTransactionExecutedAsync` now reads the store whenever its in-memory map misses.

Every one of those writes is fire-and-forget — it logs its own failure and no caller awaits it — so none is on a request's latency path. What they add is bytes, and on a store that shares a write-ahead log with the block store, records in that log. Measure what one transaction writes with the store and without it, state the figure and how it was obtained, and if it is worse than roughly doubling what a transaction writes, say so in the handoff rather than shipping it quietly.

## Edge cases & interactions

- **Key namespacing is already done.** Verify by inspection that the three prefixes are in `NODE_KV_NAMESPACES`, and that `ROOT_KV_NAMESPACES` in `packages/db-p2p-storage-fs/src/file-batch-backend.ts` therefore skips `coordinator/`, `participant/` and `executed/` when it lists blocks. No change expected; if a prefix is missing, adding it is this ticket's.
- **A memory key-value store.** With no durable store the node still builds the transaction-state store, over `MemoryKVStore`, which then behaves as `MemoryTransactionStateStore` does with a JSON round trip in between, and recovery at start finds nothing. That is the right outcome — a node's transaction state is exactly as durable as the store its other bookkeeping is in, which is the point of putting it there — and it means no second branch for the memory case. Verified by inspection.
- **`markExecutedOnceDurable` waits on `whenDurable()`.** That path becomes live on every serving node, where today it is unreachable on all of them. Re-read it before trusting it: it waits for the store's latest committed batch and writes the marker after, and a repo without `whenDurable` writes at once. Its own `NOTE:` already bounds the wait at one extra durability window. Verified by inspection.
- **`pruneExecuted` is a full scan of the `executed/` prefix** — a `list`, then a `get` and possibly a `delete` per key — and it runs on the member's periodic cleanup, not only at recovery. It is bounded by ten minutes of applied transactions. Record a `NOTE:` tripwire at `PersistentTransactionStateStore.pruneExecuted` saying so: if that sweep ever shows up in a profile on a busy node, put the timestamp in the key and delete by range instead of reading every value.
- **Recovery ordering.** The two `recoverTransactions` calls must stay where they are, in that order, before the node answers anything. Dropping the condition and leaving the call site alone is the whole change.
- **The mesh harness.** `packages/db-p2p/src/testing/mesh-harness.ts` builds its members and coordinators directly and wires no state store; the comment at its "The harness wires no `ITransactionStateStore`" line says a production node "built with `transactionStateStore`" would resume its retries. That option is going away — reword it to say a node built by `createLibp2pNode` always has one, over its key-value store, and that the harness still has none.
- **Specs that read a node's key-value store.** Any spec that boots a real node and then lists or counts keys in its key-value store will now see three more namespaces. Grep `packages/db-p2p/test/` and `packages/reference-peer/test/` for listings over a node's store before assuming none exists.
- **The upgrade-check fixtures.** A released build wrote none of these keys, so an older fixture has none and recovery finds nothing — reading a fixture is unaffected, no fixture is retired and no upgrade step is owed. Confirm `packages/upgrade-check` stays green.
- **`feat-long-lived-pend-completes-as-members-appear`** counts "the state store exists but reference-peer and sereus never inject one" as part of its own work. After this it does not; an arm on that ticket records the change.

## Tests

No new test. The store's own contract over an `IKVStore` is pinned by `packages/db-p2p/test/transaction-state-store.spec.ts`, and the recovery logic it feeds by the state-store cases in `packages/db-p2p/test/cluster-repo.spec.ts` — "wasTransactionExecutedAsync falls back to persistent store after restart" and its neighbours. What this ticket adds is one construction and one removed condition: glue, which `tsc` checks and a test would only restate.

Staging a coordinator restart in the middle of a commit broadcast — the behaviour the wiring buys — needs a mesh and a torn process, and belongs to `feat-long-lived-pend-completes-as-members-appear`, where that recovery path is exercised end to end.

## Docs

- `packages/db-p2p/docs/cluster.md`: the paragraph beginning "Unless the node was built with a `transactionStateStore`", and the coordinator/participant-state line further down that makes the same condition, both state the opposite of what will be true. Say instead that a node built by `createLibp2pNode` always keeps both, in its key-value store, and that how much survives a restart depends on whether that store is durable.
- `docs/correctness.md` §Crash-recovery: the sentence beginning "That restore happens only when the host supplies" is the one this ticket falsifies. Replace it with what is true, keeping the paragraph's distinction between per-block-cluster durability and a cross-collection decision journal.
- `packages/db-p2p/docs/storage.md`: the line saying the coordinator "passes `NodeOptions.transactionStateStore`" names an option that is gone.

## TODO

- Read `resolveKvStore`'s `NOTE:` and `prepareServingStore` in `packages/db-p2p/src/libp2p-node-base.ts`, and the four guarded write paths named above, before editing anything.
- Verify the three key prefixes are in `NODE_KV_NAMESPACES` and skipped by the fs block listing.
- Build the transaction-state store in `prepareServingStore` over the resolved key-value store, and expose it on `ServingStore`.
- Pass it to `clusterMember` and to the `coordinatorRepo` factory in place of `options.transactionStateStore`, and make both `recoverTransactions` calls unconditional.
- Remove `NodeOptions.transactionStateStore`, its doc comment, and its entry in `logIgnoredServingOptions`.
- Drop the superseded `NOTE:` on `resolveKvStore`; add the `pruneExecuted` tripwire `NOTE:`.
- Reword the mesh-harness comment.
- Grep the db-p2p and reference-peer suites for assertions over a node key-value store's keys, and fix any that now see the new namespaces.
- Measure what one transaction writes with the store and without it; put the figure and the method in the handoff.
- Update the three documents above.
- Build db-p2p, run its suite, and run `yarn lint:docs` from the root.
