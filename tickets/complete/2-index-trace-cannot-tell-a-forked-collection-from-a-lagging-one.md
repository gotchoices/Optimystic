description: Diagnostic log lines about secondary indexes now say which machine wrote each line, and which write produced the revision each line reports — so one run of the failing scenario can tell "this machine is behind" apart from "the two machines built two separate copies of the same index".
files:
  - packages/db-core/src/collection/collection.ts (`committedActionId()` ~481)
  - packages/db-core/src/collections/tree/tree.ts (forwarder ~268)
  - packages/db-core/test/reopen-action-context-rev.spec.ts (lineage-across-reopen spec)
  - packages/quereus-plugin-optimystic/src/logger.ts (`revisionToken()`)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`nodeTag()` / `setNodeTag()`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (logIndexSeek, openIndexTree)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (DirtyTree, treeActionId, logCommitCollections)
  - packages/quereus-plugin-optimystic/test/trace-helpers.ts (`parseRevPair`, both new fields)
  - packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts
  - packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts
  - docs/debugging.md
----

# What shipped

Two fields were added to the three debug lines an operator reads when a secondary index
disagrees between machines (`commit:collections`, `index:tree-open`, `index:seek`). No
behaviour or control flow changed, and no pre-existing token moved.

**`node=<tag>`, appended last on all three lines.** `CollectionFactory` gained `nodeTag()`
(six random base64url characters by default) and `setNodeTag(tag)`. One factory is built
per plugin registration, one registration per Quereus `Database`, one `Database` per
machine — so the factory instance is the node identity, and both emitting sites already
held it. `setNodeTag` rejects anything that is not one non-empty run of non-whitespace
characters, because the tag is printed as one whitespace-separated field.

**`<rev>@<actionId>` wherever a revision is printed.** `Collection.committedActionId()`
returns the action id recorded at the collection's current committed revision; `Tree`
forwards it; `DirtyTree` gained it as an optional member. Rendering goes through one
helper, `revisionToken(rev, actionId)`, so the emitters cannot drift. A revision is counted
per collection and means nothing on its own, so same-id + same-revision on two machines is
ambiguous between "one collection, one machine behind" and "two separately-built
collections each counting from 1". Equal action ids mean one lineage; different action ids
at one revision mean two.

Both fields are appended at the end of their lines, and the action id rides inside the
existing `revs=` value rather than becoming a new token, so every token that predates the
change stays byte-identical and a downstream operator's existing grep keeps matching.

# How an operator uses it

```bash
DEBUG='optimystic:quereus-plugin:*' <run the failing scenario> 2>&1 | grep -E 'index:seek|commit:collections'
```

Take the two machines' `index:seek` lines for the same `collection=`:

| Both lines show | Reading |
| --- | --- |
| same `rev=`, same action id after `@` | one collection; a machine that can't see the row is behind, not forked |
| same `rev=`, **different** action ids | two separate collections built under one id — the serious case |
| different `rev=`, same action id | ordinary lag on one collection |
| `@none` on one side | no lineage recorded at that revision; not a fork signal on its own |

`docs/debugging.md` carries the operator-facing version, including the parse rule for
`revs=` and a decision-table row for "a live refresh ran and the revision did not move".

# Commands run (review pass, after the fixes below)

```
yarn lint                                                        # clean
yarn workspace @optimystic/db-core run build
yarn workspace @optimystic/quereus-plugin-optimystic run build
yarn typecheck                                                   # clean
yarn workspace @optimystic/quereus-plugin-optimystic run test    # 656 passing, 13 pending, 0 failing
yarn workspace @optimystic/db-core run test                      # 1388 passing, 0 failing
```

`db-core` must be built before the plugin builds, and the plugin before its own tests —
the plugin resolves `@optimystic/db-core` through `dist`, and plugin specs import
`../dist/plugin.js`.

# Review findings

## Fixed in this pass

**The documented rule for splitting a `revs=` pair was wrong, and would have made an
operator's parser report every collection ABSENT.** Both `logCommitCollections`'s comment
and `docs/debugging.md` said to split each pair on its LAST `:`, asserting that "neither
half of the value" contains a colon. The action-id half routinely does: db-core stamps
session-mode action ids as `tx:<hash>` (`createTransactionId`, transaction.ts:219), and
session mode is the path a multi-node deployment actually runs. Applying the documented
rule to `default/T:3@tx:abc` yields the id `default/T:3@tx` — not a collection id, which
reads as the collection being missing from the commit: the exact false negative these
lines exist to rule out. Fixed at four sites:

- `revisionToken` now escapes `@`, `,` and `%` inside an action id as well as whitespace
  (it previously escaped whitespace only), so the separators the format itself uses can
  never appear inside a value and the escaping stays injective. `:` deliberately survives —
  it is the ordinary shape of this half and must stay greppable.
- The rule is now stated, in both the code comment and the docs, in the only order that
  works: split on `,`, then the LAST `@`, then the LAST `:`.
- `trace-helpers.ts` grew `parseRevPair`, which performs exactly that split, replacing a
  regex that happened to work only because its revision alternation was anchored. The
  parser is now the documented rule rather than a lucky approximation.
- `docs/debugging.md`'s worked examples now use `tx:`-shaped action ids, so a reader
  calibrates against the shape they will actually see.

Two regression tests, both written as whole-set claims so they survive any future
action-id stamping rather than pinning today's shape: `adapter-integration.spec.ts` drives
the emitter and parser together over a colon-bearing collection id, a `tx:`-shaped action
id, and an action id carrying a comma, an `@` and a space; `session-mode-commit.spec.ts`
asserts the ids recovered from `revs=` are exactly the ids the untouched `<id>=staged` half
named, on the real session path.

