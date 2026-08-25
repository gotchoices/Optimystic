description: Debug logging now names which stored version of the data each machine wrote to and each read came from, so the next run of the failing scenario shows whether two machines disagree about the data itself or only about how fresh their copy is. Review found and fixed an off-by-one in how the two log lines relate, plus a crash the logging could cause in the query it was tracing.
prereq:
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/trace-helpers.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts, packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts, docs/debugging.md
----

# Complete: name the revision each index read and commit lands on

## What shipped

Measurement only — no behaviour change. Three additions let an operator decide, from one
failing run's log, which of two worlds a "row written on machine A is invisible through the
index on machine B" failure is in: **forked or stale lineage** (the two machines are on
different revisions of the same collection) versus **converged but empty** (same revision,
and the index genuinely holds nothing).

- `Collection.committedRevision(): number | undefined` in db-core, forwarded by
  `Tree.committedRevision()`. `undefined` means the collection was invented locally
  (`createOrOpen` found no committed header and staged a fresh empty one) and is never
  collapsed into `0`; it prints as the token `none`.
- `commit:collections` (namespace `optimystic:quereus-plugin:txn-bridge`) gained a
  trailing `revs=<id>:<rev>,...` field. Strictly additive — the pre-existing
  `<id>=staged|clean|unknown` tokens are byte-identical, so an operator's existing grep
  keyed on a collection id keeps matching. Both commit modes (legacy sweep and
  session/coordinator) emit it.
- `index:seek` (namespace `optimystic:quereus-plugin:module`) is a new read-side line,
  one per index-driven scan, emitted from a `finally` so an abandoned or throwing scan
  still reports. It names both collections the scan touched, each one's revision, whether
  the read was allowed to refresh (`arm=live` / `arm=committed`), the framed seek key, and
  how many index entries the descent produced.
- `docs/debugging.md` documents both lines and carries the decision-rule table an operator
  reads the pair with.

Implementation landed across two commits, because the runner dispatched two overlapping
implement tickets for the same measurement in parallel: `9d277b3` (this slug) and `9709479`
(sibling slug `name-the-revision-each-collection-reads-and-writes-at`). This review covered
the union of the working tree once, as both tickets asked.

## Review findings

### Checked

Read the implement diff before the handoff summary. Covered: the db-core accessor and its
forwarding; both `commit:collections` call sites and their `log.enabled` guards; the
`index:seek` emitter and its `try/finally` placement inside the async generator; the probe
threading through `executeIndexScan`; the seek-key renderer; the test-side parsers in
`trace-helpers.ts`; every pin in the two specs; and `docs/debugging.md` end to end against
the code rather than against the handoff. Ran lint, build, typecheck, the db-core suite,
the db-p2p suite (it depends on db-core, which this change touches), and the plugin suite
in both plain and `OPTIMYSTIC_INTEGRATION=1` modes.

Two things the handoff flagged for probing came back clean and are recorded here so nobody
re-checks them: the `log.enabled` guarding is correct (the probe object and both commit
entry arrays are built inside guards, and nothing non-trivial is constructed outside one),
and wrapping the `yield*` in `try/finally` inside an async generator does not disturb the
generator's own error or early-return propagation — an early `.return()` from a satisfied
`LIMIT` delegates through `yield*` and runs the `finally` exactly once.

### Found and fixed in this pass

**The decision rule was off by one, in the direction that inverts it.** Both
`commit:collections` call sites emit BEFORE the flush, so `revs=` is the revision the
collection is *reading* at — the one the commit is about to supersede. The commit lands at
that value plus one (`Collection.getNextRev()` / `syncInternal`; `none` lands at `1`).
The shipped doc table told the operator to compare a reader's `index:seek` `rev=` against
"node A's commit revision", the only number on that line. Following it literally, a fully
converged reader (at printed + 1) matches no row of the table, and a reader that is
genuinely one revision stale matches the "the write's index action did not survive commit"
row — sending the investigation at sync/merge and conflict replay when the real answer is a
plain refresh gap. That is the single most load-bearing artifact this ticket produced, so
it mattered.

Confirmed empirically, not just read off the code: three successive inserts against one
table print `default/FormationUsage:none`, `:1`, `:2` and the collection ends at revision
`3`.

