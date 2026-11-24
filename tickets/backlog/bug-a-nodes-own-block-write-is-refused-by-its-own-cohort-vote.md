description: A machine that is nearly full now refuses to store even the writes its own application makes, whenever it happens to be one of the machines responsible for holding them — although the design deliberately keeps a last slice of space for exactly those writes.
architecture: packages/db-p2p/docs/storage.md#10-how-full-is-too-full
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/storage/storage-pressure.ts, packages/db-core/src/network/i-repo.ts, packages/db-p2p/docs/storage.md, docs/correctness.md
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The window is narrow (a node between its refusal threshold and its allotment, writing a block it happens to hold itself), the answer it gets is a correct typed refusal rather than a wrong result, and the fix means carrying a trust-free "this is my own write" fact into a consensus vote — which a maintainer may reasonably prefer to leave until a deployment actually reports it.
----

# A node's own block write is refused by its own cohort vote

## What the project already decided

A node keeps a slice of its allotted space in reserve, and `packages/db-p2p/docs/storage.md` §10 says what that slice is for in as many words: it is the headroom for pends a cohort member has already approved, **for the host's own writes**, and for the sampling window. The rule it states is that the machine's own work is the last thing it gives up — every door that refuses data from *other* machines closes at the `refuseAbove` threshold (95 % of the allotment by default), while the machine's own writes are refused only once the measured use reaches the allotment itself (`ownWriteRoomOf` in `packages/db-p2p/src/storage/storage-pressure.ts`). The blob side follows that rule: `LocalBlobService`'s `put` and `pin` refuse at the allotment, not at `refuseAbove`.

## What now happens instead

A cohort member asked to store a pend refuses at `refuseAbove` with a signed `out-of-space` vote (`ClusterMember.validatePendOperations`). The member cannot tell whose write it is voting on: the mark that says "the program in this process wrote this" (`MessageOptions.localWriter` in `packages/db-core/src/network/i-repo.ts`) is set by the writer's own transactor, is read by the coordinating repo, and deliberately never travels on the wire — a remote writer must not be able to claim it.

So for every block whose cohort includes this node, the node's own write meets its own refusal:

- the write is coordinated, the local member pre-votes on the record (`prevoteLocalPromise` in `packages/db-p2p/src/repo/cluster-coordinator.ts`), and that vote is `out-of-space`;
- on a cohort of three at the default super-majority the bar is all three approvals, so that one vote ends the write; the writer is told its cohort is full.

The coordinating repo's own cohort-of-one gate *does* honour the rule — `refuseSoloPendForSpace` returns nothing for a `localWriter` pend — so the same write is accepted when this node is the whole cohort and refused when it is one of three. That asymmetry is the defect: one of the two gates reads the mark and the other has no way to.

Blast radius scales the wrong way with deployment size. In a large network only the blocks that route to this node's slice are affected. In a three-node deployment every cohort contains every node, so one node crossing 95 % of its allotment stops *all* writes to the slice it is in, its own application's included — and the levers that would get it back under the threshold (`storage.md` §10's table) cannot free block history it is still responsible for.

## What a reader should decide

The question is how a cohort member can be told, without trusting the claim, that the pend in front of it is the local host's own write. Two shapes are worth weighing, and this ticket does not pick between them:

- **Carry it in process, never on the wire.** The local pre-vote is an in-process call from the coordinator to its own member, so a local-only argument could reach `evaluatePromise` on that path and on no other. A remote member would never see the field, and a remote writer could not forge what is not on the wire. The cost is a parameter threaded through the member's promise path purely to carry provenance.
- **Decide it at the gate from the record instead.** The gate could skip itself when this member is the record's coordinating node *and* the record arrived through the in-process pre-vote. Same effect, no new parameter, but it rests on a property of the call path rather than on a stated fact.

Whatever shape is chosen, the member-side behaviour for every *other* writer must not change, and the exemption must remain unforgeable from the wire — that is the whole reason the solo gate's exemption is safe today.

Worth stating plainly for whoever triages this: the alternative resolution is to decide that the stated rule does not extend to block pends at all, and that a node above `refuseAbove` refuses everyone including itself. That is a coherent position — it is one threshold instead of two — but it contradicts what `storage.md` §10 says today and what the solo gate already does, so it would mean changing those rather than leaving the inconsistency standing.
