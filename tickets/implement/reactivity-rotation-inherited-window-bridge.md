description: After a tail rotation, a sleeping subscriber should be able to catch up the full ~hour the design promises in one reply, but today it only recovers a few minutes' worth because the catch-up reply can carry one summary window while the data is split across three. Make the reply carry an ordered chain of those windows so the whole span comes back at once.
prereq:
files:
  - packages/db-core/src/reactivity/resume.ts
  - packages/db-core/src/reactivity/checkpoint.ts
  - packages/db-core/test/reactivity/resume.spec.ts
  - packages/db-p2p/src/reactivity/recover-transport.ts
  - packages/db-p2p/test/reactivity/recover-transport.spec.ts
  - packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts
  - docs/reactivity.md
difficulty: hard
----

# Cross-rotation resume: carry a stacked checkpoint chain in `ResumeReplyV1`

## Decision (resolved — option (b), "carry multiple checkpoints")

Of the three candidate approaches in the plan ticket, **build option (b): widen
`ResumeReplyV1.checkpoint` to an ordered, contiguous *chain* of `CheckpointSummary`s** the subscriber
verifies and applies in sequence. Rationale, and why the other two were rejected:

- **(b) chosen.** It is the only option that restores the documented `W + W_checkpoint` cross-rotation
  range for **every** collection, *and* it dissolves the ticket's hardest sub-question — `mergedDigest`
  fold composability — rather than working around it. Because each window keeps its **own already-correct**
  merged digest and is applied independently, **nothing is ever re-folded across windows**, so there is no
  composability requirement and no mis-fold risk: a per-collection `fold` override (e.g. a KV collection
  folding changed-key sets) works identically to the default fold. The cryptographic anchor is unchanged —
  each summary still carries and verifies its own two bracketing endpoints. The cost is a wire-shape change
  to `ResumeReplyV1`, which is cheap here: reactivity is a pre-release internal P2P protocol under active
  ticket-by-ticket construction with no deployed peers, `v: 1` framing with per-message structural
  validation on decode, and a documented "peer predating a feature fails the reply closed and chain-reads
  (safe)" contract. A list-valued `checkpoints` is a clean v1 evolution.

- **(a) rejected (serve-time combine into one summary).** Only the *default* left-fold is composable
  (`acc = H(acc ‖ digest)`, seedable from `inherited.mergedDigest`); a per-collection override generally is
  not, because `inherited` stores only the *folded* digest, not per-revision digests, so the combined range
  cannot be re-folded from scratch. (a) therefore delivers the full range only for default-fold collections
  and silently degrades override-fold collections back to the `W`-revision abut limitation — i.e. it is a
  half-fix that *still* needs a fallback path. It also requires extending the `DigestFold` contract with a
  seed/continue capability and combining `mergedDelta`. More hidden complexity than it appears, for a
  partial result.

- **(c) rejected (accept the `W`-revision limitation as the contract).** Cheapest, but it abandons the
  §Failure-modes "subscriber wakes after long sleep" promise the moment a rotation is involved. (b) keeps
  the promise, so there is no reason to give it up.

## Background (current state)

After a rotation the new tail's recoverable revisions for a cross-rotation resume are stacked across three
contiguous windows:

```
[ inherited handoff ]  [ new tail's rolling checkpoint ]  [ new tail's ring ]
 oldCkptTo+1 .. rotRev   rotRev+1 .. ringLow-1             ringLow .. current
```

