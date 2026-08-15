----
description: Our correctness document promised that a reader could always detect a peer tampering with block data by checking it against the block's identifier. That was false — identifiers are random numbers, not fingerprints of content — so the promise has been corrected to describe the protection the system actually provides.
files: docs/correctness.md, docs/architecture.md, docs/optimystic.md, docs/transactions.md, packages/db-core/docs/network.md
----

# Documentation claimed block identifiers are content hashes; corrected

Documentation-only change. No code behavior changed; no test or lint surface was touched.

## What was wrong

A block's ID is a random 256-bit value (`randomBytes(32)`, `packages/db-core/src/transactor/transactor-source.ts:36`),
and a collection header block's ID is the collection name passed through unchanged. Neither is derived
from block contents. `docs/correctness.md` **Theorem 15 (Read-Path Integrity)** nevertheless proved
forgery detection from the premise "Block IDs are content hashes" and concluded that content integrity
holds *unconditionally, with no trust in the serving peer*. `docs/transactions.md` already stated the
opposite, so the two documents contradicted each other.

This was a **security** claim: Theorem 15 is what a client author reads to decide whether a single-peer
read needs further verification, and as written it said none was needed.

## What the read path actually guarantees

Verified against code before rewriting, rather than assumed:

- **Cross-peer byte agreement is the only operative mechanism.** `reconcile-block.ts` requires cohort
  agreement on block *content*, not just on revision. It is conditional on an honest majority and on
  more than one reachable peer: `corroboratorCapacity` bounds the check, and at capacity one the sole
  peer's bytes are accepted on the same trust its (equally uncorroborable) revision claim already gets.
- **Commit certificates are *not* a read-path trust anchor today.** `CommitCert` is real and is produced
  at commit, but it lives only in an in-memory TTL cache used for reactivity
  (`packages/db-p2p/src/cluster/commit-cert.ts`); it is not persisted with the block, `BlockArchive` has
  no field for it, and the sync protocol has no path to serve it. A restoring node cannot obtain one.
- **The log prior-hash chain is genuine** (`packages/db-core/src/log/log.ts` — each entry carries the
  SHA-256 of its predecessor) and remains a real integrity mechanism.
- **The transaction ID is a genuine content hash** (SHA-256 of stamp id, statements, read dependencies)
  and is still described that way everywhere.

## Changes

- `docs/correctness.md`
  - §2 **Definitions** — "a cryptographic block ID" replaced with what a `BlockId` actually is: an
    opaque, stable name, random for data blocks and the collection name for headers, explicitly *not*
    a hash of contents.
  - **Theorem 15** — integrity paragraph rewritten onto cross-peer agreement; statement, bound, and
    `Depends on` all restated as *conditional*. `Depends on` no longer cites SHA-256 collision
    resistance, since no content hash is checked on this path. Added an explicit consequence note for
    client authors: a single-peer read carries no integrity guarantee. The freshness paragraph no
    longer calls served data "content-addressed".
  - **Theorem 14** — *second instance of the same class, found during this fix and not named in the
    original ticket.* Its "Content addressing" proof bullet made the identical false claim and was
    removed; the lead-in ("Two mechanisms") now matches the two that remain. Its "Commit signatures as
    trust anchor" bullet was **also false today** — a third instance — and now states plainly that the
    cert cannot be fetched on this path, pointing at `debt-read-repair-commit-cert-verification`. The
    bound was tightened from "at least one honest peer" to an honest *majority*, which is what
    outvoting liars actually requires once no content is self-authenticating.
- `docs/architecture.md` — the two opening taglines no longer call the storage "content-addressed";
  the header-block claim at §Collections restated as name-derivation. The glossary entries were already
  accurate (fixed by `storage-invariants-undocumented-and-doc-rot`) and were left alone.
- `docs/optimystic.md` — same header-block correction.
- `docs/transactions.md` — the proximity-read note no longer calls returned data "content-addressed";
  it now says the data is a real committed revision but unverified against the block id.
- `packages/db-core/docs/network.md` — reframed throughout from "content-addressed" to "ID-addressed",
  which is what the mechanism genuinely is (placement derives from the block ID via ring hashing). Added
  a note at the top drawing the distinction and pointing at correctness.md. Headings, the code comment,
  and the closing summary follow the same rename.

## Verification

- Full-document sweep for the class: `grep -rn "content hash\|content-address\|content address" -i docs/ packages/*/docs/`.
  Every surviving hit either refers to the transaction ID / invalidation reversal (genuinely
  content-addressed) or explicitly *negates* the claim. `docs/internals.md` was already correct at
  lines 356 and 471 and needed no change.
- Doc-only diff; no source files touched. `yarn check` was run over the tree for the release gate.

## Review findings

Not applicable — this ticket was executed directly on human instruction during a garden-tending pass,
not routed through the plan/implement/review pipeline. The material risk in a doc-only change of this
kind is asserting a *new* false mechanism in place of the old one, so every replacement claim was
checked against code first (see "What the read path actually guarantees" above); where the honest
answer was "this protection does not exist yet", that is what the document now says, with the tracking
ticket named.
