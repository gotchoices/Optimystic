description: A stray NUL byte in a source file made git treat it as binary; it was replaced with the standard text escape so diffs are readable again.
prereq:
files: packages/db-p2p/src/dispute/cascade.ts
difficulty: easy
----

## Change

In `packages/db-p2p/src/dispute/cascade.ts`, the `pairKey` helper used a literal `0x00` NUL byte as the
separator inside its template literal. That byte was replaced with the standard TypeScript `\0` escape
sequence, matching the sibling `entryKey` helper.

Runtime behaviour is identical — both forms compile to the same NUL-separated string. The file no longer
contains any literal NUL bytes, so git classifies it as text and future diffs render normally.

Fix landed in commit `539173b`; at HEAD, `cascade.ts:67` reads ``return `${blockId}\0${rev}`;``.

## Review findings

### Correctness / behaviour — verified, no issues
- `cascade.ts:67` now uses the `\0` escape; `git grep -P '\x00'` over the file and over all repo `*.ts`/`*.js`
  finds **no** remaining literal NUL bytes. The escape and a literal NUL produce the identical string, so all
  three call sites (`cascade.ts:264`, `:379`, `:473`) are unaffected — keys still collide/dedupe exactly as before.
- Consistency: `pairKey` (`:67`) now matches `entryKey` (`:77`), and the `entryKey` doc-comment's "mirroring
  {@link pairKey}" note remains accurate.

### Git classification — verified
- `git check-attr text` + `file(1)` both now report the file as UTF-8 text (was binary before the fix). The
  stated goal of the ticket is met.

### Docs — checked, none required
- The only references to `pairKey`/NUL are the inline doc-comment in `cascade.ts` itself, which is correct.
  No external docs (`docs/`) mention `pairKey` or the separator, so nothing else needed updating.

### Tests — checked, no new test warranted
- This is a zero-behaviour-change normalization (string is byte-identical at runtime). There is no new logic to
  cover; an equality test on `pairKey` output would only assert that `\0 === \0`. No test added, by design.

### Build & test results
- `yarn build` in `packages/db-p2p`: exit 0.
- `yarn test` in `packages/db-p2p`: ran twice.
  - Run 1: 969 passing, 30 pending, **1 failing**.
  - Run 2: **970 passing, 30 pending, 0 failing**.

### Pre-existing failure flagged (not mine)
- Run 1's lone failure was a 30s **timeout** in `reactivity/mesh-partition-healing.spec.ts` —
  an unrelated subsystem (reactivity mesh dedupe/replay) that does not import or exercise `dispute/cascade`.
  It passed on retry (Run 2), confirming it is an intermittent flake, and the same file was already triaged once
  before (`8298b12 tess: triage pre-existing test failure`). Flagged in `tickets/.pre-existing-error.md` for the
  runner's triage pass rather than chased here.

### Disposition
- No major findings → no new ticket spawned.
- No minor findings requiring an inline fix → the implementation was already correct and complete.
