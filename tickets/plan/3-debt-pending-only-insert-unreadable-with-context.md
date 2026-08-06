description: A storage node has code meant to serve a brand-new record that has been written but not yet finalised, but that code can never run — the node always reports the record as unreadable instead. Nothing hits this today, but the code claims to handle a case it does not.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-core/src/collection/action.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: No caller in this repository reaches the path — only an external peer speaking the public repo protocol could — so the fix is corrective housekeeping, and it requires deciding which of two components is authoritative, which is a judgement call a maintainer may not want to make yet.
----

# A not-yet-finalised new block cannot be read back when the reader supplies a context

## Background in plain terms

Writing to a block happens in two steps. First the node stores a *pending* record of the change.
Later, once the group agrees, the node *promotes* that pending record into a real committed
revision. Between those two steps the block has a pending record but no committed revision at all.

A reader can ask a storage node for a block in two ways:

- **without a context** — "give me the newest committed content you hold";
- **with a context** — "give me the content as of revision N, and also apply pending action A on
  top of it". This second form is how a writer reads back its own not-yet-finalised change.

## What is wrong

`StorageRepo.get` has a branch that is written to handle the second form for a block with *no*
committed revision yet — a brand-new insert. Its own comment said so, and the revision-reporting
code added by `bug-pinned-get-reports-latest-revision` has an explicit "no committed base" arm for
it. That branch is unreachable.

The reason is a mismatch between two pieces:

- `ActionContext` (`packages/db-core/src/collection/action.ts`) declares `rev` as a **required
  number**. A caller supplying a context always supplies a revision.
- `BlockStorage.getBlock(rev)` only tolerates a block with no committed revision when `rev` is
  **undefined**. With any number it walks the revision log, finds nothing, and throws
  `Failed to find materialized block ...`.

`StorageRepo.get` calls `getBlock(context?.rev)` *before* the pending branch and catches that throw
into `unavailable: 'unmaterializable'` — an answer meaning "I hold records proving this block exists
but I cannot reconstruct it". So the reader is told the block is unreadable rather than being handed
its own pending content.

Downstream, `TransactorSource.tryGet` turns a blockless `unavailable` entry into a thrown
`BlockUnavailableError`, so this would surface as a hard read failure, not a silent wrong answer.

## Reachability — why this is filed as dormant debt, not an active bug

Verified against the repo's own public API: pending an insert and then calling `get` with
`{ actionId, rev, committed: [] }` returns `{ state: {}, unavailable: 'unmaterializable' }` for every
revision tried (0, 1, 2). Locked in as a `KNOWN GAP:` test in
`packages/db-p2p/test/storage-repo.spec.ts`.

No *current* caller inside this repository reaches it — the whole suite is green, and a
collection's own not-yet-committed inserts are served from its in-memory tracker/cache rather than
from storage. So this is a latent defect on a dormant path: definitely wrong the moment anything
takes it, but nothing takes it today. That includes any future or external caller of the repo
protocol, which is a public surface — a peer is free to send this shape.

## What "fixed" should look like

Decide which of the two pieces is authoritative, then make the other agree:

- **Either** `BlockStorage.getBlock` should treat "no committed revision at all" as an absent base
  rather than a fault regardless of whether a revision was named — a block with nothing committed is
  not the same as a block whose history is truncated, and only the latter deserves
  `unmaterializable`;
- **or** `StorageRepo.get` should resolve the pending overlay before deciding a failed base lookup is
  fatal, so a pending-only insert is served over an undefined base as its branch already intends.

Whichever way it goes, the `unmaterializable` flag must keep its existing, distinct meaning for the
genuine case it was introduced for: this node holds records proving the block exists (a pending it
could not promote, or truncated history) and cannot reconstruct it. That case is covered by
`get — unavailable vs absent` tests in the same spec and must stay passing.

The `KNOWN GAP:` test asserts today's behaviour and should be rewritten — not deleted — as part of
the fix, so the new behaviour is pinned down.
