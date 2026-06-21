description: Replace the literal NUL byte in pairKey's template literal with the \0 escape so git treats the file as text.
prereq:
files: packages/db-p2p/src/dispute/cascade.ts
difficulty: easy
----

## Change

In `packages/db-p2p/src/dispute/cascade.ts`, line 67, `pairKey` used a literal `0x00` NUL byte as the separator
inside its template literal.  That byte has been replaced with the standard TypeScript `\0` escape sequence,
matching the `entryKey` helper on line 77.

Runtime behaviour is identical — both compile to the same NUL-separated key.  The file no longer contains any
NUL bytes so git classifies it as text and future diffs are readable.

## Verification

- Commit `539173b` contains the fix; the file at HEAD has `\0` escape on line 67.
- `yarn build` in `packages/db-p2p` exits 0.
- `yarn test` in `packages/db-p2p` exits 0: 970 passing, 30 pending.

## Known gaps

None — this is a single-character normalization with no logic change.
