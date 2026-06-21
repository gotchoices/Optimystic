description: Review the fix that terminates a read-only probe promptly when its promoted-but-unsharded child is cold, preventing a walk-layer livelock.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts (probeFollowedPromoted flag, lines ~154-230)
  - packages/db-core/test/cohort-topic/walk.spec.ts (2 new tests + 13 regression tests)
  - docs/cohort-topic.md (§Lookup probe callout updated, lines ~178-191)
difficulty: easy
----

## Summary

The probe-promoted livelock bug (`cohort-topic-probe-promoted-livelock`) is fixed and all tests pass.

### What was done

**`walk.ts`** — three small changes, all gated on `probe`:

1. Added `let probeFollowedPromoted = false;` in walk state initialisation (~line 158).
2. In the `promoted` case: set `probeFollowedPromoted = true` when `probe` is true (before the `followPromoted` early-return, so the flag is always set even for `followPromoted: false` callers — harmless there since the walk exits immediately anyway).
3. In the `no_state` case: added an early-out **before** the inward step — `if (probe && probeFollowedPromoted) return { kind: "retry_later", ... }`. The register path is completely untouched.

**`walk.spec.ts`** — two new tests added after the existing suite:

- `probe: livelock bound — promoted-but-cold child resolves to retry_later in ≤ d_max+3 RPCs`: uses `SingleCohortRouter` with `d_max=4`; asserts `outcome.kind === 'retry_later'` and `probes.length ≤ d_max+3` (actual: 6). Without the fix this would be 36 (maxSteps).
- `probe: happy path — probe accepted after following a Promoted redirect to a live child`: `ScriptedRouter` with `[noState, noState, Promoted(1), accepted]`; asserts `outcome.kind === 'accepted'` and correct tier sequence `[2,1,0,1]`. Guards against over-eager short-circuiting.

All 13 existing tests remain green. `yarn build` (tsc) clean.

**`docs/cohort-topic.md`** — expanded the `Read-only lookup (probe: true)` callout to document both probe divergences from a register: (1) root `NoState` backs off instead of bootstrap re-issue; (2) promoted-but-cold child also backs off immediately, with the deferred "ancestor hint" alternative noted.

### Known gaps / reviewer focus areas

- `probeFollowedPromoted` is reset to `false` on each `register()` call (it's a local variable), so a caller that reuses the same engine across multiple lookups is safe.
- The `followPromoted: false` path: the flag is set before the early return, which is correct — the walk exits with `PromotedWalkOutcome` and the caller drives from there; the flag is never read again.
- The fix does not affect `maxSteps` for non-probe walks; the `single tier-0 cohort, promoted but childless` register test still asserts the valve fires at exactly `maxSteps`.
- Multi-tier promotion end-to-end is still behind `followOn: false` in `packages/db-p2p/src/cohort-topic/host.ts:797` — this fix is unit-level only, as stated in the ticket.

## Review findings

_(to be filled in by reviewer)_
