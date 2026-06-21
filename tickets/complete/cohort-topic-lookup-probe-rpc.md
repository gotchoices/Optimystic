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
  - docs/cohort-topic.md (Lookup / Wire-format / deferred-list updates added in review)
difficulty: medium
----

# Complete: cohort-topic read-only lookup probe RPC

## What shipped

`CohortTopicService.lookup(topicId, tier)` is now a **read-only probe** instead of a real
registration. It walks the identical path a register does (`RegisterV1.probe: true`), classifies the
terminal cohort, and returns the same `CohortHint` — admitting nothing (no soft-state record, no
arrival, no promotion trigger, no topic-budget touch, no cold-start instantiation). A lookup no longer
leaves a throwaway registration behind to TTL-expire. Design: a `probe` flag on `RegisterV1` (not a
separate `LookupV1`), because the anti-flood walk loop is byte-for-byte identical for a probe — only
the terminal member action differs. See the implement commit `335112b` for the full per-file summary.

Validation at review: db-core `yarn build` clean + `yarn test` **976 passing**; db-p2p `yarn build`
clean + `yarn test` **986 passing, 30 pending, 0 failing** (~5 min). The lone
`cohort-topic cold-start: parent registration ... parent unreachable` line is an intentional
`console.warn` inside a *passing* anti-DoS test. No `tickets/.pre-existing-error.md` was needed. No
lint is configured in this repo (root `lint` is a no-op echo).

## Review findings

Adversarial pass over the implement diff, scrutinized for correctness, DRY, SPP, type safety, error
handling, resource cleanup, DoS posture, test coverage, and doc accuracy.

### MAJOR — filed as a new ticket

- **Probe livelock on a promoted-but-unsharded topic** → `tickets/fix/cohort-topic-probe-promoted-livelock.md`.
  A read-only probe that follows a `Promoted` redirect to a child tier that is not yet instantiated
  walks back inward to the (participant-independent) promoting root, which re-answers `Promoted`,
  forming an unbroken root↔child loop that only `maxSteps` breaks — **reproduced at the walk layer:
  36 router RPCs for `d_max = 4`** before backing off to `CohortBackoffError`, every other hop
  re-hitting the hot root cohort (an amplification vector). The register path escapes this by
  instantiating the child on the redirect (follow-on); the probe never instantiates, so it needs its
  own termination rule. **Latent in the current single-tier-0 milestone** (production host hardcodes
  `followOn: false`; multi-tier promotion is parked as `cohort-topic-followon-derivation`), but the
  defect lives in `walk.ts`, is reproducible today with a scripted router, and `followon-derivation`
  will **not** fix the probe. Filed with repro + candidate fix (a probe must not walk inward past a
  tier it was promoted to) and an open design question (back off vs. resolve the nearest served
  ancestor as the hint).

### MINOR — fixed inline in this pass

- **Stale docs (`docs/cohort-topic.md`).** The change shipped no doc updates; three were out of date:
  1. The "Still deferred (parked in backlog)" list still named the read-only lookup-probe RPC as
     unimplemented — it just landed. Removed it and added a "Landed since" note.
  2. The `RegisterV1` wire-format field block omitted `probe?` — added it (noting mutual exclusivity
     with `bootstrap`).
  3. The §Lookup section described only the register walk — added a note that a read-only lookup uses
     the same walk with `probe: true`, classifies rather than admits, and backs off at the root
     instead of issuing `bootstrap: true`.

### Checked and found acceptable (no action)

- **Signing-image consistency.** `probe` is appended last in `registerSigningPayload`; signer
  (db-core service) and verifier (db-p2p host) both call it, so they agree byte-for-byte. `false` and
  absent normalize identically (asserted by the new wire test). No register signature is persisted or
  cached anywhere (records carry no signature; sigs are verified at handle time), so the image churn
  for normal registers has no stored-artifact impact. Mixed-version networks are out of scope
  (pre-release substrate).
- **`bootstrap` + `probe` adversarial frame.** Safe by construction: `handleRegister` branches to
  `handleProbe` at the very top — before the admission pipeline and every durable-state guard — so a
  hand-crafted `{ probe: true, bootstrap: true }` frame can never instantiate. Defense-in-depth holds;
  no explicit wire-level mutual-exclusivity rejection was added (current behavior — probe wins — is
  safe), so this is left as-is rather than over-hardened.
- **DoS posture of the probe path.** Probe runs the participant-sig gate then a **dedicated**
  per-coord `probeRateLimiter` (separate budget from the register limiter, constructed in `host.ts`),
  and skips the replay guard / bootstrap-evidence / topic-budget gates because an idempotent read
  records nothing — strictly cheaper than the lookup-as-register it replaces. Sig-before-rate ordering
  matches the register path (no new amplification). A captured signed probe is replayable but only
  yields rate-limited read-only responses; acceptable and documented.
- **Faithfulness of the resolved hint.** `handleProbe`'s `accepted` branch reuses the exact
  `slots.assignSlots(...)` + read-only `traffic.snapshot(...)` a register's `accept` computes
  (`assignSlots` is pure/per-participant), so a probe resolves the same hint a register would — by
  construction, not duplication drift.
- **Caller / factory completeness.** Type-safe: `RegisterMessageFactory.build` requires `probe`, the
  walk always threads it, and the only two implementers (production `service.ts`, test `walk.spec.ts`)
  were both updated. `service.register` still omits `probe` (registers stay registers).

### Test coverage assessment

The implementer's tests are a solid floor and were verified green (db-core wire/walk/member-engine = 76
passing; db-p2p service.spec = 10 passing): probe round-trip + non-boolean rejection + distinct signing
image; cold-probe-never-bootstraps walk trace; engine read-only classify across served/cold/promoted +
forged-sig + over-rate + own-limiter; mock-service warm-resolve-without-soft-state + cold-backoff.
**Known coverage gaps** (carried from the handoff, not blockers, none promoted to tickets because they
are integration-depth items behind the parked multi-tier work): no e2e multi-node positive probe
across real tiers; probe-vs-register rate-limiter independence is structural not behaviorally
host-tested; no `host.registry`-level read-only assertion; integration specs not run with
`OPTIMYSTIC_INTEGRATION=1`. The MAJOR finding above is precisely the multi-tier interaction those
missing e2e tests would have surfaced — its fix ticket carries the required walk-level regression test.
