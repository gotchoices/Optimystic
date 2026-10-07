description: A node that has a signing key should start a new network watch by signing a small endorsement of its own request instead of solving a proof-of-work puzzle that a phone cannot finish in time; the puzzle stays only for participants with no key. The documents are corrected to say what actually limits cold starts.
architecture: docs/cohort-topic.md#anti-dos
files: packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts, packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts, docs/cohort-topic.md, docs/reactivity.md
----
GitHub: [#31](https://github.com/gotchoices/Optimystic/issues/31). Decided by the maintainer (2026-10-07): option A — honest nodes sign their own endorsement; proof of work stays only as the fallback for participants with no key. The thread-blocking half of #31 already landed (`pow-mint-yields-the-thread-and-stops-before-its-timestamp-goes-stale`: the mint yields every 50 ms and gives up after half the replay window).

## Why

A "cold start" is the first registration at a topic's root, or at a new deeper tier of its tree. The serving group demands evidence for it ([docs/cohort-topic.md §Anti-DoS](../../docs/cohort-topic.md#anti-dos)). The policy (`createBootstrapEvidence` in `packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts`) accepts, at tiers 2 and 3, a proof of work **or** a reputation endorsement **or** a signed parent-topic reference; at tiers 0 and 1 it accepts only the parent reference.

The reputation verifier (`createReputationVerifier` in `packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts`) accepts an endorsement whose referee is the participant itself, and an unseen referee scores 0, which is "sufficient". So any participant can skip the proof of work at T2/T3 by signing the bound fields with a freshly generated key. The proof of work is therefore paid only by honest nodes, because our own builder chooses it. Reactivity registers at T3 (`Tier.T3` in `packages/db-p2p/src/reactivity/subscription-manager.ts`), and a production node always has a reputation view (`libp2p-node-base.ts` wires `antiDos: { reputation, … }` into the host), so today every first watch of a log block mints a 20-bit proof of work: 0.9–4.0 s on one desktop core, minutes on an Android emulator, and useless past 60 s because the register's timestamp is inside the hash and the replay guard drops anything older.

The change is participant-side only: no verifier, policy or wire change. Security is unchanged, because the free path already exists for anyone who reads the verifier.

## Design

### Builder (`createBootstrapEvidenceBuilder`, `packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts`)

New decision, per tier:

| tier | `endorse` supplied | `endorse` absent |
| --- | --- | --- |
| ≤ `maxNoPowTier` (T0/T1) | `undefined` | `undefined` |
| > `maxNoPowTier` (T2/T3) | `{ v: 1, reputation }` — no proof-of-work search | proof of work, as today |

- **T0/T1 stops endorsing.** The policy consults only the parent reference at those tiers, so the reputation envelope the builder mints there today is a signature nobody reads. Origination at T0/T1 is admitted today only because a production node has no committed-parent backing and stays permissive-but-logged there (`createBootstrapEvidencePolicy` in `host.ts`); minting a parent reference is the separate follow-on `cohort-topic-parent-ref-tx-log-content`. Returning `undefined` makes the builder offer evidence only at tiers whose policy accepts it.
- **T2/T3 endorses when it can.** `endorse(bootstrapBoundImage(bound))` → `rawEnvelopeBytes({ v: 1, reputation })`. The proof-of-work search, its slice/yield/time-budget machinery and its `NOTE:`s stay unchanged for the keyless path.
- Rewrite the module header and the `endorse` field doc to say this: the endorsement is the evidence a key-ful node offers at every tier that accepts it; proof of work is what a participant with no key pays. Drop the "interim T0/T1 path" wording.
- Add a `NOTE:` tripwire at the T2/T3 endorse branch: a serving group whose reputation view has this key banned or at/above the deprioritize threshold refuses the endorsement, and the builder does not fall back to proof of work (the register reply is a generic `unwilling_cohort`, so the participant cannot tell an evidence refusal from any other). That is the reputation subsystem doing its job for a misbehaving key; if honest-but-penalized keys (a flaky phone accumulating timeouts) are seen to lose their watches in practice, carry a proof of work alongside the endorsement once a key is known to be refused, or have the register reply name an evidence refusal so the participant can retry with proof of work.

### Host wiring (`createCohortTopicHost`, `packages/db-p2p/src/cohort-topic/host.ts`)

At the "participant-side cold-start evidence builder (gap 6)" block, supply `endorse` when `options.privateKey` is defined:

```ts
endorse: nodeKey === undefined ? undefined : async (boundImage: Uint8Array): Promise<ReputationEvidenceV1> => ({
	referee: bytesToB64url(selfMemberBytes),
	sig: bytesToB64url(await signPeer(nodeKey, boundImage)),
}),
```

`selfMemberBytes` is `peerIdToBytes(node.peerId)` — the same participant identity the register's own signature uses (`createParticipantSigner` signs with the same key), and the referee encoding `createReputationVerifier` decodes with `bytesToPeerIdString`. `signPeer` and `nodeKey` (`const nodeKey = options.privateKey`) already exist in that function; reuse them. `bootstrapBoundImage` is domain-tagged `"BootstrapEvidenceV1"`, distinct from `registerSigningPayload`, so one key signing both is safe.

Rewrite the comment above the builder (it currently says T0/T1 endorsement is "intentionally left unwired") and the host module header's anti-DoS paragraph (the "participant-side PoW minter" sentence) to match: a key-ful host self-endorses at T2/T3; a keyless host mints proof of work.

### Verifier (`createReputationVerifier`)

No behaviour change. Add a `NOTE:` at the "An unknown referee scores `0` … and so is sufficient" doc line recording the accepted tradeoff: a self-vouch from a never-seen key is free, so this path does not make a cold start cost anything; what bounds cold starts is listed in docs/cohort-topic.md §Anti-DoS. Revisit condition: if fresh-key cold-start churn shows up as real abuse (topic-budget eviction of live topics, or the coordinate-engine cap refusing coords), require recorded positive history for a referee — which needs the reputation service to define a "trusted" level it does not have today — and make proof of work a real cost for new identities, with a lower network-wide difficulty and/or native mining on React Native so phones can still pay it (option B in the plan; it changes what serving groups accept, so it needs a rollout note).

### Docs

- **docs/cohort-topic.md §Anti-DoS**, bullet "Cold-start requires evidence": replace "T2/T3 topics do [need PoW]" with what happens: at T2/T3 a participant with a peer key signs a self-endorsement of the bound tuple (one signature), and one with no key mints a proof of work. State plainly that because an unseen referee is sufficient, neither is a cost an abuser must pay — a fresh key is free — and that what bounds cold starts at T2/T3 is: the per-peer register rate limit, the per-cohort topic budget (`topics_max`, zero-participant topics evicted first), the coordinate-engine cap (`coordEnginesMax`), the replay guard, and the reputation subsystem's ability to ban a key that misbehaves. Mention that proof of work cannot be lowered per device (the serving group cannot tell a phone from an abuser), which is why it is the keyless fallback and not the default.
- Same section, the implementation note's **Proof-of-work** sub-bullet: say it is the keyless participant's evidence; keep the mint-cost and yield/give-up description.
- Same section, the **Reputation endorsement** sub-bullet: replace "The participant-side *minting* of an endorsement is not wired into the host yet … not auto-minted on every register" with: the host supplies the builder's `endorse` from its peer key whenever it has one, so a key-ful node's T2/T3 cold start carries a self-endorsement and no proof of work; T0/T1 carries none (the policy accepts only a parent reference there).
- **docs/reactivity.md** §The node's watch service, the **Attach** bullet: it says a T3 cold-start register "carries a proof of work … so a first attach on that mesh measured between 0.3 s and 17 s, 3 s at the median, nearly all of it the proof". Rewrite: the register carries the subscriber's self-endorsement (one signature), or a proof of work when the node has no key. Drop the 0.3–17 s figures, which measured the proof; do not substitute a new number unless you measure it (the 22–111 ms cohort-wait figure in the same bullet stays).
- Run `yarn lint:docs` — the edited prose cites `createBootstrapEvidenceBuilder`, `createReputationVerifier` and paths that must resolve.

## Edge cases & interactions

- **Keyless host** (`options.privateKey` undefined): `endorse` undefined → proof of work at T2/T3, exactly today's behaviour. Verified by inspection plus the existing PoW builder test.
- **Serving group configured with verifier overrides but no reputation view** (`antiDos.bootstrapEvidence` set, `reputation` absent): its reputation verifier is a fail-closed deny, so a self-endorsement is refused. Production always wires `reputation` (`libp2p-node-base.ts`), so only a test or embedder override can produce this. By inspection: grep the db-p2p tests and harnesses for `antiDos` — `host-antidos-coldstart.spec.ts` builds evidence by hand and never runs the participant builder; `reactivity-mesh-harness.ts` and `matchmaking-mesh-harness.ts` configure no reputation and no override, so their serving side is entirely unconfigured and permissive. Confirm nothing else depends on the participant minting proof of work.
- **Banned or deprioritized participant key at the serving group**: refused, no proof-of-work fallback — the `NOTE:` tripwire above. Self-scoring cannot happen: `PeerReputationService` refuses reports naming its own node (`refuseSelfReport`), so a node in its own serving group scores itself 0.
- **Follow-on cold start** (`followOn: true` at a deeper tier): the service calls the same builder with the deeper tier, so it endorses at T2/T3 the same way. By inspection of the `buildBootstrapEvidence` call in `packages/db-core/src/cohort-topic/service.ts`.
- **`endorse` throws** (signing failure): propagates out of the register build exactly as a `signRegister` failure on the same key would. No special handling. By inspection.
- **Key and peer id disagree** (harness misconfiguration): the endorsement signature fails verification, as does the register's own signature, which is checked first; no new failure mode.
- **Mixed versions**: an old serving node already runs the same reputation verifier, so a new participant's endorsement is admitted there; an old participant still mints proof of work, which a new serving node still accepts. No wire or policy change, so no migration note.
- **Matchmaking** providers and seekers cold-start through the same builder and now self-endorse at T2/T3 too. Intended.
- **Integration suites** (`yarn test:integration`) run real nodes with a reputation view and a private key, so their T2/T3 cold starts switch from proof of work to endorsement. They should get faster, not fail; run them to confirm.

## Tests

The builder's tier/endorse branching is the logic worth pinning; the host wiring is not separately tested.

- In `packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts` (`describe('createBootstrapEvidenceBuilder')`), replace "mints a self-vouch reputation endorsement for T0/T1 when an endorse capability is supplied" with one test: with `endorse` supplied and `bits: 256, maxIterations: 1 << 30` (a proof of work that cannot finish), a T2 build resolves to an envelope whose `reputation` the referee verifier accepts and which carries no `pow`; T0 and T1 builds resolve to `undefined`.
- Keep "returns undefined for T0/T1 with no endorse capability" and the PoW-mint tests as they are (they cover the keyless path).

## TODO

- Change `createBootstrapEvidenceBuilder`: T0/T1 → `undefined` always; T2/T3 → endorsement when `endorse` is supplied, else proof of work. Rewrite the module header and `endorse` doc; add the deprioritized-key `NOTE:`.
- Wire `endorse` in `createCohortTopicHost` from `options.privateKey` + `selfMemberBytes`; rewrite the builder comment and the module-header anti-DoS sentence.
- Add the accepted-tradeoff `NOTE:` in `createReputationVerifier`'s doc comment.
- Update the builder test as described.
- Update docs/cohort-topic.md §Anti-DoS (bullet + both implementation sub-bullets) and docs/reactivity.md's Attach bullet.
- `yarn workspace @optimystic/db-p2p build`, then run the db-p2p tests (`yarn test` in `packages/db-p2p`), `yarn lint:docs`, and `yarn test:integration` from root to confirm the real-node cold starts still admit.
