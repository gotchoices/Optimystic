description: A node's record of the writes it is in the middle of agreeing on used to be thrown away on restart because nothing wired up a place to keep it; it is now kept in the store the node already uses for its other bookkeeping, so an interrupted write can be picked back up.
architecture: packages/db-p2p/docs/cluster.md, docs/correctness.md
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/persistent-transaction-state-store.ts, packages/db-p2p/src/cluster/memory-transaction-state-store.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/docs/cluster.md, packages/db-p2p/docs/storage.md, docs/correctness.md, docs/internals.md
difficulty: medium
----

# A node keeps its transaction state where it keeps the rest

## What landed

Every serving node now builds a `PersistentTransactionStateStore` over the key-value store it already resolved, and both crash-recovery passes run at every start. `NodeOptions.transactionStateStore` is gone — there is nothing left for a host to supply, and nothing in the repository supplied one.

- `prepareServingStore` constructs the store and exposes it on `ServingStore` beside the under-replication ledger; `wireServingRole` passes it to the cluster member as its `stateStore` and to the coordinator factory. A client (`servesBlocks: false`) skips `prepareServingStore` entirely, so it builds none of this — it runs neither a member nor a coordinator.
- `ClusterMember.recoverTransactions` and `ClusterCoordinator.recoverTransactions` are now called unconditionally, member first then coordinator.
- The removed option is out of `NodeOptions`, out of `logIgnoredServingOptions`, and out of the four documents that named it. The superseded `NOTE:` on `resolveKvStore` (which said this wiring belonged to another ticket) is dropped.
- `ITransactionStateStore` stays optional on `ClusterMemberComponents` and the coordinator factory, because specs and the mesh harness construct both directly with no store.

Implemented by `ticket(implement): a-node-keeps-its-transaction-state-where-it-keeps-the-rest`; the review pass below added four fixes, one tripwire, and two backlog tickets.

## What it costs — measured by the implementer, corroborated here

Two real nodes over TCP at the default cohort size, writing one row of a `Tree` (two cluster messages), counting both stores in the same unit (the UTF-8 byte length of each stored value plus its key):

| | key-value writes (agreement state) | block-store writes |
|---|---|---|
| the coordinating machine | 9 writes, 16,871 bytes (+4 deletes) | 12 writes, 6,334 bytes |
| a machine that only participates | 2 writes, 162 bytes | 12 writes, 6,334 bytes |

So one row write puts ~23.2 KB on the coordinating machine's disk where it put ~6.3 KB before — **about 3.7×** — and +2.6% on a participant. The review did not re-run the measurement; it checked the write sites against the reported counts and they reconcile exactly (three `coordinator/` writes per message from `persistCoordinatorState`'s three call sites, plus one `participant/` and one `executed/`, with the second message's broadcast round arming no retry: 5 + 4 = 9). The figures are recorded as a `NOTE:` at `persistCoordinatorState` so they outlive this ticket, and the reduction they argue for is now `backlog/debt-the-coordinator-writes-its-whole-record-for-phases-it-can-never-resume`.

## Review findings

### Read first, from the diff

The implement diff was read before the handoff summary. Checked by reading and by running: the construction and the removed condition; the recovery passes on both sides and their ordering against everything else `wireServingRole` does; the store's key namespacing against `NODE_KV_NAMESPACES` and `ROOT_KV_NAMESPACES`; the `list` contract across all four platform key-value stores; what a client builds; every document the change touched and two it did not.

### Found and fixed in this pass (minor)

- **Recovery could overwrite a transaction that live traffic had just established.** The claim in the call-site comment and in `docs/correctness.md` — that both passes run "before accepting new requests" / "before the node answers anything" — is false: `node.start()` happens far earlier, and both bindings an inbound request reaches (`late.cluster`, `late.coordinatedRepo`) are set *before* the two awaits. So a delivery landing while a pass is reading the store creates its own entry, and the restore loop's unconditional `set` then replaced it with the staler persisted copy and stranded that entry's two armed timers. A cohort peer retrying a commit to a machine that has just come back is exactly the traffic to expect in that window. Both passes now leave a hash already live in memory to its delivery. Unreachable before this ticket (no node had a store), reachable on any node with a durable one from now on. **Not** fixed by deferring the two bindings instead: `createServedRepoProxy` falls back to the bare storage repo when no coordinated repo is bound, so a longer window there would serve an inbound pend or commit with no consensus. That tradeoff is now stated at the call site.
- **`MemoryTransactionStateStore`'s doc comment still said "Default when no persistent store is injected."** Nothing defaults to it any more; it exists for specs. Reworded.
- **The in-memory key-value store's startup warning did not mention the state this ticket put in that store.** That warning is how an operator learns what a memory store costs, and it listed the under-replication ledger, the clock's high-water mark and the blob records but not in-flight agreement state. Clause added.
- **The mesh harness's `restart` comment overstated the production contrast** ("always has one … and so resumes its persisted commit retries"), which is only true as far as the node's key-value store is durable. Tightened, and the paragraph rewrapped.

