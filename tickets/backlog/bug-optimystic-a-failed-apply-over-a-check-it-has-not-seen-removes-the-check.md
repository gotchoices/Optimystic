description: When a machine changes a named CHECK rule that another machine has already changed without it knowing, and its schema upgrade then fails part-way, the rule disappears from the shared stored description of the table. A machine that restarts and only hydrates then stops enforcing it.
architecture: docs/internals.md#a-first-touch-writes-only-what-the-table-owes
files: packages/quereus-plugin-optimystic/src/schema/catalog-only-change.ts (`classifyCheckChange`, `AdoptedChanges`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`alterCatalogOnly`), packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts, packages/quereus-plugin-optimystic/README.md
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It needs three schema versions in flight at once and a failed apply, and the next `apply schema` of the declaration adds the rule back, so a host that re-declares on every start only loses enforcement until then.
----

## What happens

Sessions share one `MemoryRawStorage`, as in `openSession` in `packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts`.

1. Machine A declares `t` with `constraint pos check (a > 0)`, and a table `u (id, c)`.
2. Machine B hydrates.
3. A applies the same declaration with `constraint pos check (a >= 0)`.
4. B applies it with `constraint pos check (a >= 1)` plus `constraint one_c unique (c)` on `u`, which the module refuses, so the apply fails and Quereus unwinds it.
5. A new session hydrates to read the record.

| | Result |
| --- | --- |
| Record's `pos` | absent |
| Expected | `check (a >= 0)`, what A saved |

## Root cause

The outcome above was observed; this trace was read from the code. Quereus runs a changed body as a drop and an add, and unwinds them in reverse:

| Step on B | Record holds | Verdict | Record after |
| --- | --- | --- | --- |
| drop `a > 0` | `a >= 0` | adopted, as the drop half of another machine's replacement | `a >= 0` |
| add `a >= 1` | `a >= 0` | owned, "local DDL wins" in `classifyCheckChange` | `a >= 1` |
| undo: drop `a >= 1` | `a >= 1` | owned, since it matches no adopted change | none |
| undo: add `a > 0` | none | undoes the adopted drop, so nothing is written | none |

The README promises that an undo never removes from the record what that machine's apply did not put there, and names this case as the exception until it is fixed. An added column cannot reach this: adding a column of a name the record holds with a different definition is refused.

## Expected behaviour

The undo of a catalog-only change leaves the record holding what it held before that change. `tagsToSave` already follows this rule for tags: `AdoptedChanges` records what the record held for each tag change, and the undo puts that back. Extending that rule to CHECKs would retire this case as a class.
