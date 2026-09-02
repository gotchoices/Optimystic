description: One machine's self-signed receipt for its own change no longer outranks several machines that agree with each other about the same version of a block — reviewed, gaps closed, and the one case the fix does not reach written down.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/certified-claims.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/quorum-restore-certified.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts, packages/db-p2p/test/certified-claims.spec.ts, docs/internals.md, docs/transactions.md, tickets/backlog/debt-repair-cannot-tell-a-fork-from-a-lagging-cohort.md
----

# What landed

A repairing node picks a block's winning revision from what its peers report. Two kinds of evidence
can win: several distinct peers agreeing with each other, or one peer producing a signed receipt
proving the block's cohort really committed those bytes at that revision. A verified receipt used to
win any tie at the same revision on its own — safe while receipts meant "several cohort members
signed", unsafe once `mint-solo-cohort-commit-proof` let a machine that is briefly alone legitimately
sign its own.

Certification verdicts now carry how many peers the proof lists as signers, and both repair selectors
weigh it:

- **Multi-signer proof (2+)** — wins the equal-revision tie outright, as before.
- **Single-signer proof** — wins only uncontested. At the same revision it loses to two or more
  distinct peers agreeing on a different action, and to any multi-signer proof.
- **A strictly higher corroborated revision** still beats a certified claim of either weight.
- **An uncontested lone certified holder still repairs** — the ordinary solo case the receipt mint
  exists for.
- **A missing signer count weighs as single-signer** — the conservative default.
- Mirrored on the content gate: a group of two-plus carriers meeting quorum displaces a
  single-signer certified hash; a one-carrier group (possible only where a tiny cohort relaxes
  quorum to a single vote) does not.

Two contending single-signer receipts no longer deadlock the selection, and a single-signer receipt
can no longer manufacture a permanent "cohort equivocated" decline against a multi-signer one.

Landed over two implement runs (`2048eb91`, `d00ff883`) plus this review pass.

# Review findings

Read the implement diff first, before the handoff. Re-derived every precedence rule against the
selectors rather than against the tests. Ran `yarn lint`, `yarn lint:docs`, `yarn build`,
`yarn typecheck`, `yarn workspace @optimystic/db-p2p test` (**2516 passing, 0 failing**, 49 pending)
and `yarn workspace @optimystic/db-core test` (**1594 passing, 0 failing**). No pre-existing failures
surfaced.

## Fixed in this pass

- **The signer count was never tested end to end, and a broken plumb fails silently.** The
  implementer flagged this as the highest-value thing to check and was right to. The count is
  asserted where it is measured (`certified-claims.spec.ts`) and where it is weighed
  (`quorum-restore-certified.spec.ts`), but nothing covered the wiring between — and because an
  absent count weighs as single-signer, a dropped assignment throws nothing, logs nothing, and just
  quietly makes multi-signer proofs start losing ties they should win. Added four tests driving a
  real signed proof the whole way through certification into selection: a 3-signer and a 1-signer
  case on the commit-path reconcile (`reconcile-block.spec.ts`) and the same pair on the read-repair
  path (`coordinator-repo-read-repair-trust.spec.ts`). Each pair is symmetric on purpose — the
  multi-signer test fails if the count stops arriving, the single-signer one if it arrives as a
  constant. Verified they have teeth by mutation: commenting out `reconcile-block.ts`
  `c.certifiedSignerCount = verdict.signerCount` and `coordinator-repo.ts`
  `claim.certifiedSignerCount = verdict.signerCount` each flips its multi-signer test to the
  corroborated action. Source restored.
- **Both docs overclaimed the guarantee.** `docs/internals.md` stated the change "keeps a
  briefly-partitioned machine's self-signed fork from overruling the cohort that stayed together"
  and `docs/transactions.md` that such a machine "cannot use its own receipt to overrule the cohort
  that stayed together", neither qualified. The weighing fires at an **equal** revision only. Both
  claims are now scoped, at three sites, and point at the residual ticket below. This is the failure
  mode the handoff itself warned about: docs written from the implementation restate what the code
  does as though it were what the code guarantees.
- `certifiedAnswer` in `coordinator-repo-read-repair-trust.spec.ts` hard-coded a 3-peer cohort;
  parameterized with the same default so signer weight is expressible there.

## Found, filed as a ticket

