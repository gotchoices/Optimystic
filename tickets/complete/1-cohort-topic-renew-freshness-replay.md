description: A signed "I'm leaving"/"I'm taking over" message could be replayed forever to delete a member's live registration; a freshness check now rejects stale or replayed ones. Reviewed and completed.
prereq:
files:
  - packages/db-core/src/cohort-topic/registration/renewal.ts
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-core/test/cohort-topic/registration.spec.ts
  - packages/db-p2p/test/cohort-topic/service.spec.ts
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
  - docs/cohort-topic.md
----

# Complete: freshness + anti-replay on the privileged renew path

## What shipped

A freshness predicate `isFreshPrivileged(msg, rec, now)` (`renewal.ts`) gates the two privileged,
participant-attested renew branches — **withdraw** (leave, evict record) and **reattach** (crash-failover
promotion). It rejects a signed `msg.timestamp` that is stale (older than `now − maxAgeMs`), implausibly
future (newer than `now + maxFutureSkewMs`), or non-monotonic (`<= rec.lastPing`). On rejection each branch
returns its existing forged-signature outcome (withdraw → `unknown_registration`, no delete; reattach →
`primary_moved`, no promotion), so a stale/replayed frame is indistinguishable from an untrusted one.

The signed renew body includes `timestamp` (`renewSigningPayload`), so a captured frame is replayable only
byte-for-byte — a timestamp gate is therefore a complete freshness regime. The skew window reuses the
register path's replay-guard config, wired in `host.ts` as `freshness: ctx.antiDos.replayGuard`, so an
operator tuning the window moves both paths together. Plain pings are deliberately **not** gated (a replayed
ping only re-touches `lastPing`).

## Review findings

**Scope reviewed:** the implement diff (commit `e53ab6b`) with fresh eyes before the handoff — the gate
logic, both call sites, the `host.ts` wiring, all test changes, the register-path constants it reuses, the
signing payload (to confirm `timestamp` is signed → replay is exact-frame), and the wire types. Ran the full
db-core suite, db-core + db-p2p builds, and the db-p2p cohort-topic suite.

**Correctness / security — no defects found.** The gate blocks all four attack cases with repro tests; the
`<= lastPing` monotonic check and the `maxAge` window each independently catch the
withdraw-after-re-registration replay (double coverage). Rejection reuses the pre-existing forged-frame
responses, so it introduces no new information leak (a reattach reject revealing "record still exists" via
`primary_moved` is identical to the pre-existing forged-sig reattach behavior). The `host.ts` wiring passes
the correct type — `ctx.antiDos.replayGuard` is `CorrelationReplayGuardConfig` (`{ maxAgeMs?, maxFutureSkewMs? }`),
the config object the gate expects, not a guard instance. `createRenewalCohortSide` has exactly one
production caller (`host.ts`), so the always-on-by-default gate affects no other path.

**Minor — fixed inline (2):**
- *Missing tripwire home.* The handoff claimed the cross-clock-skew concern was parked as a `NOTE:` at
  `isFreshPrivileged`, but no such comment existed — only the one at the plain-ping site. Per the tripwire
  rule the analysis must live at the code site, not only in the findings index. Added a greppable `NOTE:` at
  the `timestamp <= rec.lastPing` check documenting that it compares a participant clock against a
  server-maintained `lastPing`, that a lagging participant clock yields a *soft* false-rejection (returns
  `primary_moved` → the failover loop retries the next backup / re-runs the `d_max` lookup — delayed
  failover, not data loss), and that the mitigation if skew ever stalls failovers is to relax the check to
  strict `<`.
- *Stale docs.* `docs/cohort-topic.md` described the withdraw/reattach paths as signature-gated only. Added
  a "Privileged-path freshness (anti-replay)" note to the participant-signature section covering the new
  gate, the three reject conditions, the shared replay-guard config, and that plain pings are ungated.

**Tripwires (conditional; recorded at their sites, not filed as tickets):**
- *Plain pings ungated* — `NOTE:` at the `// Plain ping.` block in `renewal.ts`. Fine now (a replayed ping
  only re-touches `lastPing`); revisit if plain-ping replay ever gains a harm vector (e.g. touch-driven
  traffic accounting being abused).
- *Cross-clock monotonic check* — `NOTE:` at `isFreshPrivileged` (added this pass, see above). Fine now;
  relax `<=` → `<` if cross-node skew is ever observed to stall legitimate failovers.

**Design fork (`<=` vs `<`) — no change.** The implementer surfaced strict `<=` vs relaxed `<` as a security
decision wanting a second opinion. Concur with keeping strict `<=`: the marginal replay-tightening is real,
the skew false-rejection it costs is soft (TTL/next-backup fallback), and the withdraw-after-re-registration
attack is backstopped by the `maxAge` window regardless. The tripwire above records the escape hatch if that
tradeoff ever bites.

**Not exercised (unchanged from handoff, no action):** the skip-gated real-libp2p integration suite
(`substrate-real-libp2p.integration.spec.ts`) was not run here (requires `OPTIMYSTIC_INTEGRATION=1`, real
transport, not agent-runnable). Its three reattach timestamp bumps (`now` → `now + 1`) were eyeballed and
are mechanically correct against the gate; a human running the integration suite should confirm.

## Validation

- `yarn workspace @optimystic/db-core build` → clean (re-run after the added `NOTE:` comment).
- `yarn workspace @optimystic/db-core test` → **1058 passing**.
- `yarn workspace @optimystic/db-p2p build` → clean.
- db-p2p `test/cohort-topic/**/*.spec.ts` → **207 passing, 4 pending** (skip-gated).
- No lint step is configured in this monorepo (`package.json` `lint` is a no-op echo).

## End
