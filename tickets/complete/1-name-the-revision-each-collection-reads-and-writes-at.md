description: Debug logging now names which stored version of each collection a write committed to and a read descended. This file records the review of that work: two documentation statements that contradicted the code were corrected, and the two "no version number" answers an operator relies on are now covered by tests.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts, docs/debugging.md
----

# Name the revision each collection reads and writes at — complete

## What shipped

Two debug lines carry a revision per collection:

- `commit:collections` (`optimystic:quereus-plugin:txn-bridge`) — trailing
  `revs=<id>:<rev>,...` field, one pair per collection the commit carries, in the same
  sorted order as the pre-existing `<id>=staged|clean|unknown` tokens (strictly additive, so
  an operator's existing grep keyed on a collection id keeps matching).
- `index:seek` (`optimystic:quereus-plugin:module`) — `rev=` (index collection) and
  `main_rev=` (main table collection), plus `seek=` (the framed key, escaped) and `matched=`.

Both are emitted only inside an `if (log.enabled)` guard, so a disabled namespace costs
nothing. Reader-facing documentation is `docs/debugging.md` § "Which revision did a read
descend?".

This slug's implement commit is `9709479`; the shared implementation landed one commit
earlier in `9d277b3` under the sibling slug `name-the-revision-each-index-read-and-commit-lands-on`,
whose own review ticket covers that commit.

## Review findings

**Scope reviewed.** The `9709479` diff read first, before its handoff: `docs/debugging.md`,
`optimystic-module.ts` (`printableSeekKey`, `logIndexSeek`, the seek probe threading through
`executeIndexScan`), `txn-bridge.ts` (`treeRevision`, `logCommitCollections`), and
`test/trace-helpers.ts` + `test/index-support.spec.ts`. The sibling review ticket, still open
in `review/`, covers `9d277b3`; nothing here was duplicated into it.

**Corrected inline (minor).**

- `docs/debugging.md`, the `rev=` bullet, said `none` means "that collection is invented" —
  which the caveat added under the decision table in the same change directly contradicts
  (`none` is also what a collection prints when nothing has ever been committed under its id,
  the normal state of a table before its first insert). A reader taking the bullet at face
  value would read a healthy log as an invention race. Bullet now states both causes and
  points at the caveat that separates them.
- `docs/debugging.md`, the `seek=` bullet, called the rendering "percent-escaped" without
  qualification. The emitter escapes code units above U+00FF as `%uXXXX`, which is not valid
  percent-encoding, so a key carrying non-Latin-1 text would make a decoder reject or mangle
  it. The bullet now says exactly which characters survive verbatim and which two escape
  widths exist, alongside the pre-existing "compare it, do not decode it" instruction.

**Coverage gap the implement handoff named, closed here (minor).** Nothing asserted that
either `none` or `unknown` is ever emitted, and those are the two tokens an operator leans on
hardest when reading a failing log. Two tests added:

- `test/adapter-integration.spec.ts` — drives three `DirtyTree` doubles through the ordinary
  legacy commit sweep and pins that a double whose `committedRevision()` returns `undefined`
  reads `none`, one lacking the method entirely reads `unknown`, and a real number is printed
  as itself. Mutation-checked: flipping `treeRevision`'s absent-method branch from `'unknown'`
  to `'none'` (rebuild, re-run) fails this test with `expected none, actual unknown`. Only a
  double can produce `unknown` at all, which is why this arm uses them.
- `test/index-support.spec.ts` — a seek against a table that has committed nothing prints
  `main_rev=none` next to a numeric index `rev=`, pinning the benign `none` on a real code
  path. Both fields render through the same helper, so this covers the index side's `none` too.
  Verified against a live capture before writing the assertion (`rev=1 main_rev=none` before
  the first insert; `rev=2 main_rev=1` after).

**Checked and found sound — no change.**

- `printableSeekKey` injectivity. `%` is outside the safe class, so it escapes to `%25`; the
  distinct-values test (`a b` vs `a%20b`) is the collision a self-unaware escaper would
  produce, and it holds. `u` is not a hex digit, so the two escape widths cannot alias.
- The module-level `/g` regex is used only via `String.replace`, which resets `lastIndex`
  around the call. (`.test`/`.exec` on the same object would have carried state between
  scans; they are not used.)
- Zero cost when the namespace is off: the probe object itself is allocated under
  `log.enabled`, and `executeIndexScan` null-checks it per entry rather than counting always.
- `matched=` counting before the row fetch, and the `finally`-emitted line for an abandoned
  scan, match what both the docblock and the docs claim.

**Tripwires — none newly parked.** The one conditional concern at this site (`index:seek` is
one line per index-driven scan, so a per-row seek loop emits one line per row) is already a
`NOTE:` on the `logIndexSeek` docblock, naming sampling or a dedicated sub-namespace as the
remedy if it ever trips. Nothing further was conditional.

**New tickets — none filed.** Every finding was a one-line documentation contradiction or a
missing assertion, both fixable in this pass; nothing rose to a class of defect worth an
invariant, a type change, or a point ticket.

## Validation

```
yarn build && yarn typecheck && yarn lint          # clean
yarn workspace @optimystic/quereus-plugin-optimystic test   # 485 passing, 13 pending, 0 failing
yarn workspace @optimystic/db-core test                     # 1387 passing, 0 failing
```

Green on a quiet machine. Worth knowing for a red CI run of this shape: the plugin suite's
specs use a fixed 15 s mocha timeout, and the prior handoff saw timeout-only failures (never
an assertion) in untouched specs while parallel builds competed for CPU. Re-run before reading
such a failure as a regression.

## Reading the lines by hand

Specs that use `captureTrace` replace the global `debug` sink, so `DEBUG=` prints nothing for
those. Use a query outside a capture:

```bash
cd packages/quereus-plugin-optimystic
DEBUG='optimystic:quereus-plugin:module' node --import ./register.mjs \
  node_modules/mocha/bin/mocha.js "test/two-node-secondary-index-convergence.spec.ts" \
  --grep "A declares and inserts" --reporter dot
```

## Answered, closed

The implement handoff asked whether `mode=` makes "123 of 136 `commit:collections` lines at
`count=0`" legible. It does, and the answer is benign: in `mode=legacy` the reported set is
the dirty set, so `count=0` means no tree staged a change — a read-only or DDL statement.
Confirmed in a local capture: `count=0` lines sit around `SELECT`/`CREATE`, inserts report
`count=2`. (`mode=session` would read differently — there the set is the whole live registry,
so `count=0` would mean nothing was registered at all.)
