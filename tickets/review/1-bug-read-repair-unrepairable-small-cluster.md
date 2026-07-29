----
description: A node that had fallen behind used to accept its own out-of-date answer as if a peer had confirmed it, and a two-node cluster could never agree on anything newer. Both are fixed; a follow-on gap (the repair still does not fetch the newer data) is filed separately.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/quorum-restore.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts, packages/db-p2p/test/coordinator-repo-solo-self-bypass.spec.ts, packages/db-p2p/test/support/capture-log.ts, docs/transactions.md, docs/internals.md
----

# Review: read-repair revision selection at small cluster sizes

## What was wrong

`selectQuorumRev` picked the block revision a read-repair pass would restore to. Two flaws
combined to make a two-node cluster permanently unable to converge:

1. **The corroboration floor was absolute.** `quorumSize` returned
   `Math.max(2, floor(0.51 × responders))`, so a revision held by exactly one peer could
   never be selected at any cluster size. A two-node cohort has, by construction, exactly
   one other peer.
2. **The reader corroborated itself.** `clusterLatestCallback` answers a self-query from
   local storage, so the reader's own revision was one of the claims. When its only peer
   timed out, the "too few responders but they all agree" fallback returned the reader's
   own stale revision as a corroborated cluster latest — and `CoordinatorRepo` then logged
   `cluster-fetch:synced` at that stale revision and called `markBlocksSeen`, suppressing
   further repair for the whole read-repair window.

## The investigation the ticket asked for first

**Are peer revision claims independently verifiable? No — they are bare assertions.**

The remote branch of `clusterLatestCallback` (`libp2p-node-base.ts`) calls
`SyncClient.requestBlock` and reads `archive.revisions[maxRev].action.actionId`. A
`BlockArchive` (`storage/struct.ts`) carries revisions, a range, and optional pendings —
**no signature, no commit certificate, nothing to check a `(rev, actionId)` against**. The
originating ticket's name (`p2p-read-repair-verify-peer-claims`, commit `42765d8`) means
"verify by cross-peer corroboration", not cryptographically. `debt-read-repair-commit-cert-verification`
in `backlog/` spells out the three gaps that keep it that way: certs live only in an
in-memory TTL cache keyed by actionId, the sync protocol has no field to serve them, and
cohort-membership anchoring is not wired into the restore paths.

## What was built

### 1. The reader's own claim is excluded from the vote (unconditional)

`CoordinatorRepo.queryClusterForLatest` now returns `{ corroborated?, local? }` instead of
a bare `ActionRev`. The self answer is split out of the claim set and returned separately,
so it can be compared but never counted. `selectQuorumRev`'s contract now says explicitly
that callers must not pass their own claim (the reconcile path in `libp2p-node-base.ts`
already filtered self out).

### 2. The corroboration floor is capped by how many peers could corroborate

`quorumSize(responderCount, threshold, corroboratorCapacity?)` keeps the floor of two, but
caps it at `corroboratorCapacity` — how many peers other than the reader could answer at
all. The proportional majority term is untouched, so large cohorts still scale up. The
ad-hoc "responders < quorum && exactly one candidate pair" fallback is **removed**; the
capacity cap expresses the same permissiveness only where it is justified.

`CoordinatorRepo.corroboratorCapacity` computes it as
`max(peers observed in findCluster excluding self, clusterSize - 1)`.

### 3. Restoration is monotonic

`fetchBlockFromCluster` restores only when the corroborated revision is strictly ahead of
the reader's own. Equal-or-older corroboration logs `cluster-fetch:local-current` and marks
the block seen (the cohort answered, so it is verified fresh). No corroboration returns
without marking seen, so a declined repair does not suppress the next attempt.

### 4. `allowUnvalidatedSmallCluster` is reachable from `createLibp2pNode`

It was defined on `ClusterConsensusConfig` and consumed by `ClusterMember.admitMembership`
and `ClusterCoordinator`, but `libp2p-node-base.ts` never populated it, so no embedder
could turn it on. Now exposed as `clusterPolicy.allowUnvalidatedSmallCluster`, default
`false` (unchanged behavior unless set).

## The design decision, and its residual risk

**No new config flag was added, and the relaxation is on by default.** Reasoning:

- The code being replaced *already* accepted a lone uncorroborated peer's claim — that was
  the small-cluster fallback, and the previous review recorded it as a deliberate
  availability-over-integrity tripwire. The change is a net **tightening**: a lone
  responder in a cohort that could have supplied a second corroborator is now refused,
  which it was not before. The only newly-accepted case is the two-member cohort, which is
  the same fallback minus the self-pollution that hid it.
- A cohort of two has no Byzantine tolerance to protect. There is no honest majority to
  appeal to, and the sole other peer is also the only other holder of the block, so
  demanding a second corroborator buys unavailability, not safety.
