description: A shared helper that extracts one block's pending changes hands back part of the data by reference instead of copying it, so every caller has to remember to make its own copy before using it — three places already do this by hand, and the fourth that forgets will silently corrupt the original.
files: packages/db-core/src/transform/helpers.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/src/transform/tracker.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/src/transactor/network-transactor.ts
difficulty: easy
repro: static
severity: corruption
likelihood: contrived
tradeoffs: Makes every caller pay a deep copy of an inserted block even when it only needs to read a flag — on the pend/commit path that is one extra copy per inserted block per call, and nobody has measured whether that matters.
----

# `transformForBlockId` should clone `insert`, not just `updates`

## What is going on

A "transform" is the set of pending changes staged for one block: an optional whole-block
replacement (`insert`), a list of in-place edits (`updates`), and an optional `delete` flag.
`transformForBlockId(transforms, blockId)` pulls one block's transform out of a larger set.

It **deep-clones `updates`** — its own doc comment explains why, citing the
"Shallow Copy of Transforms" pitfall in `docs/internals.md` — but it returns **`insert` by
reference**, aliasing the caller's original `Transforms.inserts[blockId]`.

The functions that consume a transform (`applyTransform` → `applyOperations` → `applyOperation`)
mutate **in place**. So any caller that feeds the result to `applyTransform` while `insert` and
`updates` both ride on the same id will write the update operations straight into the caller's
staged insert. The contract is half-total: one field is safe to hand around, the other is a
loaded gun, and nothing in the type says which.

## Evidence this is a class, not an instance

Four separate places have independently hand-written the same guard:

- `packages/db-core/src/testing/test-transactor.ts` — a private `applyTransformSafe` wrapper that
  clones the block *and* re-clones `transform.insert`.
- `packages/db-core/src/transform/tracker.ts` — `peekMaterialized` reassigns
  `transform.insert = structuredClone(transform.insert)` with a three-line comment explaining that
  `transformForBlockId` clones updates but not inserts.
- `packages/db-p2p/src/storage/storage-repo.ts` — `previewCommitDigest` (landed by
  `commit-cert-digest-member-check`) clones BOTH the base and the transform before `applyTransform`,
  with its own comment re-deriving the same reason. That is the fourth hand-written guard.

Each guard is correct. The point is that there are now four of them and they were each derived from
scratch. The fifth caller that skips it is a silent data-corruption bug with no test to catch it.

## Not a live defect today

Verified by reading every caller: the sites that do **not** clone
(`packages/db-core/src/transactor/network-transactor.ts` in `pend`, and the two calls in
`packages/db-p2p/src/storage/storage-repo.ts`) never pass the result to `applyTransform` — they read
`insert` as a truthiness flag, re-wrap it into another `Transforms`, or hand it to storage for
serialization. So this is hardening, not a fix.

## Desired end state

`transformForBlockId` returns data that no caller can use to damage the input, matching the
guarantee it already makes for `updates`. With that in place, the three hand-written guards become
redundant and should be removed so the next reader does not learn the wrong lesson from them.

Whoever picks this up should decide, rather than assume, whether the extra copy is acceptable on the
pend/commit path — and if it is not, the alternative is the opposite move: make the helper's
no-clone contract explicit in its name and type, so forgetting is a compile-time event rather than a
convention. Either resolution retires the class; leaving the contract half-total does not.

## Triage note (backlog gardening, 2026-09-01)

`severity: corruption` / `likelihood: contrived` / `repro: static`, derived from the body:

- **`corruption`** — the failure mode is a caller's staged `insert` being mutated underneath it, with
  no error and no test that would catch it. That is silent bad data, which is the worst plausible
  effect even though nothing produces it today.
- **`contrived`** — every current caller is safe (verified by reading all of them; three carry
  hand-written guards, the rest never reach `applyTransform`). Reaching the bad state needs a
  *future* caller written a specific way, so no user can hit it now.
- **`repro: static`** — read from the code. What would confirm it: a test that hands
  `transformForBlockId`'s result to `applyTransform` with both `insert` and `updates` on one block id,
  then asserts the input `Transforms` is unchanged.
