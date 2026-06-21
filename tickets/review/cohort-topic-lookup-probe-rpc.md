description: Looking up which group of nodes is responsible for a topic is now a read-only operation, so a lookup no longer leaves behind a throwaway registration that expires moments later.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1.probe)
  - packages/db-core/src/cohort-topic/wire/validate.ts (parse probe)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (sign probe)
  - packages/db-core/src/cohort-topic/walk.ts (thread probe; never bootstrap on a probe)
  - packages/db-core/src/cohort-topic/member-engine.ts (handleProbe read-only classify)
  - packages/db-core/src/cohort-topic/service.ts (lookup drives a probe)
  - packages/db-p2p/src/cohort-topic/host.ts (per-coord probe rate limiter)
  - packages/db-core/test/cohort-topic/{wire,walk,member-engine}.spec.ts
  - packages/db-core/test/cohort-topic/bootstrap-evidence-envelope.spec.ts (signing-image snapshot)
  - packages/db-p2p/test/cohort-topic/service.spec.ts
difficulty: medium
----

# Review: cohort-topic read-only lookup probe RPC

## What was implemented

`CohortTopicService.lookup(topicId, tier)` used to call the registration walk and read the cohort
fields off the `accepted` reply — i.e. **every lookup performed a real registration** (assigned a
primary, persisted soft-state, counted an arrival, fired the promotion trigger, touched the topic
budget, and for a cold topic instantiated a cold-start forwarder), all of which then TTL-expired
because the caller never renewed. Lookup is now a **read-only probe**: it walks the identical
path a register does, classifies the terminal cohort, and returns the same `CohortHint` —
admitting nothing.

The chosen design (per the plan ticket) is a `probe: boolean` flag on `RegisterV1` rather than a
dedicated `LookupV1` message, because the anti-flood walk loop (inward on `no_state`, follow
`Promoted`, back off on `unwilling_cohort`) is byte-for-byte identical for a probe — **only the
terminal member action differs**. This reuses the whole walk, `RegisterReplyV1` verbatim, and the
existing host register-protocol / FRET-activity dispatch.

Coordinated changes:

### 1. Wire + signing (`wire/types.ts`, `wire/validate.ts`, `wire/payloads.ts`)
- `RegisterV1` gains optional `probe?: boolean` (doc'd as read-only, mutually exclusive with
  `bootstrap`).
- `validateRegisterV1` parses it via `optBool` (assigns only when defined — same pattern as
  `bootstrap`). A non-boolean `probe` is a `CohortWireError`.
- `registerSigningPayload` appends `body.probe ?? false` **at the end** of its ordered array (after
  `correlationId`), so the participant signature covers it. A normal register now signs
  `probe: false`; `false` and absent normalize to the identical image.

### 2. Walk (`walk.ts`)
- `WalkEngine.register` takes `opts?: { probe?: boolean }`; `RegisterMessageFactory.build` gains a
  required `probe: boolean`; `RouterWalkEngine` threads `probe` into every `factory.build(...)`.
- In the `no_state` → root (`next < 0`) branch, **a probe returns `retry_later` instead of
  re-issuing with `bootstrap: true`** — a probe never instantiates a cold root. The register path is
  unchanged (still re-issues bootstrap at the root).

### 3. Member engine (`member-engine.ts`)
- New optional dep `probeRateLimiter?: RegisterRateLimiter` (absent → the probe rate gate is
  skipped; the read-only classify still runs).
- `handleRegister` branches on `reg.probe === true` **at the very top**, before the admission
  pipeline AND the durable-state anti-DoS guards, into the new private `handleProbe`.
- `handleProbe` (synchronous, read-only): runs the stateless participant-sig gate (forged →
  `no_state`) and the dedicated probe rate limiter (over-rate → `unwilling_cohort{retryAfterMs}`),
  then classifies — `promoted(treeTier+1)` for a served+promoted topic, `accepted` with the
  participant-specific `slots.assignSlots(...)` + read-only `traffic.snapshot(...)` for a served
  topic, else `no_state`. It calls **no** `store.put` / `traffic.recordArrival` /
  `promotion.onParticipantCountChange` / `topicBudget` / `coldStart.instantiate`.

### 4. Service (`service.ts`)
- `lookup()` now drives `walk.register(topicId, tier, undefined, { probe: true })`; the interim
  "lookup-as-register" doc note is replaced with the read-only contract. A still-cold topic resolves
  to `CohortBackoffError` (the probe never bootstraps a cold root).
- The `messageFactory` build stamps `body.probe = true` when `params.probe`; this is set before the
  `bootstrap` branch, which cannot run for a probe (the walk never sets `bootstrap` on a probe).

### 5. Host (`host.ts`)
- `createCoordEngine` constructs a **second** per-coord `RegisterRateLimiter` (same
  `antiDos.rateLimiter` config, separate budget) and passes it as `probeRateLimiter` to
  `createCohortMemberEngine`. No protocol-routing change — a `probe: true` frame rides the existing
  `register` handler / FRET activity callback into `handleRegister`, which now branches.

## Validation performed

- `packages/db-core` `yarn build` (tsc): clean, exit 0.
- `packages/db-core` `yarn test`: **976 passing**, 0 failing.
- `packages/db-p2p` `yarn build` (tsc): clean, exit 0.
- `packages/db-p2p` `yarn test`: **986 passing, 30 pending, 0 failing** (~7 min wall-clock; the one
  `cohort-topic cold-start: parent registration for tier-1 forwarder failed Error: parent unreachable`
  line in the output is an intentional `console.warn` inside a *passing* anti-DoS cold-start test,
  not a failure).
