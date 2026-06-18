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

# Cross-rotation resume carries a stacked checkpoint chain in `ResumeReplyV1` (COMPLETE)

## What was built

`ResumeReplyV1.checkpoint?: CheckpointSummary` became `ResumeReplyV1.checkpoints?: CheckpointSummary[]`
— an ordered, contiguous low→high **chain**. This closes the gap where a cross-rotation resume could only
recover ≈`W` revisions after a rotation (the `12.51` single-checkpoint "abut" stop-gap) instead of the full
`W + W_checkpoint` the design promises. The chain is one link in steady state and the two-link
`[inherited, rolling]` **bridge** once the new tail has evicted post-rotation revisions into its own rolling
checkpoint sitting between the inherited handoff window and the live ring.

All logic lives in db-core `resume.ts`:

- **Wire shape + JSDoc** — `checkpoints?: CheckpointSummary[]` replaces the singular field.
- **`validateCheckpointChain` (decode-time)** — non-empty, ascending + internally contiguous, single shared
  `collectionId`; wired into `validateResumeReplyV1`.
- **`resumeCheckpointChain` (pure)** — the shared builder used by both `classifyResume` and `serveResume`;
  returns the shortest gap-free chain covering `fromRevision` and abutting the ring (Cases A rolling-wins,
  B1 inherited-abuts, B2 bridge), else `undefined`.
- **`applyResumeReply`** — verify-all-then-apply: low-edge guard on the lowest link → intra-chain contiguity
  → verify every link's endpoints **before** applying anything → per-link `onCheckpointDigest` +
  `rebaseline`, then replay `recentEntries`. A single forged link rejects the whole reply with no partial
  advance.

db-p2p consumers were mechanical (re-encode via the codec; two test assertions updated; serve threads
`ps.inheritedCheckpoint`).

## Review findings

### Verification performed

- **Read the implement diff first** (`git show d804854`) before the handoff summary, then read the full
  current `resume.ts`, `checkpoint.ts`, `rotation.ts`, `push-state.ts` (eviction wiring), the subscriber's
  `rebaseline`/`lastRevision`, and `replay-buffer.ts`.
- **Build + tests run green.** db-core `build` (tsc) clean; `yarn workspace @optimystic/db-core test` →
  **878 passing**. db-p2p `build` clean; `yarn workspace @optimystic/db-p2p test` → **848 passing, 29
  pending, 0 failing**. (Lint is not configured — root `lint` is a placeholder `echo`; per-package `tsc` is
  the static gate and both pass.) The "parent unreachable" line in the db-p2p log is the intentional log
  from `host-antidos-coldstart.spec.ts`, whose test passes.

### Correctness — no findings

Traced every case and the precedence ordering by hand against the apply-side guards:

- **Case A abut invariant confirmed.** `push-state.ts:129` wires the ring's low-edge eviction directly into
  `checkpoint.retire`, so a non-empty rolling checkpoint's `toRevision` is exactly `ringLow − 1` — the new
  `rolling.toRevision === ringAbut` check in Case A is behavior-preserving. Moreover, were a non-abutting
  rolling checkpoint ever to exist, the **old** `covers()`-only classifier would have served a *gapped*
  `checkpoint + ring` reply (silent skip); the new abut requirement is therefore a latent-correctness
  improvement, not just a refactor.
- **Bridge / unbridgeable-gap / head-mismatch all sound.** Verified B2 only fires while
  `inherited.toRevision + 1 === rolling.fromRevision` (i.e. the new tail has not yet trimmed its rolling
  low edge past the handoff seam); once it trims, the genuine gap correctly falls to `out_of_window`. The
  apply-side low-edge guard (`summaries[0].fromRevision > lastRevision + 1`) catches a server/subscriber
  head mismatch independently of the codec, and verify-all-before-apply means a forged link in any position
  yields no partial advance.
- **Type safety.** `failWire` returns `never`, so `summaries` narrows to `CheckpointSummary[]` after the
  empty-check; per-link non-null assertions are sound.
- **No stragglers.** Grepped the whole `packages` tree for any remaining `.checkpoint` (singular) field
  access on a resume reply — none. All consumers (recover envelope, recover-transport, subscription-manager
  passthrough, mesh harness) use `checkpoints` / pass the digest callback through.

### Edge cases & tests — no findings (coverage is a genuine floor)

Codec round-trips (single- and two-link), rejection of empty / gapped / overlapping / misordered /
mixed-collectionId chains, classify+serve for steady-state / inherited-abuts / bridge / unbridgeable-gap /
rolling-wins-precedence / backfill-precedence / no-inherited, apply for bridge-in-order /
forged-second-link / non-abutting-low-edge / dedupe, a non-composable override-fold digest-preservation
test, and a real-manager three-window e2e in `mesh-tail-rotation.spec.ts`. Happy path, edge, error, and
regression paths are all covered.

### Minor items reviewed and accepted (no change)

- **`serveResume` recomputes the chain** after `classifyResume` already built it internally — this re-runs
  `rolling.summary()` (a fold over ≤ `W_checkpoint` entries) a second time per `checkpoint_window` serve.
  Left as-is: resume is not a hot path, the cost is bounded, and folding it would either change
  `classifyResume`'s exported signature or duplicate the backfill/tail-rotated precedence logic — not worth
  a public-API change in a review pass. Guarded by an invariant throw, so the two calls cannot silently
  disagree.
- **`onCheckpointDigest` fires once per link** (twice in the bridge). Benign: subscription-manager passes it
  through and the mesh harness accumulates; the union of the two digests is the correct invalidation set.
  Documented in the JSDoc.
- **Empty-ring-with-checkpoint → `out_of_window`** (`ringLow === undefined`): unreachable (a checkpoint only
  forms via ring eviction, which needs a non-empty ring) and a deliberate design choice; left as-is.
- **Chain length ≤ 2 in practice**; codec/validation handle arbitrary length and 1–2 are exercised
  end-to-end. A length-3 round-trip would be pure paranoia (a second rotation intentionally drops the prior
  inherited window, so the chain never transitively grows) — not added.

### Not run (out of scope / gated)

- `substrate-real-libp2p.integration.spec.ts` reads only `ResumeReplyV1.result`/`.entries`/
  `.currentRevision` (backfill path) — unaffected, compiles, gated behind `OPTIMYSTIC_INTEGRATION=1`, not
  executed.
- `substrate-simulator` has its own independent `classifyResume`/`RollingCheckpoint` (a standalone design
  simulation) and does not import the db-core resume API — untouched, unaffected.

### Major findings → new tickets

**None.** No correctness, security, or design defects warranting a follow-on ticket were found.

### Docs

`docs/reactivity.md` updated and verified against the new reality: §Resume cross-rotation narrative, the
`CheckpointWindow { checkpoints, recentEntries }` bullet, §Tail rotation step 5, the §Wire-formats
`ResumeReplyV1` schema (`checkpoints[]`), and the "Mobile subscriber wakes" worked example (now
`checkpoints: [[800..2085]]`). The stale single-checkpoint "abut limitation" prose was removed.

### No pre-existing failures

No `.pre-existing-error.md` written — every test that ran passed.
