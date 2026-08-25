description: A row saved on one machine still cannot be found through its secondary index on the other machine, and we have run out of things the current logs can tell us. Add the one measurement that separates the two remaining explanations, so the next run on the machine where this happens says which one it is.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/test/trace-helpers.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, docs/debugging.md
difficulty: medium
----

# Name the revision, not the block id

## Where the investigation stands

A table with a secondary index is stored as two Optimystic collections: the table's own
tree, and one tree per index at `<tableUri>/index/<indexName>`. A downstream project
(sereus) reports that a row written on machine A cannot be found through the index on
machine B, while the same row on the same machine B *is* found by primary-key lookup and
by a full table scan.

The previous ticket measured the write and closed the leading hypothesis: **both machines'
writes do carry the index collection, staged** — `commit:collections mode=legacy count=2`
naming the table and the index tree, on all four writes in the failing run. So nothing is
being left out of the transaction, and the fault is after the commit.

## What this fix stage established (do not re-derive)

**A collection's id is a pure function of its URI, and that id is also its header block
id.** `CollectionFactory.parseCollectionId` (`collection-factory.ts:417-436`) is literally
the URI with a leading `tree://` stripped — no allocation, no registry, no randomness. So:

- Two machines that print the same collection URI in the trace **necessarily** used the
  same header block id. The parent ticket's suggested next step — "extend the trace so it
  names the block id of each collection" — would print a value already known from the URI.
  **Do not build that.** It cannot distinguish anything.
- Do not confuse this with `backlog/speculative/6.5-block-id-derivation`, which is about
  the *content* block ids inside a collection. Those are 32 random bytes each
  (`TransactorSource.generateId`). So two machines that each invent the same collection
  share one header id but allocate **different** root and leaf blocks under it — a fork
  under a single header is entirely possible, and the header is the only merge point.

That leaves exactly two worlds, and the trace as it stands cannot tell them apart:

- **Forked lineage.** Both machines committed under the same header id but followed
  different action logs, so each holds an index tree containing only its own entries.
- **Converged lineage, stale read.** The logs agree, but the sibling's index tree serves
  content from a revision older than the one the writer committed at.

**One number separates them: the action-context revision each machine's index collection
holds.** Nothing currently prints it, from either end.

## What to add

Two things, both `debug`-gated observability. No behaviour changes.

### A public revision accessor

`Collection` keeps its revision inside its private `TransactorSource`, as that source's
action-context revision (`collection.ts:84-98`, advanced only through
`Collection.advanceContext`). There is no way to read it from outside. Add a narrow
accessor on `Collection` — returning `undefined` for an invented collection that has never
committed, which is itself the diagnostic answer — and forward it from `Tree`, next to the
existing `Tree.describe()` / `Tree.getCollection()` (`tree.ts:243-253`).

`undefined` must stay distinguishable from `0` in every line below: "never committed
anything" and "at revision zero" are different findings.

### A read-side trace line

`OptimysticTable.runQuery` (`optimystic-module.ts:769-800`) resolves both read sources
before scanning: the live arm refreshes each with `await tree.update()`, the committed arm
builds two pinned views in one synchronous block. Emit one line per index-routed scan,
naming:

- table, index name, index collection id, main collection id
- the revision of each of the two collections
- whether the read was live or committed
- the framed seek key (the value `executeIndexScan` builds at `optimystic-module.ts:1010-1024`)
- the number of primary keys the index seek yielded

The yielded count is what makes the line self-contained: a sibling that reports a current
revision and zero yielded keys is reading a converged-but-empty tree, while one reporting a
revision behind the writer's is reading a stale or forked one. Either verdict is reachable
from a single line of the failing run's log, with no second round trip.

Follow the existing convention in this package: one `debug` namespace, `key=value` fields,
and a shape the test helpers can parse. Guard any non-trivial construction behind
`log.enabled` the way `logCommitCollections` does — but note the count is only known after
the scan drains, so the line is emitted at the end of the scan, not the start.

### The revision on the commit line

Extend `commit:collections` (`txn-bridge.ts`, `logCommitCollections`) so each collection's
entry carries its revision alongside the existing `staged`/`clean`/`unknown` marker. Both
commit paths (legacy sweep and session) build their entry arrays already; this is one more
field per entry.

Keep the existing field order and marker vocabulary — `docs/debugging.md` documents the
line verbatim and downstream operators have parsers against it. Adding a field is fine;
reordering or renaming is not.

## Documentation

`docs/debugging.md` § "Which collections did a write carry?" is the reader's guide for
these lines. It needs the new field on the commit line, a new subsection for the read-side
line, and — the part that actually matters to the operator — the **decision rule**: given
one machine's commit line and the other machine's read line for the same index collection,
which of the two worlds above the pair proves.

State plainly there that the collection id is the URI with `tree://` stripped, so an
operator does not go looking for a separate block id.

## Reproduction context

Still not reproducible in this repository — every two-node shape on the mock mesh and on
real libp2p converges. It reproduces deterministically in the sereus checkout:

```bash
cd packages/integration-tests
DEBUG='optimystic:quereus-plugin:txn-bridge' \
  npx vitest run src/scenarios/strand-formation-concurrent-redemption.integration.ts
```

That is why this ticket is observability rather than a fix: the measurement has to be taken
where the failure happens. `2-two-node-index-interleaving-sweep` is the parallel attempt to
bring the failure here instead.

## Already ruled out — do not re-derive

From this ticket's ancestors: not the read-repair corroboration floor; not the
maintained-index guards; not a forked *data* collection (primary-key descent and full scan
both find the row on the failing sibling); not the mock transport; not write concurrency;
not the cluster-size configuration; not composite text primary keys; not the write
transaction's collection set; and now, not a mismatch of header block ids between the two
machines.

## TODO

- Add a revision accessor to `Collection` (reading its source's action-context revision)
  and forward it from `Tree`, keeping `undefined` distinct from `0`.
- Emit the per-index-scan read trace from `runQuery`/`executeIndexScan` with the fields
  listed above, covering both the live and the committed arm.
- Add the per-collection revision field to `commit:collections` in both commit modes,
  without reordering or renaming existing fields.
- Extend the parsers in `test/trace-helpers.ts` for the new field and the new line.
- Pin both in `test/two-node-secondary-index-convergence.spec.ts`: a converged two-node run
  must show both machines' index collection at the same revision, and the read line's
  yielded count must equal the rows the seek returned. Confirm each pin fails when its line
  is removed, rather than silently passing.
- Update `docs/debugging.md`: new field, new line, the two-worlds decision rule, and the
  note that a collection id is its URI minus `tree://`.
- Run `yarn lint`, `yarn build`, `yarn typecheck`, then `yarn test` in
  `packages/quereus-plugin-optimystic`, and `OPTIMYSTIC_INTEGRATION=1 yarn test` in the same
  package.