**`@none` was explained wrongly in five places.** Every site said a `@none` action half
meant the action had "aged out of the collection's bounded committed list". `committed` is
never pruned by age, and the entry at the *current* revision could not age out first in any
case. The real second cause (besides an invented collection) is that the current revision's
log slot belongs to an entry that carries no action — a checkpoint or an invalidation entry
takes a revision of its own — so a context read back off such a log holds no entry at its
own `rev`. `log.spec.ts`'s existing "should handle checkpoints" test already demonstrates
exactly this state (`context.rev === 4`, `committed` holding revs 1 and 2). Corrected in
collection.ts, logger.ts, txn-bridge.ts (x2), optimystic-module.ts, trace-helpers.ts and
docs/debugging.md, so an operator seeing `@none` looks at the log head instead of at
retention.

**The new decision-table row did not render as a table row.** It was appended after a blank
line following the table, with no header or delimiter row of its own, so GitHub-flavored
Markdown renders it as literal text full of pipe characters — the one row an operator
applies under pressure. Merged into the table it belongs to. The two new `####`
sub-sections had also been inserted between that table and the caveat paragraph that refers
to "the table above"; moved below it, so the reference is adjacent again.

**`randomNodeTag` used `globalThis.crypto.getRandomValues`** — the only such call in the
repo; every other random draw (twelve sites across db-core, including the action ids this
very ticket prints) goes through `@noble/hashes` `randomBytes`, which the plugin already
depends on and which does not assume a global WebCrypto. Switched, for DRY and for the
cross-platform target AGENTS.md states.

**The ticket's own gap "the matching rule is unverified against a context adopted from a
log read"** is now closed by a spec rather than by argument:
`db-core/test/reopen-action-context-rev.spec.ts` writes through one collection, re-opens
the same id (which forces `attachToLog` → `advanceContext` → a context read back off the
log, a different code path from the one the writer wrote) and asserts both name the same
action at the same revision. It passes. So a lagging reader's action id is comparable to
the writer's, which is the premise the whole fork-vs-lag reading rests on.

**The ticket's gap "session-mode action ids are pinned only indirectly"** is closed:
`session-mode-commit.spec.ts` now asserts the action half never reads `unknown` on the
registry-sourced path and that the index collection names a real action, alongside the
id-integrity claim above.

**`Tree.committedActionId`'s comment** restated its callee's four-sentence argument
verbatim; trimmed to a pointer. The remaining comment density across the change is high but
matches the surrounding file (`committedRevision` above it is an 18-line block,
`logCommitCollections` an essay) — that is house style here, not a finding, and the
canonical statement now lives in `docs/debugging.md` section "Comparing action ids" with
the other sites referring to it.

## Checked and found nothing

- **Cost when tracing is off.** Both `index:seek` and `commit:collections` build their
  arguments inside an existing `if (log.enabled)` guard, so `nodeTag()` and the action-id
  lookup do not run on a normal path at all. `index:tree-open` is bring-up-only. No
  resource to clean up; no lifetime introduced.
- **The `index:seek` revision-field parse.** The pattern is bounded by the literal field
  separators and cannot cross whitespace; with `@` now escaped inside action ids the
  "first `@`" and "last `@`" rules coincide, so the seek and commit parsers agree.
- **Backwards shape.** Existing specs comparing a bare `seek.rev` against a digits-only
  pattern still hold — the helper splits the halves before they see it.
  `session-mode-commit.spec.ts`'s pre-existing revision assertion is unaffected for the
  same reason.
- **`setNodeTag` validation** rejects the empty string, whitespace-only, embedded and
  trailing spaces, and is exercised for all four.
- **Type safety.** No `any` introduced; `DirtyTree.committedActionId` is optional on the
  same terms as `committedRevision`, so existing test doubles are unaffected and the
  `unknown`-vs-`none` distinction is preserved end to end.

## Considered and left alone

- **`node=` at the end of the line rather than the front.** The implementer flagged this as
  a legibility-versus-parser-compatibility disagreement worth having. Keeping it: the line
  is a set of `key=value` fields, `grep 'node=A'` works from any position, and the additive
  rule here has already paid for itself once (the `revs=` field was added the same way).
- **`node=` uniqueness is probabilistic** (four random bytes; two factories colliding is
  ~1 in 4 billion per pair). Hosts that care call `setNodeTag`. The spec asserting two
  default tags differ carries that same negligible flake probability; not worth a seam.
- **No spec forces the FORK case.** Every new assertion is on a converged pair, so the
  "different action ids at one revision" reading is argued from the code, not observed.
  This repo has failed eight times to reproduce the fork locally; that is the downstream
  `strand-formation-concurrent-redemption` work, not something to manufacture here. Read
  the specs as pinning the healthy baseline, not as proof the fork is detectable.
- **Whether the field actually resolves the downstream defect** is only knowable from the
  next run of that scenario. This ticket delivers the instrument, not the diagnosis.

## Observation, not filed

`ActionContext.committed` is appended to on every commit and is only replaced wholesale by
a fresh log read. On the legacy path that read happens on every `sync()`/`update()`, so the
list stays checkpoint-bounded. On the session path a collection advances through
`recordCommitted()` alone, with no log read, so a long-lived session-mode `Collection`
accumulates one entry per commit for its lifetime. This predates the change, sits outside
its diff, and I did not measure the growth, so no ticket — recorded here so the next person
to read `recordCommitted` has seen it stated.

## Tripwires recorded

One, at `Collection.committedActionId` (collection.ts): the lookup is linear in `committed`,
which grows one entry per commit between context reads. Every caller today is a
`debug`-gated diagnostic behind `log.enabled`, so it does not run on a normal path; the
NOTE says to index the lookup or search from the end if a non-diagnostic caller ever
appears. No other conditional-cost concern was introduced — `node=` is one property read
per line.
