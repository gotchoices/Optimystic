description: A machine that saves data without also stating what that data should look like keeps no proof the save happened, and other machines then refuse to accept a copy — so the data stops spreading. One integration test was in exactly that state and failing; it now declares what it saves, the contract is written down where the next reader will meet it, and the one production path with the same problem has been measured and filed.
files: packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-core/test/digest-cache-coverage.spec.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/network/i-repo.ts, packages/db-core/package.json, packages/db-p2p/package.json, docs/correctness.md, tickets/backlog/debt-digest-coverage-capped-by-read-cache.md
----

# Complete: content-digest declaration — test fix, contract documentation, measured read-cache gap

Implemented in `046ac65d`, reviewed and amended in this stage. All three arms landed; nothing was
deferred; the review filed no new tickets (the one backlog ticket,
`debt-digest-coverage-capped-by-read-cache`, was filed by the implement stage and stands).

## What the work was

A commit may declare, per block, the content digest that block will hold once the commit lands
(`CommitRequest.blockDigests`). The field is optional. Two things hang off it: cohort members
re-materialize and vote reject on disagreement, and `StorageRepo` retains a durable
`BlockCommitProof` **only** for a declared block. A block with no proof is refused by every push
receiver under the default `requirePushCertificate: true` — it stays readable, pullable, and
repairable by corroboration while two or more holders remain, but it can never *gain* a holder by
push, so churn-driven re-replication silently stops maintaining its replication factor.

- **Arm A** — every hand-built commit in `real-libp2p.integration.spec.ts` now declares, via a new
  `makeBlockDigests` helper; all nine vestigial `as any` casts removed. This fixed the failing
  `churn re-replication` test (1 failing at HEAD to 0).
- **Arm B** — `blockDigests` stays optional by decision; the rationale, the measured migration cost
  of making it required, and the revisit condition are recorded as accepted-tradeoff `NOTE:`s at
  `network/struct.ts` (canonical), `network/i-repo.ts` (pointer), `transform/digest.ts`, plus two
  paragraphs in `docs/correctness.md`.
- **Arm C** — the suspected production gap was measured and confirmed: declaration coverage is capped
  by the read cache, not bounded by the transaction. Pinned by a standing guard at
  `packages/db-core/test/digest-cache-coverage.spec.ts`; remediation filed as
  `tickets/backlog/debt-digest-coverage-capped-by-read-cache.md`.

## Review findings

### Verified — adversarial checks the implementation passed

- **The declared digests are correct, not merely accepted.** `makeBlockDigests` emits `{ digest }`
  with no `baseRev`. `previewCommitDigest` reports `baseIndependent: true` for an insert, and
  `cluster-repo.ts` treats `baseIndependent` as checkable regardless of declared `baseRev` — so the
  cohort check genuinely *runs* on these commits rather than abstaining. A wrong digest would reject
  the commit, so the green tier is real evidence.
- **The churn test genuinely exercises certified push end to end.** Re-ran it with
  `DEBUG='optimystic:*'`: the log shows `certified-claims accept-unanchored block=spread-churn-block-0
  rev=1 signers=2` and `spread-on-churn push:ok` twice, and contains **no** `cert:no-local-proof`,
  `push:reject-uncertified`, or `commit:proof-undeclared` — the chain
  `persistProofIfContentMatches` to certification to `handlePush` really is covered now.
- **Arm C's published coverage table was independently re-measured**, not taken on trust. A throwaway
  spec driving the same production path reproduced it exactly — N=32 gives 32 (100%), 128 gives 126
  (98.4%), 200 gives 126 (63.0%), 256 gives 126 (49.2%), 512 gives 126 (24.6%). The numbers quoted in
  the NOTE and the backlog ticket are correct. (Throwaway spec deleted; nothing left in the tree.)
- **The two sites declared beyond the ticket's enumeration** (`two-a1`, `drop-a1`) were the right
  call and are kept: they are the same hand-built `makeTransforms` shape as the enumerated ones, and
  leaving them undeclared would have preserved exactly the drift that produced this ticket.
