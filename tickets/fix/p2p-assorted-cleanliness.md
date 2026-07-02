----
description: A cluster of small robustness cleanups in the peer-to-peer layer: a record comparison that wrongly reports a mismatch when fields are in a different order, an unused cancellation setup, and a duplicated check that should live in one place.
files: packages/db-p2p/src/cluster/cluster-repo.ts (record equality ~435-439; dedup call sites ~334-361; handleConsensus), packages/db-p2p/src/it-utility.ts (first() ~1-17)
difficulty: easy
----

# Assorted P2P cleanliness fixes

Three low-severity robustness cleanups in `db-p2p`. Group them into this one
ticket. (A fourth related item from the review — the untyped composition root
`(components: any)` and the empty `catch {}` around `setLibp2p` injections in
`libp2p-node-base.ts:402-513` — is intentionally **out of scope here**: it is
owned by the engineering-health finding eh-4. Do not duplicate it; if it is
convenient to reference, prereq eh-4 rather than re-fixing.)

## (a) Order-sensitive record equality throws spurious "mismatch"

`cluster-repo.ts:435-439` compares records with `JSON.stringify` equality on
`peers` / `message`, which reports a false "mismatch" whenever two logically-equal
objects differ only in key order. The class already has a `canonicalJson` helper;
use it (or compare `messageHash`) so equal records compare equal regardless of
key ordering.

## (b) Dead abort-signal plumbing in first()

`it-utility.ts:1-17`: `first()` builds an `AbortController` that its main caller
ignores. Either wire the signal through so cancellation actually works, or drop
the dead plumbing.

## (c) Duplicated dedup await

`cluster-repo.ts:334-361`: both the `OurCommitNeeded` and `Consensus` call sites
independently await the async "already executed / dedup" check before calling
`handleConsensus`. Fold that check into `handleConsensus` itself so there is one
call site and the two callers can't drift.

## TODO
- (a) Replace order-sensitive equality with `canonicalJson`/`messageHash` compare.
- (b) Wire or remove the `AbortController` in `first()`.
- (c) Move the dedup check into `handleConsensus`; remove the duplicated awaits.
