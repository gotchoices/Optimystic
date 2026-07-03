description: The anti-replay memory that stops captured registrations from being resent has no size limit and fills up before the rate limiter can throttle the sender, so an attacker can grow that memory at full attack speed. Add a hard size cap and stop recording entries for frames the rate limiter is already rejecting.
prereq:
files:
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts        # add maxKeys LRU cap
  - packages/db-core/src/cohort-topic/member-engine.ts               # runGuards: rate-check before replay-record
  - packages/db-core/test/cohort-topic/antidos.spec.ts               # replay-guard cap tests
  - packages/db-core/test/cohort-topic/member-engine.spec.ts         # reorder: rate-rejected frame leaves no seen entry
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts        # reference: existing maxKeys pattern
  - packages/db-p2p/src/cohort-topic/host.ts                         # doc line ~34; replayGuard config passthrough ~1879
  - docs/cohort-topic.md                                             # §Anti-DoS, keep in sync
difficulty: medium
----

# Cap the replay guard and stop pre-rate-limit growth

## Background (for a reader without context)

A cohort member receives `RegisterV1` frames. Each frame carries a random 16-byte
`correlationId`. The **replay guard** (`CorrelationReplayGuard`, `replay-guard.ts`) remembers every
accepted `correlationId` for one freshness window (default 60 s) so a captured-and-resent frame is
caught. A separate **rate limiter** (`RegisterRateLimiter`, `rate-limiter.ts`) throttles how many
frames a given `(participant, topic)` pair may send per minute.

Both live in the per-coord anti-DoS pipeline `runGuards` (`member-engine.ts:372-398`), which today runs
in this order:

1. `verifyRegisterSig` — forged participant signature → `no_state`
2. `replayGuard.accept` — stale / future / replayed → `no_state` **(records the correlationId here)**
3. `bootstrapEvidence.verify` — missing bootstrap proof → `unwilling_cohort`
4. `rateLimiter.check` — over-rate → `unwilling_cohort`

## The two defects

**Defect 1 — the replay guard's memory is unbounded.** `WindowedReplayGuard.seen`
(`replay-guard.ts:51`) is a plain `Map` pruned only by age (`maybePrune`, line 91). The sibling rate
limiter was given a hard LRU `maxKeys` cap in completed ticket `1-cohort-topic-rate-limiter-eviction`;
the replay guard never got one. Under sustained load `seen` grows to a full window's worth of
registrations with no ceiling.

**Defect 2 — the correlationId is recorded before the rate limiter runs.** Because step 2 precedes
step 4, every spam frame with a fresh random `correlationId` inserts a `seen` entry **even when step 4
would have rejected it**. The rate limiter never gets to stop the memory growth.

Together: an attacker spraying fresh-`correlationId` frames drives replay-guard memory up at full attack
speed regardless of the rate limit.

Note: `cohort-topic-rate-limiter-eviction` and `cohort-topic-promote-gate-map-eviction` capped the
*rate limiter* and the *promote gate*; neither touched this per-coord replay guard.

## Fix (do both — defense in depth, mirroring the rate limiter which has both a cap and admit-before-record)

### A. Hard LRU cap on the replay guard

Mirror `SlidingWindowRateLimiter`'s `maxKeys` (`rate-limiter.ts:52-53, 126-129, 141-152`):