- The genuinely dangerous case is not "the cohort really is small" but "the cohort *looks*
  small". `findCluster` is unauthenticated, so a partition or an attacker with routing
  influence can shrink a reader's view to itself plus one peer. That is why the capacity is
  the **max** of the observed peers and `clusterSize - 1`: a shrunken view of a
  ten-node-configured network still requires two corroborators. The opt-in the ticket asked
  for therefore exists — it is `clusterSize: 2`, an explicit operator declaration that
  already plumbs through `createLibp2pNode` — rather than a new parallel flag.

**Residual risk, stated plainly:**

- **A two-member cohort trusts its sole peer's revision claim unconditionally.** Claims are
  bare assertions; nothing distinguishes lag from a lie. A Byzantine peer in a cohort
  configured with `clusterSize: 2` can name any `(rev, actionId)` and have it selected.
  Pinned by `quorum-restore.spec.ts` → "a sole cohort peer is believed even when its rev is
  absurd (documented exposure)". Today the blast radius is limited because the read path
  cannot actually transfer content (see below) — the worst outcome is a bogus
  `cluster-fetch:synced` log plus `markBlocksSeen` suppressing repair for one window. **If
  the follow-on content-transfer ticket lands without a content-trust gate, this becomes a
  content-injection vector.** That requirement is written into the follow-on ticket.
- **The capacity guard leans on `clusterSize` being configured honestly.** An operator who
  runs a two-node deployment while leaving `clusterSize` at its default of 10 gets a
  correctly-refusing but non-converging cluster (every attempt logs
  `cluster-fetch:no-quorum` with a `required` count). Documented in `docs/transactions.md`;
  the log line carries `required` so the cause is diagnosable.
- **Sybil resistance is unchanged** and still deferred to
  `debt-read-repair-commit-cert-verification`.

## The gap this did NOT fix — filed as `fix/read-repair-cannot-transfer-block-content`

Selection now works. Convergence does not. Verified empirically with a new spec that wires
two nodes' real `StorageRepo`/`BlockStorage`:

- The restoration call `storageRepo.get({ context: { committed: [latest], rev } })` only
  promotes a pending transaction the node **already holds**. A node that never saw the
  action has nothing to promote.
- The fallback that might have rescued it does not fire either: `setLatest` records
  coverage as the open-ended span `[E, +∞)`, so `ensureRevision` believes rev 2 is already
  covered, never calls the restore callback, and `materializeBlock`'s descending walk
  quietly resolves the request down to the node's own rev-1 materialization.

So `cluster-fetch:synced` is genuinely not evidence of convergence, exactly as the source
ticket suspected. `coordinator-repo-read-repair-content.spec.ts` asserts the *current*
(broken) outcome under a `KNOWN GAP:` title so it is visible in test output;
`tickets/fix/read-repair-cannot-transfer-block-content.md` carries the analysis, the
options, and the edge cases.

## Validation

Before (at `ff2cbbf`, the four defect specs asserting broken behavior):

```
$ yarn test:verbose --grep "DEFECT"
  CoordinatorRepo read-repair
    DEFECT: 2-node cluster cannot read-repair
      ✔ logs cluster-fetch:synced at the STALE rev when the remote peer drops out
      ✔ declines with no-quorum when the remote peer DOES report the newer rev
  quorum-restore primitives
    selectQuorumRev
      ✔ DEFECT: accepts the reader's OWN stale claim when the only other peer drops out
      ✔ DEFECT: a 2-node divergence is structurally unrepairable (quorum 2 == unanimity)
  4 passing (41ms)

$ yarn test --grep "quorum-restore primitives|CoordinatorRepo read-repair"
  28 passing (65ms)
```

After (source fixed, specs inverted):

```
$ cd packages/db-p2p && yarn test
  1333 passing (42s)
  41 pending

$ OPTIMYSTIC_INTEGRATION=1 mocha "test/**/*.integration.spec.ts"   # db-p2p
  27 passing (12s)
  2 pending

$ cd ../.. && yarn test          # root fan-out, all packages   → Done, 0 failing
$ yarn lint                      → exit 0
$ yarn build                     → exit 0
$ cd packages/db-p2p && npx tsc --noEmit → exit 0
```

Package baseline was 1322 passing / 41 pending / 0 failing; +11 net specs.

## What a reviewer should attack

- **The capacity formula.** `max(observed, clusterSize - 1)` is the whole safety argument.
  Is there a deployment where `clusterSize` is legitimately large but the cohort for a
  given block is legitimately small (`responsibilityK`, downsized clusters,
  `allowClusterDownsize`)? Such a cohort would now be unable to read-repair. I did not find
  one — `findCluster` returns the responsible set and `clusterSize` is the configured full
  size for the same set — but this is the assumption most worth a second pair of eyes.
