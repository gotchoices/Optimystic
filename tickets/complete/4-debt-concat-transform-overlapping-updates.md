description: A helper that stitches block changes together used to throw away one side's edits when both sides touched the same block — fixed, then simplified to reuse its sibling helper so the two can never drift apart again.
prereq:
files: packages/db-core/src/transform/helpers.ts, packages/db-core/test/transform.spec.ts, packages/db-p2p/src/storage/storage-repo.ts
difficulty: easy
----

## What shipped

`concatTransform(transforms, blockId, transform)` in `packages/db-core/src/transform/helpers.ts`
appends one block's `Transform` onto an existing `Transforms`. It had a clobber bug: when
`transforms.updates[blockId]` already held operations and the incoming `transform.updates` also
targeted `blockId`, the object spread replaced the existing operations array instead of
concatenating — silent data loss. `deletes` could also accrue duplicate block ids.

The implement stage fixed both by hand-copying the merge logic from the sibling helper
`mergeTransforms` (which had received the same fix earlier, under ticket
`transform-merge-and-atomic-concurrency`). The review stage then replaced that copy with delegation:

```ts
export function concatTransform(transforms: Transforms, blockId: BlockId, transform: Transform): Transforms {
	return mergeTransforms(transforms, transformsFromTransform(transform, blockId));
}
```

Behavior is identical (verified term by term for `inserts`, `updates`, and `deletes`, including the
`undefined` cases on both sides), but the merge rules now live in exactly one place.

Resulting semantics, shared by both helpers:

- `updates` — a block id present on both sides concatenates, existing operations first (order-preserving).
- `deletes` — deduped to a unique set.
- `inserts` — last-wins (intentional, unchanged).

## Why this was dormant, not an active bug

Every current caller passes disjoint block ids per accumulator, so the overlapping path never fired
in production: `network-transactor.ts` `pend` iterates a set of distinct block ids;
`test-transactor.ts` accumulates one block id per action per iteration; `db-p2p/storage-repo.ts`
`perBlockActionTransformsToPerAction` relies on one revision per action per block. No caller's
behavior changes — the trap is simply closed.

## Review findings

**Checked:** the full implement diff read before the handoff summary; `helpers.ts` against its sibling
`mergeTransforms` for behavioral equivalence and duplication; all 5 `concatTransform` call sites plus
the 4 `transformsFromTransform` call sites across `db-core` and `db-p2p`; whether any code mutates the
operations arrays these helpers hand back; every comment and doc file naming either helper; test
coverage across the concat, assign, dedupe, last-wins, and no-mutation paths.

**Fixed in this pass:**

- *Duplicated merge logic — the root cause of this very ticket.* The implement stage's fix was a
  hand-copy of `mergeTransforms`'s body into `concatTransform`. That duplication is exactly what
  produced this ticket in the first place: the sibling was fixed earlier and this one silently drifted.
  Copying the fix would have left the next divergence just as likely. Replaced with delegation
  (`mergeTransforms(transforms, transformsFromTransform(transform, blockId))`) — 13 lines down to 3,
  and the two helpers are now the same code path by construction rather than by vigilance. This is
  why no follow-up ticket was filed for the class: the class is retired, not queued.
- *Stale comment asserting the old behavior.* `packages/db-p2p/src/storage/storage-repo.ts` (the jsdoc
  above `perBlockActionTransformsToPerAction`) still said "concatTransform's last-wins merge would
  silently drop the earlier revision's ops" — false as of this change, and it also pointed at this
  ticket's own slug as if it were still open. Rewritten to state the current behavior: two revisions
  under one action id now concatenate rather than drop, which is still wrong (operations from distinct
  revisions are not composable against a single base) but loud rather than silent. The remedy it
  recommends — group by `(actionId, rev)` — is unchanged.
- *Test coverage gap the implementer flagged, plus three more.* Added to
  `packages/db-core/test/transform.spec.ts`: `deletes` dedupe through `concatTransform` (the flagged
  gap), the no-existing-operations assign path with a sibling block id left untouched, `inserts`
  last-wins on a repeated block id, and a no-input-mutation check on both arguments. Test count
  1349 → 1353.

**Noticed and deliberately not filed:**

- All three helpers (`concatTransform`, `mergeTransforms`, `transformsFromTransform`) alias the
  caller's operations array when the block id is new, rather than copying it — and `Tracker.update`
  pushes into that array in place (`tracker.ts:101`). This predates the change, spans all three
  helpers equally, and is already the documented "Shallow Copy of Transforms" pitfall in
  `docs/internals.md` with `copyTransforms` as the sanctioned mitigation, cited in jsdoc on both
  `copyTransforms` and `transformForBlockId`. Already decided; not re-filed.
- The unrelated `AGENTS.md` and `tickets/.garden-report.md` edits that rode along in the implement
  commit are garden-tending, not part of this change. Left alone.

**Docs:** grepped every doc path for both helper names. The only hit is `docs/review.html`, a
historical record of a past review pass that names the original `mergeTransforms` defect — a dated
artifact, correct as history, so not edited. No architecture doc describes these helpers' merge
semantics, so nothing else needed updating.

**Empty categories:** no major findings, so no `fix/`, `plan/`, or `backlog/` tickets were filed —
the one structural finding (duplicated merge logic) was resolvable inline in three lines, and
resolving it removed the whole drift class rather than one instance of it. No tripwires were
recorded either: the one conditional concern in range (two revisions per action id in
`storage-repo.ts`) already had a `NOTE:` at its exact site, so this pass corrected that note rather
than adding a new one.

## Validation

- `packages/db-core`: `npx tsc --noEmit` clean; `yarn test` — **1353 passing, 0 failing**.
- `packages/db-p2p`: `npx tsc --noEmit` clean; `yarn test` — **1519 passing, 44 pending, 0 failing**.
- `npx eslint` over all three touched files — clean.
