description: Clamp registration TTL at every admission path in the cohort-topic member engine so no record — local or gossip-replicated — can carry an unbounded lifetime that permanently wedges a per-cohort topic budget slot.
prereq:
files:
  - packages/db-core/src/cohort-topic/registration/types.ts
  - packages/db-core/src/cohort-topic/member-engine.ts
  - packages/db-core/src/cohort-topic/gossip/bus.ts
  - packages/db-core/test/cohort-topic/member-engine.spec.ts
  - packages/db-core/test/cohort-topic/gossip.spec.ts
  - docs/cohort-topic.md
difficulty: easy
----

## What shipped

TTL admitted into the registration store is now clamped into `[MIN_TTL_MS, MAX_TTL_MS]`
(10 s … 15 min) at **every** path that writes a fresh TTL into the store.

### Implement stage (unchanged, verified correct)
- `MIN_TTL_MS` / `MAX_TTL_MS` constants in `registration/types.ts`.
- `accept()` in `member-engine.ts` clamps `reg.ttl`.
- Four `accept()` clamp tests in `member-engine.spec.ts`.

### Review stage (added this pass)
- **Shared policy helper** `clampTtl(ttl)` in `registration/types.ts` — the single TTL gate;
  non-positive input falls to `DEFAULT_TTL_MS` first, then clamps to `[MIN_TTL_MS, MAX_TTL_MS]`.
  `accept()` now calls it (replacing the inline `Math.min/Math.max`).
- **Gossip merge clamp** in `gossip/bus.ts` `mergeRecords`: every replicated record runs through
  `clampTtl` immediately after decode, *before* the stale-drop check — closing the second
  admission path (see finding below).
- **Regression test** in `gossip.spec.ts`: a gossiped record with `ttl: 1e15` is stored clamped
  to `MAX_TTL_MS`.
- **Docs**: `docs/cohort-topic.md` §TTL and renewal now documents the clamp, its bounds, and that
  both admission paths enforce it.

## Test results

`yarn workspace @optimystic/db-core test` → **1067 passing** (was 1066; +1 gossip clamp test).
`yarn workspace @optimystic/db-core build` (tsc) → exit 0.

## Review findings

**Checked:** the implement diff first (fresh eyes), then every `store.put` path in
`cohort-topic/` (member-engine, gossip bus, handoff, renewal), the two other record-write
subsystems, TTL flow through gossip encode/decode, existing gossip + member-engine tests, and
`docs/cohort-topic.md`.

- **MAJOR (fixed inline) — gossip replication bypassed the clamp.** The implement handoff asserted
  "gossip records reflect already-clamped values." That premise is false: `gossip/bus.ts`
  `mergeRecords` is a *second* admission path — it decodes an incoming `GossipRecordV1` straight to
  a `RegistrationRecord` (`ttl: g.ttl`, unclamped) and `store.put`s it. A cohort member running
  unpatched/old code, a buggy member, or a hostile-but-membership-valid member (the `verifyInbound`
  gate only checks peer-sig + cohort membership, not TTL range) could replicate `ttl: 1e15`, and
  every receiver stored it verbatim — the exact budget-wedge the ticket set out to prevent, still
  fully reachable. Worse, the pre-merge stale-drop check (`now − lastPing > ttl`) *let a poison TTL
  survive* rather than drop. Fixed by clamping in `mergeRecords` before the stale check and routing
  both paths through one `clampTtl` helper (DRY, single policy gate). This was fixed inline rather
  than filed because the ticket's stated guarantee is false without it.

- **Verified safe — the other `store.put` paths do not reintroduce unclamped TTL.**
  `handoff.ts:124` (`{ ...rec, primary, backups }`) and `renewal.ts:421/458` (restamp/touch) all
  spread an *already-stored* record and mutate only primary/backups/lastPing — never `ttl`. So the
  only two paths that write a fresh wire-supplied TTL are `accept()` and gossip merge, both now
  clamped.

- **Tripwires / latent defects:** none. The wire validator (`wire/validate.ts`) intentionally stays
  a pure structural decoder; clamping at the two policy boundaries is sufficient and is the right
  seam — not a deferred concern.
