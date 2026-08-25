description: Debug logging now says which version of the stored data each machine read and wrote, so the next run of the failing scenario shows whether the two machines disagree about the data or merely about how fresh it is. No behaviour changed — this is measurement only.
prereq:
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/trace-helpers.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, docs/debugging.md
difficulty: medium
----

# Review: name the revision each index read and commit lands on

## Read this first — two implement runs edited these files at the same time

The runner dispatched two overlapping implement tickets in parallel:

- `1-name-the-revision-each-collection-reads-and-writes-at` (started 04:28:25Z)
- `1-name-the-revision-each-index-read-and-commit-lands-on` (this one, started 04:29:21Z)

Both were downstream of two separate `fix/` runs of the same investigation, and both
specify the same measurement. **The working tree is the union of both runs' edits**, not
either one alone. A second review ticket for the sibling slug may appear describing
overlapping ground — if so, review the union once rather than twice, and expect the two
handoffs to describe the same code.

Practical consequence for the reviewer: some code comments and doc paragraphs were written
by one run and some by the other, then edited by the other again. They agree in substance
(the suite is green and self-consistent), but the prose has more than one author, so watch
for duplicated or slightly redundant explanation rather than for contradiction.

## What the change is

Three debug lines now let an operator answer, from one failing run's log, **which of two
worlds** a "row written on machine A is invisible through the index on machine B" failure
is in:

- **Forked lineage** — both machines committed under the same collection id but followed
  different action logs, so each holds only its own entries.
- **Converged lineage, stale read** — the logs agree, but one machine's index tree is
  serving content from an older revision than the writer committed at.

Nothing branches on any of it. There are no behaviour changes; every addition is behind
the `debug` namespace it prints on.

### A revision accessor (db-core)

`Collection.committedRevision(): number | undefined` returns the collection's
action-context revision. `Tree.committedRevision()` forwards it. `undefined` means an
**invented** collection — `createOrOpen` found no committed header and staged a fresh
empty one — and that is itself a finding, so it is never collapsed into `0`. Everywhere it
is printed, `undefined` renders as the literal token `none`.

### `commit:collections` now carries revisions (`optimystic:quereus-plugin:txn-bridge`)

```
commit:collections mode=legacy count=2 default/Usage=staged default/Usage/index/by_token=staged revs=default/Usage:7,default/Usage/index/by_token:3
```

The revisions are a **trailing, strictly additive `revs=` field**. The
`<id>=staged|clean|unknown` tokens are byte-identical to what the line emitted before, so
an operator's existing grep or parser keyed on a collection id keeps matching.

> **This was a deliberate reversal of the sibling run's first shape**, which folded the
> revision into the id token as `default/Usage@7=staged`. That form is shorter, but it
> silently breaks any parser keyed on the id into reporting the collection **absent from
> the commit** — precisely the false negative this line exists to rule out, during an
> active downstream investigation that is reading these logs. The ticket's constraint was
> explicit: adding a field is fine, renaming one is not. Worth a reviewer's second opinion
> since it trades line length for compatibility.

`:none` = invented collection. `:unknown` = a `DirtyTree` test double that does not
implement the accessor. Both commit modes (legacy sweep and session/coordinator) emit it.

### `index:seek` — a new read-side line (`optimystic:quereus-plugin:module`)

One line per index-driven scan, emitted **at the end of the scan** (the entry count is not
known until the iteration drains):

```
index:seek table=Usage index=by_token collection=default/Usage/index/by_token main=default/Usage arm=committed rev=3 main_rev=7 seek=%01tok-a%00 matched=0
```

- `collection=` / `main=` — the index and main table collection ids, so one line names both
  collections the scan touched and joins to `commit:collections` and `index:tree-open`.
- `arm=live` (both trees refreshed via `update()` immediately before descending) or
  `arm=committed` (a pinned pre-transaction view that deliberately never refreshes).
- `rev=` / `main_rev=` — each collection's committed revision, `none` if invented.
- `seek=` — the framed index key, percent-escaped. Empty means the whole-index prefix;
  `unset` means the scan returned before framing a key.
- `matched=` — index entries the seek produced, counted **before** the row fetch.

### Documentation

`docs/debugging.md` § "Which collections did a write carry?" gained the `revs=` field, and
a new § "Which revision did a read descend?" documents `index:seek` and carries the
**decision-rule table** an operator reads the pair with. It also states plainly that a
collection id is its URI with `tree://` stripped and IS the header block id, so nobody
goes hunting for a separate block id.

## Use cases for testing and validation

### The suite

```bash
yarn lint && yarn build && yarn typecheck
yarn workspace @optimystic/db-core test                                    # 1387 passing
cd packages/quereus-plugin-optimystic && yarn test                         # 480 passing, 13 pending
cd packages/quereus-plugin-optimystic && OPTIMYSTIC_INTEGRATION=1 npm test # 486 passing, 8 pending
```

