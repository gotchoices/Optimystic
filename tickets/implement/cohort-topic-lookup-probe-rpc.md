description: Make resolving a topic's cohort a read-only operation, so looking one up no longer leaves throwaway registration state behind that expires moments later.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1: add optional `probe`)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateRegisterV1: parse `probe`)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (registerSigningPayload: cover `probe`)
  - packages/db-core/src/cohort-topic/walk.ts (thread `probe` to factory.build; never bootstrap on a probe)
  - packages/db-core/src/cohort-topic/member-engine.ts (read-only `handleProbe` classify path)
  - packages/db-core/src/cohort-topic/service.ts (lookup() drives a probe, not a register)
  - packages/db-p2p/src/cohort-topic/host.ts (per-coord probe rate limiter wired into the engine)
  - packages/db-p2p/test/cohort-topic/service.spec.ts (rewrite the lookup test: warm-then-probe, read-only)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts (handleProbe unit cases)
  - packages/db-core/test/cohort-topic/walk.spec.ts (probe never bootstraps at the root)
difficulty: medium
----

# Cohort-topic: read-only lookup probe RPC

## Problem (recap)

`CohortTopicService.lookup(topicId, tier)` currently calls `walk.register(...)` and reads the cohort
fields off the `accepted` reply (`service.ts:218-227`, documented as interim). Every `lookup` therefore
performs a **real registration** — assigns a primary, persists a soft-state record, counts an arrival,
runs the promotion trigger, and (for a cold topic) **instantiates a cold-start forwarder via the
`bootstrap` path** — all of which then TTL-expires because the caller never renews. For applications
that resolve a cohort without attaching (capability discovery, hint refresh) this is wasteful and
pollutes traffic/promotion signals (and the topic budget) with phantom registrations.

## Design decision (resolved): a `probe: true` flag on `RegisterV1`

The ticket offered two options — a dedicated `LookupV1` message + protocol path, or a `probe` flag on
the register path. **Chosen: the `probe` flag**, because the walk loop (the anti-flood backbone:
inward on `no_state`, follow `Promoted`, back off on `unwilling_cohort`) is *byte-for-byte identical*
for a probe — **only the terminal member action differs**. The flag approach reuses:

- the entire `WalkEngine.register` loop (no parallel walk implementation → no divergence risk),
- `RegisterReplyV1` verbatim (it already carries `primary`/`backups`/`cohortEpoch`/`cohortMembers`/
  `topicTraffic`), so the walk's `accepted` terminal handling and `service.lookup` need no new plumbing,
- the host's existing `register`-protocol + FRET-activity dispatch into `handleRegister` (a probe rides
  it unchanged and `handleRegister` branches on `reg.probe`).

A dedicated `LookupV1` would instead force a new message + validator + codec decoder + reply type +
signing payload + a parallel walk method + a new host protocol route — strictly more surface for
identical routing behaviour.

**Tradeoff accepted:** a probe is "a `RegisterV1` that does not register", which is slightly less
self-documenting than a distinct message, and the canonical signed register image gains one element
(`probe`). Both are cheap: the read-only short-circuit is explicit and unit-tested, the signed image is
recomputed identically by signer (db-core service) and verifier (db-p2p host) from the same
`registerSigningPayload`, there are no persisted signatures, and this is pre-release substrate with no
wire-compat guarantee. The clarity cost is far outweighed by not duplicating the walk + a protocol.

## What a probe must and must not do

A probe walks to the responsible cohort and returns the same `CohortHint` as a register would, **without
admitting**:

- **must NOT**: persist a record (`store.put`), count an arrival (`traffic.recordArrival`), fire the
  promotion trigger (`firePromotion`), touch the topic budget (`topicBudget.touch`/`admit`), or
  instantiate a cold-start forwarder (`coldStart.instantiate`). It must also **never set `bootstrap`** —
  a probe of a topic that exists nowhere resolves to "not found / back off", never a cold-root creation.
- **must**: preserve walk discipline — return `no_state` for a cold topic (walk steps inward),
  `promoted(treeTier+1)` for a promoted topic (walk follows the redirect), and the cohort snapshot
  (shaped as `result: "accepted"`) for a served topic, with the same participant-specific slot
  assignment a register would compute (`slots.assignSlots(participantId, cohortEpoch, members)` is pure)
  and the read-only `traffic.snapshot(topicId)` attached.

