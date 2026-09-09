description: A storage node that missed updates to a block will still apply the next update it receives on top of its old copy, silently forking the block's content. Add a commit-time guard that compares the node's local revision against the base revision the writer declares, refusing and healing instead of forking.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/transform/digest.ts
repro: verified
difficulty: medium
----

# Guard `internalCommit` against a gapped base using the writer's declared `baseRev`

## The defect, reproduced directly in db-p2p

A block's revisions form a chain: revision N is transform N applied to the block content the writer read. A cohort member that missed intermediate updates to a block and then receives a later commit applies that commit's transform to the stale copy it still holds, records the result under the new revision number, and carries on. Same revision number, different bytes, forever — and (since the 0.29.0 member-side content-digest check) that member rejects every later write to the block with `content-digest-mismatch`.

Reproduced with two in-process `StorageRepo`s over `MemoryRawStorage` (no cluster, no network) during the fix pass:

- Both repos: insert block at rev 1 (`items: []`), update rev 2 (append `'a'`, declared base 1).
- Healthy repo only: revs 3 and 4 (append `'b'`, `'c'`).
- Both repos: rev 5 (prepend `'z'`, writer's declared base 4).

Current behavior: the gapped repo's `commit` **succeeds**. Both repos report latest rev 5; healthy holds `["z","a","b","c"]`, gapped holds `["z","a"]`; `canonicalBlockHash` differs. That is the fork, produced in ~40 lines with the helpers already in `test/storage-repo.spec.ts`.

The original fix-stage ticket also verified the same fingerprint downstream (`../sereus` `control-write-degraded-cohort-member` scenario, 122 `cluster-member:content-digest-mismatch` records, all with `previewBaseRev === declaredBaseRev`).

## Why the obvious guard (`latest.rev !== rev - 1`) is WRONG — do not land it

Revisions are allocated per **collection**, not per block. A block only takes a revision when an action touches it, so a member holding block X at rev 1 legitimately receives a commit of X at rev 7 when revs 2–6 touched other blocks in the collection. That behavior is deliberately pinned by `test/storage-repo.spec.ts` "commits across an arbitrary revision gap when a base IS held" (~line 2080). A `rev - 1` guard breaks routine writes. The fix-stage research that first proposed it missed this; the pinned test must stay green.

The same reasoning kills the originally-suggested pend-tier abstain (`latest.rev < rev - 1` in `validatePendOperations`): a per-block gap under the collection rev is normal, and the pend request carries no per-block base declaration to compare against. Drop that idea entirely.

## The correct discriminator is already on the wire

`CommitRequest.blockDigests[blockId]` (`packages/db-core/src/network/struct.ts:114-125`) is the writer's per-block declaration `{ digest, baseRev? }`, where `baseRev` is "committed revision of the base the digest was computed from" — the block-level base the writer actually applied its transform to (pinned at update-stage time by the tracker; see `packages/db-core/src/transform/digest.ts`). It is absent for base-independent (insert-carrying) transforms and rides inside every cohort signature preimage.

- Legitimate collection-level gap: writer read the block at rev 1 → declares `baseRev: 1` → equals the member's `latest.rev` → commit proceeds.
- The fork case: writer declares `baseRev: 4`, gapped member holds rev 2 → mismatch → member must refuse.

`StorageRepo.commit` already receives the full commit op including `blockDigests` on every path — `ClusterMember.applyConsensusOperation` (`cluster-repo.ts:1950`) passes the wire op straight through.

## The validated fix

Spiked during the fix pass and validated: the direct repro flips to a refusal, and the **entire db-p2p suite (2622 tests) passes unchanged**. The spike was reverted; land it properly with the tests below. The diff, verbatim as validated:

In `storage-repo.ts` `commit`, the `internalCommit` call site (~line 908):

```ts
const collectionId = await this.internalCommit(blockId, request.actionId, request.rev, storage, latch, proof, request.blockDigests?.[blockId]?.baseRev);
```

`internalCommit` gains a `declaredBaseRev?: unknown` parameter, and immediately after `const latest = await storage.getLatest();` (~line 1196):

```ts
if (typeof declaredBaseRev === 'number' && !transform.insert && latest?.rev !== declaredBaseRev) {
	return await this.refuseMissingBase(blockId, actionId, rev, storage, latch,
		`local latest ${latest?.rev ?? 'none'} is not the declared base ${declaredBaseRev} of rev ${rev}`);
}
```

Observed refusal from the repro: `missing-base-revision: block block-1 cannot materialize rev 5 — local latest 2 is not the declared base 4 of rev 5`; the gapped repo stayed at rev 2.

Design rules baked into that condition, each deliberate — keep them and document them at the site:

- **`typeof declaredBaseRev === 'number'`** — `blockDigests` is untrusted wire data with no ingress schema (same rule as `validateCommitOperations`, `cluster-repo.ts:1698-1705`). A missing, malformed, or absent-by-design declaration abstains: the guard never fires, preserving today's behavior for pre-upgrade writers and undeclarable blocks.
- **`!transform.insert`** — an insert-carrying transform is base-independent (the declared entry omits `baseRev` by type, but a hostile writer could include one; key on the member's OWN pended transform shape, exactly as `previewCommitDigest` does).
- **`latest?.rev !== declaredBaseRev`** covers three states: behind the declared base (the fork case), *ahead* of it (this member holds a revision the writer never saw — divergent history, equally unsafe to apply), and no local revision at all against a numeric declaration.
- **`refuseMissingBase`** is the whole point of needing no new machinery: it throws `MissingBaseRevisionError`, which `commit` classifies as divergence (~line 920) and drops the batch's unpromotable pendings; `ClusterMember.applyConsensusOperation` maps the resulting `missing-base-revision` failure to "behind" divergence and runs `reconcileDivergentCommit` (`cluster-repo.ts:2014-2023`), pulling the committed revision from a cohort peer. The writer's retry then lands on a healed base. `CoordinatorRepo` likewise already tolerates the reason (`coordinator-repo.ts:2479`).
- A hostile writer declaring a junk numeric `baseRev` can force refusals and reconcile churn, but never a fork — and the promise-round digest check already rejects lying declarations wherever a caught-up member can check.

Note `internalCommit` has a second caller — the read-driven promotion in `get()` — which has no commit request and passes no declaration; the guard abstains there. That is correct today (context-promotion has nothing to compare) but worth one sentence at the site.

## Comment updates that must land with the guard

- `cluster-repo.ts` ~1648-1650, the digest-check abstain rule: "a lagging member applying an update-only transform to an older base legitimately materializes different bytes" — after this fix a lagging member never materializes them; it refuses at apply and reconciles. The vote-time abstain itself stays correct (a lagging member still cannot *judge* content at the promise round); only the justification prose is stale.
- `validateCommitRevisions` doc (`cluster-repo.ts` ~1528 region): says a member behind the commit "cannot judge it" and abstains on the assumption apply-time catches it. That assumption becomes true with this guard — say so.
- The pinned gap test's comment (~`storage-repo.spec.ts:2080`) can now state the full rule: an arbitrary rev gap commits when the held base **matches the writer's declared base** (or nothing is declared).

## Residual gap (document, don't chase)

A commit whose block declares no digest — pre-upgrade writer, undeclarable block (read-far-then-update eviction, see `digest.ts` NOTE), or delete-only transform — still gap-applies exactly as today. Record as a `NOTE:` tripwire at the guard site: if forked-fingerprint reports persist after this lands, the undeclared-commit arm is the residual to look at. Whether forked content can spread by replication (the push path accepts unanchored replicas) is already tracked by `backlog/debt-repair-cannot-tell-a-fork-from-a-lagging-cohort` — do not re-file.

## TODO

Phase 1 — guard:
- Add the `declaredBaseRev` parameter and guard to `internalCommit` exactly as validated above (storage-repo.ts ~908 and ~1196), with a site comment covering the abstain rules, the ahead-of-declared-base case, and the residual-gap `NOTE:` tripwire.
- Update the three comment sites listed above.

Phase 2 — tests (extend `test/storage-repo.spec.ts`, helpers exist; the fix-pass repro shape is described under "The defect" above):
- Fork prevention: gapped member (holds rev 2, declared base 4) refuses with a `missing-base-revision`-prefixed reason and `latest` stays at rev 2; healthy member commits.
- Legit collection-level gap still commits when declared `baseRev` equals the held rev (augment or sibling the ~2080 test, keeping the original un-declared variant green).
- Refusal drops the pending so a later write is not blocked (mirror the existing "drops the unusable pending" test but for the declared-base refusal).
- Abstains: non-numeric/malformed `baseRev` → commits as today; insert-carrying transform with a (hostile) declared `baseRev` → not guarded; no `blockDigests` at all → commits as today.
- Member ahead of declared base (`latest.rev > baseRev`, `< rev`) → refuses.

Phase 3 — validation:
- `yarn workspace @optimystic/db-p2p test` and `typecheck`; also run db-core tests (no source change expected there, but the commit-request shape is shared).
- Downstream, from `../sereus` `packages/integration-tests`: run `control-write-degraded-cohort-member.integration.ts` several times with `DEBUG='optimystic:db-p2p:*,sereus:cadre:control-db'` (trailing `*` required — namespaces are peer-id suffixed); the `cluster-member:content-digest-mismatch` fingerprint should disappear, replaced (at most) by `commit:missing-base` → reconcile → converge. If the sereus checkout is unavailable to the agent, note the deferral in the handoff for a human to run.
