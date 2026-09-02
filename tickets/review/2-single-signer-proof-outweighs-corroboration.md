description: Review the change that stops one machine's self-signed commit receipt from outranking several machines that agree with each other, when they disagree about the same revision of a block.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/certified-claims.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/quorum-restore-certified.spec.ts, packages/db-p2p/test/certified-claims.spec.ts, docs/internals.md, docs/transactions.md
difficulty: hard
----

# Review: single-signer proof must not outweigh corroboration

Landed over two implement runs. Run 1 (commit `2048eb91`) did the code and core tests; run 2 (this
working tree) added the remaining test cases, the docs, and ran all validation.

## The problem this fixes

When a node repairs a block, it asks its peers what revision they hold and picks a winner. Two kinds
of evidence can win: several distinct peers *agreeing* with each other (corroboration), or one peer
producing a *cohort commit proof* — a signed receipt that the block's cohort really committed those
bytes at that revision. A verified proof used to win any tie at the same revision, on its own.

That was safe while proofs meant "several cohort members signed". It stopped being safe once solo
cohorts began minting their own proofs (prereq work, `mintSoloCommitProof`): a machine that is
briefly alone — a partition, a degraded `findCluster` — now legitimately self-signs a one-signature
proof. So a machine could fork, commit alone, and then use its own receipt to overrule the cohort
that stayed together and kept committing. One machine's honest word about itself outranked the
group.

## The rule now implemented

Certification verdicts carry **how many distinct peers signed the proof**, and the selectors weigh
that:

- **Multi-signer proof (2+ signers)** — wins the equal-revision tie outright, as before.
- **Single-signer proof** — wins only where nothing multi-peer contests it. At the same revision it
  loses to 2+ distinct peers agreeing on a different action, and loses to any multi-signer proof.
- **Strictly higher corroborated revision** still beats a certified claim of either weight
  (unchanged — keeps a legacy uncertified tail readable).
- **Uncontested single-signer still wins** — a genuinely lone certified holder stays repairable,
  which is the ordinary solo case the proof mint exists for.
- **Absent signer count weighs as single-signer.** Deliberate conservative default.

Mirrored on the content gate (`selectQuorumBlock`): a 2+-carrier hash group meeting quorum displaces
a single-signer certified hash; a *one*-carrier group (possible only where a tiny-cohort capacity
relaxes quorum to a single vote) does not.

## Use cases to test / validate against

Each of these is the shape a reviewer should try to break. All are pinned as unit tests in
`test/quorum-restore-certified.spec.ts` (30 tests, all passing) — the value of re-deriving them is
checking the *rule* is right, not that the tests pass.

1. **The motivating fork.** Peers `h1`,`h2` claim `(5, cohort)` uncertified; peer `solo` claims
   `(5, solo-fork)` with a verified 1-signer proof. Expect: `cohort` wins, uncertified.
2. **Cohort proof still beats votes.** Same shape but `solo`'s proof has 3 signers. Expect: the
   proof wins, `certified: true`.
3. **Lone certified holder still repairs.** One peer, 1-signer proof, nothing else. Expect: it wins.
   (Regression guard — over-correcting here would re-break solo-cohort repair, which the prereq
   ticket existed to enable.)
4. **Convergence is not a contest.** The corroborated pair *agrees* with the sole certified action.
   Expect: the certified verdict is kept (so the certified logging and penalty exemptions still
   apply), not silently downgraded to a corroboration win.
5. **Two solo forks + a real cohort.** `solo1@(5,a)`, `solo2@(5,b)`, plus `h1`,`h2` agreeing on
   `(5,a)`. Previously this deadlocked as equivocation. Expect: resolves to `a`, uncertified.
6. **Multi-signer vs single-signer at one revision.** Expect: cohort proof wins, and
   `certifiedEquivocation` returns `undefined` — a solo receipt must not be able to manufacture a
   permanent decline.
7. **Genuine equivocation still declines.** Two *multi-signer* proofs for different actions at one
   revision → whole selection declines, incident line fires, neither claimant penalized.
