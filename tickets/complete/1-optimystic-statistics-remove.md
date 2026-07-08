description: Removed the dead StatisticsCollector from the optimystic plugin; reviewed and confirmed clean.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts
----

## What was done

Deleted `packages/quereus-plugin-optimystic/src/schema/statistics-collector.ts` (~173 lines) and
removed all references from `optimystic-module.ts` (import, field, `doInitialize` construction, the
INSERT/UPDATE-REPLACE/DELETE row-count calls, and a stale planner comment). Purely subtractive; no
behavioural change. Future statistics feature tracked in
`tickets/backlog/feat-optimystic-persisted-planner-statistics.md`.

## Review findings

Read the implement diff first, fresh, before the handoff.

**Correctness / behaviour** — Diff is purely subtractive. INSERT, UPDATE (incl. UPDATE OR REPLACE PK
collision), and DELETE return values and surrounding staging/index logic untouched.
`getBestAccessPlan` cost math unchanged (only stale comment lines removed). No concern.

**Dead-code residue (minor — fixed inline)** — The implement pass missed three stale comments still
naming the removed statistics/row-count tracking:
- `optimystic-module.ts` INSERT OR REPLACE branch — "row count is unchanged (no statistics bump)" →
  reworded (no row-count tracking exists anymore).
- `optimystic-module.ts` INSERT OR IGNORE branch — "leave the row count unchanged" → reworded.
- `test/insert-pk-uniqueness.spec.ts` doc comment — "staging / index / statistics primitives" →
  dropped the now-nonexistent statistics primitive.
After the fixes, `grep -i statistics` over `src/` and `test/` returns zero hits.

**No lingering import** — confirmed: no `statistics-collector` import survives anywhere in `src/` or
`test/`; deleted source file is gone; no barrel/index re-export.

**Tests** — happy/edge/error paths for INSERT/UPDATE/DELETE and the OR REPLACE / OR IGNORE branches
are exercised by the existing 308-test suite (the removed code had no dedicated test, so no coverage
lost). Added no new tests — the change removes a call-site, adds no branch; existing suite fully
covers the paths the removed calls sat on.

**Docs** — no doc/README references the StatisticsCollector; nothing to update.

**Tripwires** — none. The one deferred concern (persisted planner statistics) is already a backlog
ticket, not a conditional-latent issue.

## Validation

- `yarn workspace @optimystic/quereus-plugin-optimystic build` — clean, no TS errors.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **308 passing, 0 failing**, 11 pending.
- Smoke: `smoke ok quereus@4.3.0`.
