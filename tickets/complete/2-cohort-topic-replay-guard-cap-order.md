description: Hardened the cohort-topic anti-replay memory so an attacker cannot fill it before the rate limiter throttles them — a hard size cap plus a check-order fix, now reviewed and shipped.
prereq:
files:
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts
  - packages/db-core/src/cohort-topic/member-engine.ts
  - packages/db-core/test/cohort-topic/antidos.spec.ts
  - packages/db-core/test/cohort-topic/member-engine.spec.ts
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - docs/cohort-topic.md
----

# Complete: cap the replay guard and stop pre-rate-limit growth

## What shipped

Two anti-DoS defects in the cohort-topic register pipeline are fixed (defense in depth, mirroring the
sibling rate limiter):

1. **Hard LRU `maxKeys` cap on the correlation-id replay guard** (`replay-guard.ts`) — new
   `DEFAULT_REPLAY_GUARD_MAX_KEYS = 100_000`, a `maxKeys?` config field (positive-integer validated),
   oldest-inserted eviction on new-key insert, and a `size` getter. Bounds `seen` memory even under a
   flood of genuinely-fresh admitted ids, before the age prune fires.
2. **`runGuards` reordered** `sig → replay → bootstrap → rate` → `sig → rate → bootstrap → replay`
   (`member-engine.ts`). Only frames that pass signature + rate + bootstrap ever insert a `seen`
   entry; a rate-shed frame records nothing.

Docs (`docs/cohort-topic.md` §Anti-DoS) and the `host.ts` guard doc-line updated. Host passthrough of
`maxKeys` needed no code change — `ctx.antiDos.replayGuard` is already typed
`CorrelationReplayGuardConfig`, so the new field flows through `createCorrelationReplayGuard` at
`host.ts:1880` (and to the renewal freshness gate at `:1910`).

## Validation

From `packages/db-core`: `yarn build` (tsc, exit 0, clean) + `yarn test` (mocha) → **1087 passing, 0
failing**. Confirmed the 4 added tests execute (spec reporter): replay-guard cap default, cap +
reopened-window tradeoff, invalid-`maxKeys` rejection, and the member-engine "rate-rejected frame
leaves no replay entry" test.

## Review findings

Adversarial pass over the implement diff (SPP, DRY, modularity, scalability, resource cleanup, error
handling, type safety, test coverage — happy/edge/error/regression/interaction).

**Checked and clean:**
- **Cap arithmetic** — `while (size >= maxKeys) evict; set` yields final size == maxKeys with no
  off-by-one; verified at `maxKeys: 1` (empty→insert→size 1; next insert evicts then sets, stays 1)
  and the `maxKeys: 3` flood test. `keys().next().value === undefined` break guards an empty map.
- **Eviction victim mechanics** — `seen` entries are inserted once and never refreshed, so
  `Map`-insertion-order eviction is a true FIFO of first-sight; correct for the "nearest-to-stale"
  intent. (Doc precision softened — see fixed below.)
- **`maybePrune` interaction** — prune runs before the cap block inside `accept`; `size` reflects
  post-prune count. Amortized prune (once per window) does not desync the cap. Tests read `size`
  right after `accept`, so assertions are stable.
- **Reorder correctness** — an *accepted* frame is still always recorded at step 4, so a genuine
  replay of a served correlationId is still caught (proven by the member-engine test). `runGuards`
  moving `b64urlToBytes(reg.correlationId)` later introduces no new throw surface: correlationId is a
  signature-covered field and `verifyRegisterSig` runs first.
- **Bootstrap-verify amplification** — the reorder makes bootstrap verify run on rate-passed replays,
  but that is bounded by the rate limiter (4/min per peer-topic, checked first), so no new
  amplification. `bootstrapEvidence.verify` is stateless, so extra invocations cost only CPU.
- **Host passthrough** — `maxKeys` is carried by a *typed* config field, not the "untyped spread" the
  handoff described; reaches both the register-path guard and the renewal freshness gate.
- **Type safety** — `size` on the interface + impl matches the rate limiter's pattern; `RangeError`
  validation copied faithfully.

**Fixed inline (minor):**
- **Over-stated eviction-order equality.** Doc/comments asserted oldest-inserted **==**
  oldest-timestamp **==** nearest-to-stale as fact. Not strictly true: correlationIds from distinct
  peers can arrive out of timestamp order within the skew window (clock skew + network reordering), so
  insertion order only *approximates* timestamp order. Softened the config-field comment and the
  inline eviction comment in `replay-guard.ts` to "≈", noting the forgiveness bound (≤ one entry's
  remaining window) holds regardless. Behavior unchanged; comment-only.

**Recorded as a tripwire (conditional, not a ticket):**
- **Replays now consume rate budget.** With the new order a replayed frame consumes a rate-limiter
  accept before the replay guard drops it (the old order dropped replays pre-rate). Fine for spam —
  inbound traffic *should* be rate-counted — and only bites a legitimate client that reuses one
  `correlationId` across retransmits, which would then burn rate budget per retransmit. Parked as a
  `NOTE:` at the `runGuards` rate-check site in `member-engine.ts`. Not filed as a ticket: it is
  conditional on a client retry style that the "16 random bytes per RegisterV1" convention does not
  imply, and even then the back-off is a defensible signal.

**Noted, no action (out of scope / pre-existing):**
- **Default-cap stress untested.** The cap is exercised only at `maxKeys: 3`; the eviction loop is
  size-independent, so no test drives the 100k default under a large flood. Left as a floor (handoff
  gap); a property/stress test could raise it. Not blocking.
- **Sybil key growth.** Admitting 100k fresh ids in a window requires ~25k distinct rate-limited
  peers; unbounded Sybil creation is explicitly out of the substrate's scope (docs §Anti-DoS closing
  note).
- **`member-engine.ts:318` unused `ctx` param** — language-server `[6133]` only; `accept()` was not
  touched by this diff and `yarn build` (real tsconfig) is clean. Pre-existing, not this ticket's.
  No `.pre-existing-error.md` written (the build/test run is fully green — this is an IDE-only lint,
  not a build/test failure).

**Behavior change confirmed acceptable:** a frame both over-rate and missing-bootstrap now returns the
**rate limiter's** `retryAfterMs` (not the bootstrap gate's). Both are `unwilling_cohort` with a
back-off — same response class. No downstream consumer distinguishes the two back-off values.

No major findings; no new fix/plan/backlog tickets filed.