8. **Content-gate mirrors of 1/2/3/5**, plus: a quorum-meeting group of exactly ONE carrier does not
   displace a certified hash (capacity-1 cohort).
9. **Reporter vs selector independence.** `certifiedEquivocation` /
   `certifiedContentEquivocation` can both return non-`undefined` while selection *succeeded* —
   callers must key incident logging off the decline. Both call sites do; pinned by test.

## Validation actually run

- `yarn workspace @optimystic/db-p2p test` — **2507 passing, 0 failing**, 49 pending.
- `yarn workspace @optimystic/db-core test` — **1594 passing, 0 failing**.
- `yarn build` — clean. `yarn typecheck` — clean (db-p2p's tsconfig includes `test`, so specs are
  type-checked; the mocha runner uses type stripping and would not have caught type errors).

The prior run predicted integration-spec fallout (specs constructing certification literals, solo
proof specs asserting the old outcome). **None materialized** — no existing spec constructs the
contested shape. Worth a reviewer's skepticism: see the coverage gap below, which is the same fact
seen from the other side.

## Known gaps — please probe these

**The signer-count plumbing is untested end-to-end, and it fails silently.** `signerCount` is
asserted at the certification boundary (`certified-claims.spec.ts`) and the weighing is asserted at
the selector boundary (`quorum-restore-certified.spec.ts`), but nothing asserts the wiring
*between* them — that `coordinator-repo.ts:1114` and `reconcile-block.ts:186,208,258,342` really
copy `verdict.signerCount` through to `certifiedSignerCount`. Because an absent count weighs as
single-signer, a broken plumb does not throw: every certified claim would quietly degrade to
single-signer and multi-signer proofs would start losing ties they should win, with no test failing
and no log line changing. This is the highest-value thing to verify by reading, and a good candidate
for a test that drives a multi-signer proof through `certifyCandidates` into `selectQuorumRev`.

**Two judgment calls made during implementation, each documented at its site but neither mandated by
the original ticket:**

- **Penalty exemptions for certified claims.** `penalizeContradictingRevClaims`
  (`coordinator-repo.ts:1363`) and `penalizeContradictingContent` (`reconcile-block.ts:280`) now skip
  claims/candidates whose proof verified. Rationale: a displaced solo holder served a commit that
  really happened — it is a partition casualty, not a liar. Counter-argument a reviewer should weigh:
  a peer serving a *forged-but-verifying* proof (the known membership-anchoring residual — anyone
  holding N keys can stand up their own N-peer cohort) is now never penalized on the restoration
  path. That residual is already tracked as
  `feat-cluster-membership-threshold-cert-anchoring`; the question is whether this change widens it.
- **Multi-signer beats single-signer instead of declining as equivocation** (`certifiedContenders`,
  `quorum-restore.ts`). This goes beyond the original ticket's letter — the ticket named the
  decline as a deadlock the prereq introduced, and recommended the rule "a single-signer proof must
  never beat multi-peer corroboration"; resolving the conflict rather than declining is the
  implementer's reading of that. It means a solo receipt can no longer force a permanent
  unrepairable state, but it also means a real two-key compromise that happens to present as
  1-signer-vs-3-signer resolves silently instead of raising an incident.

**Threshold is hard-coded at 2.** "Multi-signer" means `>= 2`, reusing `CORROBORATION_FLOOR`. A
2-of-10 cohort proof therefore outranks peer votes as fully as a 10-of-10 one. Defensible (2 is
where "one machine's word" stops), but it is a policy constant with no configuration knob.

## Docs updated

- `docs/transactions.md` § *What a repair pass will and will not accept* — the "needs no second peer
  at **any** cohort size" claim is now qualified on both the revision and content bullets.
- `docs/internals.md` — three sites: *One-peer proofs (solo cohorts)* (the old "what this does not
  address / tracked separately as ..." paragraph now states the resolution), *The certified
  exception* (signer weighing added as a fourth limit), and *Certified-claim log lines* (only proofs
  of comparable weight raise an equivocation incident).

Worth checking the docs claims against the code independently — they were written from the
implementation, so a wrong implementation would have produced confidently wrong prose.
