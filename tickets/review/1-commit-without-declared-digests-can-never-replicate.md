description: A machine that saves data without also stating what that data should look like keeps no proof the save happened, and other machines then refuse to accept a copy — so the data stops spreading. One integration test was in exactly that state and failing; it now declares what it saves, the contract is documented where the next reader will meet it, and the one production path with the same problem has been measured.
files: packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-core/test/digest-cache-coverage.spec.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/network/i-repo.ts, docs/correctness.md, tickets/backlog/debt-digest-coverage-capped-by-read-cache.md
----

# Review: content-digest declaration — test fix, contract documentation, and the measured read-cache gap

All three arms landed. Nothing was deferred. Arm C's measurement **confirmed** the suspected gap and
produced hard numbers.

## Background in one paragraph

A commit may declare, per block, the content digest that block will hold once the commit lands
(`CommitRequest.blockDigests`). The field is optional. Two things hang off it: cohort members
re-materialize and vote reject on disagreement (so declaring turns a blind vote into a checked one),
and — the part that bit — `StorageRepo` retains a durable `BlockCommitProof` **only** for a declared
block. A block with no proof is refused by every push receiver under the default
`requirePushCertificate: true`. It stays readable and pullable (`handlePull` is not
certificate-gated) and still repairs by corroboration while two or more holders remain, but it can
never *gain* a holder by push, so churn-driven re-replication silently stops maintaining its
replication factor.

## What landed

### Arm A — the integration test, in production shape (was the release blocker)

`packages/db-p2p/test/real-libp2p.integration.spec.ts`:

- New `makeBlockDigests(blockId)` helper next to `makeTransforms`, with a comment explaining why
  declaring is mandatory *in this file* even though the field is optional in the type.
- Every hand-built commit now declares: `pendCommitGet`, and the direct commits for `two-a1`,
  `drop-a1`, `cold-a1`, `rt-a1`, `mm-a1`, `spread-churn-a1`.
- All nine vestigial `as any` casts removed — the seven `repo.commit({...})` sites the ticket named,
  **plus** the two `client.get(..., { expiration } as any)` sites at the redirect tests, which turned
  out to be equally vestigial. `npx tsc --noEmit` in `packages/db-p2p` is clean with all nine gone.

**Deviation from the ticket, flagged for review:** the ticket's TODO enumerated `pendCommitGet`,
line 407 and line 529, but its prose said "the other hand-built commits in the file". The `two-a1`
(was line 224) and `drop-a1` (was line 290) commits are also hand-built `makeTransforms` commits and
were omitted from the enumeration. I declared those two as well, on the reading that the enumeration
missed them rather than excluded them — leaving them undeclared would preserve exactly the drift that
produced this ticket. Both pass. If the reviewer disagrees, they are two lines to revert.

### Arm B — contract decided and recorded at the sites (documentation only, no code change)

`blockDigests` stays **optional**, per the ticket's decision. Accepted-tradeoff `NOTE:`s written
where the next reviewer will meet them:

- `packages/db-core/src/network/struct.ts` at `CommitRequest.blockDigests` — the full rationale: the
  three reasons the field stays optional, the measured migration cost (≥194 `tsc --noEmit` errors
  across ≥39 files) carried verbatim so nobody re-derives it, and the revisit condition.
- `packages/db-core/src/network/i-repo.ts` at `RepoCommitRequest.blockDigests` — short pointer to the
  above, so the two do not drift.
- `packages/db-core/src/transform/digest.ts` — the **existing** NOTE updated. Its old justification
  ("omission degrades to corroboration rather than failing, so this is safe") predated the
  `requirePushCertificate: true` default and was no longer the whole consequence; it now states push
  refusal, carries arm C's measured numbers, and names the new backlog ticket.
- `docs/correctness.md` — two additions: a forward-pointer sentence on the "Content digest
  declaration" definition, and a `*The cost of not declaring.*` paragraph in the Theorem 14
  durable-proof discussion.

