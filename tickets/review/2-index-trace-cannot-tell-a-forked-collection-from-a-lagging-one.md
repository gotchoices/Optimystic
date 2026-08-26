description: Diagnostic log lines about secondary indexes now say which machine wrote each line, and which write produced the revision each line reports — so one run of the failing scenario can finally tell "this machine is behind" apart from "the two machines built two separate copies of the same index".
prereq:
files:
  - packages/db-core/src/collection/collection.ts (new `committedActionId()` ~481)
  - packages/db-core/src/collections/tree/tree.ts (forwarder ~268)
  - packages/quereus-plugin-optimystic/src/logger.ts (new `revisionToken()`)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`nodeTag()` / `setNodeTag()`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (logIndexSeek ~995, openIndexTree ~2455)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (DirtyTree, treeActionId, logCommitCollections)
  - packages/quereus-plugin-optimystic/test/trace-helpers.ts (parsers for both new fields)
  - packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts (three new specs)
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts (three new specs)
  - docs/debugging.md
difficulty: medium
----

# What shipped

Two fields were added to the three debug lines an operator reads when a secondary index
disagrees between machines (`commit:collections`, `index:tree-open`, `index:seek`). Nothing
else changed — no behaviour, no control flow, no existing token moved.

## Field 1 — `node=<tag>`, appended last on all three lines

`CollectionFactory` gained `nodeTag()` (six random base64url characters by default) and
`setNodeTag(tag)`. One factory is built per plugin registration, one registration per Quereus
`Database`, one `Database` per machine — so the factory instance *is* the node identity, and
both emitting sites already held it (`this.collectionFactory`).

`setNodeTag` throws unless the tag matches `/^\S+$/`. The tag is printed as one
whitespace-separated field, so a tag with a space in it would split one trace field into two
and make every line carrying it unparseable; failing at the host's one start-up call is much
cheaper than discovering it in the log of the run that needed the log.

A field rather than a `debug` namespace suffix (which is how `db-p2p` does it) — all three
lines share one namespace here, so a per-node namespace would force an operator to know the
tags before choosing a `DEBUG=` filter.

## Field 2 — `<rev>@<actionId>` wherever a revision is printed

`Collection.committedActionId()` returns the action id recorded at the collection's current
committed revision (`context.committed.find(e => e.rev === context.rev)?.actionId`), or
`undefined`. `Tree` forwards it. `DirtyTree` gained it as an optional member alongside
`committedRevision?()`, so test doubles are unaffected.

Rendering goes through one helper, `revisionToken(rev, actionId)` in the plugin's
`logger.ts`, used by both emitters so the two lines cannot drift. Existing vocabulary is
preserved in **both** halves: `none` = asked and there is none, `unknown` = the source could
not be asked. `1@none` is a real, common state (an invented collection, or a revision whose
action has aged out of the bounded `committed` list) — not an error.

The point of the field: a revision is counted per collection and means nothing on its own, so
same-id + same-revision on two machines is ambiguous between "one collection, one machine
behind" and "two separately-built collections each counting from 1". Equal action ids mean one
lineage; different action ids at one revision mean two.

## Field placement — appended, deliberately

Both fields go at the **end** of their lines, and `commit:collections`'s action id rides inside
the existing `revs=` value rather than becoming a new token. This follows the precedent already
documented on `logCommitCollections`: every token that predates the change stays byte-identical,
so a downstream operator's existing grep or parser keeps matching. Splitting rules: a `revs=`
pair splits on its **last** `:` (ids may contain colons), then the value splits on its **first**
`@` (the revision half is a number or one of two fixed words; an action id is opaque). Whitespace
inside an action id is percent-escaped by `revisionToken` rather than trusted.

# Use cases for testing / validation

## The thing this was built for

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

And every line now answers "who wrote this" from `node=` instead of positionally.

## Manual smoke

```typescript
const plugin = register(db, config);
plugin.collectionFactory.setNodeTag('A');   // 'A B' or '' throws
```

Then any indexed insert + indexed select emits, e.g.:

```
commit:collections mode=legacy count=2 default/T=staged default/T/index/i=staged revs=default/T:none@none,default/T/index/i:1@bT1r_04c node=A
index:tree-open table=T index=i uri=tree://default/T/index/i collection=default/T/index/i node=A
index:seek table=T index=i collection=default/T/index/i main=default/T arm=live rev=2@Kx9f-2Qa main_rev=1@aQ7z-1Pd seek=%02tok%00 matched=1 node=A
```

## Automated coverage added