### Filed (major, past the bar)

- `backlog/debt-the-coordinator-writes-its-whole-record-for-phases-it-can-never-resume` — the root of the 3.7×: `persistCoordinatorState` writes the whole `ClusterRecord` three times per cluster message, and `recoverTransactions` deletes two of those three as non-resumable. Not conditional and not speculative — it is wasted work on every write today — so a tripwire would have been the wrong home. Filed rather than fixed here because it changes what a restart can see, which is behaviour, and because `backlog/1.4-dispute-commit-path-block` wants a *new* phase recorded at the same site, so the resumable set must be derived from one declaration rather than hard-coded. Ticket notes that the single-hash readers `getCoordinatorState` and `getParticipantState` have no production callers, so nothing outside recovery reads what is written there.
- `backlog/debt-a-cluster-member-can-still-be-built-without-the-store-it-always-has` — rung-1 (make the bad state unrepresentable) rather than a point fix: the member and coordinator still carry ~10 "if there is no store" branches that are now unreachable in production, and that optionality has twice produced a wrong belief that cost work (the superseded `resolveKvStore` `NOTE:` this ticket deleted, and `debt-a-recovered-commit-retry-restarts-its-budget`'s original premise). The ticket proposes defaulting the store inside the two constructors so no spec changes and the harness keeps its semantics.

### Tripwires parked (not tickets)

- **One state-store read is on a request's latency path.** The handoff said none of the new work is — true of the writes, which are all fire-and-forget, but `handleConsensus` awaits `wasTransactionExecutedAsync` on every delivery, and that now does a real key-value `get` per cluster message on every serving node where it used to short-circuit. It is cheap beside the signature verification and block reads the same delivery does, so this is knowledge rather than work: `NOTE:` at the method, with the fix if a profile ever disagrees (hold a negative set of hashes already missed on).
- The implementer's two `NOTE:`s were re-read and left as they are: the full-prefix scan in `pruneExecuted`, and the write volume at `persistCoordinatorState` (which now also indexes the ticket above).

### Checked and found sound — no action

- **Key namespacing.** `COORDINATOR_STATE_KEY_PREFIX`, `PARTICIPANT_STATE_KEY_PREFIX` and `EXECUTED_KEY_PREFIX` are all in `NODE_KV_NAMESPACES`, which `ROOT_KV_NAMESPACES` in `@optimystic/db-p2p-storage-fs` is built from, so a file store sharing the block store's directory skips them when listing blocks. `FileKVStore.keyToPath`'s own `NOTE:` already lists all three.
- **Filesystem-safe keys.** A `messageHash` is `base58btc(SHA256(…))` — no `/`, no `+`, so it is one path segment on the file backend. The case-insensitive-filesystem collision it implies is already weighed and answered in `file-batch-backend.ts` ("about 200 bits").
- **The `list` contract, across platforms.** Recovery depends on `IKVStore.list` returning whole keys, not suffixes. Verified in all four implementations (memory, file, NativeScript SQLite, React Native LevelDB, IndexedDB): each returns full keys less the store's own instance prefix. A suffix-returning store would have made recovery silently find nothing on that platform.
- **No node shares a key-value store with another node** anywhere in the repository (every call site constructs one per node), which matters because cohort members share a `messageHash` and would collide under `participant/` and `executed/`. The same constraint already applied to the under-replication ledger's `under-replicated/<blockId>` keys.
- **An exhausted or abandoned retry still deletes its persisted state** — `releaseTransaction` covers the `retry-abandoned` exit — so a recovered-then-abandoned retry leaves no key behind to be resumed again on the next restart.
- **`markExecutedOnceDurable` is live on every serving node** where it was unreachable on all of them. Re-read: it awaits the store's latest committed batch and writes the marker after, bounded by one extra durability window by its own `NOTE:`.

### Tests

**No tests cut and none added.** Nothing to cut — the implement pass added none, correctly: what it added is one construction and one removed condition, which `tsc` checks. Nothing added either, and the reason is specific rather than general: the defect found above is a race whose observable effects are a dropped merge the next delivery re-establishes and two leaked timers, so a test for it would have to reach into the member's private `activeTransactions` to assert anything — a test of the implementation, at the wrong layer, under this project's "one test per behaviour, do not test what a type already enforces" rule. The store's contract over an `IKVStore` is already pinned by `test/transaction-state-store.spec.ts` (31 cases) and the recovery logic by the state-store cases in `test/cluster-repo.spec.ts`.

**The gap the implementer stated is still open and is stated again here:** nothing in the suite exercises a real restart resuming a real broadcast. The measurement proved the write paths fire on real nodes; it did not prove a restart resumes anything. Staging that needs a mesh and a torn process, and belongs to `backlog/feat-long-lived-pend-completes-as-members-appear`, which already carries the arm.

### Deliberately not done

- **No release-notes entry.** A removed public option and new on-disk keys on every serving node are user-visible and belong in `.release-notes.pending.md`, but that file currently has no section for the cycle in progress — its newest remaining section is a leftover `# v1.27.0` while v1.29.1 is already published — and inventing one would be guessing at the release process. The next cycle's section should carry it.
- **No `yarn unwrap:md` pass or other reformatting** of the documents the change touched beyond the sentences that were wrong.

## Commands run

All from the repository root, on the final tree, after the fixes above:

- `yarn test` (every workspace) — **Done in 12m 26s, exit 0, zero failing.** db-core 2124 passing; db-p2p 3882 passing / 84 pending; db-p2p-storage-fs 131; the other storage packages 86 / 82 / 80 / 12 / 128; quereus-plugin-optimystic 1457 / 15 pending; reference-peer 6; 258; upgrade-check 341.
- `yarn workspace @optimystic/db-p2p test` re-run after the last edit and rebuild — 3882 passing / 84 pending / 0 failing.
- `yarn test:integration` — **Done in 7m 7s**: db-p2p 60 passing / 2 pending, quereus-plugin-optimystic 1464 passing / 8 pending, zero failing. Run because the change is on the consensus delivery path that integration specs drive over real nodes.
- `yarn lint` — clean. `yarn lint:docs` — 49 documents, 886 anchored citations, all resolve. `yarn lint:deps` — 1307 files across 13 packages, every import declared; 6 guarded libp2p packages on their expected majors.
- `yarn check:rn` — passed (Metro 23.0s, hermesc 12.9s). Run because the implement pass added an import to `libp2p-node-base.ts`, which ships to React Native. The `multiformats` subpath WARNs are the expected ones recorded in `tickets/.pre-existing-known.md`.
- Targeted, before the full suites: `test/cluster-repo.spec.ts`, `test/cluster-coordinator.spec.ts`, `test/transaction-state-store.spec.ts`, `test/node-service-set.spec.ts` together — 123 passing.

**One intermittent failure, reported not buried.** The *first* full `@optimystic/db-p2p` run came back 3880 passing / 2 failing, both in `test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts` ("replicated in one gossip round" assertions). The file passes alone (7 passing) and three later full runs were 3882 / 0 failing, so it fails only under suite load, in a subsystem neither this review nor the implement commit touches. Written up in `tickets/.pre-existing-error.md` for the triage pass, with the non-reproduction evidence and a warning not to loosen the assertion before telling a scheduler flake apart from a real missed replication. Nothing was skipped, disabled or loosened.

## Docs, as they now stand

- `packages/db-p2p/docs/cluster.md` — the commit-retry paragraph and the rebuild-survives bullet both said the opposite of what is now true; both now say a node built by `createLibp2pNode` always keeps the state, and that how much survives a restart is how durable its key-value store is.
- `docs/correctness.md` §1.2 Crash-recovery — rewritten by the implement pass, then corrected here: the passes run "at start", not "before the node answers anything".
- `packages/db-p2p/docs/storage.md` — the line naming the removed option.
- `docs/internals.md` §Client nodes — `transactionStateStore` dropped from the "Options a client ignores" list, which must keep matching `logIgnoredServingOptions`. (`storage` stays; `a-node-takes-all-its-storage-as-one-value` removes that one.)

## Board edits

- `tickets/backlog/debt-a-recovered-commit-retry-restarts-its-budget.md` — the implement pass added a dated arm recording that its first arm is now live wherever a node has a durable key-value store and restarts mid-broadcast, corrected the two sentences that asserted unreachability, and rewrote the now-false first clause of `tradeoffs:`. Re-read in this pass and left as it stands; the new `debt-a-cluster-member-can-still-be-built-without-the-store-it-always-has` cites its corrected premise as evidence rather than re-filing it.
- `tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md` — already carried the arm for this change; nothing added.
- Two new backlog tickets, listed under *Filed* above.
