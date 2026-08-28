----
description: Let one machine repair a record from a single peer that can prove the group approved it, instead of requiring two peers to say the same thing — which today makes records held by only one reachable machine permanently unreadable.
prereq: serve-block-commit-proof
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/reputation/types.ts, packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts
difficulty: hard
----

# Accept a proven claim from a single holder

## The defect this fixes

Repair today believes an answer only when at least two *distinct peers* corroborate it. That rule has
two measured failures:

1. **Availability.** A block held by exactly one reachable peer can never be repaired. A deployment's
   earliest data — written while it was one node — becomes permanently unreadable as it grows.
2. **It is bypassable anyway.** A peer that can dial two cohort members can push forged content to
   them and manufacture its own corroborators.

A cohort-signed proof fixes both at once: **the signature set *is* the corroboration**, so who is
relaying it stops mattering, and a lone honest holder becomes sufficient.

## The change

Both selection functions in `packages/db-p2p/src/cluster/quorum-restore.ts` gain a certified
short-circuit; corroboration stays untouched as the fallback for uncertified claims.

- `selectQuorumRev` — a claim whose proof passes `verifyBlockCommitProofClaim` against
  `(blockId, rev, actionId)` is accepted **outright, from one peer**. Among certified claims the
  **highest certified rev wins**. Only if no claim is certified does the existing corroboration vote
  run, unchanged.
- `selectQuorumBlock` — a candidate whose proof passes `verifyBlockCommitProofContent` against its
  own bytes is accepted outright. Otherwise the existing unique-hash-group quorum runs, unchanged.

Both functions are currently **pure and synchronous**; verification is async. Rather than making them
async and rippling through every caller, take an **injected, already-computed verdict**: the caller
(`CoordinatorRepo.queryClusterForLatest`, `createReconcileBlock`) verifies each claim's proof first
and passes `certified: boolean` on the claim/candidate. This keeps the selection logic pure and
unit-testable with hand-built inputs, and keeps signature verification off the hot comparison loop.

**Do not touch `corroboratorCapacity`** (`quorum-restore.ts:88`). It is deliberately the MAX of the
observed cohort size and the configured size so a shrunken view cannot talk the floor down. The
certified path goes *around* it; it does not relax it.

## Anchoring: layer 1 now, log the gap

A proof's signers are proven to be *some* set of Ed25519 identities that jointly signed. Nothing yet
proves they are that block's legitimate cohort.

Follow `verifyInvalidationCertificate` (`packages/db-p2p/src/dispute/invalidation.ts`) **exactly** —
it is the shipped precedent for this situation, and `libp2p-node-base.ts:820` documents why its
layer 2 is deliberately not wired:

- Verify at layer 1 (signatures, membership digest, thresholds, claim match).
- Take an **optional** injected capability that re-derives the block's cohort from
  `keyNetwork.findCluster` — the same source `deriveExpectedCluster` uses at
  `libp2p-node-base.ts:790` — and reports overlap with `proof.peerIds`.
- When that capability is absent or reports the recompute infeasible, **accept and log the residual**
  through an `onUnanchored`-shaped callback with a reason (`'no-recompute-capability'` /
  `'recompute-infeasible'`), rather than declining.

**Overlap must never be a hard gate at this layer.** Historic cohort rotation means overlap can
legitimately be zero for old data; making it a gate would re-create the read-dead defect this whole
chain exists to fix. Wire the capability as *not supplied* in `libp2p-node-base.ts` for now, with a
comment pointing at `feat-cluster-membership-threshold-cert-anchoring`, mirroring the
`recomputeArbitratorSet` comment already there.

**State this honestly in the code and in the handoff:** the immediate, complete win is
**availability** — one holder's proof replaces N reachable corroborators. Resistance to a peer
manufacturing agreement improves from "any two ids answering now" to "at least a super-majority of
the committing cohort's keys, checkable offline", and completes when the anchoring ticket lands.

## Folded arm: penalize only provable misbehavior

This absorbs `tickets/backlog/debt-read-repair-penalty-provable-only`. Its cheap arm falls out here,
and leaving it filed would have a future reviewer re-derive the same finding.

In `CoordinatorRepo.penalizeContradictingRevClaims`:

- **Drop** the `rev > selected.rev` branch. A peer can honestly be ahead — an in-flight commit lands
  on part of the cohort first, and the 1-second per-peer consult timeout drops honest holders out of
  the sample. With legacy uncertified revisions in play this punishes the most up-to-date peers.
- **Keep** the same-rev/different-actionId branch: two different actions cannot both be the commit at
  one revision.
- **Add** genuinely provable misbehavior: a peer that served a proof which fails verification, or
  content that contradicts a verified proof's declared digest.

Attribution rule, mirroring `VerifyOutcome.penalize` (`cluster-repo.ts:63`): **never penalize a peer
whose identity was not proven.** A `ProofFailure` of `unknown-signer` / `non-ed25519-signer` /
`malformed-signature` / `legacy-record` means the proof was unparseable, not that the *serving* peer
lied — those are non-attributable. A proof that verifies cleanly but certifies a different claim than
the peer asserted, or content contradicting a verified digest, **is** attributable to the server.