- Add `maxKeys?: number` to `CorrelationReplayGuardConfig` and a
  `DEFAULT_REPLAY_GUARD_MAX_KEYS = 100_000` export (match the rate limiter's default).
- Validate in the constructor: positive integer, else `RangeError` (copy the rate-limiter check).
- In `accept`, when inserting a **new** key (line 86), first evict the oldest entries until
  `seen.size < maxKeys`:
  ```ts
  while (this.seen.size >= this.maxKeys) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
  }
  ```
- Add a `size` getter to the `CorrelationReplayGuard` interface + impl (mirror
  `RegisterRateLimiter.size`, `rate-limiter.ts:94-95, 202-204`) for test/diagnostic introspection.

**Why evicting the oldest is the least-bad victim (document this in the class doc comment).** Replay
entries are inserted once and never refreshed, so `Map` insertion order tracks timestamp order: the
oldest entry is the one nearest to aging out of the window and being pruned as stale anyway. Evicting
it forgives at most the entry's remaining replay-protection window — a bounded tradeoff, and one that
only triggers under a flood of *genuinely fresh, admitted* correlationIds (which, post-reorder, must
also pass the rate limiter and bootstrap gate). Contrast the rate limiter, whose eviction is fully
penalty-free; the replay guard's is a small, bounded, documented tradeoff, not an identity.

### B. Reorder `runGuards` so the rate limiter admits before the replay guard records

New order (`member-engine.ts:runGuards`):

1. `verifyRegisterSig` — forged → `no_state` (unchanged; cheap, stateless, must stay first)
2. `rateLimiter.check` — over-rate → `unwilling_cohort` **(moved up)**
3. `bootstrapEvidence.verify` — missing → `unwilling_cohort`
4. `replayGuard.accept` — stale / replay → `no_state` **(records last)**

Now only frames that pass signature + rate + bootstrap ever insert a `seen` entry. A rate-limited-away
frame leaves no `seen` entry. Bonus: running the cheap rate check before the potentially-expensive
`bootstrapEvidence.verify` (which may do PoW verification) short-circuits floods sooner.

**Correctness — the reorder does NOT open a replay window for accepted frames.** `replayGuard.accept`
still runs on every frame that reaches step 4, and an *accepted* frame is always recorded there. So a
genuine replay of an already-accepted correlationId is still caught. The only frames that now skip
recording are ones the rate limiter rejected — which are never served and never had state recorded, so
skipping them is correct. (A frame rate-limited away and later re-sent when the source is back under
rate is admitted as first-sight — but that is the first *successful* admission of that id, not a replay
of a served frame.)

Minor behavior change: a frame that is *both* over-rate and missing-bootstrap now returns the rate
limiter's `retryAfterMs` instead of the bootstrap gate's — both are `unwilling_cohort` with a back-off,
same class of response. Acceptable.

## Interfaces after the change

```ts
// replay-guard.ts
export const DEFAULT_REPLAY_GUARD_MAX_KEYS = 100_000;

export interface CorrelationReplayGuardConfig {
    maxAgeMs?: number;
    maxFutureSkewMs?: number;
    maxKeys?: number; // NEW — hard LRU cap; least-recently-inserted (oldest-timestamp) evicted beyond this
}

export interface CorrelationReplayGuard {
    accept(correlationId: Uint8Array, peerId: Uint8Array, timestamp: number, now: number): boolean;
    readonly size: number; // NEW — tracked-id count, test/diagnostic
}
```

## Verification

Run from `packages/db-core`:

```
yarn test 2>&1 | tee /tmp/db-core-test.log
```

(stream with `tee` — never silent-redirect; the suite is Mocha over the `test/**/*.spec.ts` above.)
If the package has a typecheck script (`yarn build` / `tsc`), run it too and stream it.

## TODO

- `replay-guard.ts`: add `DEFAULT_REPLAY_GUARD_MAX_KEYS`, `maxKeys` config field + constructor
  validation, LRU-evict-oldest on new-key insert in `accept`, and a `size` getter. Update the file's
  doc comment to explain the cap and the oldest-is-least-bad-victim tradeoff.
- `member-engine.ts`: reorder `runGuards` to `sig → rate → bootstrap → replay`. Update the inline
  comments (lines 380-392) so they describe the new order and note that the replay record now happens
  only after rate admission.
- `antidos.spec.ts`: in the `correlation-id replay guard` block, add:
  - exposes `DEFAULT_REPLAY_GUARD_MAX_KEYS === 100_000`.
  - caps at `maxKeys`: with `{ maxKeys: 3 }` insert 4 fresh ids (all inside one window); `size` holds
    at 3, and a replay of the **oldest** (evicted) id is now admitted as fresh while a replay of a
    surviving id is still rejected — proving the cap and its documented reopened-window tradeoff.
  - rejects invalid `maxKeys` (0, 2.5, -1) at construction (mirror the rate-limiter test at
    `antidos.spec.ts:168-174`).
- `member-engine.spec.ts`: add a test that a rate-rejected register leaves **no** replay-guard entry —
  inject both a `rateLimiter` (tight `ratePerWindow`) and a `replayGuard`, drive the source over-rate,
  and assert the reply is `unwilling_cohort` **and** `replayGuard.size` did not grow for the rejected
  frames (contrast an admitted frame that does record). Reuse the `mkReg` / cold-cohort harness at
  `member-engine.spec.ts:547-611`.
- `host.ts`: the `CorrelationReplayGuardConfig` passthrough at line 1879 already forwards any new field;
  update the doc line ~34 ("a `CorrelationReplayGuard` (60 s freshness)") to mention the key cap.
- `docs/cohort-topic.md` §Anti-DoS: note the replay guard now carries a hard `maxKeys` cap (like the
  rate limiter) and that the register pipeline rate-checks before recording a correlationId.
