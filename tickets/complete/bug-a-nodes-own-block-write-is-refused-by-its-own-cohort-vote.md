description: A machine that is nearly full used to refuse even the writes its own application made, whenever it happened to be one of the machines responsible for holding them. The vote that decides this now recognises the host's own write, so the last slice of reserved space is usable for what it was reserved for.
architecture: packages/db-p2p/docs/storage.md#10-how-full-is-too-full
files: packages/db-p2p/src/storage/storage-pressure.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/cluster-pend-out-of-space.spec.ts, packages/db-p2p/docs/storage.md, docs/correctness.md
repro: verified
----

# A node's own block write is no longer refused by its own cohort vote

## The defect

A node keeps a slice of its allotted space in reserve, and `packages/db-p2p/docs/storage.md` §10 says the slice is for pends a cohort member has already approved, for the host's own writes, and for the sampling window. Two gates decide a block pend on storage grounds, and they disagreed about the "host's own writes" half: the cohort-of-one gate (`CoordinatorRepo.refuseSoloPendForSpace`) honoured the exemption; the cohort member's promise vote (`ClusterMember.validatePendOperations`) could not, because the writer's in-process mark (`MessageOptions.localWriter`) never travels on the wire and the member saw only a `ClusterRecord`. So the same write was accepted when this node was the whole cohort and refused when it was one of three — and on a three-node deployment, where every cohort contains every node, one node past 95 % of its allotment stopped every write to its slice, its own application's included.

## What shipped

Landed as `ticket(implement): bug-a-nodes-own-block-write-is-refused-by-its-own-cohort-vote`, with the review's own edits on top.

- **One predicate, read by both gates.** `refusesPendForSpace(gate, ownWrite)` in `packages/db-p2p/src/storage/storage-pressure.ts`, beside `OwnWriteRoom` where the rule is argued. Neither gate reads `refusingNewData()` directly any more, so the two cannot drift again. `refuseSoloPendForSpace` is re-expressed through it, not re-decided.
- **The fact rides an in-process call, never the record.** `ClusterMember.update` keeps its one-argument signature and stays what the wire handler calls; a new `ClusterMember.updateFromLocalWriter(record)` is the same body with the writer named as this process. Both delegate to a private `updateFrom(record, writer)`, and the writer — a module-internal two-valued `RecordWriter` — is carried down `processUpdate` → `handlePromiseNeeded` → `evaluatePromise` → `validatePendOperations`, where the gate reads the shared predicate. Each hop is a single-caller private.
- **The coordinator reads the mark and calls the new entry point.** `ClusterCoordinator.executeClusterTransaction` stops ignoring its options, and threads `options?.localWriter === true` through `executeTransaction` → `collectPromises` → `prevoteLocalPromise`, which calls `updateFromLocalWriter` when the flag is set and the method is present. The method is optional on the coordinator's `localCluster` dependency and on `CoordinatorRepo`'s `LocalClusterWithExecutionTracking`, and is bound in `localClusterRef` beside its siblings, so a bare `ICluster` double behaves exactly as before.
- **Nothing changed on the wire.** The fact is in no field of `ClusterRecord`, so the record every remote member receives and the vote every remote member casts are unchanged. `ICluster.update` still takes one argument and `updateFromLocalWriter` is not on `ICluster`, so the wire handler has no argument to forward and no method to reach.

Space stays last of the member's refusals; the exemption removes the `out-of-space` answer and reorders nothing above it. Commit and cancel records carry the flag harmlessly — the gate fires only on a record with a pend operation.

## Tests

Two cases in `packages/db-p2p/test/cluster-pend-out-of-space.spec.ts`, both at the writer tier (a member-tier test would have passed on the new entry point while the plumbing reaching it from `pend` stayed wrong, which was the whole defect):

