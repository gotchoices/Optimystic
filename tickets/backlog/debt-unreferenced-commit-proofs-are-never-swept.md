description: Once machines can delete data they are no longer responsible for, the small cryptographic receipts that proved those writes were agreed stay behind with nothing pointing at them, and nothing can ever find or remove them.
architecture: packages/db-p2p/docs/storage.md
files: packages/db-p2p/src/storage/i-raw-storage.ts (`getCommitProof`, `saveCommitProof`, `getBlockProof`), packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/batch-backend.ts (`StoreKey`'s `commitProofs` arm)
tradeoffs: One proof per consensus message with at most 256 signatures is small beside the block content it certifies, so a maintainer may reasonably decide the leak is not worth a new enumeration on every backend; against that, it is unbounded and grows with every range a node ever sheds.
----

# Unreferenced commit proofs are never swept

## What is left behind

A node stores one commit proof per consensus message, under that message's hash, however many blocks the message covered (`saveBlockProof` in `packages/db-p2p/src/storage/i-raw-storage.ts`). Each revision that the message certifies holds a *reference* to it in the proofs store. The commit-proofs store is the only one of the seven block-storage stores that is not scoped to a block, and its key — a message hash — says nothing about which blocks the message covered.

Deleting a block removes its revisions' references. It cannot remove the proof bodies they pointed at, because a body may still certify revisions of blocks this node keeps, and nothing records which. The two contract notes on `IRawStorage` anticipated exactly this: "a stored proof is kept as long as any revision refers to it — forever, since no revision-delete site exists. A site that ever deletes revisions must count or sweep the commit proofs it leaves unreferenced."

That site now exists, so the bytes now accumulate: one orphaned body per consensus message whose every certified revision this node has deleted, for every range it ever sheds.

## What a sweep would need first

The store cannot be enumerated. `BatchBackend` offers `get(key)` for a `commitProofs` key and nothing else — no listing, no range — so there is no way even to find the orphans, let alone decide which are orphans. Any fix starts with one of:

- **A listing** over the commit-proofs store on each backend, plus a mark-and-sweep that walks every block's revisions to build the live reference set. Correct, and costs a full walk of the node's revisions per sweep.
- **A reference count** per message hash, written beside the body and adjusted whenever a revision's reference is written or deleted. Cheap to read, but every write path that stores or deletes a proof reference becomes a two-key update that has to stay consistent across crashes.
- **A reverse index** from message hash to the blocks it covered, written at `saveCommitProof`. One extra key per message, and a delete can then decide locally.

The third is probably the cheapest honest answer, and it is the one that needs no new backend capability — but it only helps proofs written after it lands, so it wants a one-off migration pass or an acceptance that older bodies are never collected.

## How much it is

Unmeasured. A proof carries the consensus message and up to `MAX_PROOF_SIGNERS` (256) signatures, so an upper bound per orphan is a few tens of kilobytes and a typical one is far smaller; the count is one per consensus message whose certified revisions are all gone. Nobody has measured either the typical size or the rate on a node that sheds, and the first thing this ticket should do is measure both — a fix whose cost is a revision walk per sweep should not be built against a guess.
