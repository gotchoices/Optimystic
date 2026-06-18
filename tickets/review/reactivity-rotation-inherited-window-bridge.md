description: A sleeping subscriber that wakes after a tail rotation can now catch up the full promised range in a single reply, because the catch-up reply carries an ordered chain of summary windows instead of just one.
prereq:
files:
  - packages/db-core/src/reactivity/resume.ts
  - packages/db-core/test/reactivity/resume.spec.ts
  - packages/db-core/test/reactivity/recover.spec.ts
  - packages/db-p2p/test/reactivity/recover-transport.spec.ts
  - packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts
  - docs/reactivity.md
difficulty: hard
----

# Review: cross-rotation resume carries a stacked checkpoint chain in `ResumeReplyV1`

## What was built

`ResumeReplyV1.checkpoint?: CheckpointSummary` became `ResumeReplyV1.checkpoints?: CheckpointSummary[]`
— an ordered, contiguous low→high **chain**. This closes the gap where a cross-rotation resume could only
recover ≈`W` revisions after a rotation (the `12.51` single-checkpoint "abut" stop-gap) instead of the full
`W + W_checkpoint` the design promises. The chain is one link in steady state and the two-link
`[inherited, rolling]` **bridge** once the new tail has evicted post-rotation revisions into its own rolling
checkpoint sitting between the inherited handoff window and the live ring.

All logic lives in db-core `resume.ts`; db-p2p consumers were mechanical (they re-encode via the codec and
never touched the field, except two test assertions). The decision (build option (b), carry multiple
checkpoints) was pre-resolved in the plan ticket — see the plan rationale for why (a) serve-time-combine and
(c) accept-the-limitation were rejected. The headline payoff of (b): because each link keeps its **own
already-correct** merged digest and is applied independently, **nothing is ever re-folded across windows**,
so `mergedDigest` fold composability is a non-issue — a per-collection override fold works identically to
the default.

### Concretely, in `resume.ts`

- **Wire shape + JSDoc.** `checkpoints?: CheckpointSummary[]` replaces the singular field; module/interface
  docs updated.
- **`validateCheckpointChain` (new, decode-time).** Requires a **non-empty** array, validates each link via
  `validateCheckpointSummary`, asserts the chain is **ascending + internally contiguous**
  (`checkpoints[i].fromRevision === checkpoints[i-1].toRevision + 1`), and asserts a single shared
  `collectionId`. Wired into `validateResumeReplyV1`'s `checkpoint_window` branch, so a malformed chain
  never reaches `applyResumeReply` over the wire.
- **`resumeCheckpointChain` (new, pure).** The shared builder used by **both** `classifyResume` and
  `serveResume` so they cannot disagree. Returns the shortest gap-free chain that covers `fromRevision` and
  abuts the ring (`top.toRevision === ringLow − 1`), else `undefined`. Cases in precedence order: **A**
  rolling-wins, **B1** inherited-abuts-ring-directly, **B2** inherited+rolling bridge. `ringLow === undefined`
  → `undefined`.
- **`classifyResume`** now returns `checkpoint_window` iff the helper yields a chain (after the unchanged
  `tail_rotated`/`backfill` precedence). Exported signature unchanged.
- **`serveResume`** `checkpoint_window` branch emits `checkpoints` from the helper + the live ring's
  `recentEntries`.
- **`applyResumeReply`** `checkpoint_window` branch is now **verify-all-then-apply**: low-edge guard on the
  lowest link → intra-chain contiguity (defense in depth for in-process replies that bypass the codec) →
  verify **every** link's endpoints **before** applying anything → then per-link `onCheckpointDigest` +
  `rebaseline`, then replay `recentEntries`. A single forged link rejects the whole reply with **no partial
  advance**.

## How to validate / use cases (the tests are a floor, not a ceiling)

Run: `yarn workspace @optimystic/db-core test` (878 passing) and
`yarn workspace @optimystic/db-p2p test` (848 passing, 29 pending, 0 failing). Both packages `build` (tsc)
clean. New/changed coverage:

