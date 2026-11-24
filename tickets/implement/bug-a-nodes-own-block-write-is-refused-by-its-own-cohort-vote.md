description: A machine that is nearly full refuses to store even the writes its own application makes, whenever it happens to be one of the machines responsible for holding them — although the design deliberately keeps a last slice of space for exactly those writes. Teach the vote that decides this to recognise the host's own write.
architecture: packages/db-p2p/docs/storage.md#10-how-full-is-too-full
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/storage/storage-pressure.ts, packages/db-p2p/test/cluster-pend-out-of-space.spec.ts, packages/db-p2p/docs/storage.md, docs/correctness.md
repro: verified
----

# A node's own block write is refused by its own cohort vote

## The rule this restores

A node keeps a slice of its allotted space in reserve, and `packages/db-p2p/docs/storage.md` §10 says what the slice is for in as many words: it is the headroom for pends a cohort member has already approved, **for the host's own writes**, and for the sampling window. Every door that refuses data from *other* machines closes at the `refuseAbove` threshold (95 % of the allotment by default); the machine's own work is the last thing it gives up.

Two gates decide a block pend on storage grounds, and today they disagree about that rule:

- `CoordinatorRepo.refuseSoloPendForSpace` — the cohort-of-one gate — honours it: a pend carrying the writer's in-process mark (`MessageOptions.localWriter` in `packages/db-core/src/network/i-repo.ts`) is not refused.
- `ClusterMember.validatePendOperations` — the cohort member's promise vote — cannot honour it, because the mark is set by the writer's own transactor, read by the coordinating repo, and deliberately never travels on the wire (a remote writer must not be able to claim it). The member sees only a `ClusterRecord`, so it refuses every pend alike once its last pressure sample read `refusing`.

So the same write is accepted when this node is the whole cohort and refused when it is one of three.

## Confirmed, and what it looks like

Reproduced against HEAD (the spec was written, run, and removed; re-create it as the test below). A `CoordinatorRepo` whose cohort for the block is itself plus two approving peers, with a real `ClusterMember` wired as its `localCluster` and a pressure gate reading `refusing`, answers `repo.pend(request, { localWriter: true })` with:

```
{"success":false,"conflict":false,
 "reason":"Cohort is out of space: 1/3 member(s) have no room left (2/3 approvals): 12D3Koo…",
 "outOfSpace":{"peerIds":["12D3Koo…"],"approvals":2,"peerCount":3,"needed":3}}
```

The one peer with no room is this node itself, and the write it refused is its own. On a cohort of three at the default super-majority the bar is all three approvals, so that one vote ends the write; on a three-node deployment every cohort contains every node, so one node crossing 95 % of its allotment stops **all** writes to its slice, its own application's included — and §10's own table of levers cannot free block history the node is still responsible for.

## The shape to build

**Carry the fact in process, never on the wire, and make the wire path unable to reach it.** The local member's promise vote is an in-process call from the coordinator to its own member (`ClusterCoordinator.prevoteLocalPromise`), and that is the only path by which a pend of this node's own writer reaches its own member's vote. Three properties the shape must keep:

- The fact must never become part of `ClusterRecord`. It is not signed, not hashed, and not sent; the record that fans out to the remote members is byte-identical to the one that fans out today, and every remote member's vote is unchanged.
- A remote writer must not be able to claim it. `ICluster.update` — the method the wire handler calls (`ClusterService`, the "redirect ?? await this.cluster.update" line) — therefore keeps its exact present signature of one argument. The local fact rides a **separate** method that the wire handler does not call and cannot be made to call by forwarding an argument it already has. An optional second parameter on `update` would work today and would be one forwarded argument away from being a hole; prefer the separate method, and say why in its doc comment.
- The two gates must read **one** predicate. The defect is two gates disagreeing about one rule, so the fix is not a second copy of the exemption — it is one exported predicate both call, in `packages/db-p2p/src/storage/storage-pressure.ts` beside `OwnWriteRoom`, where the rule is already argued:

```ts
/**
 * Whether this node refuses a pend for want of space. The ONE predicate both pend gates read — the
 * cohort member's promise vote and the cohort-of-one refusal — so the two cannot drift about whose
 * write the reserved headroom is for.
 *
 * A pend the program in THIS process wrote is never refused here … (plus the NOTE below on what
 * block pends do not get).
 */
export function refusesPendForSpace(gate: StoragePressureGate | undefined, ownWrite: boolean): boolean;
```

Suggested plumbing, each hop a single-caller private except where noted:

| Site | Change |
|---|---|
| `ClusterMember.update` | unchanged signature; delegates to a private body that takes the writer |
| `ClusterMember` (new, local-only) | `updateFromLocalWriter(record)`: the same body with the writer named as this process |
| `ClusterMember.processUpdate` → `handlePromiseNeeded` → `evaluatePromise` → `validatePendOperations` | each takes the writer and passes it down; the gate reads `refusesPendForSpace(this.storagePressure, ownWrite)` |
| `ClusterCoordinator.executeClusterTransaction` | stop ignoring its `_options`: read `options?.localWriter === true` |
| `ClusterCoordinator.executeTransaction` → `collectPromises` → `prevoteLocalPromise` | each takes that boolean; the pre-vote calls `updateFromLocalWriter` when it is set |
| `ClusterCoordinator`'s `localCluster` structural dependency | gains `updateFromLocalWriter?`; absent (a bare double) → the pre-vote calls `update`, exactly as today |
| `CoordinatorRepo`'s `localClusterRef` | bind the new method beside `wasTransactionExecuted` and its siblings; `LocalClusterWithExecutionTracking` declares it optional |