Fixed by stating the `+1` explicitly and re-expressing every row of the table against a
named `landed = printed + 1` quantity, correcting the same wrong "reads *and writes* at"
wording in four docblocks (`Collection.committedRevision`, `Tree.committedRevision`,
`DirtyTree.committedRevision`, `CommitCollectionTrace.rev`), and cross-referencing the
off-by-one from both emitters. Pinned by a new test — *the revision a commit lands at is
the commit line's revision plus one* — which derives `landed` from the insert's own commit
line and asserts the following read descends exactly that, for both the index and the table
collection. It fails if the relationship ever becomes `+0` or `+2`.

**Tracing could crash the query it was tracing.** `printableSeekKey` rendered the framed
seek key with `encodeURIComponent`, which throws `URIError` on a lone surrogate — and a SQL
TEXT value can legally hold one, since `serializeIndexValue` passes strings through
verbatim. Because the render happens inside the scan's `finally`, the throw either fails a
successful query or masks the real error of a failing one, with the `module` namespace on
— i.e. exactly during the investigation this line exists to serve. Verified by negative
control: with the original renderer restored and the package rebuilt, the new test fails
with `QuereusError: Error during query on table 'traced': Query failed: URI malformed`; the
fix was then put back by inverse edit and the file diffed byte-for-byte against its
pre-control copy.

Replaced with a total, injective per-code-unit escape (`%XX`, or `%uXXXX` above `\xff`;
`A-Za-z0-9._-` survive verbatim). Output is unchanged for the ordinary case — the doc's
`%01tok-a%00` example still renders identically. Pinned by two tests in
`index-support.spec.ts`: one asserts a hostile TEXT value (lone surrogate plus a space plus
an `=`) still returns its row and renders as one whitespace-free, `=`-free token; the other
pins injectivity on the `'a b'` / `'a%20b'` pair, which is the collision a renderer that
forgets to escape its own escape character would produce. Both assert properties of the
rendered token rather than literals, so a future change may pick a different encoding and
still pass. (Only the first is a negative control for the crash; the second passes under
either renderer and exists to stop a future simplification from breaking comparability.)

**Two documentation gaps that would mislead an operator mid-investigation.** The doc did
not say that *absence* of an `index:seek` line means the planner never routed the query
through the index (a primary-key point lookup, a primary-key range query, and a full table
scan all emit nothing) — so a missing line reads as evidence about the index collection
when it is evidence about the plan. Added, including the note that a query which seeks on
one node and full-scans on the other explains an asymmetric result by itself. Separately,
the doc described `seek=` as percent-escaped without warning against decoding it; an
operator will reach for `decodeURIComponent` and get raw tuple framing, not the SQL value.
Added "compare it, do not decode it".

**One stale comment.** The `trace-helpers.ts` header still announced "the two debug lines"
while listing three, and said a change stopping "either line" fails the suite. Corrected.

### Recorded as tripwires, not filed as tickets

- **Collection ids are not validated, so the trace format's separators are assumptions.**
  `parseCollectionId` (collection-factory.ts) accepts a table's `collectionUri` verbatim
  after stripping `tree://`, so nothing prevents an id containing a comma or whitespace,
  which would make `revs=` — and the `<id>=staged` tokens that predate it — ambiguous to
  parse. Conditional: harmless while every id in practice is a slash path. `NOTE:` at the
  `logCommitCollections` docblock in `txn-bridge.ts`, including the direction the fix
  should take (validate at parse time, not escape at print time, because the id has to stay
  greppable across all three lines).
- Two tripwires the implementer had already recorded were re-read and left in place: the
  committed-arm view pinning older than the printed `rev=`, and `matched=` being a floor on
  an abandoned iteration. Both are `NOTE:`s in the `logIndexSeek` docblock in
  `optimystic-module.ts`.

### Considered and declined

None encountered — no accepted-tradeoff `NOTE:` sits at any site this review touched, so
nothing was skipped on those grounds.

### New tickets filed

None. Both defects found were bounded, verified, and fixed in this pass; neither has a class
behind it that a type change or boundary invariant would retire. The one genuinely
conditional concern went to a tripwire per the disposition rules.