- Touched specs in isolation: db-core `wire`/`walk`/`member-engine` = **76 passing**; db-p2p
  `service.spec` = **10 passing**.
- No `tickets/.pre-existing-error.md` was written — no pre-existing or unrelated failures were
  surfaced by these runs.

## Tests added / changed (the floor — extend, don't trust as exhaustive)

- `wire.spec.ts` — new `lookup probe flag` block: round-trips `probe: true`, omits an absent probe,
  rejects a non-boolean probe, and asserts `registerSigningPayload` differs between
  `probe:true` and `probe:false`/absent (with `false`==absent).
- `bootstrap-evidence-envelope.spec.ts` — the `registerSigningPayload` canonical-array **snapshot**
  was updated to include the new trailing `false // probe absent` slot (this was the only test that
  broke from the signing-image change; the index-9 `bootstrapEvidence` assertions are unaffected
  because `probe` is appended at the end).
- `walk.spec.ts` — `Probe` records `probe`; `factoryFor` emits it. Two new tests: a cold probe backs
  off at the root and **never emits a `bootstrap:true` frame** (asserts the exact `[1,0]` step
  sequence and `probe` on every frame); the non-probe path still re-issues bootstrap at the root.
- `member-engine.spec.ts` — new `handleProbe (read-only lookup)` block with `willingness`/`renewal`/
  `profile` wired as the throw-on-touch `unused` proxy (proving the probe never enters the admission
  pipeline) and traffic/promotion/cold-start spies: served→accepted (same slots a register computes,
  store + arrival + promotion + instantiate all unchanged), cold→no_state (store stays 0, no
  instantiate), promoted→`promoted(treeTier+1)`, never fires the promotion trigger, over-rate→
  `unwilling_cohort{retryAfterMs}`, forged-sig→`no_state` even for a served topic, and the probe
  consults its own rate limiter.
- `service.spec.ts` (db-p2p) — `buildSingleMemberCohort` now returns `store`; the old "lookup
  resolves the hint" test is split into: (a) warm via `register` then `lookup` returns the same hint
  with `directParticipants` unchanged, and (b) a never-warmed topic `lookup` rejects with
  `CohortBackoffError` and persists nothing.

## Known gaps / what the reviewer should scrutinize

1. **No end-to-end multi-node probe test.** The mock single-member cohort routes every coord to one
   engine, so a probe resolves at the first hop — it does not exercise the probe walking several
   real tiers/cohorts. `live-tier.spec.ts`'s post-promotion lookup still passes (it asserts
   `CohortBackoffError`), but there is no positive "a probe resolves a remote served cohort
   read-only across real nodes" e2e. Consider adding one to `live-tier.spec.ts`.

2. **Probe rate-limiter independence is unit/structural, not behaviorally integration-tested.** The
   engine unit test proves the engine consults its own `probeRateLimiter`, and the host constructs a
   separate `createRegisterRateLimiter` instance — but there is no host-level test proving a probe
   flood does *not* exhaust the register limiter at the same coord (or vice-versa). The two budgets
   are separate by construction; a behavioral host test would close this.

3. **No host.registry-level read-only assertion.** The plan ticket suggested asserting via the coord
   engine that `directParticipants`/budget are unchanged and no promotion notice is broadcast after a
   probe. I asserted the read-only contract at the **engine-unit** level (store/arrival/promotion/
   instantiate spies) and the **mock-service** level (`directParticipants` unchanged) — arguably
   stronger per-collaborator — but not through `host.registry` introspection
   (`budgetParticipantCount`/`records`/`broadcastNotice`). Add a host test if behavioral proof
   through the real dispatch is wanted.

4. **`bootstrap`+`probe` mutual-exclusivity has no explicit adversarial-frame test.** It is enforced
   by construction (walk never sets bootstrap on a probe; service stamps probe before the bootstrap
   branch) and defended in depth (`handleProbe` runs before any cold-path/instantiate). The cold
   probe unit test uses a `coldStart.instantiate` stub that throws, so any probe reaching instantiate
   fails loudly — but that frame carries `probe:true` only. A reviewer may want an explicit
   hand-crafted `{ probe:true, bootstrap:true }` frame fed to `handleRegister` asserting `no_state` /
   no instantiation.

5. **Signed-image churn for all registers.** Appending `probe` changes the signed image for *every*
   register (normal ones now sign `probe:false`). Signer (db-core service) and verifier (db-p2p
   host) both call `registerSigningPayload`, so they agree, and the full db-core suite (incl.
   peer-key-signing) + db-p2p `live-tier` (real Ed25519) are green. A mixed-version network is out of
   scope (pre-release substrate, no wire-compat guarantee). I found **no** persisted/cached register
   signature anywhere (register sigs are verified at handle time, never stored) — worth a second
   look to confirm.

6. **Replay guard / bootstrap-evidence / topic-budget are intentionally skipped on the probe path**
   (an idempotent read records nothing). This is by construction (`handleProbe` never calls them);
   there is no test asserting the replay guard's bounded memory is *not* consumed by a probe. Confirm
   this scoping ("records nothing" = registration soft-state) is the intended DoS posture — the probe
   path is strictly cheaper than the lookup-as-register it replaces, so it should not regress the
   durable-state DoS surface.

7. **Integration specs not run with `OPTIMYSTIC_INTEGRATION=1`.** The default `yarn test` includes
   the `*.integration.spec.ts` files but they self-skip without the env flag (part of the 30
   pending). Real-libp2p integration of the probe path was therefore not exercised here.
