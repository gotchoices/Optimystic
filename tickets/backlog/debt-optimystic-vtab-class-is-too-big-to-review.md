description: The main file behind Optimystic-backed SQL tables has grown to 3000 lines, with a single 2000-line class inside it, which makes changes there hard to review and easy to get subtly wrong.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: medium
tradeoffs: It is a pure move-code refactor with no behaviour change and no user-visible payoff, it will conflict with anything else in flight in that file, and the class's parts genuinely share a lot of state — so a maintainer may reasonably decide the churn costs more than the readability buys.

----

## Measurement

```
$ wc -l packages/quereus-plugin-optimystic/src/optimystic-module.ts
3000
```

Re-measured 2026-08-24 while reviewing `name-the-collections-a-write-carries` (which added a debug
line inside the big class): the same command now reports **3213**. The file is still growing, so the
churn argument in `tradeoffs:` gets worse, not better, with delay.

Re-measured 2026-08-30 while reviewing `drop-leaves-storage-the-catalog-no-longer-describes` (which
added the two storage-adoption guards and their doc comments): the same command now reports
**3691** — up 478 lines in six days. That ticket also added a third distinct concern to the same
class (declaration-time storage adoption, which has to read the schema catalog *and* probe the data
collection *and* probe index trees), so it is evidence for the split, not an argument against it.

Re-measured 2026-09-01 while reviewing `bug-one-failed-open-makes-a-table-unusable-for-the-session`
(which reworked the initialization memo and made a pass's field publication atomic): the same command
now reports **3782**. That review's core difficulty was exactly what this ticket names — deciding
whether a failed initialization pass leaves coherent state required reading initialization, the
storage-adoption guard, the row-emptiness probe and the query dispatcher, all in one class, and one
of the four (`guardStorageAdoption` reaching for `this.collection` before the pass had published it)
was a hidden ordering dependency the split would have made visible.

Top-level shape (`grep -n "^export class\|^class\|^function" …`):

| lines | what |
|---|---|
| 35–178 | module config interface + five small file-local helpers |
| 179–2257 | `OptimysticVirtualTable` — **~2080 lines, one class** |
| 2258–2305 | `OptimysticCommittedTable` (read-only wrapper) |
| 2306–3000 | `OptimysticModule` (the module/factory, incl. schema-manager wiring) |

## Why it matters

Reviews of this file are the bottleneck, not the edits. Recent tickets touching it
(`schema-catalog-index-list-is-lossy`, `index-maintenance-must-track-the-declared-index-set`,
`secondary-index-update-never-reaches-the-sibling`) each needed the reviewer to hold
schema resolution, index maintenance and transaction-bridge registration in mind at once,
because all three live as private methods on the same class with the same `this`. Several
of the defects those tickets fixed were exactly ordering mistakes *between* those concerns
— e.g. folding a schema into the index manager before the trees it declares were opened.
Concerns that cannot be named separately cannot have their interfaces checked separately.

## Seams that already exist

The class's private methods cluster cleanly; the split is mostly mechanical:

- **Schema resolution / initialization** — `doInitialize`, `initializeForCommittedRead`,
  `attachPersistedUniqueConstraints`, `buildUniqueEnforcementIndexes`, the
  candidate/persisted compare.
- **Index maintenance** — `addIndex`, `reconcileMaintainedIndexes`, `openIndexTree`,
  the maintained-index assertions.
- **DML staging and transaction bridging** — the update/insert/delete paths and
  collection registration.
- **Scan / query execution** — the cursor and plan-dispatch paths.

The unit of work is deciding what each piece owns and what it is handed, not just moving
lines: the point is that the pieces get *named interfaces* to each other. A move that
leaves four files all reaching into the same mutable `this` buys nothing.

## Scope note

Behaviour-preserving. The existing suite (463 passing at time of writing, from
`yarn test` in `packages/quereus-plugin-optimystic`) is the acceptance gate — this ticket
should add no tests and change no output.
