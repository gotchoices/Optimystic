description: Review the hardening that caps the anti-replay memory and stops it from filling before the rate limiter can throttle a spammer.
prereq:
files:
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts        # maxKeys LRU cap + size getter
  - packages/db-core/src/cohort-topic/member-engine.ts               # runGuards reorder (sig → rate → bootstrap → replay)
  - packages/db-core/test/cohort-topic/antidos.spec.ts               # replay-guard cap tests
  - packages/db-core/test/cohort-topic/member-engine.spec.ts         # rate-rejected frame leaves no seen entry
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts        # reference: existing maxKeys pattern
  - packages/db-p2p/src/cohort-topic/host.ts                         # doc line ~34
  - docs/cohort-topic.md                                             # §Anti-DoS
difficulty: medium
----

# Review: cap the replay guard and stop pre-rate-limit growth

## What the ticket asked for

Two defects in the cohort-topic anti-DoS pipeline let an attacker grow the correlation-id replay
guard's memory at full attack speed:

1. **Unbounded replay-guard memory** — `WindowedReplayGuard.seen` (`replay-guard.ts`) was a plain
   `Map` pruned only by age, with no hard size ceiling (the sibling rate limiter already had one).
2. **Record-before-rate-limit ordering** — `runGuards` recorded a frame's `correlationId` in the
   replay guard *before* the rate limiter ran, so every fresh-id spam frame inserted a `seen` entry
   even when the rate limiter would have rejected it.

Fix = defense in depth, mirroring the rate limiter (which has both a cap and admit-before-record):
add a hard LRU `maxKeys` cap to the replay guard **and** reorder `runGuards` so the rate limiter
admits before the replay guard records.

## What was implemented

**A. Hard LRU cap on the replay guard** (`replay-guard.ts`):
- New export `DEFAULT_REPLAY_GUARD_MAX_KEYS = 100_000` (matches the rate limiter's default).
- New `maxKeys?: number` on `CorrelationReplayGuardConfig`; constructor validates positive-integer
  (`RangeError` otherwise) — copied from the rate limiter's check.
- In `accept`, on a **new**-key insert, evict the oldest-inserted entries until `seen.size < maxKeys`
  (the same `while (size >= maxKeys) { delete keys().next().value }` shape as the rate limiter).
- New `size` getter on the `CorrelationReplayGuard` interface + impl (test/diagnostic introspection).
- Class doc comment updated to explain the cap and *why evicting the oldest is the least-bad victim*:
  replay entries are inserted once and never refreshed, so `Map` insertion order == timestamp order,
  and the oldest entry is the one nearest to aging out as stale anyway. Evicting it forgives at most
  that entry's remaining replay-protection window — a bounded, documented tradeoff (contrast the rate
  limiter's fully penalty-free eviction).

**B. Reorder `runGuards`** (`member-engine.ts:runGuards`) from `sig → replay → bootstrap → rate` to
`sig → rate → bootstrap → replay`. Now only frames that pass signature + rate + bootstrap ever insert
a `seen` entry; a rate-rejected frame records nothing. Inline comments rewritten to describe the new
order and the security rationale.

**C. Docs + host doc line**: `docs/cohort-topic.md` §Anti-DoS (both the bullet and the implementation
block) now note the `maxKeys` cap and the rate-check-before-record ordering; `host.ts` line ~34 doc
comment mentions the cap. The existing `host.ts:1879` config passthrough already forwards any new
`CorrelationReplayGuardConfig` field, so no code change was needed there.

## How to validate

Run from `packages/db-core`:

```
yarn build          # tsc — clean, no errors
yarn test           # mocha over test/**/*.spec.ts
```

Result at implement time: **build clean, 1087 passing, 0 failing** (~8s).

### Tests added (the floor, not the ceiling — see gaps below)

`antidos.spec.ts` → `correlation-id replay guard` block:
- `DEFAULT_REPLAY_GUARD_MAX_KEYS === 100_000`.
- **cap + reopened-window tradeoff**: `{ maxKeys: 3 }`, insert 4 fresh ids in one window → `size`
  holds at 3; a replay of a **surviving** id is still rejected, while a replay of the **evicted**
  (oldest) id is admitted as fresh — directly exercises the documented tradeoff.
- rejects invalid `maxKeys` (0, 2.5, -1) at construction.

`member-engine.spec.ts` → sweepStale/cold-cohort harness block:
- **rate-rejected frame leaves no replay entry**: inject a real `rateLimiter({ ratePerWindow: 1 })`
  and a real `replayGuard`; first frame is admitted (rate ok) and records → `replayGuard.size === 1`;
  two further fresh-correlationId frames in the same window are shed by the rate limiter
  (`unwilling_cohort` + `retryAfterMs`) and leave `replayGuard.size` unchanged at 1. Fresh cids are
  used deliberately: under the old order those frames would have grown `size` to 3.

## Reviewer focus / known gaps

- **Behavior change to confirm acceptable** (ticket flagged it, restating for the reviewer): a frame
  that is *both* over-rate and missing-bootstrap now returns the **rate limiter's** `retryAfterMs`
  instead of the bootstrap gate's. Both are `unwilling_cohort` with a back-off — same response class —
  but if any downstream consumer distinguishes the two back-off values, verify that's still fine.
- **Cap eviction is not unit-tested at the 100k default**, only at `maxKeys: 3`. The eviction loop is
  size-independent, but there is no test that the *default* guard actually bounds under a large flood.
  Left as a floor; a property/stress test could raise it.
- **No end-to-end test through the db-p2p host** that the `maxKeys` config passthrough
  (`host.ts:1879`) actually reaches a live per-coord replay guard. Relied on the existing untyped
  spread passthrough + the db-core unit coverage. Worth a glance that `ctx.antiDos.replayGuard` can
  carry `maxKeys` (it's an untyped `CorrelationReplayGuardConfig`, so it does).
- **Correctness argument to sanity-check** (from the ticket, verified by the new member-engine test
  but worth a second read): the reorder does *not* open a replay window for *accepted* frames —
  `replayGuard.accept` still runs on every frame that reaches step 4, and an accepted frame is always
  recorded there, so a genuine replay of an already-served correlationId is still caught. Only
  rate-rejected frames (never served, never recorded) skip recording, which is correct.
- **Pre-existing IDE-only diagnostics** (not introduced here, do not block): the language server
  reports `Cannot find name 'describe'/'it'` in the spec files and an unused `ctx` param at
  `member-engine.ts:318`. `yarn build` (the real tsconfig) compiles clean, so these are language-server
  noise, not tsc errors. No `.pre-existing-error.md` was written because the actual test/build run was
  fully green.

## No tripwires filed

The one conditional concern (default-cap stress coverage) is recorded above as a gap, not as a code
`NOTE:` — it's about test depth, not a live code site that misbehaves when a dormant path runs.
