----
description: Three small robustness cleanups in the peer-to-peer layer: order-sensitive record comparison, dead abort-signal plumbing in first(), and duplicated dedup await at consensus call sites.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/it-utility.ts, packages/db-p2p/src/protocol-client.ts
difficulty: easy
----

# P2P assorted cleanliness — complete

Three cleanups landed in commit `03e622a` (code) / `cb14227` (ticket move). All reviewed and verified.

## What shipped

### (a) Order-sensitive record equality — `cluster-repo.ts:427,430`
`mergeRecords` now compares `message` and `peers` with `ClusterMember.canonicalJson()` (key-sorted serialisation) instead of raw `JSON.stringify`, so records that differ only in object key insertion order no longer throw a spurious "Message content mismatch" / "Peers mismatch".

### (b) Dead AbortController in `first()` — `it-utility.ts`
Removed the unused `AbortController`, `timeoutMs` parameter, and `signal` argument. `first()` is now a plain `for await` loop. Sole caller (`protocol-client.ts:167`) already passed a zero-arity `() => source` factory — unchanged.

### (c) Dedup folded into `handleConsensus` — `cluster-repo.ts:736-742`
The async `wasTransactionExecutedAsync` pre-check that both the `OurCommitNeeded` and `Consensus` branches ran independently is now the first statement inside `handleConsensus`, ahead of the synchronous check-and-set guard. Call sites (341, 350) just `await this.handleConsensus(currentRecord)`.

## Review findings

**Checked:** implement/fix diff read first with fresh eyes; all three changes traced against their call sites and helper definitions; build (tsc), lint (eslint), and full test suite run.

- **Correctness (a):** `canonicalJson` (`cluster-repo.ts:539`) sorts keys recursively (the `JSON.stringify` replacer fires per-node) and preserves array order — matches the semantics already used to compute `messageHash`. Since `messageHash` is itself derived from `canonicalJson(message)`, once the hash check passes the message-content check is now near-tautological (can only have differed by key order); the `peers` check stays meaningful because `peers` is not part of the hash. Net effect: removes a spurious-throw path without adding one. **No issue.**
- **Correctness (b):** Verified the real response-timeout/hang protection lives at `protocol-client.ts:120-135` via `responseTimeoutMs` + `stream.abort()`, which rejects the stream iterator and surfaces through `first()`'s `for await`. The `first()`-local `timeoutMs`/`AbortController` were genuinely dead (no caller supplied them) and redundant. Only importer of `first` is `protocol-client.ts` (confirmed repo-wide). **Safe removal.**
- **Correctness/race (c):** `handleConsensus` has exactly two callers (341, 350), both previously ran the same async pre-check — no other caller inherits new behaviour. The async check → synchronous check-and-set ordering is preserved; the synchronous `executedTransactions.has` remains the atomic guard against concurrent same-hash calls (single-threaded set happens before any later resumption). Early-return path skips no cleanup (the executed-marker rollback only applies once a transaction is marked executing). **No issue.**
- **Type safety / build:** `yarn build` (tsc) clean.
- **Lint:** `eslint` on both changed files clean. Pre-existing `withReconcileTimeout` style hint [80006] left untouched (outside this diff).
- **Tests:** `yarn test` in `packages/db-p2p` → **1103 passing, 36 pending** (57s). No regressions.
- **Test additions — none, deliberately.** The one behavioural change (a) is on the private `mergeRecords`, reachable only through the full `update()` consensus flow; a targeted regression test would need heavy integration setup for a change that *removes* a failure mode rather than adding logic, and the existing merge-flow tests exercise the path. Low ROI; documented instead of added.
- **Tripwires — none.** No conditional/latent concerns surfaced.
- **Major findings / new tickets — none.**
