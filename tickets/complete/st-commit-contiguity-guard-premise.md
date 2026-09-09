description: A planned safeguard against a storage node building a new block version on stale data was found unbuildable as originally specified, and was parked for a human decision. That decision has since been answered in code: one of the options it listed was designed and shipped, so nothing here is still waiting on a person.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/src/network/struct.ts, tickets/backlog/bug-a-pended-transform-does-not-carry-its-base.md
----

# Retired: the commit contiguity guard decision was answered by `a-commit-over-a-gapped-base-forks-the-block`

This ticket sat in `blocked/` asking a human two questions. Both are now answered, so it is archived rather than left in the human's inbox. It was retired during the review of `a-commit-over-a-gapped-base-forks-the-block`; no human had acted on it in the meantime.

## What it asked, and what the answer turned out to be

**1. "Is the underlying risk actually reachable, or already covered by replication and consensus?"** — **Reachable, and not covered.** It was reproduced twice: directly, with two in-process storage repositories where one misses two updates and then commits the third (the two end up holding different bytes under the same version number), and downstream in `../sereus`, where the same shape showed up as 122 records of a cohort member rejecting every later write to a block it had forked.

**2. "If it is reachable, which detection mechanism?"** — **Option 2a, "carry the intended base revision", was chosen and shipped.** It needed no new wire field: the author already declares, per block, the committed version its edits were computed against (`CommitRequest.blockDigests[blockId].baseRev`, added for the content-digest check). `StorageRepo.internalCommit` now refuses an update-only change whose declared base is not the version this node holds, and heals from a cohort peer instead of forking.

## What this ticket got right, and why that mattered

Its central finding — that `latest.rev !== rev - 1` is **unsound**, because version numbers are allocated per collection and a per-block gap is routine — was correct, and it is the reason the shipped guard compares against the author's declared base rather than against `rev - 1`. The follow-up work re-derived the same conclusion independently and pinned it with a test (`storage-repo.spec.ts`, "commits across an arbitrary revision gap when a base IS held"). Parking the unsound version instead of landing it was the right call.

## What is still open, and where it lives now

The guard covers the case where the author declared a base. Two paths where nothing is declared still apply changes to whatever version the node happens to hold — a commit that declares no digest for the block, and the read-driven promotion in `StorageRepo.get`. Those are tracked, with the root cause and the options for closing it, by `backlog/bug-a-pended-transform-does-not-carry-its-base`. Nothing about them needs a decision from this ticket.
