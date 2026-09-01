description: When a save touches a lot of records at once, the system only manages to describe the first hundred or so of them, and every record it fails to describe quietly loses the ability to be copied to new machines. The bigger the save, the smaller the fraction that stays copyable.
files: packages/db-core/src/transform/digest.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/network/struct.ts, packages/db-core/test/digest-cache-coverage.spec.ts, packages/db-core/test/digest.spec.ts
difficulty: hard
----

# Content-digest coverage is capped by the read cache, so it decays as 1/N

Design task: make declaration coverage a function of what a transaction touches rather than of what
a fixed-size cache happens to still hold. The measurement and its standing guard already landed;
this ticket is the remediation design only.

## What a "declaration" is, and why missing one matters

When a change is committed, the committing node may declare, per block, the content digest that
block should hold once the commit lands (`CommitRequest.blockDigests` in `network/struct.ts`). Two
things depend on that declaration:

- **At vote time** each cohort member re-materializes the block and votes reject if the result
  disagrees — so a declaration turns a blind vote into a checked one.
- **At replication time** the committing members retain a durable `BlockCommitProof` *only* for a
  block that was declared. A block with no proof is refused by every push receiver running the
  default `requirePushCertificate: true`. It stays readable, pullable, and repairable by
  corroboration while two or more holders remain — but it can never **gain** a holder by push, so
  churn-driven re-replication silently stops maintaining its replication factor.

The second point is what this ticket is about. Declaring is optional and skipping it never fails a
commit, which is exactly why the shortfall is invisible.

## The measurement (already landed — do not redo)

`computeBlockContentDigests` describes the commit *without loading anything from the network*: for
each touched block it asks `Tracker.peekMaterialized`, which peeks the read cache for the base and
returns `undefined` for any id the cache cannot answer for. A `Collection` builds exactly one read
cache — a `CacheSource` LRU at the default capacity of **128 blocks** (`collection.ts` `probeHeader`).

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

## Expected behaviour

A commit of N update-carrying blocks should declare all N, minus only the ids that legitimately have
nothing to declare — deletes, and updates whose base this node genuinely never read. Coverage must
not depend on cache residency at commit time.

## Both producer sites must end up covered

`computeBlockContentDigests` has **two** callers, and a remediation that fixes only the first leaves
half the problem standing:

- `collection/collection.ts` (~line 967) — the single-collection `sync()` retry loop. Builds a fresh
  snapshot `Tracker` over `this.sourceCache` on **every retry attempt**, so whatever carries the base
  must survive being re-derived from `copyTransforms(this.tracker.transforms)`.
- `transaction/coordinator.ts` (~line 1206) — the multi-collection commit path, using the
  collection's own live tracker. Same cache, same cap.

## Two candidate shapes (both sketched at `digest.ts`; the design call is this ticket's job)

- **Size the cache to the transaction.** Guarantee that every block an in-flight action touches stays
  resident until the action commits. Cheap to state, but it makes the cache's memory ceiling a
  function of transaction size, which is the property the fixed LRU exists to prevent.
- **Carry the base revision alongside the staged updates.** Record what a block's base was at the
  moment the update was staged, so the digest pass never has to re-read it. The stronger rung: it
  makes declarability independent of cache residency, so the bad state stops being reachable rather
  than merely becoming rarer. Costs a change to the `Tracker`/`Transforms` representation, which
  `copyTransforms`, `blockIdsForTransforms`, the pend/commit wire path, and `createReadTracker`'s
  pinned read view all sit on top of.

The second shape is the one to design against unless the investigation turns up a blocker; the first
is the fallback. Note that a base-carrying representation must hold enough to *materialize*, not just
enough to identify — `peekMaterialized` needs the base block content, not only its revision number.
Weigh that memory cost against shape one honestly; if carrying content is what it takes, the two
shapes may converge and the design should say so rather than pick by label.

## Constraints the remediation must preserve

- **Delete-only / tombstone blocks** materialize to nothing and must keep being omitted.
- **A commit must never pay a network read to describe itself** — that is the whole reason the
  current pass peeks instead of fetching, and it must stay true under either shape.
- **An unreplayable staged op must degrade to "undeclared", not throw** out of `sync()` before the
  pend (covered by `digest.spec.ts`).
- **Declared digests must stay byte-stable in the canonical-JSON preimage**: the request is hashed
  verbatim into every cohort signature, and a commit that declares nothing must serialize exactly as
  it did before the field existed (`blockDigestsField`).
- **`peekMaterialized` must stay recency-neutral and memo-neutral** — an observation pass must not
  reshape LRU eviction order or the tracker's materialized memo.

## What flips when this lands

- `digest-cache-coverage.spec.ts`: `declares every block it touches` starts passing and
  `pins today's gap` starts failing. Retire the second test; keep the first as the standing guard.
- The accepted-tradeoff `NOTE:` at `transform/digest.ts` (which carries the measurement table) and
  the `NOTE:` at `network/struct.ts` that cites it both need rewriting to describe the new contract.

## Why a maintainer might defer this

Nothing observed has yet committed more than ~128 update-carrying blocks in one action, so this is a
latent capacity concern with no current workload behind it — and both remedies touch the
read-cache/tracker contract that a lot of other behaviour rests on.
