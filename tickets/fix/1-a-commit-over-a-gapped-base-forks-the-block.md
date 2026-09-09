----
description: A storage node that has missed one or more updates to a block will still apply the next update it receives, on top of whatever old copy it happens to hold. From then on it holds different content than everyone else under the same version number, and it rejects every later write to that block.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-core/src/collection/collection.ts
repro: verified
difficulty: hard
----

# A commit applied over a gapped base forks the block

## What happens

A block's revisions are a chain: revision N is produced by applying transform N to revision N-1.
A cohort member that missed revisions 8 and 9 and then receives the commit for revision 10 applies
transform 10 to the revision **7** it still holds, records the result as revision 10, and carries on.
It now holds different bytes than the rest of the cohort under the same revision number. The fork is
durable and silent.

It became visible only because 0.29.0 shipped the member-side content-digest check
(`complete/1.4-commit-cert-digest-member-check`). A forked member re-computes what the next write
will produce, gets a different digest than the author declares, and votes reject with
`content-digest-mismatch`. From that point every write the author makes to that block is refused by
that member, permanently.

**The check is behaving correctly. It is reporting a real defect, not causing one.** The fork
predates it; before 0.29.0 the two nodes simply disagreed in silence.

## How it was measured

Downstream, in `../sereus`, from `packages/integration-tests`:

```
DEBUG='optimystic:db-p2p:*,sereus:cadre:control-db' npx vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts
```

Three isolated runs: two produced `content-digest-mismatch` on two tests each; the third died in
boot with a sibling failure of the same family (see the separate ticket below). Note the debug
namespaces are peer-id suffixed — an exact-match namespace matches nothing, the trailing `*` is
required.

Every captured `cluster-member:content-digest-mismatch` record — 122 field-sets across the three
runs — has the same shape:

```
blockId: hKusn9F9…Nxk   actionId: 2AGMVXX5P4MQV-0-fEePqw   rev: 11
declaredDigest: 4eiun6QT…   declaredBaseRev: 10
previewDigest:  Lai3m4FO…   previewBaseRev:  10
baseIndependent: false
```

`previewBaseRev === declaredBaseRev` in all of them. That excludes the base-revision race by the
check's own predicate (`cluster-repo.ts:1725`): author and member applied the same wire transform to
what each calls the same revision and got different bytes. The two nodes hold different content
under one revision number.

## The lineage that produces it

Run 1, block `hKusn…`, cohorts read from the `promises:` lists at each pend's `cluster-member:phase`:

| rev | cohort | what happened |
| --- | --- | --- |
| 1-7 | A solo, then {A,B} | B reaches rev 7 via `saveReplicatedBlock` and commits 7 as a member |
| 8 | **{C, A}** | rev-8 replication logged `replica:skip held=8` on both — never reached B |
| 9 | **{C, A}** | no rev-9 replication logged anywhere |
| 10 | **{B, A}** | B's commit line logs `prune … rev=7` — its prior `latest` was **7**. A logs `prune rev=9`. B goes 7 → 10, applying transform 10 over revision 7, skipping 8 and 9 |

Test 1 then writes rev 11 over base 10. A declares the digest of T11(T10(T9(T8(r7)))); B previews
T11(T10(r7)). C was at 9 and abstained; A's own member matched. Hence `1/3 rejected`.

Run 2 is the same mechanism with the roles moved: rev 7 on cohort {B,A}, rev 8 on {C,A} where C held
only its rev-6 replica, so C committed 8 over 6 and then rejected A's rev 9.

The cohorts that fork are **2-peer discovery cohorts** — the writes that create the gap happen during
bring-up, before the scenario installs its forced 3-peer cohort. The forcing does not cause the fork;
it makes the forked node a mandatory voter, which is why the damage surfaces instead of hiding.

## Why nothing catches it today

Neither tier has a guard for a member that is *behind*:

- `storage-repo.ts` `pend` (~:596) treats only `latest.rev >= request.rev` as stale. Behind-by-N passes.
- `cluster-repo.ts:1429` `validatePendOperations` applies the same rule.
- `storage-repo.ts` `commit` partitions on `toCommit: latest.rev < request.rev` (~:765) — any gap commits.
- `internalCommit` (:1177-1210) reads `latest`, calls `readCommitBase(latest.rev)` — local-only by
  design (:1382-1393) — and applies the transform. Its only invariant guard covers `latest === undefined`.
- `validateCommitRevisions`' own doc (~:1528) says a member behind the commit "cannot judge it" and
  abstains, on the assumption that a behind member is caught at apply time. It is not.

## Recommended fix

`packages/db-p2p/src/storage/storage-repo.ts`, `internalCommit`, immediately after
`const latest = await storage.getLatest();` (~:1195) — the missing sibling of the guard already there:

```ts
if (latest !== undefined && latest.rev !== rev - 1) {
	return await this.refuseMissingBase(blockId, actionId, rev, storage, latch,
		`local latest ${latest.rev} is not the base of rev ${rev}`);
}
```

This needs no new machinery. `refuseMissingBase` throws `MissingBaseRevisionError`, which `commit`
already classifies as divergence (:711-716), which drops the unpromotable pendings, which
`ClusterMember.applyConsensusOperation` already tolerates by reconciling every block in the batch
from a cohort peer (`cluster-repo.ts` ~:1953-2020). The writer's retry then lands on a healed base.

`rev - 1` is sound for honest writers — `db-core/src/collection/collection.ts:812` sets the next
revision to committed + 1 — and the `>= rev` cases are partitioned out before `internalCommit` runs.

A pend-tier abstain for `latest.rev < rev - 1` in `validatePendOperations` would surface the
condition one round earlier and more cheaply, but the commit-tier guard is the invariant and should
land first.

## Ruled out, with the method

- **A canonicalization or JSON round-trip artifact.** `canonicalJson`
  (`db-core/src/utility/canonical-json.ts:10`) is `JSON.stringify` with sorted keys, so `undefined`
  properties drop identically on both sides. And the author's own member — working from in-memory
  lineage — matched the author's cache-derived declaration in every run.
- **A base-revision race.** Excluded by `previewBaseRev === declaredBaseRev` across all 122 records.
- **The downstream scenario's forced cohort.** The forking commits ran at `peerCount: 2`
  (`cluster-tx:commit-majority-reached`), before the force was installed.
- **The repair yardstick** (`repairCorroborationClusterSize`). The forked revisions came from
  commits, not from the repair or fetch path.

## Not established

- Whether a forked block can spread by replication. Run 1 shows a replica accepted with
  `certified-claims accept-unanchored … reason=no-recompute-capability, signers=2`, so the push path
  accepts unanchored content — shape observed, not measured.
- Raw block bytes were never dumped; the content divergence is inferred from the lineage and the
  digests, without instrumentation.

## TODO

- Reproduce the gap directly in a db-p2p test — a 3-node mesh where one member misses two commits and
  then receives the third — rather than only through the downstream scenario.
- Add the `internalCommit` guard and confirm the refusal routes through divergence to reconciliation.
- Decide whether the pend-tier abstain lands with it or separately.
- Re-run the downstream scenario (`../sereus`, `control-write-degraded-cohort-member`) several times;
  the `content-digest-mismatch` fingerprint should disappear entirely.