- `accepts a pend from the program on this machine, though this node is a member of its cohort` — the reproduction inverted. A `CoordinatorRepo` whose cohort is this node plus two approving peers, with a real `ClusterMember` wired as `localCluster` and both at `refusing` pressure, answers `pend(makePend(), { localWriter: true })` with success and the write reaches local storage.
- `still refuses the same pend from any other writer, naming itself as the member with no room` — identical wiring without the mark: `isOutOfSpaceFailure`, `peerIds: [self]`, `approvals: 2`, `needed: 3`, and nothing reached local storage.

The implementer confirmed these are a real reproduction rather than a tautology by temporarily removing the exemption: the first fails, the second still passes. The review re-ran the file and kept both — one behaviour each, and the second is what keeps the first from being satisfiable by disarming the member-side gate wholesale.

## Review findings

**Read the implement diff first, then the handoff.** The implementation matches its fix-stage specification point for point; the findings below are what the specification itself did not cover, plus hygiene.

### Major — one, filed

- **The exemption reaches only a write this node *coordinates*, which neither the code nor the docs said.** `localWriter` is set by `NetworkTransactor.localWriterMark` only on the request handed to the writer's own node, and the member learns it only from `prevoteLocalPromise` — so a write of this node's own program that a *peer* coordinates arrives at this member over the wire, indistinguishable from a stranger's, and is still refused for space. It usually does not arise, because `bestCoveringPeer` breaks coordinator-cover ties in favour of the local peer (so every single-block write, and every write on a three-node deployment where all cohorts are equal, is self-coordinated — the full suite's own mesh output reports `coordinator outside cohort for 0/200 ids`). It does arise for an action whose blocks a peer covers more of, and for a batch a retry re-homes — a case `localWriterMark`'s own doc comment already names. Not conditional and not dormant, so recorded as a defect rather than a tripwire: `tickets/backlog/bug-a-full-nodes-own-write-is-still-refused-when-a-peer-coordinates-it.md` (`repro: static`, with what would confirm it, and the three candidate shapes — none free, because the forgery-free ones all change coordinator choice or add a verified writer identity). Filed to `backlog/` rather than `fix/` because which of those shapes the design wants is the unsettled part; `tradeoffs:` carries the decline argument.
- **Docs corrected inline for the same boundary**, since both sites read as though the exemption were unconditional: a new paragraph in `packages/db-p2p/docs/storage.md` §10 and a sentence in `docs/correctness.md`'s space-is-last paragraph, with the canonical statement on `refusesPendForSpace`.

### Minor — fixed in this pass

- **The security argument was restated in full in eleven places** (four in `cluster-repo.ts`, three in `cluster-coordinator.ts`, two in `coordinator-repo.ts`, both docs, the spec header). The cost was concrete rather than aesthetic: adding the boundary above would have meant editing all eleven or leaving the rest wrong by omission. Trimmed to two canonical homes — `refusesPendForSpace` for the rule and its boundary, `ClusterMember.updateFromLocalWriter` for the mechanism — with a sentence and a pointer at each other site. No statement was dropped, only its repetitions.
- **The spec header said "Four claims, over the three tiers"** after the implement commit split a bullet and added a fourth tier. Now five and four.

### Checked and clean — no change

