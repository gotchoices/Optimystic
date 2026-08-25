description: A bug report claimed our tests had never tried two machines writing rows that share one search-index value. They had, and those tests pass. New tests were added anyway for three neighbouring situations that genuinely had never been tried, and those pass too — so the reported bug still has no explanation on our side.
prereq:
files: packages/quereus-plugin-optimystic/test/two-node-shared-index-key.spec.ts, packages/quereus-plugin-optimystic/test/two-node-index-interleaving-sweep.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, tickets/backlog/debt-index-sweep-misses-update-delete-and-orphans.md
difficulty: medium
----

# What the fix ticket claimed, and why it was wrong

`fix/two-nodes-writing-one-index-key-was-never-tested` argued that all five prior attempts to
reproduce a downstream secondary-index bug had given the two machines **disjoint index keys**, so
no index entry had ever had to hold two writers' contributions — and that the downstream failing
case shares one index key. It proposed a mechanism: a shared index entry overwritten
last-writer-wins instead of merged.

Both halves are wrong, and each was settled by measurement or by reading the code rather than by
argument.

**The shape was already tested.** The sweep's `token` dimension crosses `same-token`, which puts
both machines on `tok-seed` while they write distinct primary keys (100 and 200). That is 72 of the
144 orderings, and they pass:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/two-node-index-interleaving-sweep.spec.ts" --reporter min --exit --grep "token=same-token"
→ 72 passing (16s)
```

The ticket reached its claim from the exclusion list in
`backlog/debt-index-sweep-misses-update-delete-and-orphans`, which says "no same-**primary-key**
conflict between the nodes." That is about primary keys. The index is on `Token`, not on the
primary key, so disjoint primary keys do not imply disjoint index keys.

**The proposed mechanism cannot happen.** `index-manager.ts insertIndexEntries` keys every index
tree entry as `frame(indexColumns) ‖ frame(primaryKey)`, for unique and non-unique indexes alike,
and a seek range-scans the `frame(indexColumns)` prefix. Two rows sharing an indexed value occupy
two **distinct** tree keys. There is no shared slot whose contents could be overwritten. What two
same-value writers do share is the tree **block** their adjacent keys land in — and that block-level
merge is exactly what the `same-token` cases already exercise.

**One thing the fix ticket got right.** The sweep header claimed "the downstream scenario redeems
distinct [tokens]". It does not: `sereus/packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts`
says at its head that two nodes "redeem the SAME token in the same tick", and
`sereus/schemas/control.qsql` makes `UsageStampId` (a per-redemption nonce) the primary key with a
non-unique index on `Token`. The header sentence was corrected in place.

# What was added

`packages/quereus-plugin-optimystic/test/two-node-shared-index-key.spec.ts` — 6 cases, ~3s, ungated
so it runs on every `yarn test`. It closes three gaps the sweep's own review catalogued as untested:

- **A shared index value created from nothing.** Every `same-token` sweep case grows a group a
  committed seed row already established; here the index tree starts empty and both machines create
  the group at once. All three commit orders (A-then-B, B-then-A, both-staged-then-committed).
- **A third writer.** A three-node mesh, all three staging before any commits. Two machines cannot
  distinguish "last writer wins over the whole group" (1 surviving row) from "a pairwise merge drops
  one arm" (2); three can.
- **A UNIQUE index across two machines**, and **an index tree that spans more than one block.** The
  latter derives its preload from the btree's exported `NodeCapacity` rather than hard-coding 80, and
  asserts through `Path.branches` that the tree actually split — with a negative control on the
  two-entry cases asserting `split === false`, so the probe cannot be silently constant.

Every case also asserts the committed entry count through a **fresh** Tree on each node's transactor
(not the vtab's tracker), so a lost write the query path happened to paper over would still fail.

**All six pass.** This is the sixth failure to reproduce the downstream report upstream.

# What the reviewer should be adversarial about

- **Is the new spec actually exercising what its comments claim?** In particular: does the shared
  value really start absent (no seed row anywhere), and is `staged-both` genuinely staging before
  either commit rather than serialising?
- **Is the UNIQUE case meaningful?** It deliberately uses **distinct** values, because two machines
  writing the same value into a unique index is a check-then-write question
  (`optimystic-module.ts resolveSecondaryUniqueDecision` reads the tree before writing, so neither
  machine sees the other's uncommitted row and both admit). That is argued in a comment, not tested.
  Judge whether the comment is right, and whether the untested same-value-unique case deserves to
  exist as a case that asserts the over-admission rather than merely describing it.
- **Cost.** ~3s on a ~3m package suite. The sweep header carries a standing warning about the file
  budget for index tests; check this stays within it.
- **The correction landed in two places** — the sweep header and an "Update 2026-08-25" section
  appended to `backlog/debt-index-sweep-misses-update-delete-and-orphans`. Check they agree with each
  other and with the code.

# Honest limits

Nothing here explains the downstream report, and nothing here is a fix — there was no defect to fix.
The new cases are standing regression cover plus three closed coverage gaps.

The gaps that remain open are unchanged and listed on
`backlog/debt-index-sweep-misses-update-delete-and-orphans`: no UPDATE or DELETE anywhere in any
two-node index spec (that ticket's actual subject), no real sockets, no process restart
mid-scenario, no genuine thread-level concurrency, no same-primary-key conflict, no composite index,
and the read-only-sibling shape.

Where the investigation goes next is a human's call and is filed separately as
`blocked/secondary-index-repro-exhausted-upstream`.

# Validation

| command | result |
|---|---|
| `yarn lint` (root) | pass |
| `yarn typecheck` (`packages/quereus-plugin-optimystic`) | pass |
| `yarn test` (`packages/quereus-plugin-optimystic`) | 647 passing, 13 pending, 0 failing (3m) — was 641 before |
| both index specs together, standalone | 156 passing (144 orderings + 6 coverage guards + 6 new), 24s |
| sweep, `--grep "token=same-token"` | 72 passing (16s) — the baseline that refutes the fix ticket |

No pre-existing test failures surfaced; `tickets/.pre-existing-error.md` was not written, and
nothing was skipped, commented out, or loosened.
