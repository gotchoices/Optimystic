description: A nearly-full machine now accepts the writes its own application makes, but only the ones it happens to be driving itself. When a different machine in the group is driving the write instead, the full machine still turns its own application's write away.
architecture: packages/db-p2p/docs/storage.md#10-how-full-is-too-full
files: packages/db-p2p/src/storage/storage-pressure.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-core/src/transactor/network-transactor.ts
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: A writer almost always drives its own write (the coordinator cover already breaks ties in favour of the local machine), so the gap is narrow; and every fix that keeps the fact unforgeable costs something real — changing how a writer picks which machine drives a write, or adding a signed writer identity to the record that the group would then have to verify — so a maintainer could reasonably decide a full machine is a condition the operator should fix instead.
----

# A full node's own write is still refused when a peer coordinates it

## What the rule says, and how far it now reaches

A node keeps a slice of its allotted space in reserve, and `packages/db-p2p/docs/storage.md` §10 says the slice is for pends a cohort member has already approved, **for the host's own writes**, and for the sampling window. The machine's own work is the last thing it gives up.

The sibling ticket `bug-a-nodes-own-block-write-is-refused-by-its-own-cohort-vote` (landed as `ticket(implement): bug-a-nodes-own-block-write-is-refused-by-its-own-cohort-vote`) made the cohort member's promise vote honour that rule, and made both pend gates read one predicate (`refusesPendForSpace`). It carries the fact — "the program in this process wrote this pend" — on an in-process call from this node's coordinator to this node's own member (`ClusterCoordinator.prevoteLocalPromise` → `ClusterMember.updateFromLocalWriter`), deliberately never on the record, because a fact on the wire is a fact a remote writer can claim.

That carrier is also the limit. The exemption covers a pend this node **both wrote and coordinates**. When some other machine coordinates the write, this node's member is asked over the wire, with nothing in the record to say whose write it is, and refuses it for space like anybody else's.

## When that actually happens

A writer's transactor marks only the request it hands to its own node (`NetworkTransactor.localWriterMark`, keyed on the peer the request goes to), and it usually hands it there: `coordinatorCover` assigns each of an action's blocks to a cohort member by greedy set cover, and `bestCoveringPeer` breaks ties in favour of the local peer. So a single-block write, or any action whose blocks all share one cohort (every write on a three-node deployment, where every cohort contains every node), is driven by the writer itself and is covered.

Two shapes fall outside it:

- **An action whose blocks a peer covers more of.** With block cohorts that overlap without being equal — say a two-block action where this node is in the first block's cohort and a peer is in both — the cover assigns both blocks to that peer, because two beats one. This node is still a cohort member of the first block, so it still votes on that record, and now votes on it as a stranger's write.
- **A batch a retry re-homes.** `localWriterMark`'s own doc comment says it: a batch re-homed onto another coordinator carries no mark.

In either shape, with this node above `refuseAbove` (95 % of its allotment by default), its `out-of-space` vote refuses its own program's write. On a cohort of three at the default super-majority the bar is all three approvals, so that one vote ends the write, and the writer gets the non-retryable `OutOfSpaceFailure` — for a write the reserved headroom exists to accept.

**Not reproduced.** Read off the code paths above, not observed: it needs a node past its refusal threshold and an action the cover re-homes, and the existing spec (`packages/db-p2p/test/cluster-pend-out-of-space.spec.ts`) drives only the cohort shapes where the writer coordinates. What would confirm it: a `CoordinatorRepo` on peer B whose cohort for the block includes a full peer A, with A's real `ClusterMember` answering B's promise request, driven by a `pend` carrying A's `localWriter` mark nowhere — i.e. the existing own-write test with the coordinating and member roles on different repos.

## What the answer is not

Putting the writer's identity in `ClusterRecord` — signed or otherwise — is the thing the sibling ticket ruled out, and ruling it out was the point: the reserved headroom must not be claimable by whoever asks for it. Any proposal here has to keep that.

Shapes worth weighing, none of them free:

- **Let the writer drive the blocks it is a cohort member of.** Have `coordinatorCover` keep a block on the local peer when the local peer is in its cohort, rather than folding it into a peer that covers more. Honest and needs no new trust, but it trades batching (more coordinators per action, so more consensus records) for the exemption, and it changes coordinator choice for every writer, full or not.
- **Let the member recognise the record out of band.** This node's writer could tell its own member, in process, which pend it is about to send — but the thing that identifies a record is the `messageHash`, which the coordinating peer computes from the message and the membership digest, so the writer would have to derive it the same way, and a member keyed on a hash it was promised is a new piece of state with its own expiry.
- **Accept it, and say so.** `refusesPendForSpace` and §10 now state the boundary; this ticket could close as documented behaviour, on the argument that a node above `refuseAbove` is a condition the operator resolves (shedding, or more space) and the covered common case is enough to keep a single-machine or small deployment writing.

The decision that has to be made first is which of those the design wants; the code change follows from it.
