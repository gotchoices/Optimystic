description: A machine that is nearly full used to refuse even the writes its own application made, whenever it happened to be one of the machines responsible for holding them. The vote that decides this now recognises the host's own write, so the last slice of reserved space is usable for what it was reserved for.
architecture: packages/db-p2p/docs/storage.md#10-how-full-is-too-full
files: packages/db-p2p/src/storage/storage-pressure.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/cluster-pend-out-of-space.spec.ts, packages/db-p2p/docs/storage.md, docs/correctness.md
repro: verified
----

# Review: a node's own block write is no longer refused by its own cohort vote

## What the defect was

A node keeps a slice of its allotment in reserve, and `packages/db-p2p/docs/storage.md` §10 says the slice is for pends a cohort member has already approved, for the host's own writes, and for the sampling window. Two gates decide a block pend on storage grounds, and they disagreed about the "host's own writes" half: the cohort-of-one gate (`CoordinatorRepo.refuseSoloPendForSpace`) honoured the exemption; the cohort member's promise vote (`ClusterMember.validatePendOperations`) could not, because the writer's in-process mark (`MessageOptions.localWriter`) never travels on the wire and the member saw only a `ClusterRecord`. So the same write was accepted when this node was the whole cohort and refused when it was one of three — and on a three-node deployment, where every cohort contains every node, one node past 95 % of its allotment stopped every write to its slice, its own application's included.

## What was built

**One predicate, read by both gates.** `refusesPendForSpace(gate, ownWrite)` in `packages/db-p2p/src/storage/storage-pressure.ts`, beside `OwnWriteRoom` where the rule is argued. Both pend gates now call it; neither reads `refusingNewData()` directly any more, so the two cannot drift again. `refuseSoloPendForSpace`'s behaviour is unchanged — it is re-expressed through the predicate, not re-decided.

**The fact rides an in-process call, never the record.** `ClusterMember.update` keeps its exact signature (one argument) and is still what the wire handler calls; a new `ClusterMember.updateFromLocalWriter(record)` is the same body with the writer named as this process. Both delegate to a private `updateFrom(record, writer)`, and the writer — a two-valued `RecordWriter` (`'this-process' | 'elsewhere'`), module-internal — is carried down `processUpdate` → `handlePromiseNeeded` → `evaluatePromise` → `validatePendOperations`, where the gate reads the shared predicate.

**The coordinator reads the mark and calls the new entry point.** `ClusterCoordinator.executeClusterTransaction` stops ignoring its options (`_options` → `options`), reads `options?.localWriter === true`, and threads that boolean through `executeTransaction` → `collectPromises` → `prevoteLocalPromise`, which calls `updateFromLocalWriter` when the flag is set and the method is present, and `update` otherwise. The coordinator's `localCluster` structural dependency and `CoordinatorRepo`'s `LocalClusterWithExecutionTracking` both declare it optional, and `CoordinatorRepo`'s `localClusterRef` binds it beside `wasTransactionExecuted` and its siblings — so a bare `ICluster` double behaves exactly as before.

Three properties the shape keeps, and the three things most worth an adversarial look:

- **Nothing changed on the wire.** The fact is in no field of `ClusterRecord` — not signed, not hashed, not sent — so the record that fans out to remote members is byte-identical to before and every remote member's vote is unchanged.
- **A remote writer cannot claim it.** `ICluster.update` still takes one argument, and `updateFromLocalWriter` is not on `ICluster` at all, so the wire handler (`ClusterService`, the `redirect ?? await this.cluster.update(message.record)` line) has no argument to forward and no method to reach. An optional second parameter on `update` was deliberately not used.
- **No later delivery re-votes without the fact.** `ClusterMember.getTransactionPhase` asks for a promise vote only on a record that is not yet decided and carries no vote of this member's, and the in-process pre-vote is the first delivery of every record this node coordinates — so the commit round, the consensus broadcast and a carried owed record all arrive either already carrying this member's vote or already decided. **This was established by reading those paths, not by a test** (see the gaps below).

Space stays last of the member's refusals: the exemption only removes the `out-of-space` answer and reorders nothing above it. A pend from any other writer still meets the gate at `refuseAbove`, on this member and on every other. Commit and cancel records carry the flag harmlessly — the gate fires only on a record with a pend operation (`sawPend`).

## How to validate it

The reproduction, inverted, plus its control. Both at the **writer** tier, because a member-tier test alone would pass on the new entry point while the plumbing that reaches it from `pend` stayed wrong — which was the whole of the defect.

