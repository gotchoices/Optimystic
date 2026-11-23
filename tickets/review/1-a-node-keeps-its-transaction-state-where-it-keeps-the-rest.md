description: A node's record of the writes it is in the middle of agreeing on used to be thrown away on restart because nothing wired up a place to keep it; it is now kept in the store the node already uses for its other bookkeeping, so an interrupted write can be picked back up.
architecture: packages/db-p2p/docs/cluster.md, docs/correctness.md
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/persistent-transaction-state-store.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/docs/cluster.md, packages/db-p2p/docs/storage.md, docs/correctness.md, docs/internals.md, tickets/backlog/debt-a-recovered-commit-retry-restarts-its-budget.md
difficulty: medium
----

# Review: a node keeps its transaction state where it keeps the rest

## What changed

Every serving node now builds its own `PersistentTransactionStateStore` over the key-value store it already resolved, and both recovery passes run at every start. `NodeOptions.transactionStateStore` is gone — there is nothing left for a host to supply.

- `prepareServingStore` (`packages/db-p2p/src/libp2p-node-base.ts:1088`) constructs `new PersistentTransactionStateStore(kvStore)` and exposes it on `ServingStore.transactionStateStore`, beside `underReplicationLedger`. A client (`servesBlocks: false`) skips `prepareServingStore` entirely, so it builds none of this — it runs neither a member nor a coordinator.
- `wireServingRole` destructures it and passes it as `clusterMember`'s `stateStore` and as the `coordinatorRepo` factory's last argument, where `options.transactionStateStore` was read.
- The two `recoverTransactions` calls are unconditional, member first then coordinator, in the same place they were.
- `NodeOptions.transactionStateStore`, its doc comment, its entry in `logIgnoredServingOptions`, and its mention in the `servesBlocks` doc comment are removed. `ITransactionStateStore` stays optional on `ClusterMemberComponents` and the `coordinatorRepo` factory — specs and `createMesh` construct both directly with no store, and `MemoryTransactionStateStore` is still what those specs inject.
- The superseded `NOTE:` on `resolveKvStore` (which said the wiring belonged to another ticket) is dropped.

Two `NOTE:` tripwires added, and the mesh-harness comment reworded — see below.

## Use cases to validate

**A serving node's in-flight agreement state survives a restart.** Boot a node with a durable `kvStore` (`FileKVStore`), stop it mid-commit-broadcast, restart: `ClusterCoordinator.recoverTransactions` finds the `broadcasting` record and resumes the retry, and `ClusterMember.recoverTransactions` restores the records it promised on. Before this change, both found nothing on every node in the repository. End-to-end staging of a torn coordinator belongs to `feat-long-lived-pend-completes-as-members-appear` (see *Tests*).

**A memory key-value store behaves as `MemoryTransactionStateStore` with a JSON round trip.** The node still builds the store; nothing survives a process restart and recovery finds nothing. That is the intended outcome — a node's transaction state is exactly as durable as its other bookkeeping. No second branch for the memory case.

**A client builds none of it.** `servesBlocks: false` must still register the four storage protocols' absence and log no line about a store it was never offered. `test/node-service-set.spec.ts` covers the service set; run it.

**Key namespacing.** Verified by inspection: `COORDINATOR_STATE_KEY_PREFIX`, `PARTICIPANT_STATE_KEY_PREFIX` and `EXECUTED_KEY_PREFIX` are all three in `NODE_KV_NAMESPACES` (`packages/db-p2p/src/storage/node-kv-namespaces.ts`), and `ROOT_KV_NAMESPACES` in `packages/db-p2p-storage-fs/src/file-batch-backend.ts` is built straight from that list, so a file-backed store sharing the block store's directory skips `coordinator/`, `participant/` and `executed/` when it lists blocks. No change was needed.

**No spec asserts over a node key-value store's whole key set.** Grepped `packages/db-p2p/test/` and `packages/reference-peer/test/`: every `list`/`get` over a key-value store in those suites is either prefix-scoped (`UNDER_REPLICATED_KEY_PREFIX`, `BLOB_RECORD_KEY_PREFIX`, `OWED_BLOB_KEY_PREFIX`) or on a store the spec built itself, never on a booted node's store. Nothing needed fixing. A reviewer adding such an assertion should expect the three new namespaces.

## What it costs — measured, and worse than doubling

The ticket asked for a figure and said to say so if the cost is worse than roughly doubling what a transaction writes. **It is: about 3.7× on the coordinating machine.**

