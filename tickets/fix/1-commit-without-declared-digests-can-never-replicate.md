description: A machine that commits data without stating what that data should hash to keeps no proof that the write really happened — and since peers now refuse copies that arrive without proof, such data can never be copied to another machine. It fails silently, and one of our own integration tests is currently in exactly that state.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-core/src/network/i-repo.ts, packages/db-core/src/transform/digest.ts
difficulty: medium
repro: verified
----

# A commit that declares no `blockDigests` stores no proof, and its block can never replicate

**This is a release blocker: `yarn check` is red at HEAD.** `test/real-libp2p.integration.spec.ts`
— "churn re-replication: a middle peer re-pushes an owned block to an expansion peer that then
serves it" — fails deterministically (not a flake; re-run twice in isolation).

## The chain, traced end to end

Run with `DEBUG='optimystic:db-p2p:*'`, in order:

```
storage-repo            commit:proof-undeclared blockId=spread-churn-block-0 rev=1 actionId=spread-churn-a1
block-transfer-service  cert:no-local-proof     block=spread-churn-block-0 rev=1 (pushing uncertified)
block-transfer-service  push:reject-uncertified block=spread-churn-block-0 rev=1 reason=no-proof
block-transfer          confirm:unmet           block=spread-churn-block-0 holders=0/2
```

1. `persistProofIfContentMatches` (`storage-repo.ts:1156`) asks `proofDeclaredDigest(proof, {blockId,
   rev, actionId})` what digest the commit declared for this block. A commit carrying no
   `blockDigests` declares none, so **no proof is stored** — documented behavior, logged as
   `commit:proof-undeclared`.
2. `sourceBlockCertification` then finds no local proof and pushes meta-only.
3. `handlePush` with `requirePushCertificate: true` (the new default) rejects it: `reason=no-proof`.
4. The block cannot replicate. Ever. The retry/confirm arm spins and gives up at `holders=0/2`.

## Why the severity is lower than it first looks — and still not zero

The failing test hand-builds its commit and bypasses the type that carries digests:

```ts
await ownerRepo.commit({ actionId: 'spread-churn-a1', tailId: blockId, rev: 1, blockIds: [blockId] } as any)
```

Every **production** path does declare them — `collection.ts:644` and `coordinator.ts:1051` both call
`computeBlockContentDigests`, and `NetworkTransactor` threads `request.blockDigests` down to each
per-block commit (`network-transactor.ts:691-702`). So this is not a live production replication
failure, and the `as any` is what let the test drift out of production shape.

What is *not* only a test problem: `CommitRequest.blockDigests` is **optional**
(`db-core/src/network/i-repo.ts:48`), so any embedder calling `IRepo.commit` directly without it gets
blocks that are silently unreplicable — committed, readable locally, and permanently uncopyable. The
only signal is a debug line nobody has enabled. Before the push-certificate default landed, such a
commit merely had no proof; now it has no future.

## What this ticket must decide

Two separable questions. Answer both; they have different shapes.

- **The test.** Almost certainly: rebuild its commit in production shape (real `blockDigests` via
  `computeBlockContentDigests`) so it exercises the certified path end to end — which is also the
  end-to-end certified-push coverage the `require-proof-on-block-push` handoff flagged as its largest
  gap. **Do not** make it pass by setting `requirePushCertificate: false`; two specs were already
  downgraded that way, and a third would leave the production default almost unexercised.
- **The contract.** A commit that cannot ever be replicated should not be silently accepted. Options,
  in rough order of preference: make `blockDigests` required at the `IRepo.commit` boundary (a typed
  change — find every caller); or keep it optional but refuse/loudly warn at commit time rather than
  logging at debug level; or accept it as a documented embedder obligation with an
  accepted-tradeoff `NOTE:` at the site. Pick one and say why, with the migration cost stated.

## Why it escaped the pipeline

The integration tier is env-gated (`OPTIMYSTIC_INTEGRATION=1`, separate `test:integration` script) and
the ticket runs validate with `yarn test`, which does not include it. Five tickets of certificate work
landed without it running once. Worth a line in the handoff conventions — a ticket touching the
replication or transport path should run the integration tier before handing off — but that belongs in
the tess agent rules, not here.

## Edge cases & interactions

- **Tombstones** (a commit with no `block`) legitimately declare no digest; they must keep working
  after whatever change lands.
- **A diverged member** stores no proof by design (`commit:proof-digest-mismatch`) and falls back to
  corroboration. That path must stay distinguishable from "declared nothing" — same absent proof, very
  different meaning.
- **`backFillProof`** shares `persistProofIfContentMatches`; a change to the declaration rule hits both
  the fresh-commit and back-fill sites.
- **Multi-block commits** narrow the action-wide digest map per request (`i-repo.ts:41`); a required
  field must survive that narrowing.
- Whatever lands must keep `push:reject-uncertified` firing for genuinely unproven content — that
  rejection is the fix for the measured forgery, and this ticket must not weaken it.