| Test (in `packages/db-p2p/test/cluster-pend-out-of-space.spec.ts`) | What it verifies |
|---|---|
| `accepts a pend from the program on this machine, though this node is a member of its cohort` | The defect itself. A `CoordinatorRepo` whose cohort is this node plus two approving peers, with a real `ClusterMember` wired as `localCluster` and both at `refusing` pressure, answers `pend(makePend(), { localWriter: true })` with success and the write reaches local storage. Before the fix this answered `Cohort is out of space: 1/3 member(s) have no room left (2/3 approvals)`, naming this node itself. |
| `still refuses the same pend from any other writer, naming itself as the member with no room` | That the exemption is a fact carried on the in-process pre-vote and not a blanket disarm of the member-side gate. Identical wiring, no `localWriter` mark: `isOutOfSpaceFailure`, `peerIds: [self]`, `approvals: 2`, `needed: 3`, and nothing reached local storage. |

Both were confirmed to be a real reproduction rather than a tautology: with the exemption temporarily removed (passing `false` where the gate reads the writer), the first test fails on `success` and the second still passes.

The spec's five member-tier claims and its solo-tier pair are unchanged and still pass, including the ordering claim (a stale revision still rejects permanently, a rival reservation still answers `held`) — that is where the "space is last" invariant is pinned.

The file's header comment was updated: its last bullet used to say the exemption lived on the solo tier only.

## Commands run

- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/cluster-pend-out-of-space.spec.ts` (from `packages/db-p2p`) — 10 passing.
- The specs covering the changed code, in two invocations: `test/storage-pressure.spec.ts test/cluster-pend-out-of-space.spec.ts test/cluster-pend-held-vote.spec.ts test/cluster-pend-staleness.spec.ts test/cluster-slot-hold.spec.ts test/cluster-repo.spec.ts test/cluster-member-batch-record.spec.ts test/cluster-expired-vote.spec.ts test/cluster-membership-admission.spec.ts` — 162 passing; `test/cluster-coordinator.spec.ts test/cluster-coordinator-promise-retry.spec.ts test/cluster-coordinator-supermajority.spec.ts test/commit-round-carries-coordinator-commit-vote.spec.ts test/coordinator-repo-stale-classification.spec.ts test/cohort-pend-refusal-channel.spec.ts test/cluster-abandonment-e2e.spec.ts` — 65 passing.
- `yarn workspace @optimystic/db-p2p run build` and `run typecheck` — clean.
- `yarn lint:docs` — 49 documents, all citations resolve. `yarn lint:deps` — clean.
- Per `tickets/rules/testing.md`, the package's full `yarn test` was **not** run; review runs it.

## Known gaps, honestly

- **The new tests' commit phase is not production-shaped.** Their two non-local cohort peers are `AnsweringClusterClient` mocks whose promise and commit signatures are fixed strings, so the real local member throws on `validateSignatures` once a record carries them. The promise phase — the thing this ticket is about, and the only phase the pre-vote and the space gate live in — is exercised exactly; the commit phase is not, and the accepted write consequently lands through the coordinator's fallback apply rather than through the member's own consensus apply. That is why the success test asserts `pendCalls` is greater than zero rather than an exact count. A reviewer who wants the member's own apply covered would need a real-signing cohort (the two-real-member harness in `cohort-pend-refusal-channel.spec.ts` is the pattern), which is a heavier fixture than this claim needs.
- **The "no later delivery re-votes without the fact" argument is read, not tested.** It rests on `getTransactionPhase` asking for a promise vote only on an undecided record carrying no vote of this member's. Worth re-reading rather than taking on trust; if it is wrong, the symptom is a local write refused on a *second* delivery, not the first.
- **Unreachability from the wire is enforced by shape, not by a test.** The ticket asked for exactly that (a separate method, not an optional parameter), so no test was added; confirming it means reading `ClusterService` and `carried-records.ts` / `libp2p-node-base.ts`, where the three `cluster.update(record)` call sites are all genuinely "writer elsewhere".
- **`RecordWriter` is module-internal.** Nothing outside `cluster-repo.ts` names it, which keeps it off the package's public surface but also means the coordinator side carries a plain boolean. That asymmetry is deliberate (the ticket called for it) and is the one place a future edit could mix the two up.

## Tripwire parked

Both pend gates exempt the host's own write **entirely**; neither refuses it at the allotment the way `LocalBlobService.put` and `.pin` do (`NodeOutOfSpaceError`). Past the allotment, the writer of a block pend is answered only by the store's own write failure. Deliberate and pre-existing — a cohort has no peer a member can shed block history to — and recorded as a `NOTE:` at `refusesPendForSpace` in `packages/db-p2p/src/storage/storage-pressure.ts`, with the revisit condition: a deployment seen filling its disk past its allotment through its own block writes.

## Documentation

Both doc sites stated the defect in prose and named the ticket; both now state the behaviour, and the reference is gone.

- `packages/db-p2p/docs/storage.md` §10 — the own-writes paragraph was split into three: the blob doors at the allotment, both pend gates exempting the host's own write and how the member learns it in process, and blobs alone carrying the allotment backstop. The four-door table's pend row carries the same correction.
- `docs/correctness.md` — the "Space is checked LAST" paragraph's closing sentences now describe how far the exemption reaches and why it cannot be forged; the vote table's `out-of-space` row gained the second condition.