`test/two-node-secondary-index-convergence.spec.ts`:
- *every trace line names the node that emitted it* — two `Database`s tagged `A`/`B`, both
  writing the same collection; asserts **all three** line kinds from each node carry only that
  node's tag.
- *a converged read on both nodes reports the same revision AND the same action id* — the
  healthy baseline the downstream numbers are read against. If a future change makes two
  **converged** nodes print different action ids, the field has started lying and every "forked"
  reading taken from it downstream is wrong.
- *the commit line names the action id behind each revision, and preserves none* — first insert
  (table collection at `none@none`, index collection at a real `<n>@<id>`), second insert (table
  collection has gained a lineage; the index collection's action id has changed).

`test/adapter-integration.spec.ts`:
- *sources the action-id half of revs= independently of the revision half* — doubles that
  implement one accessor and not the other, pinning `none` vs `unknown` in the action half the
  way the existing spec pins them in the revision half.
- *names the emitting node on commit:collections*.
- node-tag defaults are distinct per factory and whitespace-free; `setNodeTag` rejects `''`,
  `'   '`, `'two words'`, `'trailing '`.

Existing specs that assert `seek.rev` against `/^\d+$/` still do: `trace-helpers` splits the
emitted `rev=` into `rev` (bare) and `action`, so nothing that previously compared revisions had
to change.

## Commands run

```
yarn workspace @optimystic/db-core run build
yarn workspace @optimystic/quereus-plugin-optimystic run build
yarn workspace @optimystic/quereus-plugin-optimystic run test    # 655 passing, 13 pending, 0 failing
yarn workspace @optimystic/db-core run test                      # 1387 passing, 0 failing
```

`db-core` must be **built** before the plugin builds — the plugin resolves `@optimystic/db-core`
through its `dist`, so a fresh `committedActionId()` is invisible until `db-core`'s `tsc` runs.
Plugin specs import `../dist/plugin.js`, so the plugin must be built before its tests too.

# Known gaps — please probe these

- **Does not fix the downstream defect, and does not claim to.** The deliverable is that the next
  downstream run of `strand-formation-concurrent-redemption` can answer "one copy or two" from its
  own log. Whether it *does* is only knowable from that run.
- **`committedActionId()` matching rule is unverified against a lagging/replayed collection.** It
  scans `context.committed` for the entry whose `rev` equals `context.rev`. That holds by
  construction on the three paths that write the context (`syncInternal`'s inline bump,
  `recordCommitted`, `bootstrapContext`). What is *not* exercised anywhere is a context adopted by
  `advanceContext` from a log read (`latest.context`) whose `committed` list happens to hold no
  entry at `rev` — that prints `@none`, which is documented as legitimate, but no spec drives that
  path deliberately. Worth a look: if that turns out to be the *common* shape on the session/
  consensus path, the field would read `@none` exactly where an operator needs it most.
- **Session-mode `commit:collections` action ids are pinned only indirectly.**
  `session-mode-commit.spec.ts` asserts the revision half still matches `/^(\d+|none)$/` (which it
  does, because the parser splits the halves) but nothing there asserts the action half. The
  session path builds its trace entries from a different expression than the legacy path
  (`Collection` directly vs. the optional `DirtyTree` accessor), which is exactly the drift the
  existing comment there warns about.
- **No two-node spec forces the FORK case.** Every new assertion is on a converged pair; the
  "different action ids at one revision" reading is argued from the code, not observed. This repo
  has failed eight times to reproduce the fork locally, so this is a known limit rather than an
  oversight — but the reviewer should not read the specs as proof the fork is detectable.
- **`node=` uniqueness is probabilistic by default.** Four random bytes; two factories in one
  process colliding is ~1 in 4 billion per pair. Hosts that care should call `setNodeTag`.
- **Placement is a judgement call.** Both fields were appended so existing greps keep matching.
  The cost is that the emitting node is at the *end* of the line, where an operator eyeballing
  interleaved output scans for it last. If a reviewer thinks legibility should win over parser
  compatibility here, that is a real disagreement worth having — the tests would need their
  regexes reordered but nothing else.
- **`docs/debugging.md` grew two new sub-sections** (*Comparing action ids*, *Which node emitted
  this line?*) and one new decision-table row (a live refresh ran and the revision did not move,
  split by action id). Worth reading as prose — the decision table is the thing an operator
  actually applies under pressure, and a row that reads ambiguously is worse than no row.

# Tripwires recorded

None. No conditional-cost concern was introduced: `node=` is one property read per line, the
action-id lookup is one `Array.find` over a bounded list, and both sit behind the same
`log.enabled` guards the surrounding lines already had.