- **Completeness of the threading.** All three production `executeClusterTransaction` call sites (`pend`, `commit`, `cancel` in `CoordinatorRepo`) already pass `options`. Both production `localCluster` wirings (`libp2p-node-base.ts`, `testing/mesh-harness.ts`) pass a real `ClusterMember`, and `CoordinatorRepo.localClusterRef` binds the new method, so the optional-method fallback never silently degrades in production. `evaluatePromise` / `validatePendOperations` / `handlePromiseNeeded` / `processUpdate` have exactly one caller each — the threading has no second entry.
- **Unforgeability from the wire, which the handoff flagged as shape-only.** Verified by reading, and it holds for a reason the handoff did not give: the repo wire handler does not forward `MessageOptions` at all — `packages/db-p2p/src/repo/service.ts` rebuilds them as `{ expiration: message.expiration }`, so `localWriter` cannot arrive from a remote writer even by accident. On the cluster side, the member exposes only `update` and `updateFromLocalWriter` (no `updateCarrying`), and the three wire-reachable `cluster.update(record)` sites (`service.ts`, `carried-records.ts`, `libp2p-node-base.ts`) are all genuinely writer-elsewhere. No test added: a test that `updateFromLocalWriter` is absent from a type is a test of a type.
- **"No later delivery re-votes without the fact", also flagged as read-not-tested.** Confirmed, and it rests on a stronger guarantee than the handoff claimed: `prevoteLocalPromise` returns a peer outcome whether the member voted *or threw*, so `collectPromises` filters self out of the promise round unconditionally — the local member is asked for a promise exactly once per record, by that one call. `getTransactionPhase` then yields `OurPromiseNeeded` only on a record that is undecided and carries no vote of this member's, and the commit round, consensus broadcast and carried-record paths all deliver a decided record (`OurCommitNeeded`, which has no space gate). No test added: there is no reachable path to assert against.
- **The concurrent-delivery dedupe in `updateFrom`** returns an in-flight promise keyed by `messageHash`, so a wire delivery could in principle receive a verdict computed under the exemption. Not a hole: `messageHash` binds the message and the membership digest, so the only record that can collide is byte-identical to the host's own, and the member's approval of that record already stands. Nothing changed.
- **Gate ordering.** `sawPend` still scopes the gate to pend records only, and the gate is still the last refusal in `validatePendOperations`, after stale, slot-hold and reservation. The spec's ordering cases (stale rejects permanently, a rival reservation answers `held`, both at `refusing` pressure) still pass.
- **Resource cleanup.** The new test helper returns the member and both cases dispose it; `CoordinatorRepo` and `ClusterCoordinator` expose no dispose, so there is nothing else to release, and the spec process exits cleanly.
- **The handoff's remaining two gaps are accurate and were left as they are.** The new tests' commit phase is not production-shaped (the two peer mocks sign fixed strings, so the accepted write lands through the coordinator's fallback apply rather than the member's consensus apply, which is why the assertion is `pendCalls > 0`); and `RecordWriter` is module-internal while the coordinator side carries a boolean. Both were called for by the fix ticket, and a real-signing cohort is a heavier fixture than the promise-phase claim needs.
- **File size.** `cluster-repo.ts` (4079 lines) and `coordinator-repo.ts` (4635) are far over any reasonable bar, but that is pre-existing and already claimed by open tickets (`debt-cluster-coordinator-owed-delivery-outgrew-its-file`, `debt-freshness-state-scattered-across-coordinator-repo`), and this change is a net −4 lines after the trims. No new ticket.

### Tripwires

The one the implementer parked stands and was re-read: both pend gates exempt the host's own write entirely, with no allotment backstop of the kind `LocalBlobService.put` and `.pin` apply (`NodeOutOfSpaceError`) — recorded as a `NOTE:` at `refusesPendForSpace`, revisit condition "a deployment seen filling its disk past its allotment through its own block writes". The review added none of its own; the one conditional-looking concern it found (the coordinator-choice boundary above) is a currently-reachable defect, not a tripwire, so it went to a ticket instead.

## Commands run

All after the review's own edits, per `tickets/rules/testing.md`.

- `yarn workspace @optimystic/db-p2p run test` — **3938 passing**, 84 pending, 0 failing (3m).
- `yarn workspace @optimystic/quereus-plugin-optimystic run test` — **1458 passing**, 16 pending (4m), plus its smoke script.
- `yarn test:integration` (root, every workspace) — **1466 passing**, 8 pending (7m 6s). Run because the change is on the cohort promise-vote path.
- `yarn lint`, `yarn lint:docs` (49 documents, all citations resolve), `yarn workspace @optimystic/db-p2p run typecheck`, `run build`, and `yarn check:rn` (Metro bundle + Hermes compile) — all clean.
- `test/cluster-pend-out-of-space.spec.ts` on its own — 10 passing, re-run after the last comment edits.

No pre-existing failures surfaced, so nothing was written to `tickets/.pre-existing-error.md`.