- **Reconcile was left on the strict floor** (no capacity passed in
  `libp2p-node-base.reconcileBlock`). Removing the fallback changes nothing observable
  there, because reconcile's content gate `selectQuorumBlock` requires two block-carrying
  corroborators and has no relaxation — so a two-member cohort could never reconcile before
  this change and still cannot. Whether that *should* be relaxed too is a real question I
  deliberately did not answer in this ticket.
- **`markBlocksSeen` on the `local-current` path.** I mark the block seen when the cohort
  corroborates a revision at or below ours, reasoning that a cohort that answered is
  evidence of freshness. If a lying peer can be the sole corroborator (the two-member case
  above), it can hold a reader's repair window open by repeatedly corroborating the
  reader's own revision. Bounded by `readRepairWindowMs`, but worth a judgement call.
- **Specs that mock `clusterLatestCallback`.** I audited all five
  (`coordinator-repo-read-repair`, `-trust`, `-solo-self-bypass`, `-integration`,
  `quorum-restore`). Three needed changes; the audit is described below. A reviewer should
  confirm I did not miss a false-green.
- **The mesh harness fakes data sync.** `testing/mesh-harness.ts`'s `clusterLatestCallback`
  writes the peer's block into local storage after reading its latest — something the
  production callback never does. Every harness-based read-repair assertion therefore
  observes convergence the real path does not provide. Left alone here (out of scope, and
  changing it would break unrelated harness specs); it is a TODO on the follow-on ticket.

## Test changes, itemised

Inverted (the four from `ff2cbbf`):

- `quorum-restore.spec.ts` — "accepts the reader's OWN stale claim…" → "the reader cannot
  corroborate itself when its only peer stays silent"; "a 2-node divergence is structurally
  unrepairable" → "a 2-node divergence IS repairable: the sole other peer's newer rev is
  adopted".
- `coordinator-repo-read-repair.spec.ts` — "logs cluster-fetch:synced at the STALE rev…" →
  "does not treat its own stale rev as corroboration…"; "declines with no-quorum when the
  remote peer DOES report the newer rev" → "adopts the newer rev the only other peer
  reports".

Changed because they depended on removed behavior (all three were false-greens riding the
old fallback or an unrealistic self-returns-`undefined` mock):

- `coordinator-repo-read-repair.spec.ts` — "paranoid mode invokes clusterLatestCallback for
  a present (stale) block" and "paranoid mode is a noop when cluster reports the same rev"
  now use a three-peer cohort with a self-answering callback.
- `coordinator-repo-solo-self-bypass.spec.ts` — "returns sync result when a remote peer
  reports a newer revision" now uses two corroborating remotes (it previously relied on a
  single responder being accepted in a `clusterSize: 3` cohort).
- `coordinator-repo-read-repair-trust.spec.ts` — the lone-responder spec's title/comment
  updated; it passes unchanged because it already set `clusterSize: 2`.

Added:

- `quorum-restore.spec.ts` — capacity cap, capacity-caps-floor-only, lone-responder
  declined vs accepted, and the documented Byzantine exposure.
- `coordinator-repo-read-repair.spec.ts` (`2-node cluster read-repair`) — reader-ahead
  (tested first, as the highest-risk regression), zero responders, shrunken-view must not
  relax, declined repair must not suppress the next attempt.
- `coordinator-repo-read-repair-content.spec.ts` — new file; real two-node storage,
  divergence sanity check, selection proof, and the `KNOWN GAP` content-convergence pin.
- `test/support/capture-log.ts` — the `debug` capture helper, extracted so the two specs
  that need it do not duplicate it. Deliberately not a `.spec.ts` so mocha's glob skips it.

## Edge cases from the source ticket — dispositions

| Case | Where covered |
|---|---|
| Single-node cluster | `coordinator-repo-solo-self-bypass.spec.ts` (pre-existing, still green): `cluster-fetch:solo-self-skip` fires before any callback |
| Zero responders | `2-node cluster read-repair` → "declines when no peer responds at all" |
| Reader ahead of every peer | `2-node cluster read-repair` → "never restores backwards…" |
| 3+ distinct revisions, none corroborated | `quorum-restore.spec.ts` → "declines when nothing reaches quorum and responders disagree" (pre-existing) |
| `markBlocksSeen` suppression after a decline | `2-node cluster read-repair` → "a declined repair does not suppress the next attempt" |
| Byzantine peer with an absurd rev in a relaxed cohort | `quorum-restore.spec.ts` → "a sole cohort peer is believed even when its rev is absurd", plus the residual-risk section above |

## Docs

- `docs/transactions.md` § "Read Consistency and Staleness" — new subsection "What a repair
  pass will and will not accept" (self-exclusion, the capacity rule and its `clusterSize: 2`
  consequence, and the content-transfer limitation). Removed the now-false claim that a
  lazy repair pass "converges the local copy to the current revision".
- `docs/internals.md` — the reconcile bullet now cross-references read-repair's
  self-exclusion and capacity cap.
