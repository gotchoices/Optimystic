description: The written documentation stated two things the code no longer does — an old agreement threshold and an old name for transactions — so a reader who followed it would have budgeted against the wrong safety margin or written code that does not compile. Both are now fixed to match the code.
files: docs/correctness.md, docs/right-is-right.md, docs/repository.md, docs/transactions.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/readme.md, packages/db-p2p/src/cluster/cluster-repo.ts (~991), packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts (~12)
difficulty: easy
----

# Documentation restated code facts that had drifted — fixed

Two independent arms, both docs-only (Arm A also touched two code comments). No behaviour change;
verified with a targeted build + test run of the touched package, not the full monorepo suite.

## Arm A — super-majority threshold default: 0.67 → 0.75

`DEFAULT_SUPER_MAJORITY_THRESHOLD` (`packages/db-core/src/cluster/structs.ts:58`) is `0.75` and is
applied by `resolveClusterPolicy` (`packages/db-p2p/src/cluster/cluster-policy.ts`). Several docs
still said the default was `0.67` (true before ticket `6.2-implement-supermajority-threshold-coupling`
unified three drifting defaults onto this one constant) and cited a stale line number
(`libp2p-node-base.ts:605`) as the resolution site.

**Fixed, all citing `resolveClusterPolicy`/`DEFAULT_SUPER_MAJORITY_THRESHOLD` by file+symbol instead
of a line number:**
- `docs/correctness.md` — 5 sites (implementation-status notice, §1.5 status, Theorem 1 Case 3,
  Theorem 2, Theorem 10 status notes).
- `docs/right-is-right.md:142`.
- `packages/db-p2p/src/cluster/cluster-repo.ts` `admissionFloor`'s `NOTE:` comment.
- `packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts` doc comment (the test's own
  `threshold: 0.67` scenario rows are deliberate overrides, not defaults — left unchanged and still
  pass).

**A finding that changed the substance, not just the number:** since the *actual* default (0.75) now
equals the proof's own assumption (≥75%), the "threshold discrepancy" framing in the Theorem 2 and
Theorem 10 status notes was no longer just a stale digit — the discrepancy itself no longer exists. I
rewrote those two status notes rather than search-replacing the digit:
- **Theorem 2** status note used to say "proof assumes 0.75, code defaults to 0.67, but the compound
  product `2·admissionFraction·superMajorityThreshold` still holds at `2·0.75·0.67=1.005`". Now that
  code and proof agree at 0.75, I re-derived the real product at the actual shared defaults:
  `2 · 0.75 · 0.75 = 1.125` (`membershipAdmissionFraction` also defaults to 0.75, in
  `packages/db-p2p/src/cluster/cluster-repo.ts`). The margin is larger than the old text implied, not
  smaller — the compound-product point (proof's simple K-counting argument isn't the whole story once
  the admission gate can admit a shrunk `K′`) is still worth keeping, so I kept it, just re-derived.
- **Theorem 10** status note used to say the code's `0.67` gave "~33% effective Byzantine tolerance,
  not 25% as stated." That's now false — at the real 0.75 default the tolerance *is* the stated ~25%
  (K/4). Reworded accordingly; the "~33%" figures in the §1.5 status note and the Theorem 10
  "Effective guarantee today" line are now "~25%" to match.

Two sites already correct before this ticket (fixed during review of
`corroboration-floor-defaults-to-two-for-large-meshes`, confirmed still correct, left untouched):
`packages/reference-peer/src/cli.ts` help text, `packages/reference-peer/README.md`.

## Arm B — retired "trx" vocabulary → "action"

Source finished the `TrxBlocks→ActionBlocks`, `trxRef→actionRef`, `trxId→actionId` rename; `TrxBlocks`
survives only as a one-line deprecated alias in `packages/db-core/src/network/struct.ts` (left alone —
deleting it is a breaking change and explicitly out of scope). Docs still used the old names in several
places. **Not every "trx" hit was actually stale** — I verified each site against the real code rather
than blanket-replacing:

**Fixed (named the current vocabulary, and for code snippets matched the real signature):**
- `docs/repository.md` — 7 sites: `getStatus`, `pend`, `cancel`, `commit` method docs now say
  `actionRef`/`ActionBlocks` instead of `trxRef`/`TrxBlocks`.
