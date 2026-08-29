description: When a save touches a lot of records at once, the system only manages to describe the first hundred or so of them, and every record it fails to describe quietly loses the ability to be copied to new machines. The bigger the save, the smaller the fraction that stays copyable.
files: packages/db-core/src/transform/digest.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/collection/collection.ts, packages/db-core/test/digest-cache-coverage.spec.ts
tradeoffs: Nothing has been observed committing more than ~128 update-carrying blocks in one action, so a maintainer could reasonably say this is a latent capacity concern with no current workload behind it and wait for a real one — especially since both remedies touch the read-cache/tracker contract that a lot of other behaviour rests on.
----

# Content-digest coverage is capped by the read cache, so it decays as 1/N

## What a "declaration" is, and why missing one matters

When a change is committed, the committing node may declare, per block, the content digest that
block should hold once the commit lands (`CommitRequest.blockDigests`). Two things depend on that
declaration:

- **At vote time** each cohort member re-materializes the block and votes reject if the result
  disagrees — so a declaration turns a blind vote into a checked one.
- **At replication time** the committing members retain a durable `BlockCommitProof` *only* for a
  block that was declared. A block with no proof is refused by every push receiver running the
  default `requirePushCertificate: true`. It stays readable, pullable, and repairable by
  corroboration while two or more holders remain — but it can never **gain** a holder by push, so
  churn-driven re-replication silently stops maintaining its replication factor.

The second point is the one this ticket is about. Declaring is optional and skipping it never fails
a commit, which is exactly why the shortfall is invisible.

## The measurement

`computeBlockContentDigests` describes the commit *without loading anything from the network*: for
each touched block it peeks the read cache for the base, and omits any id the cache cannot answer
for. A `Collection` builds exactly one read cache, an LRU at the default capacity of **128 blocks**.

Measured through the production path (`Collection.act` → `Collection.sync`) by
`packages/db-core/test/digest-cache-coverage.spec.ts`, for a commit that updates N blocks:

| N update-carrying blocks | declared | coverage |
| --- | --- | --- |
| 32 | 32 | 100% |
| 128 | 126 | 98.4% |
| 200 | 126 | 63.0% |
| 256 | 126 | 49.2% |
| 512 | 126 | 24.6% |

The declared count does not merely thin out — it **caps**. 126 is the 128 cache slots less the
collection header and the log tail, which occupy two of them. So coverage is `min(N, 126) / N`: it
decays as 1/N, and an arbitrarily large commit declares an arbitrarily small fraction of itself. The
survivors are the newest contiguous run of ids, exactly as LRU eviction predicts.

Nothing warns. The only signal is a debug-level `commit:proof-undeclared` line on each committing
member, and then a `push:reject-uncertified reason=no-proof` much later when replication is refused.

## What is already done, and is NOT this ticket

The measurement above and its standing guard already landed (three tests in
`digest-cache-coverage.spec.ts`, including a control that a transaction fitting inside the cache
declares all of it). The accepted-tradeoff `NOTE:` at `transform/digest.ts` carries these numbers.
This ticket is only the remediation.

## Expected behaviour

Declaration coverage should be a function of what the transaction touches, not of what a fixed-size
LRU happens to still hold. A commit of N update-carrying blocks should declare all N (minus the ids
that legitimately have nothing to declare — deletes, and updates whose base this node genuinely
never read).

Two candidate shapes, both sketched at `digest.ts` and both larger than a point fix:

- **Size the cache to the transaction.** Guarantee that every block an in-flight action touches
  stays resident until the action commits. Cheap to state, but it makes the cache's memory ceiling a
  function of transaction size, which is the property the fixed LRU exists to prevent.
- **Carry the base revision alongside the staged updates.** Record what a block's base was at the
  moment the update was staged, so the digest pass never has to re-read it. This is the stronger
  rung: it makes declarability independent of cache residency, so the bad state stops being
  reachable rather than merely becoming rarer. It costs a change to the tracker/transform
  representation.

Whichever lands, the `debt-` guard flips: `pins today's gap` in `digest-cache-coverage.spec.ts`
starts failing and should be retired, and the `NOTE:`s at `transform/digest.ts` and
`network/struct.ts` that cite it need updating.

## Edge cases the remediation must preserve

- **Delete-only / tombstone blocks** materialize to nothing and must keep being omitted.
- **A commit must never pay a network read to describe itself** — that is the whole reason the
  current pass peeks instead of fetching, and it must stay true.
- **An unreplayable staged op must degrade to "undeclared", not throw** out of `sync()` before the
  pend (covered by `digest.spec.ts`).
- **Declared digests must stay byte-stable in the canonical-JSON preimage**: the request is hashed
  verbatim into every cohort signature, and a commit that declares nothing must serialize exactly as
  it did before the field existed (`blockDigestsField`).
