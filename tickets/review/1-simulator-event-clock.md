description: Review the discrete-event virtual-clock engine (EventScheduler + SeededRng + LatencyModel + SimWorldCore) that founds the design simulator. New self-contained package `packages/substrate-simulator`; engine only, no domain behaviour.
prereq:
files:
  - packages/substrate-simulator/src/types.ts
  - packages/substrate-simulator/src/rng.ts
  - packages/substrate-simulator/src/heap.ts
  - packages/substrate-simulator/src/scheduler.ts
  - packages/substrate-simulator/src/latency.ts
  - packages/substrate-simulator/src/peer.ts
  - packages/substrate-simulator/src/world.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/README.md
  - packages/substrate-simulator/test/*.spec.ts
  - packages/substrate-simulator/package.json
  - packages/substrate-simulator/tsconfig.json
  - packages/substrate-simulator/register.mjs
  - package.json (root: build/test/clean aggregate scripts)
----

# Review: discrete-event virtual-clock engine

The implement stage built the **engine only** for the design simulator, in a new mock-only,
dependency-free package `packages/substrate-simulator`. It mirrors `db-p2p`'s scripts
(`build: tsc`; `node --import ./register.mjs … mocha` test), ESM, tabs, no `any`.
`yarn build` and `yarn test` are green (48 passing, ~0.7 s including both 1M tests).

The four engine-shaping decisions plus the two scoping decisions from the plan are
**resolved in the ticket** and were built to as written — they are not open for re-litigation
here. They are recorded in `README.md` and in source comments next to the implementing code.

## What was built (map for the reviewer)

- **`src/types.ts`** — the pinned contracts verbatim from the ticket: `VTime`, `PeerRef`,
  `EventRun`/`BatchRun`, `EventScheduler`, `EventContext`, `SeededRng`, `LatencyModel`,
  `SimConfig`, `SimWorldCore`.
- **`src/rng.ts`** — `Mulberry32Rng` (mulberry32, 32-bit state) + `createRng`. `fork(label)`
  derives a sub-stream from FNV-1a `hash(constructionSeed ‖ label)` — keyed on the
  *construction* seed, never live state, so forks are independent of parent draw interleaving.
- **`src/heap.ts`** — binary min-heap keyed on `(at, seq)`, O(log n) push/pop. `HeapEntry`
  carries `isBatch`/`count` to discriminate single events from batches.
- **`src/scheduler.ts`** — `VirtualScheduler` implementing the run semantics: `(at, seq)`
  ordering, never-reset `seq`, `run(until)` boundary (event at `until` fires; `now()` not
  fabricated forward), `scheduleBatch` (one heap slot, ascending index, atomic at `at`),
  past-time/negative/non-integer rejection, and an optional `maxEvents` backstop for unbounded
  same-time reschedule loops.
- **`src/latency.ts`** — `DeterministicLatency` (default), `StochasticLatency` (log-normal via
  Box–Muller on `ctx.rng`, rounded + floored to `minMs`), `AdversarialLatency` (fixed `worstMs`
  or custom strategy). `DEFAULT_GOSSIP_ROUND_MS = 200`, `DEFAULT_HOP_MS = 50`.
- **`src/peer.ts`** — `generatePeers(count, rng)`: deterministic synthetic `PeerRef`s with
  256-bit keys. No real libp2p identity; no ring/distance math (that is ticket 2).
- **`src/world.ts`** — `createSimWorld(config, latency?, schedulerOptions?)` wiring the core
  four fields; latency defaults to `DeterministicLatency(DEFAULT_HOP_MS)`.

## How to validate

```
yarn install            # from repo root (already done; deps are db-p2p's devDeps)
cd packages/substrate-simulator
yarn build              # tsc, must be clean
yarn test               # mocha+chai; 48 passing incl. two 1M-scale tests
```

## Test coverage (the floor, not the finish line)

Every *Key test* from the ticket is present:

- `rng.spec.ts` — seed determinism, `[0,1)`/`nextInt` ranges, `fork` independence of parent
  interleaving, fork-of-fork, distinct labels.
- `scheduler.spec.ts` — non-decreasing `at`; `now()` tracks firing event; equal-`at` seq order;
  event-at-`now()`-during-fire lands after the cohort; `scheduleAfter == scheduleAt(now+delay)`;
  past-time/negative/non-integer throws; `run(until)` boundary (incl. `now()` not fabricated,
  second `run(until)` returns 0); empty-queue termination; `maxEvents` backstop; batch ascending
  index + atomicity + one-slot + batch-before-later-seq-single.
- `latency.spec.ts` — fixed delay; stochastic floor binds + integer + never negative; stochastic
  determinism per seed + varies by seed; adversarial fixed + custom strategy; model-swap changes
  only times.
- `determinism.spec.ts` — byte-identical traces for same `(seed, config)`; seed change alters
  values but not the equal-time ordering rule; equal-`at` order identical across runs.
- `world.spec.ts` — factory wiring; default latency; open config index; `generatePeers`
  determinism + 256-bit keys + distinct ids.
- `scale.spec.ts` — 1M discrete events drain (logical count, monotonic `now()`, spies prove no
  `Math.random`/`Date.now`/`setTimeout`); 1M `scheduleBatch` from a single heap slot.
- `no-real-time.spec.ts` — source scan of `src/` rejects `Math.random`/`Date.now`/`new Date`/
  `setTimeout`/`setInterval`/`await`/`Promise`.

## Known gaps / things for the reviewer to probe

- **`maxEvents` counts heap pops, not logical events.** A 1M batch is one pop, so the backstop
  does not bound per-batch work — by design (the backstop targets reschedule loops). Confirm
  this matches intent; the README documents it.
- **`StochasticLatency` floor-binds rarely at low sigma.** The floor-binding assertion uses
  `sigma: 1.5` over 20k draws to make the clamp actually trigger. At realistic small sigma the
  floor may never bind in a short run — not a bug, but worth noting for downstream scenarios
  that rely on a tight RTT spread.
- **No explicit overflow test near 2^53.** `seq`/`VTime` bounds are documented and argued safe
  (multi-day horizon ~10^8 ms; 1M+ events « 2^53) but not asserted at the boundary. Low risk;
  flagged for completeness.
- **`fork` uses FNV-1a + UTF-16 code units** for the label hash — adequate for stream
  separation, not a cryptographic guarantee of non-collision across adversarially-chosen
  labels. Acceptable for a mock simulator; reviewer may want a sanity check that the labels
  ticket 2 actually uses don't collide.
- **Root aggregate scripts** (`build`/`test`/`clean`) had the new package appended; the
  workspace glob already covered it for `yarn install`. The full monorepo `yarn test` was **not**
  run during implement (long-running, unrelated packages) — only the package's own suite.

## Adversarial angles worth a reviewer's time

- Try to break determinism: reorder insertions of equal-`at` events and confirm the trace is
  unchanged for a fixed seed; swap `Deterministic`↔`Stochastic` and confirm only times move.
- Stress `run(until)` with events exactly at the boundary and a batch straddling `until`
  (a batch's single `at` is wholly before/after `until` — confirm no partial batch fires).
- Confirm `scheduleBatch` events that schedule further events interleave at the correct `seq`.
- Verify nothing in the engine assumes a domain shape (the cross-subsystem seam check in the
  ticket): events push events, `now()`/`pending()` exposed, `seq` global.
