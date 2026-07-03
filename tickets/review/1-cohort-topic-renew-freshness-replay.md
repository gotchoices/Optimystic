description: A signed "I'm leaving"/"I'm taking over" message could be replayed forever to delete a member's live registration; this adds a freshness check that rejects stale or replayed ones. Review the freshness rule and its clock assumptions.
prereq:
files:
  - packages/db-core/src/cohort-topic/registration/renewal.ts                 # freshness gate: isFreshPrivileged + withdraw/reattach branches + plain-ping NOTE
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts                  # DEFAULT_REPLAY_MAX_AGE_MS / DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS (reused constants)
  - packages/db-p2p/src/cohort-topic/host.ts                                   # createRenewalCohortSide now passes freshness: ctx.antiDos.replayGuard
  - packages/db-core/test/cohort-topic/registration.spec.ts                    # 4 new repro tests + monotonic-timestamp updates to existing privileged tests
  - packages/db-p2p/test/cohort-topic/service.spec.ts                          # buildMockService gained an injectable clock; withdraw test drives it
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts                   # reattach timestamps made monotonic
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts                        # reattach timestamps made monotonic
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts            # reattach timestamps made monotonic (skip-gated suite; not run here)
difficulty: medium
----

# Review: freshness + anti-replay on the privileged renew path

## Plain-language summary

A participant can send two kinds of *privileged* renew message to its cohort:
- **withdraw** — "I'm leaving, free my registration now" (evicts the record).
- **reattach** — "my primary died, you (a backup) take over" (re-stamps the primary).

Both are signed, but the signature had **no time component being enforced**, so a captured copy stayed
valid forever. An attacker who recorded one could replay it later — e.g. after the victim's record
expired and the victim re-registered — and the stale message would delete the *fresh* registration (or
force bogus primary re-stamps). This change adds a **freshness check** so a stale or replayed privileged
message is rejected, returning the same opaque answer an untrusted message already gets.

## What was implemented

A single freshness predicate on the cohort side, `isFreshPrivileged(msg, rec, now)`
(`renewal.ts:338`), applied to the **withdraw** and **reattach** branches only. It rejects when the
signed `msg.timestamp` is:
1. **stale** — older than `now − maxAgeMs`,
2. **implausibly future** — newer than `now + maxFutureSkewMs`, or
3. **non-monotonic** — `<= rec.lastPing` (the record's last successful touch).

On rejection each branch returns its existing **forged-signature** outcome, so a stale/replayed frame is
indistinguishable from an untrusted one and leaks nothing:
- withdraw → `{ v: 1, result: "unknown_registration" }`, no delete.
- reattach → `primaryMoved(primary, backups, cohortEpoch)`, no promotion.

The skew window reuses the register path's constants (`DEFAULT_REPLAY_MAX_AGE_MS` = 60 s,
`DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS` = 5 s). `RenewalCohortSideDeps` gained an optional
`freshness?: { maxAgeMs?; maxFutureSkewMs? }` (defaults to those constants when absent, so key-less unit
tests and other callers are unaffected). In `host.ts` it is wired to `ctx.antiDos.replayGuard` — the
exact same `{ maxAgeMs, maxFutureSkewMs }` config the register path already consumes — so an operator
tuning the skew window moves both paths together.

The signed timestamp is immutable to a replayer (`renewSigningPayload` includes `body.timestamp`), so
replay is exact-frame only; a timestamp gate is therefore a complete freshness regime here. This does
**not** reuse the register path's `CorrelationReplayGuard` seam — a `RenewV1` reuses the original
register's `correlationId` on every ping, so routing it through the single-use guard would reject every
legitimate renew after the first. (This was the fix ticket's suggested hint; the ticket body already
explained the divergence, and it holds.)

## Use cases to validate

**Attack cases now blocked (all four have repro tests in `registration.spec.ts`):**
- **Stale withdraw** — withdraw stamped inside the record's `lastPing` monotonic bound but delivered a
  full `maxAge` window later → rejected on the skew check; the live record survives, no eviction gossip.
- **Replayed withdraw after re-registration** — capture a withdraw at `t0`; record TTL-expires and
  re-registers with `lastPing = t2 > t0`; replay the captured frame *inside* the skew window → rejected
  by the monotonic check (skew alone would miss it). The fresh record survives.
- **Replayed reattach** — the first legit reattach re-stamps `lastPing = now`; replaying the identical
  frame is `<= lastPing` → redirected, not re-stamped, and no second gossip touch.
- **Implausibly-future privileged frame** — beyond `maxFutureSkewMs` → rejected.

**Happy paths still work (regression-covered):**
- A fresh withdraw (timestamp `> lastPing`, inside window) still evicts.
- A fresh reattach (timestamp `> lastPing`, inside window) still promotes the computed backup.
- A normal ping stream still touches (plain pings are **not** gated — see scoping below).

## Scoping decision (honest note): plain pings are deliberately unguarded