- `docs/transactions.md` — 2 of its 4 "trx" hits were a real drift: a Phase-0 migration note claimed
  `TrxId`/`TrxRev` are "kept as deprecated aliases" — verified via repo-wide grep that no such aliases
  exist (unlike `TrxBlocks` and its siblings, `TrxId`/`TrxRev` were renamed with no alias kept). Fixed
  the two false claims; left the two neighboring checklist lines (`[x] Audit all uses of "Trx"...`,
  `renamed generate-*-trx-id.ts...`) alone — those are an accurate historical record of the rename
  task itself, not a claim about current state.
- `packages/db-p2p/docs/cluster.md` — one fenced TypeScript snippet's `operation.cancel.trxRef` →
  `operation.cancel.actionRef` (matches `cluster-repo.ts`'s real call). Note: the surrounding
  `handleConsensus`/`executedTransactions` method in that snippet no longer matches current
  `cluster-coordinator.ts` beyond that one token — pre-existing drift, out of scope per the ticket's
  explicit "don't restructure beyond naming and numbers."
- `packages/db-p2p/readme.md` — two sites: a `StorageRepo implements IRepo` code snippet's
  `cancel(trxRef: TrxBlocks)` → `cancel(actionRef: ActionBlocks)` (matches
  `packages/db-p2p/src/storage/storage-repo.ts:490` exactly), and the filesystem-backend directory
  listing's `trx/{actionId}.json` → `actions/{actionId}.json` (verified against
  `packages/db-p2p-storage-fs/src/file-storage.ts`, whose own comment says the real directory is
  `actions/`). This second one wasn't in the ticket's file list or occurrence count — found while
  fixing the first; same class of drift, same file, fixed while there.

**Verified accurate, deliberately left unchanged** (these were in the ticket's occurrence table but
turned out to be correct, not stale):
- `docs/internals.md` (3 sites), `docs/architecture.md` (1), `docs/optimystic.md` (1) — all describe
  `trxId` as the coordinator's log-correlation variable name and `actionId` as the network-transactor's.
  Checked against the real code: `packages/db-core/src/transaction/coordinator.ts` still literally logs
  `trxId=%s` (a local variable, never renamed), and `network-transactor.ts` does use `actionId`. The
  docs are accurate here — the source itself never finished this particular rename, so the docs
  shouldn't claim it did.

## Verification

- `cd packages/db-p2p && yarn build` — clean.
- `yarn mocha --loader=ts-node/esm test/cluster-coordinator-supermajority.spec.ts` — 3/3 passing
  (confirms the comment-only edit didn't touch the deliberate `0.67`-override test scenarios).
- `yarn mocha --loader=ts-node/esm test/cluster-membership-admission.spec.ts test/cluster-policy.spec.ts`
  — 33/33 passing (the tests closest to the `admissionFloor` NOTE comment and `resolveClusterPolicy`
  I cited repeatedly across the docs).
- Did not run the full monorepo test suite or other packages' builds — this ticket touched no
  production logic (comments + prose only), so a targeted check of the two edited source files' package
  was judged sufficient. No pre-existing test failures encountered.

## Gaps / known limitations for the reviewer

- I did not re-derive or double check theorem numbering, section cross-references, or the Appendix
  dependency graph in `docs/correctness.md` — only the 5 flagged threshold-default sites were touched.
- `docs/repository.md`'s `IBlockNetwork` interface name (the real type is `IRepo`,
  `packages/db-core/src/network/i-repo.ts:41`) and `commit`'s two-arg `(tailId, actionRef)` shape (the
  real `IRepo.commit` takes one `RepoCommitRequest` object) are both further drift on the same page,
  visible while fixing the vocabulary. Left alone per the ticket's explicit scope note ("Do not
  renumber, restructure or otherwise rewrite these documents beyond the naming and the numbers... mixing
  that in makes the diff unreviewable"). Flagging here rather than filing a ticket, since I have not
  swept the rest of the page for how much more drift exists — a reviewer or future pass should decide
  whether this warrants its own ticket.
- `packages/db-p2p/docs/cluster.md`'s `handleConsensus` code snippet has drift beyond the one token I
  fixed (the method doesn't appear under that name in current `cluster-coordinator.ts` — likely moved/
  refactored). Same reasoning: out of scope here, flagging for the reviewer rather than expanding this
  ticket's diff.
