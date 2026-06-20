description: A source file has a stray invisible null character in it that makes Git treat the whole file as binary, so its diffs show up as unreadable "binary files differ" instead of normal text changes.
prereq:
files: packages/db-p2p/src/dispute/cascade.ts
difficulty: easy
----

# Normalize the literal NUL byte in cascade.ts `pairKey`

## What's wrong

`pairKey` in `packages/db-p2p/src/dispute/cascade.ts` (around line 67) uses a **literal `0x00` (NUL) byte**
as the separator inside its template literal:

```ts
function pairKey(blockId: BlockId, rev: number): string {
	return `${blockId}<literal NUL here>${rev}`;
}
```

It should use the `\0` **escape** instead (two source characters: backslash + `0`), exactly as the sibling
`entryKey` helper a few lines below already does:

```ts
function entryKey(collectionId: CollectionId, actionId: ActionId): string {
	return `${collectionId}\0${actionId}`;
}
```

## Why it matters

Runtime behaviour is **identical and already correct** (both compile to a single NUL-separated key). This
is purely a tooling/maintainability fix: the literal NUL byte makes git classify the whole file as
**binary**, so `git show`/`git diff` report "Binary files … differ" and `--stat` shows `Bin` instead of a
readable line-level diff. Every future change to this file is harder to review because of it.

## Notes for whoever picks this up

- It is a **one-character** change: replace the single `0x00` byte on the `pairKey` line with the
  two-character `\0` escape. Do it through an editor/IDE — a review pass found that Bash-level byte writes
  to this (harness-tracked) file get reverted to the cached NUL, so the edit must go through the normal
  edit path.
- After the change, confirm `git diff --stat` shows a text line-count for `cascade.ts` (not `Bin`), and
  that `yarn build` + `yarn test` in `packages/db-p2p` stay green (the cascade tests exercise `pairKey`).
- This was surfaced during the review of `cascade-multi-collection-dependent-reversal`; it is pre-existing
  and was intentionally left out of that ticket's scope to keep the diff minimal.
