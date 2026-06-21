description: A read-only topic lookup of a busy-but-still-growing topic can bounce between two nodes dozens of times before giving up; make it give up promptly instead.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts (RouterWalkEngine.register: probe + promoted/no_state handling)
  - packages/db-core/test/cohort-topic/walk.spec.ts (walk unit tests, ScriptedRouter / SingleCohortRouter)
  - packages/db-core/src/cohort-topic/service.ts (lookup → CohortBackoffError mapping; no change expected)
  - docs/cohort-topic.md (§Lookup, lines ~145-200)
difficulty: easy
----

# Implement: terminate read-only probe promptly when its promoted-but-unsharded child is cold

## Confirmed reproduction

The bug is real and reproducible at the walk layer today (no production multi-tier wiring required).
A `ScriptedRouter`-style router that answers `Promoted(targetTier: 1)` whenever `reg.treeTier === 0`
and `no_state` otherwise, driven by `engine.register(TOPIC, 1, undefined, { probe: true })` with
`d_max = 4`, returned **`retry_later` after exactly 36 router RPCs**
(`maxSteps = 2*(d_max+2)+maxMemberRetries+8 = 2*6+16+8 = 36`) — confirmed by a throwaway spec run
during the fix stage. The cost scales ~`2*(d_max+2)+wantK` per lookup and every other hop re-hits the
**root** cohort (the tree's hottest contention point): an amplification / DoS vector, not just latency.

## Root cause (verified against current `walk.ts`)

`RouterWalkEngine.register` (`packages/db-core/src/cohort-topic/walk.ts:149-239`) routes a probe and a
register identically. The divergence is only at the terminal cohort:

- **Register:** the cohort *host* instantiates a tier-`N` forwarder on a follow-on redirect
  (`shouldInstantiate` / `followOn`), so the walk terminates by acceptance.
- **Probe:** `handleProbe` (member-engine.ts) **never instantiates** by design (a read is read-only).
  So the promoted-but-unsharded child answers `no_state` forever; the `no_state` branch
  (`walk.ts:181-205`) steps inward (`d = d - 1`) back to the promoting root, which re-answers
  `Promoted(targetTier)` (`walk.ts:206-216`) — the one outward move — sending the walk straight back
  to the cold child. `coord_0` is participant-independent, so the inward step always re-hits the *same*
  promoting ancestor; there is no sibling escape. The loop runs until `maxSteps` trips → `retry_later`.

The existing `single tier-0 cohort, promoted but childless` test (walk.spec.ts:314-332) already
exercises this oscillation for the **register** path and asserts the `maxSteps` valve bounds it; this
ticket adds the **probe**-specific early-out so a lookup does not need the valve at all.

## Reachability

In the current single-tier-0 milestone the production host hardcodes `followOn: false`
(`packages/db-p2p/src/cohort-topic/host.ts:797`), so end-to-end multi-tier promotion is not yet wired
and the loop is not hit in production today. The defect nonetheless lives in `walk.ts`, is reproducible
at unit level now, and becomes a live amplification vector the moment multi-tier promotion lands. The
sibling ticket `cohort-topic-followon-derivation` fixes the *register* path (instantiate-on-redirect);
it does **not** fix the probe, which by definition never instantiates and therefore needs its own
termination rule. This ticket is independent of that one.

## Chosen contract (design question resolved)

**A probe that follows a `Promoted` redirect and then receives `no_state` resolves to `retry_later`
→ `CohortBackoffError`.** This is the deliberate choice, not a fall-out of the loop:

- `service.ts:219-228` already maps a non-accepted probe outcome to `CohortBackoffError(afterMs)`, so
  `retry_later` is the contract the lookup layer already expects — no service-layer change needed.
- The "resolve the nearest served ancestor instead" alternative is **rejected for now**: a `Promoted`
  reply carries only `targetTier`, not the promoting cohort's `primary`/`backups`/`cohortEpoch`
  (`RegisterReplyV1`), so the walk has no served snapshot to hand back without a wire/protocol change
  (the promoting cohort would have to additionally report its own participants on the `Promoted`
  reply). That is a separate feature, out of scope here. If a future product need arises for "give the
  reader a live ancestor cohort to talk to while its shard spins up," file a new backlog ticket to
  extend the `Promoted` reply — do not bolt it on here.

Semantics: `CohortBackoffError` for a demonstrably-live topic means "the child cohort responsible for
*your* prefix-shard is not instantiated yet — back off and retry; a register will instantiate it." The
caller's existing back-off-and-restart-at-`d_max` loop then resolves once the shard exists.

## Fix

In `RouterWalkEngine.register`, track whether a **probe** has already followed at least one `Promoted`
redirect, and short-circuit a subsequent `no_state` to `retry_later`. Equivalently: a probe must never
step inward *past* a tier it was promoted to.

- Add a local flag, e.g. `let probeFollowedPromoted = false;` near the other walk state
  (`walk.ts:154-158`).
- In the `promoted` case (`walk.ts:206-216`), set `probeFollowedPromoted = true` when `probe` is true
  (set it regardless of `followPromoted`; for `followPromoted: false` the walk returns immediately
  anyway, so it is harmless).
- In the `no_state` case (`walk.ts:181-205`), **before** stepping inward, add:
  `if (probe && probeFollowedPromoted) { return { kind: "retry_later", afterMs: backoffRetryMs(0) }; }`.

Leave the register path completely untouched — the flag is gated on `probe`. Do not change the
existing root-`no_state` probe back-off (`walk.ts:192-196`) or the bootstrap re-issue.

Post-fix RPC trace for the repro (`d_max = 4`): inward `4→3→2→1→0` (5 `no_state` RPCs), root
`Promoted(1)` → go to tier 1 (RPC 6, flag set), tier 1 `no_state` → immediate `retry_later`.
**6 RPCs**, well within the `≤ d_max + 3` bound the acceptance asks for.

## Tests

Add to `packages/db-core/test/cohort-topic/walk.spec.ts`:

- **New probe-livelock repro / bound test.** A router answering `Promoted(targetTier: 1)` for
  `treeTier === 0` and `no_state` otherwise (a `ScriptedRouter`-style cyclic router, or reuse/extend
  `SingleCohortRouter` with a non-zero `d_max`), driven with `{ probe: true }` and `d_max = 4`. Assert
  `outcome.kind === 'retry_later'` AND `router.probes.length <= d_max + 3` (expect 6). Without the fix
  this is 36; the test must fail pre-fix and pass post-fix.
- **Probe still resolves a normal multi-tier lookup.** A probe that walks inward through `no_state`,
  follows one `Promoted` outward, and gets `accepted` at the target tier still returns `accepted`
  (the flag must not break the happy path — guard against over-eager short-circuiting).

Verify unchanged (must stay green):

- `re-issues at the root with bootstrap:true after the root returns NoState` (register path).
- `the non-probe walk still re-issues bootstrap:true at the root` (probe flag does not touch register).
- `single tier-0 cohort, promoted but childless` (register oscillation still bounded by `maxSteps`).
- `a probe of a cold topic backs off at the root and NEVER emits a bootstrap:true frame` (probe that
  *never* followed a Promoted still walks inward to the root then backs off — the new flag must not
  fire here, since `probeFollowedPromoted` stays false).

## Docs

Update `docs/cohort-topic.md` §Lookup (the `Read-only lookup (probe: true)` callout, ~lines 178-184)
to state the new termination rule: a probe that follows a `Promoted` redirect and then hits `no_state`
backs off (`CohortBackoffError`) immediately rather than walking inward to the promoting ancestor —
"the responsible child shard is not instantiated yet; a probe never instantiates it." Note the
contract is `CohortBackoffError`, with the nearest-ancestor-hint alternative explicitly deferred.

## Validation

Run from `packages/db-core`:

```
yarn test 2>&1 | tee /tmp/db-core-walk.log
```

(or the focused `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/walk.spec.ts" --reporter spec` during iteration). Also run `yarn build` (tsc) to confirm types.

## TODO

- [ ] Add `probeFollowedPromoted` flag + set it in the `promoted` case when `probe` (walk.ts).
- [ ] Short-circuit `no_state → retry_later` when `probe && probeFollowedPromoted` (walk.ts, before the inward step).
- [ ] Add the probe-livelock bound test (`retry_later`, `probes.length <= d_max + 3`) to walk.spec.ts.
- [ ] Add the probe happy-path multi-tier `accepted` test to walk.spec.ts.
- [ ] Confirm the four listed regression tests still pass.
- [ ] Update docs/cohort-topic.md §Lookup probe callout with the termination rule + chosen contract.
- [ ] `yarn build` + `yarn test` green in packages/db-core (stream with `tee`).