Method: a throwaway spec (since deleted) booted two real nodes over TCP with the `test/util/two-machine-lifecycle.ts` helpers, default `clusterSize`, each over a `MemoryKVStore` subclass recording every `set` and a `MemoryRawStorage` Proxy recording every `save*`/`delete*`. One row of a `Tree` was written to warm the collection, the counters were reset, then one more row was written and the counters read 8 s later (the state-store writes are fire-and-forget and the executed marker waits on the block store's durability window). Both sides are counted in the same unit — the UTF-8 byte length of each stored value plus its key — because both stores encode values as JSON. Two runs agreed to within 4 bytes.

One row write is two cluster messages (the pend and the commit), each its own `ClusterRecord`:

| | key-value writes (transaction state) | block-store writes |
|---|---|---|
| A — coordinator and member | 9 writes, **16,871 bytes** (+4 deletes) | 12 writes, 6,334 bytes |
| B — member only | 2 writes, **162 bytes** | 12 writes, 6,334 bytes |

Per message hash on A: `coordinator/` three times (`promising`, `committing`, and the deferred commit-broadcast round), `participant/` once, `executed/` once. Each coordinator copy is bigger than the last as promises, commits and signatures accumulate — 2,382 → 2,906 → 3,200 bytes for the first message, 1,669 → 2,193 for the second.

So the bytes a one-row write puts on disk go from ~6.3 KB to ~23.2 KB on the coordinating machine (**≈3.7×**), and from ~6.3 KB to ~6.5 KB on a member-only machine (**+2.6%**, two 81-byte markers). The cost is concentrated entirely on whichever machine coordinates.

None of it is on a request's latency path — every one of those writes is fire-and-forget, logs its own failure, and nothing awaits it. What it adds is bytes, and records in a write-ahead log on a store that shares one with the block store.

**This is the one thing a reviewer should weigh.** The obvious reduction, if the figure is judged too high: `persistCoordinatorState` writes the whole record three times per message where recovery can only ever resume the `broadcasting` one (`promising` and `committing` are deleted as non-resumable by `recoverTransactions` itself). Writing only `broadcasting`, or a phase plus a delta, would cut most of the 16.9 KB. That was deliberately **not** done here — it changes what recovery sees, which is behaviour, and this ticket was scoped to wiring. The measured figure and that suggestion are recorded as a `NOTE:` at `persistCoordinatorState` (`packages/db-p2p/src/repo/cluster-coordinator.ts:2213`).

## Tripwires parked

- **`PersistentTransactionStateStore.pruneExecuted` is a full scan** of the `executed/` prefix — one `list`, then a `get` and possibly a `delete` per key — run on the member's periodic cleanup, not only at recovery, and bounded by ten minutes of applied transactions. `NOTE:` at the method: if the sweep shows up in a profile on a busy node, put the timestamp in the key and delete by range.
- **The coordinator's write volume**, with the measured figures above: `NOTE:` at `persistCoordinatorState`.

## Verified by inspection, not run

- **`markExecutedOnceDurable` is now live on every serving node**, where it was unreachable on all of them. Re-read: it awaits the store's latest committed batch (`whenDurable()`) and writes the marker after; a repo without `whenDurable` writes at once. Its own `NOTE:` bounds the wait at one extra durability window. The measurement above exercised this path on both machines (each wrote its two `executed/` markers), which is the first time it has run in this repository.
- **The upgrade-check fixtures.** A released build wrote none of these keys, so an older fixture has none and recovery finds nothing. `packages/upgrade-check` is green (341 passing).

## Tests

**No new test**, per the ticket. The store's contract over an `IKVStore` is already pinned by `packages/db-p2p/test/transaction-state-store.spec.ts` (31 cases), and the recovery logic it feeds by the state-store cases in `packages/db-p2p/test/cluster-repo.spec.ts`. What this ticket adds is one construction and one removed condition — glue, which `tsc` checks and a test would only restate. Staging a coordinator restart mid-broadcast needs a mesh and a torn process and belongs to `feat-long-lived-pend-completes-as-members-appear`.

**Known gap, stated plainly:** nothing in the suite now exercises the recovery path this ticket made reachable. The measurement above proved the write paths fire on real nodes, but not that a restart resumes anything. That is the honest limit of this change.

## Commands run

From `packages/db-p2p`:

- `yarn build` — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/transaction-state-store.spec.ts` — 31 passing.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/cluster-repo.spec.ts` — 66 passing.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/node-service-set.spec.ts` — 5 passing.

From `packages/upgrade-check`: `yarn test` — 341 passing.

From the root: `yarn lint:docs` — 49 documents, all citations resolve. `yarn lint:deps` — every import declared.

Per the project's testing rules, no package's full `yarn test` was run here; review runs the full suites.

## Docs updated

- `packages/db-p2p/docs/cluster.md` — the commit-retry paragraph and the rebuild-survives bullet both stated the opposite of what is now true. Both now say a node built by `createLibp2pNode` always keeps the state, in its key-value store, and that how much survives a restart is how durable that store is.
- `docs/correctness.md` §1.2 Crash-recovery — the "only when the host supplies" sentence replaced, keeping the paragraph's distinction between per-block-cluster durability and a cross-collection decision journal.
- `packages/db-p2p/docs/storage.md` — the line naming the removed option.
- `docs/internals.md` §Client nodes — `transactionStateStore` dropped from the "Options a client ignores" list, which must match `logIgnoredServingOptions`. (`storage` stays; `a-node-takes-all-its-storage-as-one-value` removes that one.)
- `packages/db-p2p/src/testing/mesh-harness.ts` — the `restart` comment now says a node built by `createLibp2pNode` always has a state store over its key-value store and resumes its retries, while the harness still has none.

## Board edits

- `tickets/backlog/debt-a-recovered-commit-retry-restarts-its-budget.md` — its premise was "neither arm is reachable; nothing supplies a `transactionStateStore`", which this ticket falsifies. Added a dated arm saying the first arm is now live wherever a node has a durable key-value store and restarts mid-broadcast, corrected the two sentences that asserted unreachability, and rewrote `tradeoffs:` whose first clause was the now-false decline argument.
- `tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md` already carried the arm recording this change (written when this ticket was planned); nothing added.

## Review focus

- The 3.7× write amplification on the coordinating machine: ship as measured, or cut `persistCoordinatorState` down to the resumable phase in a follow-up ticket?
- `recoverTransactions` ordering and placement — member then coordinator, before the node answers anything. The call site did not move; only its condition went away.
- Whether `ServingStore.transactionStateStore` is the right home given `a-node-takes-all-its-storage-as-one-value` lands next: that ticket's one storage value carries the three stores a host opens, and this store is derived from one of them rather than being a fourth, which was the point of sequencing this first.