The freshness gate is applied to withdraw/reattach only, **not** plain pings. A replayed plain ping is
low-harm — it can only re-touch a record's `lastPing`, never delete or usurp — and the strict
`timestamp <= lastPing` check would risk rejecting a legitimate ping that arrives slightly out of order
or under minor participant-clock non-monotonicity. This is recorded as a `NOTE:` tripwire at the
plain-ping site (`renewal.ts`, the `// Plain ping.` block) so a future reader meets it. **Index-only
mention per the tripwire rule; the analysis lives at the code site.**

## The main thing to review: the monotonic check compares two different clocks

`isFreshPrivileged`'s condition (3), `msg.timestamp <= rec.lastPing`, compares a **participant-supplied**
`timestamp` against a **server-maintained** `lastPing` (set by whichever cohort member last touched the
record, from its own `Date.now()`). These are different machines' clocks. Implications a reviewer should
weigh:

- **Correctness in the common case:** a genuine reattach/withdraw always post-dates the participant's
  last successful ping, so `timestamp > lastPing` holds in normal operation. This is why the *synthetic*
  "register at `now`, then immediately act at `now`" idiom several existing db-p2p tests used had to be
  made monotonic (see below) — that same-instant collision does not model a real leave/failover.
- **Clock-skew false-rejection (tripwire, not a filed ticket):** if the participant's clock lags the
  server that set `lastPing`, a *legitimate* reattach can be rejected. The failure mode is **soft**: a
  rejected reattach returns `primary_moved`, so the participant's failover loop tries the next backup or
  re-runs the `d_max` lookup — a delayed failover, not data loss or a hang. This is recorded as a `NOTE:`
  at `isFreshPrivileged`; if cross-node skew is ever observed to stall failovers, the mitigation is to
  relax condition (3) to `<` (accept `timestamp == lastPing`) — see next bullet.
- **Strict `<=` vs relaxed `<` (the design fork):** the ticket specified strict `<=`, implemented as-is.
  The alternative `<` (accept equality) would keep the same-instant test idiom working with **no** test
  changes and reduce skew false-rejections, at the cost of a *very* narrow theoretical gap: a reattach
  replay whose original frame was processed at exactly `now == timestamp` (zero server latency) and
  replayed within 60 s. That gap is backstopped by the `maxAge` age window (re-registration always takes
  longer than TTL 90 s > `maxAge` 60 s, so the withdraw-after-re-registration attack is *also* caught by
  the age check alone). **Recommendation for the reviewer:** decide whether the strict `<=`'s
  skew-sensitivity is worth its marginal replay tightening; if not, relaxing to `<` is a one-character
  change plus reverting the test-timestamp bumps. I kept `<=` because it is what the ticket specified and
  it is a security decision that deserves an explicit second opinion rather than a silent relaxation.

## Test changes beyond the new repros (and why)

Because the monotonic contract now requires privileged frames to carry `timestamp > lastPing`, several
**existing** tests that used a same-instant `register(now) → reattach/withdraw(now)` shortcut had to be
made monotonic. These are legitimate flows expressed with a compressed clock, not bugs being masked:

- `registration.spec.ts` — `renewMsg` gained a 4th `timestamp` param; privileged happy-path tests now
  stamp their frame ~10 ms before the delivery `now` (a frame is signed just before it is processed).
- `gossip-cadence.spec.ts` / `live-tier.spec.ts` — reattach timestamps bumped past the register's
  `lastPing`.
- `service.spec.ts` — `buildMockService` gained an **injectable clock** used for both the server-side
  handling `now` and the participant's renew timestamps; the withdraw test advances it (`1_000 → 2_000`)
  so the leave post-dates the last ping. This exposed that the participant timestamp and server `now` are
  separate clocks (see the review section above).
- `substrate-real-libp2p.integration.spec.ts` — same monotonic bump at three reattach sites. **This
  suite is `describe.skip` unless `OPTIMYSTIC_INTEGRATION=1` and was NOT executed here** (real libp2p,
  not agent-runnable). The edits are defensive; a reviewer running the integration suite should confirm
  them.

## Validation performed

- `yarn workspace @optimystic/db-core test` → **1058 passing** (includes the 4 new repros + updated
  privileged tests).
- `yarn workspace @optimystic/db-core build` → clean.
- `yarn workspace @optimystic/db-p2p build` → clean (confirms the new `RenewalCohortSideDeps.freshness`
  field and host wiring typecheck).
- db-p2p cohort-topic specs (`test/cohort-topic/**/*.spec.ts`) → **207 passing** after the monotonic
  test fixes (5 initially regressed by the gate, all now green — see the design-fork section for why they
  regressed).

## Known gaps / where a reviewer should push

- The strict-`<=` clock-coupling above is the highest-value thing to scrutinize. The tests are a floor;
  they exercise the gate with coincident single-process clocks, **not** genuine cross-node skew.
- No test exercises a real multi-node reattach where the backup's replicated `lastPing` (primary's
  clock) is compared against the reattaching participant's `timestamp`. The unit + mock tests approximate
  it; the skip-gated integration test is the closest real-transport coverage and was not run.
- The plain-ping unguarded decision (tripwire) is a judgment call worth a second look if plain-ping
  replay ever gains a harm vector (e.g. touch-driven traffic accounting being abused).