`ResumeReplyV1` (`packages/db-core/src/reactivity/resume.ts`) carries **one** `checkpoint` summary +
`recentEntries`. The `12.51` stop-gap (`classifyResume`'s abut guard `inherited.toRevision >= ringLow - 1`)
keeps every served reply correct but only serves the inherited window while it still abuts the ring — i.e.
only the first ≈`W` revisions after a rotation, before the new tail evicts into its *own* rolling
checkpoint. Once that rolling checkpoint forms *between* the inherited window and the ring, the request
falls to `out_of_window` (an honest chain read) instead of recovering in one round trip.

Note the production geometry (don't assume otherwise): the inherited handoff covers the **outgoing ring**
folded (`buildRotationHandoffCheckpoint` folds `[lastCheckpoint.toRevision+1, rotationRevision]`, ≈`W`
wide), *not* `W_checkpoint`; the outgoing rolling checkpoint is **not** migrated. So in steady state the new
tail holds at most **two** stacked summaries (`inherited` then its own `rolling`), which are **disjoint and
abut** (`inherited.toRevision + 1 === rolling.fromRevision === rotationRevision + 1`). A second rotation
does **not** transitively carry the prior inherited window (`buildRotationHandoffCheckpoint` reads
`state.checkpoint`, the rolling one, never `inherited`), so the chain never exceeds length 2 in practice —
but the list representation must handle a general contiguous chain.

## Design

### 1. Wire shape — `ResumeReplyV1.checkpoint` → `checkpoints: CheckpointSummary[]`

Replace the singular field with an ordered low→high **contiguous chain** (length 1 in the steady-state
rolling/abutting-inherited case; length 2 in the bridge case):

```ts
export interface ResumeReplyV1 {
  v: 1;
  result: ResumeResult;
  // backfill
  entries?: NotificationV1[];
  currentRevision?: number;
  // checkpoint_window — ordered low→high; each checkpoints[i].fromRevision === checkpoints[i-1].toRevision + 1
  checkpoints?: CheckpointSummary[];
  recentEntries?: NotificationV1[];
  // out_of_window
  currentTailId?: string;
  // tail_rotated
  newTailId?: string;
  newRevisionAtRotation?: number;
}
```

`validateResumeReplyV1` (`checkpoint_window` branch) must:
- require `checkpoints` to be a **non-empty** array, each element validated via `validateCheckpointSummary`;
- assert the chain is **internally contiguous and ascending**: for `i ≥ 1`,
  `checkpoints[i].fromRevision === checkpoints[i-1].toRevision + 1` (reject gapped / overlapping /
  misordered);
- assert all elements share one `collectionId`.

This validation runs on decode, so a malformed chain never reaches `applyResumeReply` over the wire.

### 2. Serve / classify — shared contiguous-chain builder

Introduce a pure helper (in `resume.ts`) that builds the served chain, used by **both** `serveResume` and
`classifyResume` so they cannot disagree:

```ts
function resumeCheckpointChain(
  fromRevision: number,
  ringLow: number | undefined,
  rolling: RollingCheckpoint | undefined,
  inherited: CheckpointSummary | undefined,
): CheckpointSummary[] | undefined
```

It returns the **shortest** contiguous chain that both covers `fromRevision` and abuts the ring's low edge
(`top.toRevision === ringLow - 1`), or `undefined` when no gap-free chain exists. Evaluate in this order
(this ordering preserves every existing classification test — see Edge cases):

```
if ringLow === undefined: return undefined          // no ring to abut / no recentEntries

// Case A — rolling wins (fresher, narrower): rolling abuts the ring AND covers fromRevision
if rolling abuts ring (rolling.toRevision === ringLow - 1) and rolling.covers(fromRevision):
    return [rolling.summary()]

// Case B1 — inherited abuts the ring directly and covers fromRevision (the 12.51 abut case)
if inherited and inherited.toRevision === ringLow - 1 and inherited covers fromRevision:
    return [inherited]

// Case B2 — bridge: inherited abuts rolling, rolling abuts ring, inherited covers fromRevision
if inherited and rolling abuts ring and inherited.toRevision + 1 === rolling.fromRevision
   and inherited covers fromRevision:
    return [inherited, rolling.summary()]

return undefined                                     // any gap → out_of_window (honest chain read)
```

- `classifyResume` returns `"checkpoint_window"` iff this helper returns a chain (after the existing
  `tail_rotated` and `backfill` checks), else `"out_of_window"`. Keep its exported signature
  `(req, buffer, checkpoint, currentTailId, inherited?)`.
- `serveResume`'s `checkpoint_window` branch sets `checkpoints` to the helper's chain and `recentEntries` to
  the live ring's entries. Drop the old single-summary selection logic.

`rolling.summary()` is `undefined` only when the rolling checkpoint is empty; the helper only calls it after
confirming `rolling.toRevision === ringLow - 1` (non-empty), so the non-null assertion is safe — but assert
it rather than blind-`!` for clarity.

### 3. Subscriber apply — verify-all-then-apply over the chain

Rework `applyResumeReply`'s `checkpoint_window` branch to a chain (no partial advance on any failure):

```
const summaries = reply.checkpoints
if empty/undefined: failWire
// low edge must abut the subscriber's contiguity head (the existing high-/low-edge guard, on the lowest link)
if summaries[0].fromRevision > subscriber.lastRevision + 1: onChainRead(...); return "checkpoint_untrusted"
// intra-chain contiguity (defense in depth; codec already checks decoded replies, but an in-process
// reply may bypass the codec)
for i in 1..n-1: if summaries[i].fromRevision !== summaries[i-1].toRevision + 1: onChainRead(...); return "checkpoint_untrusted"
// verify EVERY summary's endpoints before applying anything — a single forged link kills the whole reply
for s in summaries: if await verifyCheckpointEndpoints(s, verifier) !== "verified": onChainRead(...); return "checkpoint_untrusted"
// apply in order: digest hint per link, then advance the contiguity head
for s in summaries: onCheckpointDigest?.(s); subscriber.rebaseline(s.toRevision)
for n in reply.recentEntries ?? []: await subscriber.onNotification(n)
return "checkpoint_applied"
```

Behavior notes: `onCheckpointDigest` now fires **once per link** (twice in the bridge case) — the
application sees each window's hint. `rebaseline` is monotone, so rebaselining each link in turn lands the
head at the top link's `toRevision`; the ring's `recentEntries` then replay gap-free above it (dedupe
against the head as today).

### 4. db-p2p consumers (mechanical — the logic lives in db-core)

- `packages/db-p2p/src/reactivity/recover-transport.ts` `serveResumeReply` already passes
  `inheritedCheckpoint` (line ~361) and re-encodes via the codec — **no logic change**; just confirm it
  compiles against the new field.
- `packages/db-p2p/test/reactivity/recover-transport.spec.ts` lines ~217-218 read
  `reply.resumeReply!.checkpoint!.fromRevision/toRevision` — update to `.checkpoints![0]!.…`.
- `packages/db-p2p/src/testing/reactivity-mesh-harness.ts` already passes `inheritedCheckpoint`
  (lines ~606-616) — the bridge works through it automatically; no structural change.

### 5. Docs (`docs/reactivity.md`)

- §Resume: remove the **"Single-checkpoint reply ⇒ abut requirement (current limitation)"** block
  (lines ~305-313) and the `reactivity-rotation-inherited-window-bridge` pointer; replace with the restored
  behavior — the reply carries an ordered contiguous **chain** of checkpoint summaries, so a cross-rotation
  resume recovers the full stacked range in one round trip regardless of fold. Update the `CheckpointWindow`
  bullet (line ~324) to drop the abut caveat and note the inherited+rolling chain.
- §Tail rotation step 5 (line ~468): drop the "while the inherited window still abuts the new ring's low
  edge … single-checkpoint reply cannot bridge … see the follow-on" caveat; state the new tail serves the
  inherited+rolling chain.
- §Failure modes "Subscriber wakes after long sleep" / "Tail rotation during subscriber outage" (lines
  ~525-534): confirm they read consistently — a cross-rotation resume within `W + W_checkpoint` now recovers
  in one round trip (no rotation-specific shortfall). Adjust wording only where it implied the shortfall.

## Edge cases & interactions

- **Existing classification tests must stay green (the chain builder's ordering is load-bearing).** Verify
  against `resume.spec.ts`: rolling-wins overlap (`fromRevision=12`, inherited `[1,16]` + rolling `[9,16]`
  → `[rolling 9..16]`); inherited-abuts-ring-directly (`fromRevision=5`, inherited `[1,16]` → `[inherited
  1..16]`, *not* a bridge — Case B1 before B2); pure rolling, no inherited (`fromRevision=12` →
  `[rolling]`); backfill preferred over inherited (`fromRevision=18` → backfill, builder not reached);
  no-inherited `out_of_window` (`fromRevision=5`).
- **Bridge happy path (the gap the ticket exists to close):** inherited `[1,8]`, new rolling `[9,16]`, ring
  `[17,20]`; `fromRevision` in `[1,8]` → `checkpoints = [[1,8],[9,16]]`, `recentEntries = [17..20]`. The
  existing test *"falls to out_of_window when the inherited window no longer abuts the ring"* asserts the
  **old** behavior on exactly this fixture — **convert it** to assert the bridge (`checkpoint_window`, two
  links).
- **Unbridgeable gap → `out_of_window`.** inherited `[1,6]`, rolling `[9,16]` (gap `[7,8]` — the new tail
  evicted past the handoff seam, so the inherited window is legitimately > `W + W_checkpoint` behind):
  builder returns `undefined`. Same for any non-abutting trio.
- **Low-edge guard still fires (subscriber side).** A served (or forged) chain whose lowest
  `fromRevision > subscriber.lastRevision + 1` leaves an un-summarized gap below it → `checkpoint_untrusted`
  + chain read, nothing delivered. (Preserve the existing `100..116` non-abutting test, now expressed as a
  one-link chain.)
- **Partial forgery in a multi-link chain.** A 2-link chain whose **second** (rolling) summary has a forged
  endpoint must reject the **whole** reply — verify-all-before-apply means nothing is delivered and
  `lastRevision` is unchanged (no partial advance to the first link's `toRevision`).
- **Empty / single-link chains.** Codec rejects an empty `checkpoints`. A length-1 chain behaves exactly as
  the old singular field (so `onCheckpointDigest` fires once, mesh "exactly one summary applied" assertions
  hold for non-bridge cases).
- **Codec robustness.** Round-trip a 2-link `checkpoint_window` reply; reject a non-contiguous chain
  (gap/overlap/misorder), a mixed-`collectionId` chain, and an empty chain.
- **Fold composability (the resolved sub-question) — prove it's a non-issue.** Build the new tail's rolling
  checkpoint with a **non-composable override fold** (e.g. one whose output is not a seedable running
  accumulator) and an inherited summary; serve the bridge and assert each link carries its **own original**
  `mergedDigest` unchanged (`checkpoints[0].mergedDigest === inherited.mergedDigest`,
  `checkpoints[1].mergedDigest === rolling.summary()!.mergedDigest`) — i.e. nothing was re-folded. End-to-end
  apply still succeeds (digest is a hint; endpoints verify).
- **`mergedDelta` per link.** Each summary keeps its own optional `mergedDelta`; none is combined. No
  change to `coalesceMergedDelta`.
- **Forked/concurrent cohort members.** Unchanged: each link's endpoints carry the original threshold
  signature and verify end-to-end; the chain is order-checked structurally. No new gossip/state.
- **Second rotation.** Confirm the chain stays length ≤ 2 (the prior inherited window is intentionally
  dropped from the next handoff; those revisions are out of range by then) — no transitive chaining bug.

## TODO

- [ ] `resume.ts`: rename `ResumeReplyV1.checkpoint` → `checkpoints: CheckpointSummary[]`; update the
      `checkpoint_window` JSDoc.
- [ ] `resume.ts`: `validateResumeReplyV1` `checkpoint_window` — require non-empty `checkpoints`, validate
      each summary, assert ascending-contiguous chain and single `collectionId`.
- [ ] `resume.ts`: add the pure `resumeCheckpointChain(fromRevision, ringLow, rolling, inherited)` helper
      (Cases A / B1 / B2 above).
- [ ] `resume.ts`: rewrite `classifyResume` to map `resumeCheckpointChain` presence → `checkpoint_window`
      vs `out_of_window` (keep the `tail_rotated`/`backfill` precedence and the exported signature).
- [ ] `resume.ts`: rewrite `serveResume`'s `checkpoint_window` branch to emit `checkpoints` (from the
      helper) + `recentEntries` (live ring). Refresh the `ResumeServingDeps.inheritedCheckpoint` doc.
- [ ] `resume.ts`: rewrite `applyResumeReply`'s `checkpoint_window` branch to the verify-all-then-apply
      chain loop (low-edge guard on `checkpoints[0]`, intra-chain contiguity, per-link endpoint verify,
      per-link `onCheckpointDigest` + `rebaseline`, then replay `recentEntries`).
- [ ] `resume.spec.ts`: update all `reply.checkpoint`/round-trip references to `checkpoints`; convert the
      "no longer abuts the ring" test to the bridge case; add: bridge serve (two links), bridge end-to-end
      apply (`fromRevision` at inherited low edge → `checkpoint_applied`, two digests, deliver `[17..20]`,
      `lastRevision === 20`, nothing skipped), unbridgeable-gap → `out_of_window`, partial-forgery rejection,
      non-composable-override-fold digest-preservation, and codec contiguity/empty/mixed-collection
      rejection.
- [ ] `packages/db-p2p/test/reactivity/recover-transport.spec.ts`: `reply.resumeReply!.checkpoint!` →
      `.checkpoints![0]!`.
- [ ] `packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts`: add a three-window end-to-end test —
      rotate, commit enough post-rotation revisions that the new tail's rolling checkpoint forms *between*
      the inherited window and the ring, then resume from inside the inherited window through the real
      manager and assert contiguous catch-up with no chain read.
- [ ] `docs/reactivity.md`: §Resume (remove abut-limitation block + pointer), §Tail rotation step 5, and
      §Failure-modes — agree with the chain-of-checkpoints behavior.
- [ ] Build + test: `yarn workspace @optimystic/db-core test` and
      `yarn workspace @optimystic/db-p2p test` (stream with `2>&1 | tee`), plus type-check both packages.
      Confirm no other reference to the singular `ResumeReplyV1.checkpoint` remains across the monorepo.
