description: The inbound `promote` protocol handler (gap 4) runs `verifyAndApplyNotice` on every frame any peer sends, with no per-peer rate limit, replay guard, or freshness check — unlike the register path, which is gated by the anti-DoS guards. Each *untrusted* notice still drives a `MembershipVerifier.verifyMessage` whose single stale-cert refetch issues a network membership fetch, so a peer can spam forged `promote` frames and amplify each into a cohort dial. Newly reachable because the handler went from a no-op to live verification in gap 4.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (promote handler at L935 — no rate/replay/freshness gate before verifyAndApplyNotice)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (verifyMessage L64 — on cache/stale miss issues source.fetch() refetch, one per failing notice)
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts (RegisterRateLimiter — the register-path gate that has no promote-path analogue)
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts (CorrelationReplayGuard — register-path only)
----

# Cohort-topic: the inbound promote handler is an un-gated verify/refetch amplification vector

## The gap

Before gap 4 the `promote` handler was `async () => undefined` — a frame from any peer was a no-op.
Gap 4 made it live:

```ts
node.handle(protocols.promote, makeFrameHandler(async (frame) => {
  const inbound = decodeInboundNotice(frame, maxBytes);
  if (inbound === undefined) { log(...); return undefined; }
  const tier = inbound.kind === "promotion" ? inbound.notice.fromTier : inbound.notice.tier;
  const target = registry.findServing(b64urlToBytes(inbound.notice.topicId), tier);
  const outcome = await verifyAndApplyNotice(inbound, target, verifier, Date.now());
  ...
}, maxBytes));
```

There is **no per-peer rate limit, replay guard, or freshness window** before the work. Compare the
register path, which (once `cohort-topic-host-antidos-coldstart` lands) runs `RegisterRateLimiter` +
`CorrelationReplayGuard` + `TopicBudget` + bootstrap-evidence before doing anything expensive. The
promote path has no analogue.

The expensive part is `verifyAndApplyNotice → verifier.verifyMessage`. On a verification *miss*
(forged signers, short quorum, wrong cohort) the verifier does its single stale-cert refetch:

```ts
const refreshed = await this.loadFrom(source.fetch(expectedCoord)); // network membership fetch
```

So **every** untrusted notice — even when the node already has the correct cert cached (the cached cert
fails `messageVerifies`, which then forces the one refetch) — issues a membership fetch (a cohort dial).
A peer that streams forged `promote` frames amplifies each cheap frame into a network round-trip plus a
multisig verification. Forged frames are also never `effectiveAt`-gated (the high-water guard lives in
the apply step, which a forged notice never reaches), so there is no dedup throttle either.

## Why it matters now

This vector did not exist while the handler was a no-op; gap 4 opened it. The register protocol is
defended; the promote protocol — equally reachable by any dialer — is not.

## Options to decide

- **Reuse the register-path guards on the promote handler**: a per-peer rate limiter keyed on the
  dialing peer (the handler already has `connection.remotePeer` via `makeFrameHandler`'s `from`) and a
  freshness window on `effectiveAt`/`cohortEpoch` to drop stale/replayed notices *before* verification.
- **Cap or suppress the verifier refetch for promote traffic**: pass a "no-refetch" mode to
  `verifyMessage` for inbound notices (rely on the cached cert only — the node caches its own cohort
  cert via `onCertPublished`), or rate-limit refetches per coord, so a forged frame cannot force an
  unbounded fetch rate. Trades a small correctness window (a genuinely stale cache) for DoS resistance.
- **Both**: cheap pre-verify gating + bounded refetch.

## Acceptance

- A peer streaming forged `promote` frames cannot drive more than a bounded membership-fetch rate per
  coord and is rate-limited per peer. Add a db-p2p test that floods forged notices and asserts the
  refetch/verify count is bounded.
- A stale/replayed notice (`effectiveAt` older than the last adopted transition, or a stale
  `cohortEpoch`) is dropped before `verifyMessage` runs.
- Legitimate notices still verify and apply (no regression in `promote-notice.spec.ts`).

## Notes

- Surfaced by the gap-4 review (`cohort-topic-promote-verify-apply`).
- Adjacent to `cohort-topic-host-antidos-coldstart` (gap 6), which wires the register-path guards but
  is scoped to `RegisterV1` on the register protocol — it does **not** cover the promote protocol.
  Whoever picks this up should reuse those guard modules rather than inventing new ones.