A good name for the carried fact is a two-valued type rather than a bare boolean at the member tier — `'this-process' | 'elsewhere'` — so the member's own signatures say what the value means; the coordinator side can stay a boolean read off `options`.

`CoordinatorRepo.pendThroughCluster` already hands `options` to `executeClusterTransaction`, so nothing new is threaded there. Commit and cancel records pass the same flag harmlessly: the gate fires only on a record carrying a pend operation.

## What must not change

- A pend from any other writer still meets the gate at `refuseAbove`, on this member and on every other. The exemption is for the record the in-process pre-vote carries and nothing else.
- Space stays **last** of the member's refusals: a stale, invalid, expired or held pend still gets its own permanent or rival-naming answer first ([docs/correctness.md §Theorem 1](../../docs/correctness.md#theorem-1-consensus-safety-no-conflicting-commits)). The exemption only removes an answer; it must not reorder the ones above it.
- The cohort-of-one gate's behaviour is unchanged — it is being re-expressed through the shared predicate, not re-decided.

The exemption riding the pre-vote call is enough to cover the whole defect, and that is worth checking rather than assuming while building: `ClusterMember.getTransactionPhase` asks for a promise vote only on a record that is **not yet decided** and carries no vote of this member's, and the in-process pre-vote is the first delivery of every record this node coordinates. Every later delivery of such a record to this member — the commit round, the consensus broadcast, a carried owed record — is either already carrying its vote or already decided, so no path re-votes on a local write without the fact.

## The honest limit, to record rather than fix

Both pend gates exempt the host's own write **entirely**; neither refuses it at the allotment the way `LocalBlobService.put` and `.pin` do (`NodeOutOfSpaceError`). That asymmetry between block pends and blobs is deliberate and pre-existing — `refuseSoloPendForSpace` already argues it for the cohort of one — but §10 currently reads as though the pend door refuses own writes at the allotment, and after this ticket it still will not. Record it as a tripwire `NOTE:` at `refusesPendForSpace`, in one line: block pends have no allotment backstop, past that point the writer is answered only by the store's own write failure, and the revisit condition is a deployment seen filling its disk past its allotment through its own block writes. Do not file it as a ticket.

## Documentation to bring in line

Both doc sites state the defect in prose and name this ticket; both must now state the behaviour instead, and lose the reference.

- `packages/db-p2p/docs/storage.md` §10 — the paragraph beginning "The host's own writes are refused last": replace the "**The pend door reaches only part of the way to that rule**" sentences with the rule as built (both pend gates exempt the host's own write; the member learns it from the in-process pre-vote and never from the wire; blobs alone carry the allotment backstop). The four-door table's pend row ends with the same claim and needs the same correction.
- `docs/correctness.md` — the paragraph "**Space is checked LAST of a member's refusals**": its last two sentences say the exemption "reaches the cohort of one and no further". They now describe how far it does reach and why it cannot be forged. The vote table above it ("whenever the member's last pressure sample read `refusing` and the record would otherwise have been approved") gains the second condition.

## Test

One test, at the layer where the defect is observable — the writer tier, because a member-tier test alone would pass on the new method while the plumbing that reaches it stayed wrong. Add it to `packages/db-p2p/test/cluster-pend-out-of-space.spec.ts`, which already owns this rule and carries every helper needed (`makeKeyPair`, `makeClusterPeers`, `makePend`, `pressure`, `AnsweringClusterClient`, `CountingStorageRepo`, `cfg`, `MockPeerNetwork`):

- a `coordinatorRepo(keyNetwork, createClient, cfg)({ storageRepo, localPeerId, localCluster, storagePressure: pressure(true) })` whose `localCluster` is a real `clusterMember({ …, storagePressure: pressure(true) })` for the same peer id, and whose two other cohort peers are `AnsweringClusterClient`s answering `'approve'`;
- `pend(makePend(), { localWriter: true })` succeeds and reaches local storage (the reproduction above, inverted);
- the same wiring with **no** `localWriter` mark still answers `isOutOfSpaceFailure`, naming this node — so the exemption is not a blanket disarm of the member-side gate.

Dispose the member (`member.dispose()`) as the existing member-tier helper does. Per `tickets/rules/testing.md`, run that one spec file only.

## TODO

- Add `refusesPendForSpace` to `packages/db-p2p/src/storage/storage-pressure.ts`, with the tripwire `NOTE:` about block pends having no allotment backstop, and point `OwnWriteRoom`'s doc comment at it.
- Thread the writer through `ClusterMember`: `update` unchanged, a new `updateFromLocalWriter`, and the writer carried down `processUpdate` → `handlePromiseNeeded` → `evaluatePromise` → `validatePendOperations`; the gate reads the shared predicate.
- Thread the flag through `ClusterCoordinator`: read `options.localWriter` in `executeClusterTransaction`, pass it to `executeTransaction` → `collectPromises` → `prevoteLocalPromise`, and call `updateFromLocalWriter` there when it is set and available.
- Declare `updateFromLocalWriter` on the coordinator's `localCluster` dependency and on `LocalClusterWithExecutionTracking`, and bind it in `CoordinatorRepo`'s `localClusterRef`.
- Re-express `CoordinatorRepo.refuseSoloPendForSpace` through the shared predicate, leaving its behaviour and its argument intact.
- Add the writer-tier test and its no-mark control to `cluster-pend-out-of-space.spec.ts`; update that file's header comment, whose last bullet says the solo tier is where the exemption lives.
- Correct `packages/db-p2p/docs/storage.md` §10 (the own-writes paragraph and the four-door table's pend row) and `docs/correctness.md` (the space-is-last paragraph and the vote table row), removing both references to this ticket.
- Run the one spec file, plus `yarn workspace @optimystic/db-p2p run typecheck` and `yarn lint:docs`.
