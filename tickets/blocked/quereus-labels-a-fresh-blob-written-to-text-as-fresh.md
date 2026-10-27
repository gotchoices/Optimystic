description: Quereus's analysis of a write statement labels a 16-byte random value written to a text column as one no other writer can produce, although the engine stores a lossy text rendering of those bytes; until Quereus corrects the label, the plugin tells the application such an insert is assured. Unblocked by a Quereus release that labels that write as not fresh.
architecture: docs/offline-sync.md#what-the-analysis-needs-from-quereus
files: packages/quereus-plugin-optimystic/test/write-description.spec.ts, packages/quereus-plugin-optimystic/package.json, docs/offline-sync.md, packages/quereus-plugin-optimystic/README.md
difficulty: easy
----

**Blocked: a dependency outside this repository.** Unblocks when `@quereus/quereus` publishes a release in which `randomblob(16)` written bare to a `text` column classifies `other`. Both repositories belong to the same maintainer (the sibling checkout `../quereus`), so the upstream change is a ticket there; this ticket carries its proposed shape and the work here once it lands.

## What is wrong upstream (Quereus 4.21.0)

Quereus's docs/write-scope.md promises that "a fresh value becomes `other` when the conversion is lossy … a fresh blob written to a `text` column, for one". The classifier applies that rule (`afterWriteConversion` in `@quereus/quereus/src/planner/analysis/value-provenance.ts`) only to a cell the insert builder wrapped in a `WriteCoercionNode`, and `coerceToDeclared` in `@quereus/quereus/src/planner/building/insert.ts` skips the wrap for a column whose logical type has neither `parse` nor `validate` — which `TEXT_TYPE` has not. So for

```sql
create table t (id text primary key, body text) using memory;
insert into t (id, body) values (randomblob(16), 'a');
```

`stmt.getWriteScope().writes[0].columns[0].provenance` is `{ kind: 'fresh', function: 'randomblob' }`, while running the statement stores a string carrying U+FFFD replacement characters (`typeof(id)` answers `text`): the executor converts the cell, the plan never described the conversion. Observed on 2026-10-26 against 4.21.0 from the plugin's test harness, on a memory table and on an Optimystic table alike. The label is also inconsistent across table shapes: give `t` a `b blob` column and the same insert's `id` classifies `other`.

The plugin trusts the label by design (docs/offline-sync.md §Judging each guard), so an offline insert keyed by bare `randomblob(16)` into a text column is judged assured although its stored key is not the 128-bit value the label promises.

## Proposed upstream fix (the recommended default)

Apply the fresh-conversion rule to every fresh cell written to a typed column, whether or not a `WriteCoercionNode` was planned: the classifier knows the cell's static type and the column's declared type at the projection, so `conversionKeepsFresh(from, to)` can run there. Pin it in Quereus's `test/optimizer/write-scope-analyzer.spec.ts` with the two-text-column table above (`id` → `other`) beside `hex(randomblob(16))` (`fresh`).

Alternatives rejected:

- **The plugin reasons about the column type itself** (treat `fresh` from `randomblob` into a text-affinity column as not fresh). It duplicates a rule Quereus owns and documents, in a shape that becomes dead code the day Quereus fixes it, and it is the one place the plugin would second-guess a label.
- **Plan the `WriteCoercionNode` for text columns too.** Every plan over a text column would then carry the identity conversion the skip exists to avoid.

## If nothing is done

An application that keys a text column by bare `randomblob(16)` is told the insert is assured while the stored key is a lossy decode of the bytes: a collision stays very unlikely, but is not ruled out as the label promises, and one would fail the entry with `constraint`, be logged as `offline:assured-entry-failed` and counted in `assuredFailures`. `hex(randomblob(16))` and `StampId()` are labelled correctly and are the documented spellings (README § Offline mode). Fully reversible: no interface changes on either side.

## Work here once it lands

- Raise the Quereus range (`@quereus/quereus` in `packages/quereus-plugin-optimystic/package.json`, moving `engines.quereus` with it; `yarn lint:deps`) and regenerate `QUEREUS_VERSION` through the plugin's build.
- Pin the case in `packages/quereus-plugin-optimystic/test/write-description.spec.ts`: bare `randomblob(16)` into the text key, `freshElementsOf` answers `[]` — the case the implement ticket `offline-sync-outlook-from-write-description` asked for and could not pin; the comment above the lossy-wrapper case says so.
- Drop the caveat sentences in docs/offline-sync.md §What the analysis needs from Quereus and README § Offline mode ("Write `hex(randomblob(16))` …").
