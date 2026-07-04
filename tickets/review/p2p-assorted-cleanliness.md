----
description: Review three small robustness cleanups in the peer-to-peer layer: order-sensitive record comparison, dead abort-signal plumbing in first(), and duplicated dedup await at consensus call sites.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/it-utility.ts
difficulty: easy
----

# P2P assorted cleanliness — review handoff

All three items implemented and verified in code. 1103 tests pass, type check clean.

## Changes to review

### (a) Order-sensitive record equality — `cluster-repo.ts:427,430`

`mergeRecords` previously compared `existing.message` and `existing.peers` with plain `JSON.stringify`. Replaced both with `ClusterMember.canonicalJson()` (sorts keys before serialising), so logically equal objects that differ only in key insertion order compare equal instead of throwing a spurious mismatch error.

### (b) Dead AbortController in `first()` — `it-utility.ts:1-9`

`first()` previously built an `AbortController` and passed its signal to `createIterable`, but no caller ever used the signal (the only caller in `protocol-client.ts` passes `() => source`, ignoring the signal). The `timeoutMs` parameter was also dead. Removed both; the function is now a plain `for await` loop. Caller unchanged.

### (c) Dedup folded into `handleConsensus` — `cluster-repo.ts:736-742`

Both `OurCommitNeeded` and `Consensus` branches previously called `wasTransactionExecutedAsync` before invoking `handleConsensus`. That check is now inside `handleConsensus` itself (async persistent-store check first, then the synchronous in-memory check-and-set). Call sites at lines 341 and 350 simply `await this.handleConsensus(currentRecord)`. Single authoritative dedup path; ordering preserved.

## Review findings

- `withReconcileTimeout` carries a pre-existing TypeScript style hint [80006] ("may be converted to async function") — not introduced here, left unchanged.
- No new tests added; structural/correctness fixes covered by existing 1103-test suite.
- No tripwires identified.
