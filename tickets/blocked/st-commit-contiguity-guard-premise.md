description: A planned safeguard meant to stop a storage node from building a new block version on stale data cannot be built the way it was specified — the check it relies on would also reject ordinary, correct writes. A human needs to decide whether the underlying risk is real and, if so, how to detect it soundly.
prereq:
files:
  - packages/db-p2p/src/storage/storage-repo.ts (StorageRepo.commit partition loop ~387-411; internalCommit ~526-567)
  - packages/db-p2p/src/storage/block-storage.ts (materializeBlock 256-300 — the sparse-revision model)
  - packages/db-core/src/transform/struct.ts (Transform — carries no base revision)
  - packages/db-core/src/network/struct.ts (CommitRequest.rev is the collection-wide action revision)
  - packages/db-p2p/test/cascade.spec.ts (seed helper 106-117 — writes blocks at sparse revisions)
  - tickets/fix/st-pend-seeds-open-ended-ranges.md (companion; the ranges/restoration mechanism)
----

# The commit contiguity guard, as specified, is unsound — decide the real fix (or drop it)

## What this ticket originally asked for

The implement ticket asked us to add a guard to `StorageRepo.commit()` that rejects a commit
whenever the block's last-known revision is **more than one behind** the revision being committed
(`latest.rev < request.rev - 1`). The stated worry: such a "gap" means the node skipped one or more
intermediate commits, so applying the new revision on top of its stale content would produce a block
that silently diverges from other, up-to-date nodes.

We implemented it exactly as specified (guard + a distinct "behind" result the caller can recognize,
plus routing that result to the existing peer-reconcile path). **It broke normal operation**, so the
change was reverted and the working tree is clean. This ticket records *why* it is unsound and asks a
human to decide the real path forward.

## Why the premise is wrong (plain terms)

A "revision number" here is **not** a per-block counter that increments 1, 2, 3 for each block.
It is a **collection-wide** counter, bumped once per committed transaction and shared by every block
in that collection. (`CommitRequest.rev` is documented as "the new revision for the committed
action".)

A single transaction only writes *some* of the collection's blocks. Blocks it doesn't touch keep
their old revision number. So an individual block's revision numbers are naturally **sparse**:

- Transaction at rev 1 writes blocks A, B, D → each is now at rev 1.
- Transaction at rev 2 writes only A → A is at rev 2; **B and D are still at rev 1**.
- Transaction at rev 3 writes only B → B jumps from rev **1** straight to rev **3**, skipping 2.

B skipping rev 2 is completely normal and correct. B's right base for its rev-3 write is still its
rev-1 content, because nothing changed B at rev 2. The storage layer is *built* for this: reading a
block at revision N (`materializeBlock`, block-storage.ts:256-300) walks **down** from N to the
nearest revision the block actually has and reconstructs from there — precisely because blocks skip
revision numbers.

The proposed guard fires on exactly this normal case (`latest.rev (1) < request.rev (3) - 1`) and
rejects the write. So it doesn't just fail to catch the bug — it **rejects the ordinary, correct
path**.

## Evidence

Implementing the guard verbatim broke **3 existing tests** in `packages/db-p2p/test/cascade.spec.ts`
("reverts a genuine linear chain", "stops at maxCascadeTransactions", "is idempotent / restartable").
Their setup writes blocks at sparse revisions (block B: rev 1 → rev 3; block D: rev 1 → rev 4) — the
normal case above. The guard rejected those commits; because the seed helper does not inspect the
commit result, the writes silently never landed, and the downstream logic lost the affected
transaction. Reverting the guard restored **56/56** passing in the two affected spec files
(`cascade.spec.ts` + `storage-repo.spec.ts`). The failures were solely caused by the guard.

## The real risk, and why it can't be caught this way

There *is* a genuine underlying concern the original ticket was reaching for: a node that **missed a
commit which actually did write this block**, then applies a later write on top of the wrong (older)
content. That is real divergence.

The problem is that, **locally, this is indistinguishable from the legitimate sparse jump**. Both
look identical: the node holds the block at rev 1 and is asked to commit rev 3. Nothing in the
request says which base the new write expects. A `Transform` (db-core `transform/struct.ts`) is just a
set of edits (`insert` / `updates` / `delete`) applied blindly to whatever content is present — it
carries **no base-revision stamp**. So there is no revision-number arithmetic that separates
"legitimately skipped rev 2" from "missed a write at rev 2". Any guard keyed on `latest.rev` vs
`request.rev` rejects both — which is why the specified fix regresses.

## The decision needed (human / design)

1. **Is the underlying risk actually reachable** in this system, or already covered? Cluster members
   apply commits through consensus, and a member that is behind already hits an existing recovery
   path (a commit whose matching pend the member never saw is treated as "behind" and reconciled by
   pulling the committed revision from a cohort peer — see `cluster-repo.ts` around the
   "consensus-commit-diverged / behind" handling). If replication + that path already guarantee a
   member can't apply a write on stale content, this ticket may be a **non-issue and should be
   closed with no code change**.

2. **If it is reachable and worth guarding**, detection needs a *different* mechanism than
   revision-number comparison. Options to weigh:
   - **Carry the intended base revision** in the pend/commit so a node can verify it actually holds
     that base before applying (schema + producer/consumer change across db-core and db-p2p).
   - **Trust the block's own "which revisions do I actually hold" range metadata** and
     restore-the-missing-predecessor-before-apply, rather than guessing from `latest.rev`. This is
     the domain of the companion fix ticket `st-pend-seeds-open-ended-ranges` (it makes that range
     metadata honest); the two would need to be designed together.
   - **Accept the risk** as adequately covered by replication/consensus and document that decision.

These reverse the original ticket's "confirmed" analysis and pick an architecture, so they are a
human call rather than something to decide inside an implement ticket.

## State left behind

- **No code changed** — all guard/type/test edits were reverted; `git status` is clean; the two
  affected spec files pass 56/56.
- A related, separately-filed concern about the storage layer over-reporting which revisions it holds
  is already tracked as `st-pend-seeds-open-ended-ranges` (in `fix/`) and is relevant to option 2b
  above.
