description: Our tests for "does a secondary index agree with the table across two machines" only ever add rows — they never change or remove one. Changing or removing a row is the most common way an index is left pointing at something that is no longer there, and the test we would use to catch that cannot see it even in principle.
prereq:
files: packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/query-helpers.spec.ts, packages/quereus-plugin-optimystic/test/two-node-index-interleaving-sweep.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: medium
tradeoffs: The downstream report this would chase is about a row that is present-but-unfindable, which is an INSERT-shaped symptom, so a maintainer could reasonably say the UPDATE/DELETE paths are a different investigation and wait for a report that actually implicates them.
----

## Background

A downstream project reports a row that replicates between two machines while the
secondary-index lookup for it comes back empty on the sibling machine (primary-key lookup
and full scan both find the row). Five investigations have failed to reproduce it here.
The most recent one stopped hand-picking scenarios and enumerated instead — 144 generated
two-node orderings in `two-node-index-interleaving-sweep.spec.ts`, all green.

Reviewing that sweep turned up a coverage hole that is bigger than the sweep itself.

## The hole

**Every two-node index test in this package only ever INSERTs.** Not just the sweep — no
spec under `test/two-node-*.spec.ts` issues an `update` or a `delete` at all. The
`updateIndexEntries` / `deleteIndexEntries` paths in `index-manager.ts` are exercised only
by `index-support.spec.ts` and `insert-pk-uniqueness.spec.ts`, both single-node. So the
whole question "when one machine changes or removes a row, does the other machine's index
agree afterwards?" has never been asked.

This matters because changing an indexed value is the ordinary way an index entry is
orphaned: the entry for the OLD value has to be removed and one for the NEW value added,
and those are two separate edits to a tree that a sibling machine may be holding at a
different moment.

## Why the existing test could not catch it anyway

The shared assertion `expectIndexAgreesWithScan` (`query-helpers.ts`) works by scanning the
table, collecting every value it finds in the indexed column, and then checking that an
index lookup for each of those values returns the same rows.

That design can only ever see values the table still holds. An index entry left behind for
a value that no row has any more is never looked up, so it is never noticed. The helper's
own docstring says so — and it names "orphaned entries left by an UPDATE" as part of the
defect class it is supposed to generalize. Those two statements contradict each other:
it claims the class and then excludes the most common member of it.

So adding UPDATE and DELETE coverage on top of the current assertion would produce more
green tests without increasing what can actually be detected. The assertion has to be
fixed first.

## What is wanted

Two arms, in this order — the second is not worth doing without the first.

**Arm 1 — make the assertion able to see an orphan.** Compare the index's own contents
against the table, rather than only probing the index with values the table still supplies.
The check to aim for is a two-way one: every row implies an index entry, AND every index
entry implies a row. Once that holds, an entry for a deleted or superseded value fails the
assertion instead of hiding from it. This needs a way to read an index tree's entries
directly; whether that is worth exposing on a test surface, or is better expressed some
other way, is part of the work. Fix the docstring's claimed scope to match whatever the
result actually covers.

**Arm 2 — add mutation to the two-node sweep.** Extend the generator so a case can, after
the initial writes, have one node change a row's indexed value, or delete a row, and then
assert both nodes still agree. The interesting shapes are: the value moves to one the other
node already wrote; the value moves to a brand-new one; the row is deleted entirely; and
each of those done by the node that did NOT originally write the row.

Mind the cost. The sweep is currently 144 cases and runs on every `yarn test` because it
is only ~7% of the package suite. Mutation is another dimension, and dimensions multiply —
it may need to be a second, narrower generator rather than another axis on this one. The
spec header carries the measurement commands and a note about exactly this.

## Not in scope

Whether the downstream report is itself an UPDATE-shaped bug. Nobody knows yet; that is
what the coverage is for. Do not tune the new cases toward a guess about the downstream
scenario — the point is to close a hole that is real regardless of what that report turns
out to be.

## Other gaps recorded but deliberately not filed

The sweep's review listed several further untested dimensions — no real sockets, no mesh
larger than two nodes, no process restart mid-scenario, no genuine thread-level concurrency,
no same-primary-key conflict between the nodes, no composite or UNIQUE index, and only three
rows per case (too few to split an index tree across blocks). Two more found while
reviewing, both nearly free to add if this generator is being widened anyway:

- The `staged-both` write ordering stages both machines' changes before either is
  committed, but always commits them in the same order, so "both staged, then the second
  machine commits first" is never tried.
- No case ever has a machine look up a value that only the OTHER machine writes. So the
  shape where a machine touches an index purely by reading someone else's value — never
  writing to it at all — is untested, even though that is precisely the situation the
  downstream report describes.

They are recorded in that
spec's "known gaps" discussion rather than as tickets, because unlike the mutation gap none
of them has a specific reason to be suspected. The UNIQUE-index one is the closest to
earning its own ticket: `two-node-multi-collection-commit.spec.ts` shows the downstream
stack's failing signature naming a `_uniq_1` index collection, and nothing here covers a
UNIQUE index across two nodes.
