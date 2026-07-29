----
description: When a cluster has only two nodes, a node that has fallen behind can never catch up by reading — it either accepts its own out-of-date answer as if a peer had confirmed it, or refuses the correct newer answer its peer offers. Either way the two nodes stay permanently out of sync.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/quorum-restore.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts
difficulty: hard
----

# Read-repair is structurally impossible at small cluster sizes

## Status: reproduced, not fixed

Four tests pinning the defect already landed in commit `ff2cbbf` (tests only, no source
change). They pass today **because they assert the broken behavior** — they are executable
documentation, and this ticket's job is to invert them. Run them first:

```
cd packages/db-p2p && yarn test:verbose --grep "quorum-restore primitives"
cd packages/db-p2p && yarn test:verbose --grep "CoordinatorRepo read-repair"
```

Baseline for the whole package before you start: `1322 passing, 41 pending, 0 failing`.

## The two defects

`selectQuorumRev` in [`packages/db-p2p/src/cluster/quorum-restore.ts`](packages/db-p2p/src/cluster/quorum-restore.ts)
chooses which revision of a block the cluster agrees on. It was introduced by `42765d8`
(`p2p-read-repair-verify-peer-claims`, 2026-07-03), which deliberately replaced the previous
"take the max revision any single peer reports" rule with one requiring corroboration. That
goal is sound; the implementation has two flaws that interact badly.

### 1. The corroboration floor is absolute, so a single-holder revision is unselectable

```ts
// quorum-restore.ts:41-43
export function quorumSize(responderCount: number, simpleMajorityThreshold: number): number {
	return Math.max(2, Math.floor(simpleMajorityThreshold * responderCount));
}
```

`simpleMajorityThreshold` is `0.51` (`libp2p-node-base.ts:641`). With 2 responders this is
`max(2, floor(1.02)) = 2` — unanimity. **A revision held by exactly one peer can never be
selected, at any cluster size**, because the floor never drops below 2 regardless of how many
peers exist. In a two-node cluster, where by definition a freshly written revision starts out
held by exactly one node, that makes read-repair a no-op forever.

### 2. The lone-responder fallback lets the reader corroborate itself

```ts
// quorum-restore.ts:98-101
if (responderCount < quorum && groups.size === 1) {
	const only = groups.values().next().value!;
	return { rev: only.rev, actionId: only.actionId, supporters: [...only.supporters] };
}
```