- **A solo fork one revision ahead still wins** — filed as
  `debt-repair-cannot-tell-a-fork-from-a-lagging-cohort`. A machine that commits twice while cut off
  presents revision 6 against a cohort's corroborated revision 5, and is selected. Not an oversight
  in the rule: a claim carries no lineage, so "one peer ahead of two" is identical whether it forked
  or the two are lagging, and refusing it would break ordinary lagging-cohort repair — which is why
  the ticket is filed at the representation rung (make lineage visible, either in the proof or in a
  wider repair answer) rather than as a point fix in the selector. Verified rather than inferred:
  pinned as `does NOT reach a solo fork one revision AHEAD` in `quorum-restore-certified.spec.ts`,
  which asserts the current outcome so the boundary is visible instead of assumed, with a `NOTE:` at
  the selector site pointing at the ticket. This residual predates the change; the change narrows
  the class without closing it.

## Checked and found sound

- **The signer count is a safe proxy.** `signerCount` is `proof.peerIds.length` — the declared
  signer list, not a count of signatures actually collected — so the `>= 2` threshold deserved
  checking. `verifyBlockCommitProofClaim` rejects a duplicated id outright (`duplicate-signer`,
  `commit-proof.ts`) and counts only verified signatures from that exact set against
  `ceil(superMajorityThreshold * peerIds.length)`. Two or more listed peers therefore implies two or
  more genuinely distinct valid signatures. The threshold is sound where it is drawn.
- **The penalty exemptions do not widen the forged-proof residual**, which was the handoff's own
  open question. On the content path `penalizeContradictingContent` already ran only when no
  certified carrier held the agreed hash, and on the read path `penalizeContradictingRevClaims`
  already returned early on a certified selection — both pre-existing. The new inner guards add only
  the case where a certified claim *loses*: they decline to convict a displaced holder. Declining to
  convict cannot hand a forged proof a reputation lever;
  `feat-cluster-membership-threshold-cert-anchoring` is unchanged in scope.
- **Resolving multi-signer-over-single-signer instead of declining** goes beyond the original
  ticket's letter, as the handoff admits. It is the right call: the alternative lets any single
  machine mint a receipt that forces a permanent unrepairable state, which is a denial lever, not a
  safety property. The cost — a two-key compromise presenting as 1-versus-3 resolves without an
  incident line — is stated in `docs/internals.md`.
- **The threshold of 2 needs no configuration knob.** It reuses `CORROBORATION_FLOOR`, and 2 is
  exactly where the security property above holds. A 2-of-10 proof outranking peer votes as fully as
  a 10-of-10 one is the intended reading of "no longer one machine's word".
- Source hygiene: `quorum-restore.ts` 475 lines, `reconcile-block.ts` 427, `certified-claims.ts` 332
  (`wc -l`). No size debt. `certifiedContenders` and `certifiedHashes` keep the contention rule in
  one place each, so the selectors and their equivocation reporters cannot drift.
- Reporter/selector independence holds on both gates, and both call sites key incident logging off
  the decline, as the handoff claimed.

## Considered and left alone

- **The content-gate mirror weakens a cryptographic check.** After revision selection every carrier
  claims the same `(revision, action)`, so a proof's declared digest binds those exact bytes — and
  two proof-less carriers serving different bytes can now displace it. The safety argument is
  genuinely weaker here than on the revision gate. But this is precisely what the implement ticket
  specified ("a single-signer certified hash does not displace a hash group that meets the ordinary
  quorum"), and the implementer tightened it beyond the letter by demanding two-plus carriers rather
  than a bare quorum. The call was made upstream; not re-litigated.
- Use case 4 (a corroborated pair agreeing with the sole certified action keeps the certified
  verdict) is covered by `pools distinct certified claimants of the winning pair as its supporters`,
  whose name does not say so. The branch is exercised; renaming a passing test buys nothing.

## Empty categories

- **No new tripwires.** Nothing in this diff is "fine now, only matters if X grows" — the one
  conditional concern in the touched area, the per-reconcile re-hash of every carrier's block,
  already carries its `NOTE:` in `hashCarriers` and is untouched and still accurate.
- **No accepted-tradeoff `NOTE:` was overridden.** None of the sites this review touched carried one.
- **No blocked-stage output.** Nothing here needs a human decision or an out-of-repo dependency.
