description: When a storage node fails to apply part of a write that the rest of the cluster accepted, it can be left holding a leftover record of that write forever. The leftover makes the node report a phantom conflict on every later write to the same data, so it stops taking part in those writes and can only catch up by copying from peers.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The cluster keeps working — only the diverged node quietly stops contributing to one block — and every candidate fix either broadens behaviour or touches the commit hot path, so a maintainer may prefer to wait for a deployment that actually shows the degradation.
----

# A member that diverges mid-commit keeps unpromotable pending records

## What happens

A write in this system lands in two steps. First each node in the group stores a *pending record*
of the change. Later, once the group agrees, each node *promotes* that pending record into a real
revision of the data.

When a node cannot complete the second step for one piece of data, `StorageRepo.commit` stops
processing the rest of that write's data items. Any item it had not reached yet keeps its pending
record. The recovery path then pulls the finished data for those items directly from a peer, which
moves them past the write — so their pending records can never be promoted. Nothing deletes them.

The result is a permanent phantom: every later write to those data items sees an outstanding
pending action that will never clear.

## Why it matters, and how much

The group's agreement protocol tolerates a single node failing to store a pending record — it logs
`cluster-member:consensus-pend-diverged` and moves on. So this does **not** block writes for the
cluster, and it does not corrupt data.

What it does is silently demote the affected node for that data, permanently:

- It stops storing pending records for those items, so it stops participating in their writes.
- It therefore always misses the promote step too, and only ever catches up by copying the finished
  data from a peer.
- Copying requires enough peers to corroborate the data. Where that is not available — a small
  group, for instance — the node simply falls further behind.

So the failure mode is a node that looks healthy, answers reads, and quietly contributes nothing to
one block's writes for the rest of its life.

## This is pre-existing, not new

Two independent routes reach it, and both are pinned by passing specs in
`packages/db-p2p/test/storage-repo.spec.ts` under `mixed batch (one block committable, one with no
base)`, named `KNOWN GAP: …`:

- **The older route** — the node never received the pending record for one item, so `commit` throws
  *before* it processes any item. Every item in the write keeps its pending record. This route has
  existed as long as the recovery path has.
- **The newer route** — the node received the pending record but not the data it applies to, so
  `commit` refuses that item and stops. Items after it in the write keep their pending records.

The second route was added by `bug-member-commits-unmaterializable-revision`; the review of that
ticket found the leftover records and confirmed the first route produces them identically. Flip the
two `KNOWN GAP` assertions from `false` to `true` when this is fixed.

## Sibling ticket in the same file

`debt-pending-only-insert-unreadable-with-context` is the *other* `KNOWN GAP:` in
`packages/db-p2p/test/storage-repo.spec.ts` — a not-yet-finalised new block that cannot be read back
when the reader supplies a context. Different function (`StorageRepo.get` / `BlockStorage.getBlock`
rather than `StorageRepo.commit`) and a different fix, so they are deliberately not merged; but they
are the same weakness seen twice — the boundary between a pending record and a committed revision is
handled ad hoc at each site rather than by one owner — and between them they account for every
`KNOWN GAP:` assertion in that spec. Worth reading together before either is planned.

## What to decide

The question is what a node should do with the rest of a write it has given up on. Roughly:

- **Discard that write's pending records on this node** when it diverges, mirroring what the
  refusal already does for the single item it refused. Simple and local, but it is a broader
  behaviour change than either existing path makes today, and it needs care: discarding a pending
  record that a *later* retry could still have promoted would trade one problem for another.
- **Let the promote step clean up as it goes** — whenever a data item moves past a revision by any
  route, drop pending records for actions at or below that revision, since they can no longer be
  promoted. More general, and it also cleans up leftovers from other causes, but it touches a hot
  path.
- **Sweep them periodically** as a background chore, keeping the write path untouched at the cost of
  a window where the phantom is still reported.

Worth confirming first whether any *other* mechanism already clears these in a long-running node —
the review found none, but it did not exhaust every cleanup path in the codebase.