- **db-core `resume.spec.ts`** — codec: single- and two-link round-trips; rejects empty / non-contiguous
  (gap/overlap/misorder) / mixed-collectionId chains. Classify+serve: the **bridge happy path**
  (`fedState(20)` ⇒ rolling `[9,16]`, ring `[17,20]`; inherited `[1,8]` ⇒ `checkpoints = [[1,8],[9,16]]`,
  `recentEntries = [17..20]`) — this is the converted "no-longer-abuts" test; the **unbridgeable gap**
  (inherited `[1,6]`, gap `[7,8]` ⇒ `out_of_window`); **non-composable override fold digest-preservation**
  (each link keeps its own `mergedDigest`, end-to-end apply still succeeds). Apply: **bridge applies both
  links in order** (two digests `[.,8]` then `[.,12]`, deliver `[17..20]`, `lastRevision = 20`, nothing
  skipped); **partial forgery in the second link** rejects the whole reply (`lastRevision` unchanged, no
  partial advance to the first link's `toRevision`). Existing single-link, dedupe, forged-endpoint, and
  non-abutting guards preserved (now expressed as one-link chains).
- **db-core `recover.spec.ts`** — the envelope round-trip carries the chain (`checkpoints`).
- **db-p2p `recover-transport.spec.ts`** — `reply.resumeReply!.checkpoints![0]!` assertions; serve threads
  `ps.inheritedCheckpoint`.
- **db-p2p `mesh-tail-rotation.spec.ts`** — a real-manager three-window e2e: rotate, then commit enough
  post-rotation revisions that the new tail's rolling checkpoint forms **between** the inherited window and
  the ring (`w:4, wCheckpoint:12`; commit 8 → rotate → commit 8 ⇒ inherited `[5,8]`, rolling `[9,12]`, ring
  `[13,16]`), then resume from inside the inherited window ⇒ `checkpoint_applied`, two digests `[8,12]`,
  deliver `[13..16]`, `lastRevision = 16`, **no chain read**.

## Things to scrutinize / known gaps (treat my work as a starting point)

- **Case A gained an explicit abut check the original lacked.** The old `classifyResume` returned
  `checkpoint_window` for the rolling checkpoint on `covers()` alone; `resumeCheckpointChain` Case A also
  requires `rolling.toRevision === ringLow − 1`. This is behavior-preserving **only because the rolling
  checkpoint always abuts the ring by construction** (`PushState` feeds ring eviction into
  `RollingCheckpoint.retire`, so it covers `[ringLow − W_checkpoint, ringLow − 1]`). Worth a second look
  that no code path can produce a non-abutting rolling checkpoint while the ring is non-empty.
- **Empty-ring-with-checkpoint edge is now `out_of_window`.** `ringLow === undefined` ⇒ helper returns
  `undefined`. The old code could still have returned `checkpoint_window` (serving an empty `recentEntries`).
  This state shouldn't arise (a checkpoint forms only via ring eviction, which needs a non-empty ring) and
  the design chose this deliberately, but it is a real (if unreachable) behavior change — no test exercises
  it.
- **`serveResume` recomputes the chain** after `classifyResume` already built it internally (both pure, same
  inputs, guarded by an invariant throw). Minor redundancy, not a correctness issue; could be folded into
  one call if a reviewer prefers.
- **`onCheckpointDigest` now fires twice in the bridge case.** No consumer assumed exactly-one globally
  (subscription-manager passes it through; the mesh harness accumulates), and the existing "exactly one
  summary applied" mesh assertion is a non-bridge case that still holds — but any future consumer must
  expect per-link firing.
- **Chain length is ≤ 2 in practice**; only lengths 1–2 are exercised end-to-end. The codec/validation
  handle arbitrary length (a length-3+ codec round-trip could be added for paranoia, but it is not a
  production path — a second rotation intentionally drops the prior inherited window, so the chain never
  transitively grows).
- **`substrate-real-libp2p.integration.spec.ts`** references `ResumeReplyV1` but only reads
  `.result`/`.entries`/`.currentRevision` (backfill path) — unaffected and it compiles, but it is gated
  behind `OPTIMYSTIC_INTEGRATION=1` and was **not executed** in this run.
- **`substrate-simulator`** has its own independent `classifyResume`/`RollingCheckpoint` (a standalone
  design simulation) and does not import the db-core resume API — out of scope, untouched, unaffected.

## No pre-existing failures

No `.pre-existing-error.md` written — every test that ran passed (the "parent unreachable" line in the
db-p2p log is an intentional log from `host-antidos-coldstart.spec.ts`, whose test passes).