## Validation

All run against the final tree, all green, zero failing:

```bash
yarn lint && yarn build && yarn typecheck
yarn workspace @optimystic/db-core test                     # 1387 passing
yarn workspace @optimystic/db-p2p test                      # 1898 passing, 44 pending
cd packages/quereus-plugin-optimystic && yarn test          # 483 passing, 13 pending
# and with OPTIMYSTIC_INTEGRATION=1                         # 491 passing, 8 pending
```

No pre-existing failures were encountered, so `tickets/.pre-existing-error.md` was not
written.

## Known gaps carried forward

Unchanged from the implement handoff, all documented at their sites and none of them
defects:

- **The bug is not fixed.** This is measurement. The failure does not reproduce in this
  repository — every two-node shape on the mock mesh and on real libp2p converges. It
  reproduces deterministically in the downstream sereus checkout, where the two lines are
  meant to be read together.
- `rev=` is the collection's revision, not the committed view's pin. For `arm=committed`
  over a tree staged into the in-flight transaction the view pins to the transaction's
  first-touch boundary, which can be older. If a committed-arm investigation ever turns on
  that difference, print `CollectionSnapshot.context.rev` as a further field.
- `matched=` is a floor, never an overcount — so `matched=0` soundly means "the descent
  found nothing", which is the reading the decision rule turns on, but a nonzero value is a
  lower bound on an abandoned scan.
- Per-collection revision counters are not on one scale. `rev=` and `main_rev=` come from
  different collections and are routinely unequal on a healthy run; the doc says so twice
  and the review left both warnings in place.

---

# Second review pass (concurrent run)

The runner dispatched this review ticket twice in parallel. The pass above landed first; this
one read the tree *after* those fixes were already in it, so the off-by-one and the
`encodeURIComponent` crash were already gone and are not re-reported. Everything below is
additive, and is committed — the runner swept it into `f4b359b` and `4e37b63`.

## Review findings (second pass)

### Checked

