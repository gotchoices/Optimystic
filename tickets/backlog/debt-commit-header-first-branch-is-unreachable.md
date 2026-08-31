description: A branch in the write path that was meant to commit a new collection's header block before everything else can never actually run, and three comments still describe it as if it does — so either wire it up or delete it, and fix the comments either way.
files:
  - packages/db-core/src/transactor/network-transactor.ts:686-700 (the `if (request.headerId && !request.blockIds.includes(request.headerId))` branch)
  - packages/db-core/src/transactor/transactor-source.ts:147-160 (`transact` — the only production code that sets `headerId`)
  - packages/db-core/src/network/struct.ts:113-123 (`CommitRequest.headerId` / `tailId` doc comments)
  - packages/db-core/test/commit-digest-threading.spec.ts (the only tests that reach the branch, via hand-built requests)
difficulty: easy
tradeoffs: The branch is inert rather than wrong — the ordering that actually runs is coherent and tested — so a maintainer could reasonably leave it alone and just fix the comments; deleting it also throws away the only place a future create-race ordering fix would naturally hang.

# The commit path's header-first step cannot fire from production code

## What is going on

When a collection is written, its blocks are committed in stages rather than all at once, so that
a partial failure leaves a recoverable state rather than a dangling one. The stages, as the code
reads today:

1. the collection's **header** block, but only when the header is not already in the list of
   blocks being committed;
2. the collection's **log tail**;
3. a sweep over every remaining block.

Stage 1 can never happen on the production path. The only production caller that supplies a header
id (`TransactorSource.transact`) supplies it exactly when the header is a **fresh insert** — and a
fresh insert is, by construction, part of the block list the pend returned
(`blockIdsForTransforms` unions inserts, updates and deletes). So the guard
`!blockIds.includes(headerId)` is always false there, and the header is committed in stage 3 like
any other touched block: **after** the tail, not before it.

This was measured, not inferred: instrumenting the branch and running both suites produced 0 hits
across every db-p2p mesh test and 2 hits in db-core, both from `commit-digest-threading.spec.ts`
requests hand-built with the header deliberately held out of the block list.

## Why it matters

Nothing is broken today — the ordering that actually runs (tail, then everything else) is the one
`Collection.bootstrapContext` depends on, and it is what all the current tests exercise. The cost
is that **three separate contracts describe a behavior the system does not have**:

- `CommitRequest.headerId`'s doc comment says "commit first";
- `TransactorSource.transact`'s doc comment explains the ordering as a race-resolution mechanism
  for collection creation;
- the staged-commit narrative in `docs/internals.md`.

A reader reasoning about a collection-creation race from those comments will reason about a code
path that does not execute. That is the kind of drift that costs someone a day.

## The decision to make

Someone has to answer: **was the header meant to be ordered ahead of the tail during collection
creation, or not?**

- If **yes** — the guard is simply wrong and should key off "the header is a fresh insert" rather
  than "the header is absent from the block list", with the header then excluded from the sweep
  so it is not committed twice. This is a behavior change to the create path and needs a test
  that fails without it.
- If **no** — the branch and the `headerId` field's ordering role are dead weight. Delete the
  branch, and either drop `headerId` from the commit request or keep it purely as the
  metadata it has quietly become.

Either way, all three comments above must end up describing what the code does.

## Notes for whoever picks this up

- `NetworkTransactor.commit` already carries a NOTE at the sweep recording this measurement; keep
  it in sync with whatever is decided, and remove it if the branch goes away.
- `commit-digest-threading.spec.ts` is currently the only thing exercising the branch. If the
  branch is deleted, those requests are exercising a shape production never produces — worth
  deciding whether they should be rebuilt around a realistic request.
- Related, already-landed context: `Collection.bootstrapContext`'s "the tail is always committed
  first" comment is *true* today precisely because this branch never fires.
