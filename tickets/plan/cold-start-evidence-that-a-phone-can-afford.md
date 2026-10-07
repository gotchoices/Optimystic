description: To start serving a topic nobody has used yet, the network asks the first registering machine to solve a proof-of-work puzzle that a phone cannot finish in time — yet the same check also accepts a free self-signed endorsement from any key it has never seen, so only honest machines pay. Decide which cost a cold start should really carry, so phones can use network watches.
architecture: docs/cohort-topic.md#anti-dos
files: packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts, packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts, packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts, packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/libp2p-node-base.ts, docs/cohort-topic.md, docs/reactivity.md
repro: static
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-10-07T06:08:51.030Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\cold-start-evidence-that-a-phone-can-afford.plan.2026-10-07T06-08-51-028Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->

**Decided (maintainer, 2026-10-07): option A.** Honest nodes sign their own endorsement; proof of work stays only as the fallback for participants with no key. Plan the change on that basis.

GitHub: [#31](https://github.com/gotchoices/Optimystic/issues/31). The thread-blocking half of that issue is fixed independently by `implement/pow-mint-yields-the-thread-and-stops-before-its-timestamp-goes-stale`, which is correct under every option here.

## What the documents say

[docs/cohort-topic.md §Anti-DoS](../../docs/cohort-topic.md#anti-dos): a cold start (the first registration at a topic's root, or at a new deeper tier) must carry evidence — "a small proof-of-work, a signature from a peer with a sufficient reputation score, or a signed reference to a parent topic that does exist". "T0/T1 topics generally don't need PoW because they correspond to committed work; T2/T3 topics do." Reactivity registers at T3 ([docs/reactivity.md](../../docs/reactivity.md)), so on a production node — where `libp2p-node-base.ts` always supplies a reputation view, which turns the real verifiers on — every first watch of a log block mints a 20-bit proof of work.

## What the code does

- **The builder** (`createBootstrapEvidenceBuilder`, `packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts`) mints a proof of work at T2/T3 and never anything else there. It has an `endorse` seam for a self-signed endorsement, used only at T0/T1, and `host.ts` does not wire it.
- **The verifier** for the reputation path (`createReputationVerifier`, `packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts`) accepts an endorsement whose referee is the participant itself, and its own doc comment says "An unknown referee scores `0` (a clean, unseen peer) and so is sufficient". The T2/T3 policy (`packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts`) accepts PoW **or** reputation **or** parent reference.

So any participant can skip the proof of work at T2/T3 by signing the bound fields with a key the serving group has not scored — a freshly generated key costs nothing. The proof of work is therefore not a cost an abuser has to pay; it is a cost only honest nodes pay, because our builder chooses it. (Read from code; a spec that registers at T2 with a fresh-key self-vouch against a reputation-configured host and sees it admitted would confirm it.)

## What the proof of work costs

Measured on a Windows 11 desktop, Node 24 (details in the implement ticket): 0.83–3.83 µs per try depending on how the loop is written, so 2^20 tries ≈ 0.9–4.0 s on one core; single mints ranged 0.4–17.6 s because the try count is geometric. On a phone under Hermes (no JIT) it is much slower — not measured here; the reporter saw minutes of blocked thread on an Android emulator and expects a Galaxy S7 to be slower. A register's timestamp is inside the hashed preimage and the serving group drops a register older than 60 s (`DEFAULT_REPLAY_MAX_AGE_MS`), so a mint that takes longer than that is useless.

What it buys against an abuser who does mine: by the same desktop numbers, one core produces roughly 900–4000 cold starts per hour, so a few cores exceed a cohort's topic budget (`topics_max` 2048, LRU, zero-participant topics evicted first) within an hour. That is an inference from the per-try measurements, not a measured attack.

## Options

**A — Recommended: honest nodes self-endorse; proof of work is the keyless fallback.** Wire `endorse` in `host.ts` (the participant signer already holds the node's peer key) and have the builder offer the endorsement at every tier whose policy accepts it, minting a proof of work only when no `endorse` capability is supplied. No verifier, wire or policy change. A phone pays one signature. The documents are corrected to say what actually bounds cold starts today at T2/T3: per-peer register rate limits, the per-cohort topic budget, the coordinate-engine cap, the replay guard, and the reputation subsystem's ability to ban a key that misbehaves — with proof of work as what a keyless participant pays. Security is unchanged from today, because the free path already exists for anyone who reads the verifier. Fully reversible: it is a participant-side choice.

**B — Make the proof of work a real cost, then make it affordable on phones.** Tighten `createReputationVerifier` so an unseen referee is not sufficient (require recorded positive history, which needs a definition — the reputation service today records penalties and successes but has no "trusted" level). New identities would then have to mine, and phones would need: a lower network-wide difficulty (it cannot be lowered per device, since the serving group cannot tell a phone from an abuser; 16 bits ≈ 65 k tries ≈ 0.05–0.25 s on the desktop above), and/or an injectable miner port so the React Native kit can mine in native code (`react-native-quick-crypto` or a JSI module, ideally off the JS thread), and/or a precomputed SHA-256 midstate over the fixed preimage prefix (measured 0.83 µs per try vs 1.19 µs without it). Larger change, affects every node's anti-DoS posture, and the phone cost would need measuring before choosing the difficulty. Rejected as the default because it adds cost to every honest participant to close a hole whose impact (topic-budget churn at one cohort) the other defenses already bound.

**C — Do nothing beyond the implement ticket.** Phones no longer hang, but a slow phone spends its whole mint time budget on every cold start, gives up, and is refused; its watches degrade to the periodic tail check (30 s Core, 20 s Edge). Battery cost on each cold start, and the docs keep describing a cost abusers do not pay. The reporter keeps `strandReactivity` off on phones.

## Reversibility

A and C are participant-side and can be changed in any release. B changes what serving groups accept, so nodes on different builds would disagree during a rollout (an old node's self-endorsement refused by a new serving group); it needs to ship with a migration note.
