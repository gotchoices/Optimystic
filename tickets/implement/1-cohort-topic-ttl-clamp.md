description: Clamp the TTL a register request can ask for so no record can outlive the intended soft-state window, keeping the per-cohort topic budget reclaimable.
prereq:
files:
  - packages/db-core/src/cohort-topic/registration/types.ts          # add MIN_TTL_MS / MAX_TTL_MS constants
  - packages/db-core/src/cohort-topic/member-engine.ts               # accept() — apply clamp at admission
  - packages/db-core/test/cohort-topic/member-engine.spec.ts         # add TTL-clamp test cases (or nearest test file)
difficulty: easy
----

## Background

`accept()` in `member-engine.ts` computes:

```ts
const ttl = reg.ttl > 0 ? reg.ttl : DEFAULT_TTL_MS;
```

There is no upper bound. A `RegisterV1` carrying `ttl: 1e15` produces a record with a 31-year
lifetime. That record keeps `directParticipants(topic) > 0`, which prevents `LruTopicBudget` from
ever evicting it as a "cold zero-participant" victim, so it permanently consumes a slot in
`topics_max`. A handful of such registers (one per distinct `topicId`) wedge the budget while serving
nothing.

The wire validator (`wire/validate.ts`) accepts `ttl` as any finite number via `reqFiniteNumber` — no
range check.

The TTL is also carried verbatim in `GossipRecordV1.ttl` (validated the same way), so the poisoned
value replicates cohort-wide through gossip.

## Fix: clamp at admission

Add two new constants to `packages/db-core/src/cohort-topic/registration/types.ts`:

```ts
/** Minimum accepted registration TTL (ms). Requests below this are clamped up. */
export const MIN_TTL_MS = 10_000;                      // 10 s

/** Maximum accepted registration TTL (ms). Requests above this are clamped down.
 *  10 × DEFAULT_TTL_MS keeps the window predictable and forces records to expire
 *  within a sane horizon (15 min) even if a participant never pings again. */
export const MAX_TTL_MS = 10 * DEFAULT_TTL_MS;         // 900_000 ms = 15 min
```

In `accept()` (`member-engine.ts`), replace the current single-sided guard with a clamped range:

```ts
// Before:
const ttl = reg.ttl > 0 ? reg.ttl : DEFAULT_TTL_MS;

// After:
const ttl = Math.min(Math.max(reg.ttl > 0 ? reg.ttl : DEFAULT_TTL_MS, MIN_TTL_MS), MAX_TTL_MS);
```

Import `MIN_TTL_MS` and `MAX_TTL_MS` alongside the existing `DEFAULT_TTL_MS` import.

The wire validator does **not** need to change: clamping at admission is sufficient and lets the wire
layer remain a pure structural decoder. Out-of-range values are not malformed — they are simply
adjusted at the policy boundary.

## What NOT to change

- `GossipRecordV1.ttl` validation in `wire/validate.ts` — gossip records reflect what was actually
  admitted (already clamped), not what was requested.
- `EDGE_TTL_MS` — unchanged; it is a separate constant for edge-tier defaults, not a cap.
- Any existing test that uses valid in-range TTL values.

## TODO

- Add `MIN_TTL_MS` and `MAX_TTL_MS` constants to `registration/types.ts`
- Update `accept()` in `member-engine.ts` to clamp `ttl` into `[MIN_TTL_MS, MAX_TTL_MS]`
- Import the new constants in `member-engine.ts`
- Add unit tests covering:
  - `ttl: 1e15` → clamped to `MAX_TTL_MS`
  - `ttl: 1` (too small, > 0) → clamped to `MIN_TTL_MS`
  - `ttl: 0` (falls to default) → `DEFAULT_TTL_MS`, still within range
  - `ttl: DEFAULT_TTL_MS` → unchanged (in-range passthrough)
