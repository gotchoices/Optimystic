description: A read-only topic lookup could spin forever when the topic had been handed off to a child that wasn't running yet; it now gives up promptly and tells the caller to retry later.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts
  - packages/db-core/test/cohort-topic/walk.spec.ts
  - packages/db-core/src/cohort-topic/service.ts
  - docs/cohort-topic.md
difficulty: easy
----

## Summary

The probe-promoted livelock (`cohort-topic-probe-promoted-livelock`) is fixed and reviewed. A read-only
`service.lookup` probe that followed a `Promoted` redirect outward to a child shard which then answered
`NoState` (cold / not yet instantiated) used to oscillate inward→ancestor→re-redirect until the `maxSteps`
safety valve fired (36 RPCs in the repro). It now backs off immediately on the first post-redirect
`NoState`, returning `retry_later` (surfaced to the caller as `CohortBackoffError`).

### Implementation (unchanged from implement stage, reviewed and accepted)

`walk.ts` — three `probe`-gated changes in `RouterWalkEngine.register`:
1. `let probeFollowedPromoted = false;` in walk-state init.
2. `promoted` case: set the flag when `probe` is true (before the `followPromoted:false` early return).
3. `no_state` case: early-out `if (probe && probeFollowedPromoted) return retry_later` **before** the
   inward step. The register (non-probe) path is untouched.

`service.ts` `lookup()` already maps any non-`accepted` outcome (`retry_later`) to `CohortBackoffError`,
so the doc's stated behavior holds end-to-end.

## Review findings

**Diff reviewed:** `git show c87ae86` (walk.ts +10, walk.spec.ts +32, docs/cohort-topic.md ±10). Read with
fresh eyes before the handoff summary, then cross-checked against the handoff's claims.

### Correctness — verified, no issues
- **Fix logic is sound.** Tree semantics: after following a `Promoted(targetTier)` redirect outward, a
  `NoState` from the target is *definitionally* the cold-child case — the only inward neighbor is the
  ancestor that just issued the redirect, so walking back re-triggers `Promoted` and loops. Backing off is
  the correct (and only non-looping) resolution. Confirmed there is no well-formed-tree path where a
  post-redirect `NoState` should instead be walked inward to a different serving cohort.
- **Flag is never reset within a walk and never needs to be.** Once a probe follows a redirect, every
  subsequent `NoState` (including multi-level `Promoted`→`Promoted`→cold chains) is the same cold case.
  Reset-per-`register()`-call is automatic (local variable), so engine reuse across lookups is safe.
- **Register path untouched.** Guard is `probe && probeFollowedPromoted`; `register()` passes `probe:false`.
  The existing "single tier-0 cohort, promoted but childless" register test still asserts the valve fires
  at exactly `maxSteps`, confirming no regression.
- **`followPromoted:false` ordering.** Flag is set before the early `return {kind:"promoted"}`; the walk
  exits immediately and the flag is never read again — harmless, as the handoff states.
- **Defense in depth holds.** `member-engine.ts:155` branches probes before the admission pipeline, so even
  a hand-crafted `probe:true, bootstrap:true` frame can't instantiate; the walk never sets `bootstrap` on a
  probe. The two layers are consistent.
- **Doc accuracy.** `docs/cohort-topic.md §Read-only lookup` now documents both probe divergences from a
  register (root `NoState` backs off; promoted-but-cold child backs off), and correctly notes the deferred
  "ancestor hint" alternative requires a protocol extension (`Promoted` carries only `targetTier`). The
  `CohortBackoffError` mapping cited in the doc is verified at `service.ts:226`.
- **Scope claims accurate.** Multi-tier promotion end-to-end remains behind `followOn:false`
  (`packages/db-p2p/src/cohort-topic/host.ts:797`, parked in `cohort-topic-followon-derivation`); this fix
  is unit-level, as the ticket states. `service.ts:224` is the only production probe caller.

### Tests — adequate, verified green
- New `probe: livelock bound` test: `SingleCohortRouter`, `d_max=4`; asserts `retry_later` in ≤ `d_max+3`
  RPCs (actual 6 = inward 4→3→2→1→0, follow `Promoted(1)` to d=1, immediate exit). Without the fix this is
  36 (`2*(d_max+2)+wantK+8`). Confirmed the without-fix loop never reaches `d<0` (each `Promoted` resets to
  d=1), so 36/maxSteps is the genuine prior bound.
- New `probe: happy path` test: `ScriptedRouter [noState, noState, Promoted(1), accepted]`; asserts
  `accepted` with tier sequence `[2,1,0,1]` and `probe:true` on every frame — guards against over-eager
  short-circuiting.
- Full suite: **978 passing** (`yarn test`), 12 passing under `--grep probe`. `yarn build` (tsc) clean,
  exit 0.

### Minor observations — noted, not actioned (no change warranted)
- **Duplicated back-off literal.** The `no_state` case now has two `return { kind:"retry_later", afterMs:
  backoffRetryMs(0) }` sites (promoted-cold and root-bootstrap-probe). Each carries a distinct semantic
  comment; extracting a shared constant would obscure intent more than it would DRY. Left as-is.
- **Untested edge: `unwilling_member` after a followed redirect.** If a dialed candidate returns `NoState`
  post-redirect, the flag short-circuits to `retry_later`. This is correct read-only behavior (temporal
  back-off; the caller retries idempotently) and not a regression, but it is uncovered by tests. Too narrow
  and benign to warrant a ticket — recorded here for traceability.

### Disposition
No **major** findings → no new fix/plan/backlog tickets filed. All **minor** observations were assessed and
deliberately left unchanged (each documented above with its reason). No pre-existing test failures
encountered. The implementation is accepted as-is.