- **The new guard is cheap.** All three tests run in 124 ms, so the generous 30/60/120 s timeouts
  never cost the default unit suite anything.
- **The guard's degenerate case is handled**: if nothing at all were declared, `Math.max(...[])` is
  `-Infinity` and the "newest block still declared" assertion fails — a broken harness cannot pass
  as a confirmed gap.
- **The proof-retention rule is covered at unit level** at the back-fill and replicate sites
  (`block-storage.spec.ts`, `block-transfer-push-persist.spec.ts`), and `persistProofIfContentMatches`
  is shared with the fresh-commit path, whose wiring is now covered end-to-end by the churn test.

### Fixed in this pass (minor)

- **`yarn typecheck` was close to a no-op** — only `quereus-plugin-optimystic` defined the script, so
  the root `foreach` silently skipped `db-core` and `db-p2p` and exited 0. The implement stage
  noticed this and left it to review. Confirmed `tsc --noEmit` is clean in both, added
  `"typecheck": "tsc --noEmit"` to each. Root `yarn typecheck` now really checks all three packages
  (22 s, was ~18 s checking one). `yarn check` was already sound because it builds first.
- **The push-refusal consequence was stated in full in five places** (`struct.ts`, `i-repo.ts`,
  `digest.ts`, the new spec's header, the integration helper's jsdoc) plus `docs/correctness.md` —
  one fact, five copies to update when the `requirePushCertificate` default next moves. Left
  canonical at `struct.ts`; the other three now state the consequence in one line and point there.
  Net 14 fewer comment lines, no fact lost.

### Recorded as a tripwire, not filed

- The concrete **126** in the tables is not pinned by any assertion — the spec deliberately pins the
  *shape* of the gap (bounded by the cache; identical at 2x and 4x) so it does not break on an
  off-by-one in how many slots the collection header and log tail take. The cost is that the quoted
  table rots silently if `CacheSource`'s `DefaultMaxSize` changes. Parked as a `NOTE:` at the
  `CacheCapacity` constant in `digest-cache-coverage.spec.ts`, with the re-measure instruction and
  the date it was last confirmed.

### Checked and found not to be a problem

- `src/testing/reactivity-mesh-harness.ts` and `src/testing/raw-storage-conformance.ts` also commit
  without declaring — structurally the same omission as the bug. Neither drives a push receiver
  (notification origination, and raw-storage conformance), so no proof is needed and declaring would
  buy nothing. Not filed.

### Major findings

**None.** The three arms do what the ticket asked, the measurement is reproducible, and no
correctness, resource-cleanup, or error-handling defect surfaced in the diff. No new `fix/`, `plan/`,
or `backlog/` ticket was opened by this review.

## Validation run at review

| Command | Result |
| --- | --- |
| `yarn lint` (root) | clean, exit 0 |
| `yarn build` (root) | success, 59 s |
| `yarn typecheck` (root, after the fix) | clean, 22 s, all three packages |
| `npx tsc --noEmit` in `db-core` / `db-p2p` | 0 errors each |
| `yarn workspace @optimystic/db-core test` | **1426 passing**, 0 failing |
| `yarn workspace @optimystic/db-p2p test` | **2274 passing**, 44 pending, 0 failing |
| db-p2p integration tier (`OPTIMYSTIC_INTEGRATION=1`) | **30 passing, 2 pending, 0 failing** — run twice, before and after the review edits |
| `digest-cache-coverage.spec.ts` alone | 3 passing, 124 ms |

No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written. Nothing was
skipped, disabled, or loosened.

## Carried forward for whoever picks up the backlog ticket

- Arm C measures one workload shape (insert-then-update-everything, one action per block, one
  collection, `TestTransactor`). The 1/N decay and the cap are real; a different access pattern that
  keeps old ids warm would land elsewhere on the curve.
- No workload is known to actually commit more than 128 update-carrying blocks in one action, so this
  is a confirmed capacity defect with no observed victim — that is the decline argument stated in the
  backlog ticket's `tradeoffs:`.
- The 194-error migration cost quoted in the `struct.ts` NOTE comes from the upstream ticket and was
  not re-measured here. The recipe to re-verify is in the NOTE.
