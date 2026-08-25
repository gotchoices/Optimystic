description: Five attempts to reproduce a downstream index bug have all used two machines writing rows with different index keys. The failing case downstream has both machines writing rows that share one index key and differ only in primary key — two entries that must merge inside a single index slot. That case has never been tried.
prereq:
files: packages/quereus-plugin-optimystic/test/two-node-index-interleaving-sweep.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collection/collection.ts
difficulty: medium
repro: suspected
----

# Every reproduction attempt gave the two machines disjoint index keys. The failing case shares one.

## The gap

`2-two-node-index-interleaving-sweep` swept 144 orderings and passed all of them. Its own
exclusion list is what makes this worth filing — it states plainly:

> **No same-primary-key conflict.** Each node writes its own disjoint id (100 / 200).

Disjoint primary keys, and — because the index is single-column over those same distinct
values — **disjoint index keys too**. Every one of the 144 cases has each machine inserting
into its *own* index entry. The four hand-written attempts before it were the same shape.

**The downstream failing case is not that shape.** Read out of sereus's schema
(`schemas/control.qsql`):

- `FormationUsage`'s PRIMARY KEY is `UsageStampId` — a per-redemption **nonce**, so two
  machines redeeming concurrently do write disjoint primary keys, exactly as the sweep
  assumes.
- The index is `index FormationUsageByToken on FormationUsage (Token)` — **non-unique**, over
  the *invite*, not the redemption.
- Concurrent redemption of one invite means both machines write **the same `Token`**. A
  schema comment states the rule for future writers outright: *"two FormationUsage rows for
  one token"*.

So the two machines insert rows that **share a single index key** and differ only in primary
key. Both index writes target one entry, and that entry has to end up holding *both* row
references. Nothing tested so far requires an index entry to merge two writers' contributions.

## Why this fits the symptom better than anything tried

The reported behaviour is that each machine finds **its own** row through the index and not
the other's, while a primary-key descent and a full scan on that same machine find both. If
each machine's copy of the shared index entry holds only the reference it wrote — a
last-writer-wins overwrite of the entry rather than a merge of its contents — that is exactly
what a reader would see. The data collection converges (scan and PK are fine); the *index
entry* does not.

It also explains the five failures to reproduce without needing anything exotic: with disjoint
index keys there is no shared entry, so there is nothing to merge and nothing to lose.

`repro: suspected`. Nobody has run this shape. The first job is to run it, not to fix anything.

## The case to add

In `two-node-index-interleaving-sweep.spec.ts`, add a dimension — or a separate case if the
144 is already at its documented cost ceiling (there is a `NOTE:` in that spec's header about
exactly this):

- Two nodes, one table, one **non-unique** single-column index.
- Each node inserts a row with a **distinct primary key** and the **same indexed value**.
- Then assert on both nodes that a seek on that indexed value returns **both** rows.

Worth covering all three commit orders (A then B, B then A, interleaved) since a merge bug
is likely order-sensitive, and worth a third writer to see whether the loss is "all but one"
or "all but the last".

Two adjacent dimensions from the same exclusion list are cheap to fold in once this shape
exists and are also untested: a **UNIQUE** index (the downstream stack's other failing
signature names a `_uniq_1` collection), and enough rows to split an index btree node
(everything so far uses three).

## If it reproduces

The likely site is wherever an index entry's value set is written — whether a commit replaces
the entry or merges into it. Note that the entry is a *collection* value like any other, so
this may be a general multi-writer merge question rather than an index-specific one, in which
case it is worth knowing whether the same loss shows up for two writers appending to any
shared key.

## If it does not

That is a sixth negative, and it is worth saying so on the downstream ticket
(`sereus/tickets/blocked/secondary-index-seek-blind-to-sibling-rows`) rather than filing a
seventh sweep. At that point the difference is host wiring — the sibling opens its database by
catalog **hydration** rather than a re-declared `create table`, runs a write-through
raw-storage cache, and the two machines hold different node roles — and instrumenting the
downstream read path directly is cheaper than another guess here.