As instructed, `commit:proof-undeclared` / `push:reject-uncertified` were **not** promoted onto the
libp2p component logger — that would be a seventh instance of the trap
`backlog/debt-service-logs-split-across-two-logger-factories` documents.

### Arm C — measured; the gap is real, and worse than "quieter than it looks"

New guard: `packages/db-core/test/digest-cache-coverage.spec.ts` (3 tests), driving the **production**
path (`Collection.act` → `Collection.sync` → `computeBlockContentDigests`), not the digest function
directly — unit mechanics are already covered by `digest.spec.ts`.

**The number, which is the whole point of the arm.** For a commit updating N blocks:

| N update-carrying blocks | declared | coverage |
| --- | --- | --- |
| 32 | 32 | 100% |
| 128 | 126 | 98.4% |
| 200 | 126 | 63.0% |
| 256 | 126 | 49.2% |
| 512 | 126 | 24.6% |

The declared count does not thin out — it **caps**. 126 = the `CacheSource` default 128 slots less the
collection header and log tail. So coverage is `min(N, 126) / N`: it decays as 1/N, and an
arbitrarily large commit declares an arbitrarily small fraction of itself. Survivors are the newest
contiguous run of ids, exactly as LRU eviction predicts.

Remediation **not** attempted here (both candidates are larger than this ticket, as the ticket
directed). Filed as `tickets/backlog/debt-digest-coverage-capped-by-read-cache.md`.

## Validation — what was actually run

| Command | Result |
| --- | --- |
| `yarn lint` (root) | clean |
| `yarn build` (root) | success, 51s — the real typechecker for db-core/db-p2p |
| `npx tsc --noEmit` in `packages/db-p2p` | 0 errors with all nine casts removed |
| `yarn test` (root, all workspaces) | exit 0, 13m36s |
| db-core unit suite direct | **1426 passing**, 0 failing |
| db-p2p integration tier (`OPTIMYSTIC_INTEGRATION=1`, full `test/**/*.integration.spec.ts`) | **30 passing, 2 pending, 0 failing** — run twice |
| `test/digest-cache-coverage.spec.ts` alone | 3 passing |

At HEAD the integration tier was 29 passing / 2 pending / **1 failing**; `churn re-replication` now
passes in ~0.8s against its 15s timeout. No pre-existing failures surfaced, so no
`tickets/.pre-existing-error.md` was written. Nothing was skipped, disabled, or loosened.

## What to actually check — use cases and validation targets

**Highest value first.**

1. **Are the declared digests correct, or merely accepted?** A wrong digest is not a weaker test but
   a failing one — cohort members vote reject with `content-digest-mismatch` on the promise round. So
   a green integration tier is real evidence. But confirm the *shape* is right: `makeBlockDigests`
   emits no `baseRev` because `makeTransforms` only inserts. Verify that matches what
   `computeBlockContentDigests` produces for an inserted block (it should — inserts are
   base-independent). If any of these tests ever gains an update-carrying transform, the helper is
   wrong for it and will need a `baseRev`.

2. **Does the churn test now genuinely exercise certified push, end to end?** That was the
   `require-proof-on-block-push` handoff's largest stated gap. Worth confirming the chain actually
   runs: `persistProofIfContentMatches` stores a proof → `sourceBlockCertification` finds it →
   `handlePush` accepts under `requirePushCertificate: true`. A cheap way to check: run
   `--grep "churn re-replication"` with `DEBUG='optimystic:db-p2p:*'` and confirm
   `cert:no-local-proof` and `push:reject-uncertified` are *absent* where they fired at HEAD.

3. **The two extra sites I declared beyond the ticket's enumeration** (`two-a1` at the two-node mesh
   test, `drop-a1` at the three-node-dropped test). Judgement call — see the deviation note above.

