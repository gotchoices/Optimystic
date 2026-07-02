description: Privileged cohort-topic renew messages ("I'm leaving" / "I'm taking over") have no expiry, so a recorded one can be replayed later to delete a member's live registration; add a freshness check so stale/replayed ones are rejected.
prereq:
files:
  - packages/db-core/src/cohort-topic/registration/renewal.ts     # onRenew (~305-381) — add freshness gate to withdraw/reattach branches
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts      # DEFAULT_REPLAY_MAX_AGE_MS / DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS — reuse the skew constants
  - packages/db-core/src/cohort-topic/wire/payloads.ts             # renewSigningPayload (~60-75) — confirms timestamp is signed (immutable to attacker)
  - packages/db-p2p/src/cohort-topic/host.ts                       # resolveRenew (~1933-1941); RenewalCohortSide construction — thread freshness config
  - packages/db-core/src/cohort-topic/member-engine.ts             # handleRenew (~243-256); runGuards (~371-398) reference for register-path regime
  - packages/db-core/test/cohort-topic/registration.spec.ts        # renewal/withdraw/reattach unit tests — add repro cases here
difficulty: medium
----

# Add freshness + anti-replay to the privileged renew path

## Root cause

The **register** path runs privileged admissions through a freshness gate
(`member-engine.ts:runGuards`, ~379-397): after the signature check it calls
`replayGuard.accept(correlationId, participantId, reg.timestamp, now)`, which rejects a timestamp outside
the skew window and rejects an already-seen `correlationId` (`antidos/replay-guard.ts`).

The **renew** path has no equivalent gate. `RenewalCohortSide.onRenew` (`renewal.ts:305-381`) verifies
`verifyParticipantSig` on the two privileged branches — `withdraw` (evict, ~314-328) and `reattach`
(primary re-stamp, ~334-365) — but never inspects `msg.timestamp`. On the db-p2p side `resolveRenew`
(`host.ts:1933-1941`) forwards straight to `handleRenew` with no guard.

Because these frames are signed but not time-bound, a captured signed `withdraw` is valid forever. An
attacker who records one can replay it after the victim's record TTL-expires and re-registers: the stale
frame evicts the *fresh* record and the eviction is gossiped cohort-wide. A captured `reattach` can be
replayed to force bogus primary re-stamps.

This is a gap opened by the withdraw-tombstone mechanism (complete ticket
`cohort-topic-withdraw-tombstone`), which added the signed `withdraw` flag and bound its signature to the
participant but did not add freshness — a new hole, not a regression.

## Why the fix is timestamp-based, NOT the register's CorrelationReplayGuard

The fix ticket's suggested-fix hint proposed reusing the register path's `CorrelationReplayGuard` seam.
**That seam does not fit the renew shape** — do not route renew `correlationId`s through it:

- A `RegisterV1` carries a fresh random 16-byte `correlationId` per registration, so the guard's
  correlation-id-keyed single-use `seen` map is correct there.
- Every `RenewV1` from a participant **reuses the original register's `correlationId`**
  (`renewal.ts:73` dep doc "Correlation id matching the original RegisterV1"; `buildRenew` at
  `renewal.ts:225-240` sets `correlationId: this.deps.correlationId`, a constant across every ping,
  reattach, and withdraw). Feeding that into the register guard would record it on the first ping and
  then **reject every subsequent legitimate renew as a replay** — it would break renewal outright.

What *does* transfer is the **skew constants** and the timestamp regime. The renew signature already binds
`timestamp` (`renewSigningPayload`, `payloads.ts:60-75`, includes `body.timestamp`), so an attacker
cannot forge a fresher timestamp onto a captured frame — replay is exact-frame only. That makes a
timestamp gate a *complete* freshness regime for renews:

1. **Skew window** (same constants the register path uses): reject when
   `msg.timestamp < now - maxAgeMs` (stale) or `msg.timestamp > now + maxFutureSkewMs` (implausibly
   future). Reuse `DEFAULT_REPLAY_MAX_AGE_MS` (60 s) / `DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS` (5 s) from
   `antidos/replay-guard.ts`.
2. **Per-record monotonicity**: reject when `msg.timestamp <= rec.lastPing`. This closes the sub-`maxAge`
   fast-replay window using state already on the record. Walk the attack:
   - Captured `withdraw` (timestamp `t0`) replayed after re-registration: the re-registered record has
     `lastPing = t_reregister > t0`, so `t0 <= lastPing` → rejected. (Skew alone would miss this when the
     whole sequence fits inside 60 s.)
   - Captured `reattach` replayed repeatedly: the first accepted reattach re-stamps `lastPing = now`; the
     replay's `t0 <= lastPing` → rejected.

Together these need no new per-renew state and share the register path's one skew constant — the "one
freshness regime" the fix ticket asked for, expressed in the form the renew shape actually supports.

## Behavior on rejection

Mirror each branch's existing forged-signature outcome so a stale/replayed frame is indistinguishable
from an untrusted one and reveals nothing:

- `withdraw` fails freshness → return `{ v: 1, result: "unknown_registration" }` (same opaque answer the
  forged-sig branch returns at `renewal.ts:321-323`). Do **not** delete the record.
- `reattach` fails freshness → return `primaryMoved(primary, backups, cohortEpoch)` (the redirect the
  forged-sig branch falls through to at `renewal.ts:338-340`). Do **not** promote.

## Scope: privileged branches only

Apply the freshness gate to the `withdraw` and `reattach` branches, **not** to plain pings. A plain ping
only advances `lastPing`; the strict `timestamp <= lastPing` monotonic check would risk rejecting a
legitimate ping that arrives slightly out of order or under minor participant-clock non-monotonicity, and
a replayed plain ping is low-harm (it can only re-touch a record's `lastPing`, never delete or usurp).
Record that residual as a `NOTE:` tripwire at the plain-ping site rather than guarding it — see TODO.

## Wiring

Thread the skew config so both paths read one source:

- Add an optional freshness config to `RenewalCohortSideDeps` (`renewal.ts:258-283`), e.g.
  `freshness?: { maxAgeMs?: number; maxFutureSkewMs?: number }`, defaulting to the two `DEFAULT_REPLAY_*`
  constants imported from `antidos/replay-guard.ts`. Absent → defaults (keeps existing key-less unit
  tests and callers working, matching how `verifyParticipantSig` is optional).
- In `host.ts` where `createRenewalCohortSide(...)` is constructed, pass
  `freshness: ctx.antiDos.replayGuard` (the same `{ maxAgeMs, maxFutureSkewMs }` the register-path
  `createCorrelationReplayGuard` already consumes at `host.ts:1736`), so an operator tuning the skew
  window moves both paths together.

`now` is a real wall clock on both entry points (`resolveRenew` passes `Date.now()` at `host.ts:2637`;
`handleRenew` forwards it to `onRenew`), so the skew comparison is meaningful in production and remains
injectable in tests.

## Repro (write these tests first, in `db-core/test/cohort-topic/registration.spec.ts`)

- **Stale withdraw**: register (record `lastPing = t0`); build a signed `withdraw` at `t0`; deliver it at
  `now = t0 + maxAgeMs + 1`. Expect `unknown_registration` and the record still present (no
  `store.delete`, no `gossip.evicted`).
- **Replayed withdraw after re-registration**: register at `t0`; capture a `withdraw` at `t0`; simulate
  re-registration bumping `lastPing` to `t2 > t0`; replay the captured withdraw at `now` within the skew
  window. Expect rejection via the monotonic check; live record survives.
- **Replayed reattach**: as a legitimate backup, accept one `reattach` (record re-stamped, `lastPing`
  advanced); replay the identical frame. Expect the second to return `primaryMoved` (no second re-stamp,
  no second `gossip.touch`).
- **Happy paths still pass**: a fresh `withdraw` (timestamp `> lastPing`, inside window) still evicts; a
  fresh `reattach` still promotes; a normal ping stream (unchanged, unguarded) still touches.

## TODO

- [ ] In `renewal.ts` import `DEFAULT_REPLAY_MAX_AGE_MS` / `DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS` from
      `../antidos/replay-guard.js` and add optional `freshness` to `RenewalCohortSideDeps`, resolving the
      two values (with defaults) in the `StoreRenewalCohortSide` constructor.
- [ ] Add a private freshness predicate, e.g. `isFreshPrivileged(msg, rec, now): boolean` — returns
      `false` when `msg.timestamp < now - maxAgeMs`, `msg.timestamp > now + maxFutureSkewMs`, or
      `msg.timestamp <= rec.lastPing`.
- [ ] In the `withdraw` branch (`onRenew` ~314-328), after the `verifyParticipantSig` check, reject a
      non-fresh frame with `{ v: 1, result: "unknown_registration" }` before `store.delete`.
- [ ] In the `reattach` branch (~334-365), after the `verifyParticipantSig` check, reject a non-fresh
      frame with `primaryMoved(primary, backups, cohortEpoch)` before any promotion.
- [ ] Leave the plain-ping branch (~367-380) unchanged; add a `NOTE:` comment there recording that plain
      pings are deliberately unguarded by the freshness regime (low-harm re-touch only) so a future reader
      meets the tripwire.
- [ ] In `host.ts`, pass `freshness: ctx.antiDos.replayGuard` to `createRenewalCohortSide(...)`.
- [ ] Add the four repro/regression tests above to
      `packages/db-core/test/cohort-topic/registration.spec.ts`.
- [ ] Build + test the touched packages, streaming output:
      `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/db-core-test.log` and the db-p2p build
      (`yarn workspace @optimystic/db-p2p build 2>&1 | tee /tmp/db-p2p-build.log`). Confirm no type errors
      from the new `RenewalCohortSideDeps` field.
- [ ] Hand off to review with an honest note on the plain-ping scoping decision and the divergence from
      the fix ticket's CorrelationReplayGuard hint (explained above).