Update `packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts` accordingly, and **delete
`tickets/backlog/debt-read-repair-penalty-provable-only.md`** as part of this ticket.

## Edge cases & interactions

- **The headline case: one holder, valid proof, no second corroborator.** Must repair. This is the
  reproduced defect; pin it as the acceptance test.
- **One holder, no proof.** Must still decline, exactly as today.
- **Certified vs uncertified conflict.** A certified rev 5 and an uncorroborated claimed rev 9: the
  certified claim wins. A certified rev 5 and a *corroborated* rev 9: define and pin the rule —
  prefer the higher rev, since corroboration remains a legitimate (weaker) path and a legacy
  uncertified tail must stay readable.
- **Two competing certified claims at the same rev with different action ids.** Both cannot verify
  against the same cohort; if they do, that is equivocation — decline and log rather than picking.
- **Fully rotated cohort.** Overlap zero must still accept and log. Pin it.
- **A proof that verifies but names a different block id or rev than the claim** — the replay case;
  step 7 of claim verification catches it. Pin that repair rejects it.
- **Content contradicting a verified proof's digest.** Reject the candidate, penalize the server,
  and continue to the next holder rather than failing the whole repair.
- **A hostile peer serving a large, expensive-to-verify proof per claim.** Verification is bounded by
  `peerIds.length` signature checks; confirm the cohort-size bound already applied to records also
  bounds `peerIds` here, and cap it explicitly if not.
- **Reconcile and read-repair share one callback instance** (`libp2p-node-base.ts:909` passes the
  same `reconcileBlock` to both). Any behaviour added here lands on both paths; verify both.
- **Mixed cohort.** Some peers serve proofs, some do not: certified claims short-circuit, the rest
  still corroborate among themselves.

## Two arms appended by the `serve-block-commit-proof` review

Both are places the proof now *arrives* and is dropped. Neither is a defect today — nothing decides
with a proof yet — but both become this ticket's work the moment verification exists.

**The reconcile path never lifts the proof off the archive it fetched.** `CoordinatorRepo`
populates `RevClaim.proof`; `createReconcileBlock` does not. Its `toCandidate`
(`cluster/reconcile-block.ts`) reads `rev`, `actionId`, and `block` out of the served entry and
discards `entry.proof`, so a certified short-circuit added to `selectQuorumRev` would fire on the
read path and never on the commit-time reconcile path — the two paths would silently heal by
different rules, which is exactly what the shared `quorum-restore.ts` primitives exist to prevent.
Carry the proof into `ReconcileCandidate` alongside `block`.

**A repaired replica retains no proof, so it re-serves the revision proof-less.** Today that is
correct and deliberate — `BlockStorage.saveRestored` carries a `NOTE:` saying so: nothing has
verified the served proof, and persisting an unverified one would let this node re-serve a hostile
peer's artifact as evidence it retained itself. Once this ticket verifies a proof before accepting
it, the verified proof is safe to persist, and persisting it is what stops certification from
decaying across every repair hop. Same at the push site, which `require-proof-on-block-push` owns.

## TODO

- Add an optional `certified` flag to `RevClaim` and `BlockHashCandidate`; add the certified
  short-circuit to `selectQuorumRev` and `selectQuorumBlock`, leaving the corroboration path intact.
- Verify proofs in the callers (`CoordinatorRepo.queryClusterForLatest`, `createReconcileBlock`)
  before selection, resolving each claim's `certified` flag and its failure reason.
- Add the optional cohort-overlap capability plus its `onUnanchored`-shaped logging; leave it
  unwired in `libp2p-node-base.ts` with a comment pointing at
  `feat-cluster-membership-threshold-cert-anchoring`.
- Rework `penalizeContradictingRevClaims` per the folded arm; keep non-attributable failures
  penalty-free.
- Update `test/coordinator-repo-read-repair-trust.spec.ts`; delete
  `tickets/backlog/debt-read-repair-penalty-provable-only.md`.
- Tests: single certified holder repairs; single uncertified holder still declines; certified beats
  uncorroborated; competing certified claims decline; zero overlap accepts and logs; replayed proof
  rejected; digest-contradicting content rejected and penalized; unparseable proof rejected and NOT
  penalized; every pre-existing corroboration test still passes untouched.
- Carry the proof into `ReconcileCandidate` and verify it in `createReconcileBlock`, per the first
  appended arm; persist the VERIFIED proof where a repair lands a revision (`BlockStorage.saveRestored`,
  replacing the `NOTE:` there), per the second.
- Update `docs/internals.md` (its **On the repair wires** subsection states today's "nothing decides"
  position and the repaired-replica asymmetry) and `docs/correctness.md` (Theorem 14 states the same) with
  the certified short-circuit and the honest statement of what layer 1 does and does not prove.
- Run `yarn build && yarn typecheck && yarn test` from the root.
