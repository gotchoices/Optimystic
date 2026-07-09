description: When a storage node rejected a write because someone else had already written a newer version, it was supposed to send back the newer changes it had — but a coding slip made it send back an empty set every time. Fixed, with regression tests.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
----

## What shipped

### The fix (`packages/db-p2p/src/storage/storage-repo.ts`, `perBlockActionTransformsToPerAction`)

`concatTransform` is a pure function — it returns a new `Transforms` and never mutates its first
argument. The reduce called it and discarded the result, so the accumulator stayed at
`emptyTransforms()` forever. Every `StaleFailure.missing[*].transforms` returned by
`StorageRepo.commit` was `{ inserts: {}, updates: {}, deletes: [] }`, no matter how many blocks the
missed action had touched.

```ts
// before
concatTransform(acc.transforms, blockId, transform.transform);
// after
acc.transforms = concatTransform(acc.transforms, blockId, transform.transform);
```

### Tests (`packages/db-p2p/test/storage-repo.spec.ts`, `describe('commit — stale-conflict missing transforms')`)

Four cases, all of which fail against the pre-fix source and pass against the fixed source:

- single-block stale conflict returns the missed action's insert (and its `rev`)
- multi-block stale conflict returns inserts for both missed blocks
- the missed action's `updates` and `deletes` both survive the regrouping
- two missed actions on one block come back as two entries, each with its own `rev` and its own transforms

## Review findings

### Checked

- **The one-line fix itself.** Read `concatTransform` (`packages/db-core/src/transform/helpers.ts:152`)
  and confirmed it is pure and covers all three of `inserts` / `updates` / `deletes`. The fix is
  correct and complete for the whole `Transforms` shape.
- **Falsifiability of the new tests.** Reverted the fix in the working tree, ran the spec: all four
  new tests fail. Restored the fix; they pass. A regression test that also passes on the bug would
  have been worthless here, and the original two nearly were (see below).
- **Sibling instances of the same mistake.** Grepped every `packages/*/src` for a pure transform
  helper (`concatTransform`, `concatTransforms`, `mergeTransforms`, `copyTransforms`,
  `withOperation`, `transformsFromTransform`, `transformForBlockId`, `applyTransform`) called as a
  bare statement with its result discarded. No other sites. This was a one-off.
- **Docs.** `packages/db-core/docs/network.md:229` already states that `missing` carries "the newer
  committed transactions" so the collection layer can rebase, and `docs/correctness.md:279-281`
  distinguishes `success:false` *with* `missing` (tolerated divergence) from a bare `reason`
  (propagated fault). Both documents describe the post-fix behavior; the code was the thing out of
  step, not the docs. No doc edits needed.
- **Lint and tests.** `npx eslint` on both touched files: clean. `yarn workspace @optimystic/db-p2p
  build`: clean. Full package suite: **1310 passing, 36 pending, 0 failing.** No pre-existing
  failures surfaced.

### Found and fixed in this pass (minor)

- **The original two tests could pass vacuously.** Both wrapped every assertion in
  `if (!result.success && 'missing' in result) { ... }`. If a future regression made `commit` fail
  some *other* way — a thrown missing-pend, a bare `reason` with no `missing` — the guard would be
  false, the body would never run, and the test would report green having asserted nothing. Replaced
  with an `expectStaleMissing(result)` helper that asserts `success === false` and asserts `missing`
  is present before returning it, so a shape change fails loudly.
- **A shared mutable fixture.** The multi-block test passed one `Transforms` object literal to two
  separate `pend` calls. `pend` and the tracker layer mutate inserted block objects in place (this is
  a documented pitfall — see the `copyTransforms` doc comment), so the two actions were pending
  against the same block instances. Replaced with a factory that builds a fresh `Transforms` per call.
- **Silent setup failure.** Writing the new update/delete test surfaced that `StorageRepo.commit`
  converts an exception thrown while applying a transform into `{ success: false, reason: <message> }`
  rather than throwing. My first draft used a block with no `items` array, so the setup commit failed
  with `"Cannot read properties of undefined (reading 'splice')"` and the test's premise silently
  never held. Both new tests that rely on a prior commit landing now assert `commit.success === true`
  on that setup step.
- **A misleading comment.** The site read `// Assumption: all missing actionIds share the same
  revision`, which is false — the new grouping test returns `a1` at rev 1 and `a2` at rev 2 in one
  response. The real (and true) assumption is that *one* action commits at *one* revision, so all of
  a single actionId's per-block entries agree. Comment corrected.

### Major findings

None. No new tickets filed. The fix is correct, minimal, and now covered; nothing in the diff or its
surroundings warranted separate work.

### Tripwires

- `perBlockActionTransformsToPerAction` depends on each `(actionId, blockId)` pair appearing at most
  once. That holds today (one revision per action per block), and it is why the known
  `concatTransform` overlapping-updates overwrite cannot bite here. If a block ever records two
  revisions under the same actionId, the earlier revision's ops for that block would be silently
  dropped. Parked as a `NOTE:` comment on the function in
  `packages/db-p2p/src/storage/storage-repo.ts`, cross-referencing
  `debt-concat-transform-overlapping-updates`.

### Carried-forward reviewer notes from implement, now resolved

- "Only `inserts` is exercised" — resolved; `updates` and `deletes` now have a test.
- "Downstream callers today only inspect `missing.length`" — confirmed by reading
  `coordinator.ts` and `cluster-repo.ts`. Still true, so there was no present-day data loss; the fix
  restores the `StaleFailure` contract that `packages/db-core/docs/network.md` promises to future
  consumers (client-side rebase, dispute evidence).
