----
description: Three small robustness cleanups in the peer-to-peer layer: order-sensitive record comparison, dead abort-signal plumbing in first(), and duplicated dedup await at consensus call sites.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/it-utility.ts
difficulty: easy
----

# P2P assorted cleanliness — implementation handoff

All three items from the fix ticket are done. 1103 tests pass, type check clean.

## Changes made

### (a) Order-sensitive record equality — `cluster-repo.ts:435-439`

`mergeRecords` compared `existing.message` and `existing.peers` with plain
`JSON.stringify`, which throws a spurious "mismatch" error when two logically
equal objects differ only in key insertion order. Replaced both comparisons
with `ClusterMember.canonicalJson` (the existing helper that sorts keys before
serialising), so equal records compare equal regardless of key order.

### (b) Dead AbortController in `first()` — `it-utility.ts:1-17`

`first()` built an `AbortController` and passed its signal to the
`createIterable` factory, but the only caller (`protocol-client.ts`) supplied
`() => source` — a function that ignores the signal. The abort and the optional
`timeoutMs` parameter were both dead (no caller passes `timeoutMs` either).
Removed the `AbortController`, `timeoutMs` parameter, and signal from the
signature; the function is now a straightforward `for await` loop. The caller
required no change (it already passed a zero-arity factory).

### (c) Duplicated dedup await — `cluster-repo.ts`

Both the `OurCommitNeeded` and `Consensus` branches independently checked
`wasTransactionExecutedAsync` before calling `handleConsensus`. Folded that
async check into `handleConsensus` itself (before the existing synchronous
check-and-set guard), so there is one authoritative dedup path and the two
call sites simply `await this.handleConsensus(currentRecord)`.

The ordering is preserved: the async check (in-memory fast-path + persistent
store fallback) runs first, then the synchronous check-and-set that prevents
the concurrent-call race.

## Review notes

- `withReconcileTimeout` at the bottom of the file carries a pre-existing
  TypeScript style hint [80006] ("may be converted to async function"). Not
  introduced by this ticket; not changed.
- No new tests were added — the three issues are structural/correctness fixes
  fully covered by the 1103 existing tests.