Returning `result: "accepted"` for the served case is deliberate: from the walk's perspective
"accepted" means "the walk landed — here is the cohort", which is exactly what a probe resolves, so the
walk's existing terminal branch and `service.lookup` (`outcome.kind !== "accepted" → CohortBackoffError`)
work without a new enum value.

### Anti-DoS posture for the probe path (resolved)

"Records nothing" is scoped to **registration soft-state** (record / arrival / promotion / traffic /
budget). For DoS the probe path:

- **runs**, when present, the stateless participant-signature gate (`verifyRegisterSig`) → forged-sig
  probe answers `no_state`, mirroring register and keeping participant-identity discipline uniform
  (in key-less interim mode this gate is absent and probes are unsigned, exactly like register);
- **runs a dedicated per-coord probe rate limiter** (its *own* `RegisterRateLimiter` instance, separate
  budget from the register limiter, reusing `antiDos.rateLimiter` config) → over-rate probe answers
  `unwilling_cohort{retryAfterMs}` (walk → `retry_later` → `CohortBackoffError`). A separate budget so a
  probe flood cannot exhaust a participant's register budget or vice-versa;
- **skips** the replay guard (an idempotent read records nothing; logging correlation-ids for reads only
  burns the guard's bounded memory), the bootstrap-evidence gate, and the topic budget (no instantiation).

Net effect: a probe is **strictly cheaper than today's lookup-as-register** it replaces, so this never
regresses the cohort's durable-state DoS surface — it shrinks it.

## Wire / signing changes

`RegisterV1` gains one optional field:

```ts
/** Read-only lookup probe: classify + return the cohort snapshot without admitting
 *  (no record, no arrival, no promotion, never bootstrap). */
probe?: boolean;
```

- `validateRegisterV1` parses it via `optBool(obj, "probe", what)` and assigns only when defined
  (same pattern as `bootstrap`).
- `registerSigningPayload` appends `body.probe ?? false` to its ordered array (append at the end, after
  `correlationId`) so the signature covers it; both sides call this one function so they stay in lockstep.
  (A normal register now signs `probe: false` — harmless, recomputed identically on verify.)

## Walk change

`WalkEngine.register` takes an options bag:

```ts
register(topicId: Uint8Array, tier: number, appPayload?: Uint8Array, opts?: { probe?: boolean }): Promise<WalkOutcome>;
```

- `RegisterMessageFactory.build(params)` gains `probe: boolean`; `RouterWalkEngine.register` threads
  `const probe = opts?.probe ?? false` into every `factory.build({ ..., probe })`.
- In the `no_state` → `next < 0` (root) branch, **a probe never re-issues with `bootstrap: true`**:

  ```ts
  if (next < 0) {
    if (bootstrap) return { kind: "retry_later", afterMs: backoffRetryMs(0) }; // already tried root
    if (probe)     return { kind: "retry_later", afterMs: backoffRetryMs(0) }; // probe never instantiates
    d = 0; bootstrap = true; break;
  }
  ```

Everything else in the loop (Promoted follow, `unwilling_member` sibling retries, `unwilling_cohort`
back-off, `maxSteps` cap) is unchanged.

## Member-engine change

`handleRegister` branches at the top, before the guards/hot-cold/admission pipeline:

```ts
async handleRegister(reg, ctx, now) {
  const topicId = b64urlToBytes(reg.topicId);
  const participantId = b64urlToBytes(reg.participantCoord);
  const tier = reg.tier as Tier;
  if (reg.probe === true) return this.handleProbe(reg, topicId, participantId, tier, ctx, now);
  // ... existing guards + serves()/cold-path + admitOrDecline ...
}
```

`handleProbe` (read-only; no `store`/`traffic`/`promotion`/`budget`/`coldStart` mutation):

```ts
private handleProbe(reg, topicId, participantId, tier, ctx, now): RegisterReplyV1 {
  if (this.deps.verifyRegisterSig?.(reg) === false) return { v: 1, result: "no_state" };
  const rate = this.deps.probeRateLimiter?.check(participantId, topicId, now);
  if (rate !== undefined && rate.ok === false) {
    return { v: 1, result: "unwilling_cohort", retryAfterMs: rate.retryAfterMs };
  }
  if (this.serves(topicId)) {
    if (this.deps.promotion.isPromoted(topicId)) {
      return promotedRedirectReply(ctx.treeTier + 1, this.deps.traffic.snapshot(topicId));
    }
    const { members, cohortEpoch } = this.deps.cohort();
    const { primary, backups } = this.deps.slots.assignSlots(participantId, cohortEpoch, members);
    const reply: RegisterReplyV1 = {
      v: 1, result: "accepted",
      primary: bytesKey(primary), backups: backups.map(bytesKey),
      cohortEpoch: bytesKey(cohortEpoch), cohortMembers: members.map(bytesKey),
    };
    return attachTopicTraffic(reply, this.deps.traffic.snapshot(topicId));
  }
  return { v: 1, result: "no_state" };
}
```

Add `readonly probeRateLimiter?: RegisterRateLimiter;` to `CohortMemberEngineDeps` (absent → the rate
gate is skipped, keeping unit/mock flows composing). `bytesKey`, `attachTopicTraffic`,
`promotedRedirectReply`, `RegisterRateLimiter` are already imported in `member-engine.ts`.

## Service change

```ts
async lookup(topicId, tier): Promise<CohortHint> {
  const outcome = await this.walk.register(topicId, tier, undefined, { probe: true });
  if (outcome.kind !== "accepted") {
    throw new CohortBackoffError(outcome.kind === "retry_later" ? outcome.afterMs : 0);
  }
  return this.hintFromReply(topicId, tier, outcome.reply);
}
```

Replace the interim doc note (`service.ts:219-221`) with one stating `lookup` is a read-only probe that
admits nothing. The `messageFactory().build` sets `body.probe = true` when `params.probe` (the
`bootstrap`-evidence branch cannot run for a probe because the walk never sets `bootstrap` on a probe).

## Host change

In `createCoordEngine` (`host.ts`), construct a second limiter and pass it to the engine:

```ts
const probeRateLimiter = createRegisterRateLimiter(ctx.antiDos.rateLimiter);
// ... in createCohortMemberEngine({ ..., rateLimiter, replayGuard, topicBudget, probeRateLimiter, ... })
```

No protocol-routing change: a `probe: true` `RegisterV1` already flows through the `register` handler /
FRET activity callback → `dispatchRegister` → `handleRegister`, which now branches.

## Edge cases & interactions

- **Cold topic probe never instantiates.** A probe whose walk reaches the root on `no_state` returns
  `retry_later` (walk) → `CohortBackoffError` (lookup), with **zero** cold-start instantiation and zero
  topic-budget admit. This is the behavioural change the ticket targets — assert it directly.
- **Existing `service.spec.ts` "lookup resolves the cohort hint" test changes meaning.** It currently
  probes a *cold* topic and expects a hint (works today only because lookup-as-register instantiates).
  Rewrite it: first `register` (or otherwise warm the topic), then `lookup` returns the same hint
  **read-only**, and a `lookup` of a still-cold topic now throws `CohortBackoffError`.
- **Probe leaves no soft-state.** After a probe of a served topic, `store.directParticipants(topicId)`,
  the traffic arrival count, and the topic-budget participant count are all **unchanged** vs. before the
  probe; no promotion notice is produced. Assert each.
- **Promoted topic.** A probe of a promoted topic returns `promoted(treeTier+1)`; the walk follows it
  and re-probes at the redirect target, terminating at the serving cohort (or `maxSteps`). No state
  mutated at any hop.
- **Participant-specific slot assignment.** The resolved `primary`/`backups` depend on
  `participantCoord` (slot assignment is per-participant). A probe carries `self` as `participantCoord`
  (via the existing `messageFactory`), so it resolves the *same* primary the caller would get on a real
  register. A probe and a register for the same `(topic, participant, epoch)` must return equal
  `primary`/`backups`.
- **Forged / unsigned probe (keyed mode).** `verifyRegisterSig === false` → `no_state` (serve nothing),
  exactly like register; never a cohort snapshot for a forged `participantCoord`.
- **Probe rate limiting is an independent budget.** Exhausting the probe limiter must not affect the
  register limiter for the same `(peer, topic)` and vice-versa (separate instances). Over-rate probe →
  `unwilling_cohort` → walk `retry_later` → `CohortBackoffError`.
- **Signed-image churn.** Adding `probe` to `registerSigningPayload` changes the signed image for *all*
  registers (normal ones sign `probe: false`). Both signer and verifier call the same helper, so they
  agree; a mixed-version network is out of scope (pre-release). Keep `peer-key-signing.spec.ts` green.
- **`bootstrap` + `probe` are mutually exclusive.** The walk never sets `bootstrap` on a probe, and
  `handleProbe` runs before any cold-path/instantiate, so even a hand-crafted `probe: true, bootstrap:
  true` frame cannot instantiate — `handleProbe` classifies and returns first (defense in depth).
- **Key-less / mock composition.** `probeRateLimiter` and `verifyRegisterSig` are both optional; absent
  → those gates are skipped and probes still classify. The mock service test must compose without them.

## Tests (TDD targets, expected outputs)

### db-core unit

- `member-engine.spec.ts` — `handleProbe`:
  - served topic (seed a record first) → `result: "accepted"` with `primary`/`backups`/`cohortEpoch`/
    `cohortMembers` equal to what `handleRegister` returns for the same participant, **and** the store
    direct-participant count + traffic arrival count are unchanged after the probe (read-only).
  - cold topic → `result: "no_state"`; `store.directParticipants` stays 0; no `coldStart.instantiate`.
  - promoted topic → `result: "promoted"`, `targetTier === ctx.treeTier + 1`.
  - probe never fires promotion: probe a topic sitting at `cap_promote − 1` participants → no
    `PromotionNoticeV1` emitted (a real register at that count would).
  - over-rate probe (inject a `probeRateLimiter` stub returning `{ ok: false, retryAfterMs }`) →
    `result: "unwilling_cohort"` with that `retryAfterMs`.
  - forged sig (`verifyRegisterSig` stub → false) → `result: "no_state"`.
- `walk.spec.ts` — with a router that always replies `no_state`, `register(TOPIC, tier, undefined,
  { probe: true })` terminates as `retry_later` and **never emits a `bootstrap: true` frame** (assert
  the factory was never asked to build with `bootstrap === true`); the non-probe path still re-issues at
  the root with `bootstrap: true`.
- `wire.spec.ts` — round-trip a `RegisterV1` with `probe: true` (encode→decode→validate equal); a
  non-boolean `probe` is a `CohortWireError`; `registerSigningPayload` differs between `probe: true` and
  `probe: false`/absent.

### db-p2p integration

- `service.spec.ts` — rewrite the lookup test: register/warm `TOPIC`, then `lookup` returns the same
  hint with no new arrival; a `lookup` of a never-warmed topic rejects with `CohortBackoffError`. Add a
  test that `lookup` followed by inspecting the coord engine shows `directParticipants` unchanged and no
  promotion side effect.

## TODO

### Phase 1 — db-core wire + walk + classify

- Add `probe?: boolean` to `RegisterV1` (`wire/types.ts`) with the doc comment above.
- Parse `probe` in `validateRegisterV1` (`wire/validate.ts`) via `optBool`.
- Append `body.probe ?? false` to `registerSigningPayload` (`wire/payloads.ts`).
- Add `opts?: { probe?: boolean }` to `WalkEngine.register` + `RouterWalkEngine`; add `probe: boolean`
  to `RegisterMessageFactory.build`; thread `probe` through every `factory.build(...)`; make the root
  `no_state` branch return `retry_later` for a probe instead of setting `bootstrap`.
- Add `readonly probeRateLimiter?: RegisterRateLimiter` to `CohortMemberEngineDeps`; implement
  `handleProbe` and branch in `handleRegister`.
- Rewrite `service.lookup()` to drive `walk.register(..., { probe: true })`; set `body.probe` in the
  service `messageFactory`; replace the interim doc note.

### Phase 2 — db-p2p host wiring

- Construct a per-coord `probeRateLimiter` in `createCoordEngine` and pass it into
  `createCohortMemberEngine`.

### Phase 3 — tests + validation

- Add/adjust the unit + integration tests above.
- From `packages/db-core`: `yarn build 2>&1 | tee /tmp/dbcore-build.log` then
  `yarn test 2>&1 | tee /tmp/dbcore-test.log`.
- From `packages/db-p2p`: `yarn build 2>&1 | tee /tmp/dbp2p-build.log` then
  `yarn test 2>&1 | tee /tmp/dbp2p-test.log` (stream output — never silent-redirect).
- If any failure is plainly pre-existing / outside this diff, record it in
  `tickets/.pre-existing-error.md` and finish the ticket; otherwise fix it.

## End