Read the union diff (`2191ab9..HEAD` over `packages/` and `docs/`) before the handoff summary.
Beyond the first pass's ground: `Collection.committedRevision()`'s semantics traced against
`getNextRev`, `recordCommitted`, `syncInternal` and `createOrOpen`'s invention branch;
`printableSeekKey`'s totality re-derived for lone surrogates and astral pairs (each surrogate
code unit escapes separately — the regex has no `u` flag — and `%XX`/`%uXXXX` cannot be
confused because `u` is not a hex digit); the `revs=` parser's last-`:` split and its empty-
`seek=` handling; and both doc citations (`CollectionId = BlockId` at `struct.ts:5`,
`probeHeader`'s `source.tryGet(id)`). Grepped the board for open tickets claiming the touched
files before considering any filing.

### Found and fixed in this pass

**The session-mode `revs=` field was emitted but never pinned.** The two commit paths build
the field with *different* expressions — legacy goes through the optional
`DirtyTree.committedRevision()` accessor, while the session path holds real `Collection`s from
the registry and calls `committedRevision()` directly (`txn-bridge.ts:433`). Only the legacy
expression had test cover, so deleting `rev:` from the session call site failed nothing, while
`docs/debugging.md` told the reader the session commit case *was* pinned. Session mode is the
path a multi-node deployment actually runs, and it is the mode whose revisions the two-worlds
decision rule is read against. Fixed by adding revision assertions to the existing session-mode
trace test in `session-mode-commit.spec.ts`, plus an assertion that no registry-sourced
collection ever reads as `unknown` — a real `Collection` always implements the accessor, so
`unknown` there would mean the registry stopped holding `Collection`s.

**"A collection's revision advances only through `update()`/`sync()`" is wrong, and wrong in
exactly the mode the downstream failure runs in.** The coordinator advances it via
`Collection.recordCommitted()` (`coordinator.ts:338,383,618,635`) with no `update()` involved
anywhere. The claim appeared at three sites — the `Collection.committedRevision` docblock, the
`logIndexSeek` docblock, and `docs/debugging.md` — and it drives a decision-table row that
tells the operator "nothing called `update()` on it". An operator in session mode would go
hunting for a missing refresh call that never existed on that path. All three corrected to name
the explicit-call invariant ("nothing moves it passively") and both mechanisms.

**The `finally` emission was reasoned about but not pinned.** The first pass confirmed by
argument that an early `.return()` delegates through `yield*` and runs the `finally` once; that
argument is correct but nothing in the suite would catch a refactor moving the `logIndexSeek`
call after the loop, which is the shape that silently emits nothing for the operator who most
needs the line. Added *index seek trace is still emitted when the consumer abandons the scan
early*, which breaks out of `db.eval` after one row of three matching rows. Measured while
writing it: the line reports `matched=1` against three matching entries, so the scan really is
being abandoned rather than drained and reported afterwards — the pin bites. That measurement
is recorded in the test's comment so nobody has to re-derive it.

**`logIndexSeek`'s docblock had grown to 59 lines restating `docs/debugging.md`.** The
field-by-field reading guide and the "do not subtract / mind the off-by-one" operator guidance
existed in near-verbatim duplicate at both the code site and in the doc the docblock already
links — two copies with nothing keeping them in step. Trimmed the code-site copy to what a
future editor of that function needs (where each field is sourced from, and the invariants that
must not be collapsed: `none` vs `unknown`, empty `seek=` vs `unset`), leaving the operator
guide and the decision table in the doc.

**Two doc-accuracy slips.** The "pinned by tests" paragraph named two of the four spec files
that actually hold the pins — `committed-read-isolation.spec.ts` (the `arm=committed` case,
which plain SQL cannot reach) and `adapter-integration.spec.ts` (`:none` vs `:unknown`) were
both missing, which matters here because `debt-doc-code-citations-rot-silently` is open against
exactly this failure mode. And the `Common DEBUG patterns` entry still described that namespace
pair as write-side only, though it is now what turns on the read-side line too. Both corrected.

### Recorded as a tripwire, not filed as a ticket

- **`distributed-quereus.spec.ts` binds a fixed `BASE_PORT = 9100`.** Re-running the plugin
  suite while a previous run's libp2p nodes are still exiting fails that suite's `before all`
  with `UnsupportedListenAddressesError` / `EADDRINUSE ... 0.0.0.0:9100`. Hit twice during this
  pass's validation, and it reads like a real failure of whatever change is under test, so it
  costs an agent a diagnosis each time. Genuinely conditional — a single clean run always
  passes. `NOTE:` at the constant naming the symptom, the cause, and the fix if back-to-back or
  parallel runs ever become routine (bind port `0` and read the assigned port back off each
  node's multiaddrs instead of numbering from a constant).

### Considered and declined

- `optimystic-module.ts` is 3361 lines (`wc -l`). `tickets/backlog/debt-optimystic-vtab-class-is-too-big-to-review.md`
  already claims that site, and this ticket's contribution to it was mostly comment, now
  trimmed. Evidence for the existing ticket, not a new one.
- The `revs=` shape decision (trailing additive field rather than folding the revision into the
  id token) was re-examined independently and the reversal is right: a parser keyed on the id
  token would report the collection **absent from the commit**, which is precisely the false
  negative this line exists to rule out, and it would be read as evidence during the live
  downstream investigation. Reasoning is already recorded at the site; left alone.
- No accepted-tradeoff `NOTE:` sits at any site this pass touched, so nothing was skipped on
  those grounds.

### New tickets filed

None. Every finding was bounded and fixed in this pass, except the one genuinely conditional
concern, which went to a tripwire per the disposition rules.

## Validation (second pass, final tree)

```bash
yarn lint && yarn build && yarn typecheck          # all exit 0
yarn workspace @optimystic/db-core test            # 1387 passing
yarn workspace @optimystic/quereus-plugin-optimystic test   # 500 passing, 13 pending, 0 failing
```

The plugin count is 500 rather than the 483 quoted above because this pass added one test and
the concurrently-running `two-node-index-interleaving-sweep` ticket added its own; two
consecutive runs agreed on 500/13/0.

`tickets/.pre-existing-error.md` was not written. One `EADDRINUSE` failure was seen during
validation and is not pre-existing and not a defect — it was this pass's own back-to-back runs
colliding on port 9100, and it is now documented at that site as the tripwire above.