All green, zero failing, as of this handoff. No pre-existing failures were encountered, so
`tickets/.pre-existing-error.md` was not written.

### The pins, and the negative control that proves they bite

In `test/two-node-secondary-index-convergence.spec.ts`:

- `commit trace names the index collection alongside the table…` — asserts each collection
  in the commit names a revision.
- `index seek trace names the revision each side of the read descended` — the live arm.
- `index seek trace names both collections, the framed key, and a count that matches the
  rows` — three rows exist, two match; `matched` is asserted **against `rows.length`**, not
  a hard-coded literal, so a line that reports the whole index (or nothing) fails.
- `two converged nodes report the same index collection revision and the same framed key`
  — the ticket's core pin: on a run that DOES converge, both nodes must report the same
  `rev=` and the same `seek=`. If a change makes two converged nodes' revisions disagree,
  the diagnostic has started lying and every downstream reading from it is wrong.

In `test/committed-read-isolation.spec.ts`:

- `the index:seek trace names the committed arm for a hand-driven committed index scan` —
  the committed arm is not reachable from plain SQL, so without this it would ship
  unexercised.

**Negative control was run, not assumed.** With the `revs=` field and the `logIndexSeek`
call temporarily removed and the package rebuilt, exactly four tests failed (the
commit-revision pin and the three `index:seek` pins in the two-node spec); both emitters
were then restored by inverse edit, not by a working-tree revert. The committed-arm pin
asserts on the same emitter and the same `seeks.length > 0` precondition, so it fails by
the same mechanism — that one was reasoned, not separately re-run.

### Using it on the real failure

The failure does **not** reproduce in this repository — every two-node shape on the mock
mesh and on real libp2p converges. It reproduces deterministically in the downstream
sereus checkout:

```bash
cd packages/integration-tests
DEBUG='optimystic:quereus-plugin:txn-bridge,optimystic:quereus-plugin:module' \
  npx vitest run src/scenarios/strand-formation-concurrent-redemption.integration.ts
```

Then read the failing sibling's `index:seek` line for the index collection against the
writer's `commit:collections` revision **for that same collection id**, using the table in
`docs/debugging.md`.

## Known gaps — please probe these

- **The measurement is the deliverable; the bug is not fixed.** This ticket is
  observability. If the reviewer expects a behaviour change, there isn't one by design.
- **`rev=` is the collection's revision, not the committed view's pin.** For `arm=committed`
  over a tree staged into the in-flight transaction, the view pins to the transaction's
  first-touch boundary, which can be *older* than the `rev=` printed. Documented in the
  code and in `docs/debugging.md`, but not printed as a separate field. If a committed-arm
  investigation ever turns on that difference, the fix is to print
  `CollectionSnapshot.context.rev` as a further field.
- **`matched=` is a floor, not an exact count.** A scan the caller abandons early (a
  satisfied `LIMIT`, an error mid-scan) reports what it had produced when it stopped. It
  can never overcount, so `matched=0` still soundly means "the descent found nothing" —
  which is the reading the decision rule turns on — but a nonzero value is a lower bound.
- **Only index-routed scans emit a line.** Point lookups, range queries, and full table
  scans emit nothing. If the downstream failing query ever plans to a full scan, there
  will be no `index:seek` line to read.
- **`seek=` is comparable, not decodable.** `encodeURIComponent` over the framed key is
  injective, so two nodes' keys compare exactly — but decoding one yields raw framing
  bytes, not the SQL value. Do not document it as a way to recover the seek value.
- **Per-collection revision counters are not on one scale.** `rev=` and `main_rev=` come
  from different collections and are routinely unequal on a healthy run. The doc says
  "do not subtract"; a reviewer should check that warning is prominent enough, because
  subtracting them is the obvious wrong instinct.
- **`log.enabled` guarding.** The probe object is allocated only when the namespace is on,
  and both commit call sites build their entry arrays inside `if (log.enabled)`. Worth a
  check that no non-trivial construction leaked outside a guard.
- **Emission point.** `index:seek` is emitted from a `finally` around the `yield*` in
  `runQuery`, so an abandoned or throwing scan still reports. Worth confirming that adding
  a `try/finally` around a `yield*` inside an async generator has no effect on the
  generator's own error/return propagation.

## Review findings

- Recorded as tripwires at the code site (`NOTE:` in the `logIndexSeek` docblock,
  `packages/quereus-plugin-optimystic/src/optimystic-module.ts`), not filed as tickets:
  the committed-arm pin revision differing from the printed collection revision, and
  `matched=` being a floor on an abandoned iteration. Both are conditional — they only
  become work if a committed-arm investigation or an early-terminating scan turns on the
  difference.
- The `commit:collections` revision placement (trailing `revs=` field rather than folded
  into the id token) is a compatibility decision made mid-flight against the sibling run's
  original shape; the reasoning is recorded in the `logCommitCollections` docblock in
  `packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`.
