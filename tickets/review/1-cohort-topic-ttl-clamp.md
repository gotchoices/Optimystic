description: Review TTL clamp at admission in the cohort-topic member engine — ensures no registration record can carry an unbounded lifetime that wedges the per-cohort topic budget.
prereq:
files:
  - packages/db-core/src/cohort-topic/registration/types.ts
  - packages/db-core/src/cohort-topic/member-engine.ts
  - packages/db-core/test/cohort-topic/member-engine.spec.ts
difficulty: easy
----

## What was built

Three targeted changes; no other files touched.

### 1. New constants (`registration/types.ts`)

```ts
export const MIN_TTL_MS = 10_000;           // 10 s
export const MAX_TTL_MS = 10 * DEFAULT_TTL_MS;  // 900 000 ms = 15 min
```

Added immediately after the existing `EDGE_TTL_MS` constant.

### 2. Clamp in `accept()` (`member-engine.ts`)

```ts
// Before:
const ttl = reg.ttl > 0 ? reg.ttl : DEFAULT_TTL_MS;

// After:
const ttl = Math.min(Math.max(reg.ttl > 0 ? reg.ttl : DEFAULT_TTL_MS, MIN_TTL_MS), MAX_TTL_MS);
```

Import line updated to pull in `MIN_TTL_MS` and `MAX_TTL_MS` alongside the existing `DEFAULT_TTL_MS`.

### 3. New test suite (`member-engine.spec.ts`)

`describe('cohort-topic / member-engine: TTL clamping in accept()')` — four cases:

| `reg.ttl` supplied | expected `record.ttl` |
|---|---|
| `1e15` (far above `MAX_TTL_MS`) | `MAX_TTL_MS` |
| `1` (positive, below `MIN_TTL_MS`) | `MIN_TTL_MS` |
| `0` (falls to default) | `DEFAULT_TTL_MS` |
| `DEFAULT_TTL_MS` (in range) | `DEFAULT_TTL_MS` (unchanged) |

Each case drives `handleRegister` through a real engine that always accepts, observes the admitted record via `onAdmit`, and asserts `record.ttl`.

## Test results

All 1 066 tests pass (`yarn workspace @optimystic/db-core test`).

## Scope not changed (as specified)

- `GossipRecordV1.ttl` validation in `wire/validate.ts` — untouched; gossip records reflect already-clamped values.
- `EDGE_TTL_MS` — untouched.
- Wire validator (`wire/validate.ts`) — untouched; `reqFiniteNumber` range check deliberately deferred to the policy boundary.

## Review findings

- No tripwires or latent defects identified; the change is a two-expression one-liner at a single policy boundary.