4. **Arm C's guard is a tripwire by construction.** `pins today's gap` asserts the shortfall exists
   and `the declared count saturates...` asserts it caps. When a remediation lands, both fail on
   purpose. Check the comments say clearly enough what to do at that point (retire the two tests,
   update the NOTEs at `transform/digest.ts` and `network/struct.ts`, close the backlog ticket) —
   that is the whole mechanism keeping the docs from rotting.

5. **Edge cases the ticket required to survive** — confirm none were broken:
   - tombstone / delete-only commits still commit and still declare nothing (`digest.spec.ts`
     covers; the new spec's `insert`/`update` modules deliberately do not exercise delete),
   - `commit:proof-digest-mismatch` (diverged member) stays distinguishable from
     `commit:proof-undeclared` (declared nothing) — same absent proof, very different meaning,
   - `backFillProof` shares `persistProofIfContentMatches` and was not touched,
   - multi-block per-batch narrowing (`network-transactor.ts` `digestsFor`) was not touched,
   - `push:reject-uncertified` still fires for genuinely unproven content — nothing here weakened it.

## Known gaps and honest caveats

- **Arm B changed no code.** The decision was "keep it optional and write it down", so the entire arm
  is comments plus two doc paragraphs. Its value is entirely in whether the next reviewer actually
  finds those NOTEs before re-filing the same finding. Judge them on that.
- **The ≥194-error migration cost in the `struct.ts` NOTE is carried from the upstream ticket, not
  re-measured by me.** It was measured there; I did not re-run it. If the reviewer wants it verified,
  the recipe is: make the key required-but-nullable on both `RepoCommitRequest` and `CommitRequest`,
  then `npx tsc --noEmit` per package.
- **Arm C measures one workload shape** — insert-then-update-everything, one action per block, one
  collection, `TestTransactor`. The 1/N decay is real and the cap is real, but a different access
  pattern (interleaved reads that keep old ids warm) would land somewhere else on the curve. The
  ticket asked "what fraction ends up declared"; that is answered, for this shape.
- **No workload is known to actually commit >128 update-carrying blocks in one action.** So the arm C
  gap is a confirmed capacity defect with no observed victim. That is stated as the decline argument
  in the backlog ticket's `tradeoffs:`.
- The db-p2p integration tier takes ~30–40s and spins real TCP meshes; it was green on both runs, but
  it is the sort of tier that flakes under load. If the reviewer sees an intermittent failure that is
  not `churn re-replication`, it is unlikely to be from this diff.

## Noticed, not fixed — reviewer's call

Carried forward verbatim from the implement ticket, still true and still unfiled:

`yarn typecheck` at the repo root is close to a no-op. Only `packages/quereus-plugin-optimystic`
defines a `typecheck` script (`tsc --noEmit`); `db-core` and `db-p2p` do not, so
`yarn workspaces foreach -At ... run typecheck` skips them and exits 0 in ~18s. Type errors in those
two packages *are* still caught, because `yarn check` runs `yarn build` (a real `tsc`) first — so
`yarn check` itself is sound. But `yarn typecheck` alone is misleading to anyone using it as a fast
pre-flight. Whether adding `"typecheck": "tsc --noEmit"` to those two packages is worth the one-line
change is the review stage's decision.

## Review findings

- Arm C's suspected read-cache declaration gap was **confirmed**, measured (coverage caps at 126
  blocks, decaying as 1/N), pinned by a standing guard at
  `packages/db-core/test/digest-cache-coverage.spec.ts`, and its remediation filed as
  `tickets/backlog/debt-digest-coverage-capped-by-read-cache.md`.
- The `NOTE:` at `packages/db-core/src/transform/digest.ts` was out of date rather than merely
  incomplete — its "omission is always safe" justification predated the `requirePushCertificate:
  true` default. Corrected in place with the measured numbers.
- Accepted-tradeoff decision (keep `blockDigests` optional) parked at
  `packages/db-core/src/network/struct.ts` and `packages/db-core/src/network/i-repo.ts`, with the
  migration cost and revisit condition, so the next reviewer does not re-derive it.
- `yarn typecheck` being a near no-op for `db-core`/`db-p2p` is recorded in the section above rather
  than filed; `yarn check` is unaffected because it builds first.