`clusterLatestCallback` short-circuits self to local storage
([`libp2p-node-base.ts:794-803`](packages/db-p2p/src/libp2p-node-base.ts#L794-L803)), so the
reader's own revision is one of the claims. When the remote peer's `SyncClient.requestBlock`
misses the 1 s per-peer timeout (`coordinator-repo.ts:354`) or errors — both swallowed to
`undefined` at `libp2p-node-base.ts:818-820` — the reader is left holding only its own claim,
and this fallback returns it as the corroborated result. `CoordinatorRepo` then logs
`cluster-fetch:synced` at the **stale** revision (`coordinator-repo.ts:319`) and calls
`markBlocksSeen`, suppressing further repair for the read-repair window.

### Why they compound

The two failure modes cover the entire timing space of a two-node cluster:

| Remote peer at rev 2 … | responders | quorum | outcome |
|---|---|---|---|
| …times out or errors | 1 (self only) | 2 | fallback fires → **accepts own stale rev 1**, logs it as synced |
| …answers successfully | 2 (self + remote) | 2 | two singleton groups, `responderCount < quorum` is `2 < 2` = false → fallback declines → **`no-quorum`**, stale kept |

There is no timing under which the newer revision is adopted. Retrying cannot help.

## Also verified: the existing spec masked this

`coordinator-repo-read-repair.spec.ts` mocked `clusterLatestCallback` to return `undefined`
for self (`peerId.equals(otherPeer) ? remoteLatest : undefined`) — something the real callback
never does. That unrealistic mock is why the existing "paranoid mode invokes
clusterLatestCallback for a present (stale) block" test passes today: it collapses to a single
*remote* claim and lands in the fallback. The new tests use a self-answering callback that
mirrors production. **Any other spec in this package that mocks that callback should be
audited for the same false-green.**

## What to build

### Required: stop counting the reader as a corroborator

This one is a plain bug under any policy — a node confirming its own answer is not evidence of
anything. The reader's own revision is the *baseline being repaired*, not a claim about what
the cluster holds. Exclude it from the quorum arithmetic. Decide whether to filter it inside
`selectQuorumRev` (pass the self peer id in) or upstream in `queryClusterForLatest`; either is
acceptable, but the self revision must still be available to the caller so it can tell whether
the selected revision is actually newer than what it has.

### Required: make the corroboration requirement respect how many peers can possibly corroborate

The floor must be expressible as "two independent peers, **or** everyone else if there are
fewer than two of them". Requiring more corroborators than the cluster contains is not a safety
property, it is a deadlock.

**Before choosing the shape, answer this question, because it determines how much safety is
actually at stake:** are peer claims independently verifiable by the reader — i.e. does the
reader validate a signature, hash, or transaction proof over the claimed `(rev, actionId)`
before adopting it, or is a claim just an assertion the reader must take on trust? The
originating ticket was named `p2p-read-repair-verify-peer-claims`, so establish what "verify"
means there today. If claims are cryptographically checkable, single-peer adoption is close to
free and the corroboration rule is mostly an availability heuristic. If they are bare
assertions, accepting one peer's word restores exactly the trust problem `42765d8` set out to
remove, and the reduced requirement must be opt-in.

Follow the precedent already in this codebase for exactly this tradeoff:
`ClusterMember.allowUnvalidatedSmallCluster` (`cluster/cluster-repo.ts`) is a fail-closed,
explicitly-opted-into relaxation for small clusters. Mirror that shape rather than inventing a
new one — and if you add a config field, plumb it all the way through `libp2p-node-base.ts`
options so an embedder can actually set it. Note the existing gap: `allowUnvalidatedSmallCluster`
is **not** currently exposed through `createLibp2pNode`, which makes it unreachable for
embedders. Do not reproduce that mistake; if it is cheap, fix it while you are in there.

### Required: confirm the repair actually transfers data

Selecting the right revision is necessary but may not be sufficient. The "restoration" at
`coordinator-repo.ts:318` is:

```ts
await this.storageRepo.get({ blockIds: [blockId], context: { committed: [clusterLatest], rev: clusterLatest.rev } });
```

`StorageRepo.get` with a commit context only **promotes a pending transaction the node already
holds locally** (`storage-repo.ts:167-198`). It does not fetch bytes from a peer. If the node
has no pending for that `actionId`, this is a silent no-op — and `cluster-fetch:synced` is
logged regardless, which is why that log line cannot be trusted as evidence of convergence.
Block-transferring restoration lives in `reconcileBlock` → `fetchArchiveFromPeer` /
`saveReplicatedBlock` (`libp2p-node-base.ts:~675-735`) and runs on the commit path only.

So: after fixing selection, **write a test that asserts the block content is actually present
and current on the lagging node afterwards**, not merely that a revision was selected or a log
line emitted. If it turns out the read path cannot transfer blocks at all, that is a second
ticket — file it, describe precisely what is missing, and say so plainly in the handoff rather
than declaring victory on the selection fix.

## Edge cases & interactions

- **Single-node cluster** (only the reader): must not fetch, must not log a false sync, must not
  error. Assert this explicitly.
- **Zero responders** (all peers time out): must decline, not adopt anything.
- **Reader is ahead of every peer**: selection must not drag it *backwards* to an older revision.
  Verify this is impossible after the self-exclusion change — that change removes the reader's
  own high revision from the claim set, which is exactly the condition under which a regression
  here would be introduced. This is the highest-risk consequence of the required change; test it
  first.
- **Peers split across three or more distinct revisions** with no group meeting the requirement.
- **`markBlocksSeen` suppression**: a declined or failed repair should not suppress the next
  attempt for the full read-repair window. Check whether it currently does.
- **Byzantine peer reporting an absurdly high revision** in a cluster small enough to have
  relaxed corroboration — document the exposure honestly in the handoff even if you accept it.

## TODO

- [ ] Determine whether peer claims are cryptographically verifiable; record the answer in the handoff.
- [ ] Exclude the reader's own claim from corroboration arithmetic.
- [ ] Replace the absolute `Math.max(2, …)` floor with one bounded by the number of other peers.
- [ ] Plumb any new config through `libp2p-node-base.ts` / `createLibp2pNode`.
- [ ] Invert the four defect tests from `ff2cbbf` so they assert correct behavior.
- [ ] Audit other specs mocking `clusterLatestCallback` for the self-returns-undefined false-green.
- [ ] Add the end-to-end assertion that content, not just a revision number, converges.
- [ ] Full `db-p2p` suite green (baseline 1322 passing / 0 failing) and root `yarn lint` clean.
