description: Our correctness document promises that a reader can always detect a peer that tampers with block data, by checking the data against the block's identifier. That is not true — identifiers are random numbers, not fingerprints of the content — so the promise should be corrected to describe the protection the system actually provides.
files: docs/correctness.md, docs/architecture.md, docs/optimystic.md, packages/db-core/docs/network.md, docs/transactions.md
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: It is a documentation-only defect — no shipping code behaves differently because of it — so a maintainer could reasonably rank it below functional work; the counter-argument is that this particular claim is a *security* claim, and someone designing a client on top of it may skip a verification step they actually need.

# The documentation claims block identifiers are content hashes; they are not

## What is wrong

A block's identifier is a random 256-bit value (`generateId` in
`packages/db-core/src/transactor/transactor-source.ts` — `randomBytes(32)`). A collection header
block's identifier is the collection name itself, passed through unchanged. Neither is derived from
the block's contents, and a block's contents change every revision, so an identifier *cannot* be a
fingerprint of them.

Several documents nevertheless say it is. The most consequential is
`docs/correctness.md`, **Theorem 15 (Read-Path Integrity)**, whose proof opens:

> *Integrity (forgery detection).* Block IDs are content hashes. A reader that knows a block ID can
> fetch the block from any peer and verify the hash. A Byzantine peer serving tampered content
> produces a hash mismatch — detected immediately. This holds unconditionally: no trust in the
> serving peer is required, only knowledge of the expected block ID.

Every sentence of that paragraph is false as written. The theorem's stated bound ("Content integrity
is unconditional given the block ID") and its "Depends on: SHA-256 collision resistance" line rest on
the same false premise.

`docs/transactions.md` already states the true position, and directly contradicts Theorem 15:

> block ids are random 256-bit strings, not content hashes, so a peer's bytes are checked against
> *other peers' bytes*, never against the id you asked for.

## Why it matters

Theorem 15 is the document a client author would read to decide whether a single-peer read needs
further verification. As written it says no verification is needed, unconditionally. In reality a
single peer's bytes are unchecked: the protections that do exist are (a) comparing bytes fetched from
several peers, which needs an honest majority and more than one reachable peer, and (b) the
super-majority commit signatures a committed revision carries. Both are conditional. The gap between
"unconditional" and "conditional on honest majority and multi-peer reachability" is exactly the gap
someone would build a wrong client on.

## Scope — the whole class, not just the one paragraph

This is one instance of a recurring phrase. A fix should sweep them together and land on one accurate
formulation, because they are read against each other:

- `docs/correctness.md` — Theorem 15's integrity paragraph, its bound, and its dependency list
  (above). Also §2 Definitions, which calls the block ID "a cryptographic block ID" (true only in the
  sense of *cryptographically random*, which is the reading a hurried reader will not take), and
  Theorem 15's freshness paragraph, which calls a served block "internally consistent
  (content-addressed)".
- `docs/architecture.md` and `docs/optimystic.md` — both say a collection's header block is
  "content-addressed from the collection name". It is not addressed by a hash of anything; it *is*
  the name. The property that actually matters — every peer resolves the same collection name to the
  same header block without coordination — survives an accurate rewording.
- `packages/db-core/docs/network.md` — repeatedly frames the whole system as
  "content-addressed distributed storage" where "blocks are distributed by their hash/ID". Block
  placement on the ring really is derived from the block ID, so the mechanism described is right;
  only the word "hash" is wrong.
- `docs/architecture.md`'s opening taglines (lines 3 and 9) call the storage "content-addressed" at
  the system level. That is loosely defensible — the transaction ID genuinely is a content hash — but
  it is the phrase that seeds the confusion everywhere else, so it deserves a decision rather than
  being left alone by default.

Blocks and revisions that genuinely *are* content-addressed, and should stay described that way: the
transaction ID (`SHA-256` of stamp ID, statements, and read dependencies), which is the identifier
2PC keys on.

## What "done" looks like

`docs/correctness.md` Theorem 15 states the real read-path guarantee and its real conditions, its
dependency list matches, and no remaining document asserts that a block identifier is a hash of block
content. Someone reading Theorem 15 and `docs/transactions.md` back to back should not find them
contradicting each other.

## How this was found

Review of `storage-invariants-undocumented-and-doc-rot`, which corrected the same confusion in
`docs/architecture.md`'s glossary and `docs/internals.md`'s Key Invariants. That sweep grepped for
the phrase "content-addressed" and so did not see "Block IDs are content hashes", which is the more
damaging instance.
