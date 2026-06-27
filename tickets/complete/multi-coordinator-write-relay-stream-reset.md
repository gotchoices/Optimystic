description: Two storage nodes that reach each other only through a relay can now agree on a write even when the relayed connection used to collect the second node's approval is briefly disrupted — the coordinator retries that approval instead of failing the whole write, and prefers a direct connection when one exists.
prereq:
files:
  - packages/db-core/src/cluster/structs.ts (promiseImmediateRetries config knob)
  - packages/db-p2p/src/repo/coordinator-repo.ts (defaults promiseImmediateRetries)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (updateMember helper; collectPromises + broadcastMergedRecord use it)
  - packages/db-p2p/src/libp2p-key-network.ts (connect() prefers a direct connection over a limited/relayed one)
  - packages/db-p2p/test/cluster-coordinator-promise-retry.spec.ts (deterministic regression; +local-once error-path test added in review)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (connect() prefer-direct cases)
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts (smoke; passes-or-skips)
  - tickets/fix/p2p-fret-rpc-over-limited-connection.md (follow-up filed during implement — external package, left in fix/)
----

# Multi-coordinator write over a relayed (limited) connection — COMPLETE

## Summary of the shipped change

A super-majority write across two same-keyspace coordinators collects one promise
locally and one from the peer over the cluster RPC. When that peer is reachable only
through a relay, the RPC rides a circuit-relay ("limited") libp2p connection that can
be reset transiently, surfacing as a `StreamResetError`. Two gaps turned that blip
into a hard consensus failure, both now fixed:

1. **Asymmetric retry.** The commit broadcast already absorbed a transient reset with
   a per-peer in-line retry; the **promise** phase had none, so a single relayed reset
   left 1/2 approvals and failed super-majority. Fixed by a shared
   `ClusterCoordinator.updateMember(peerIdStr, record, immediateRetries, phase)` helper
   (local invoked once — a local throw is a real fault; remote retried up to
   `immediateRetries` then surfaced). `collectPromises` now uses it with the new
   `promiseImmediateRetries` knob (default 1); `broadcastMergedRecord` was refactored
   onto the same helper (behavior preserved). Commit-**collection** is deliberately
   left un-retried — it already has the broadcast retry + scheduled-retry timer as
   backstops, and retrying it would break existing asserted call counts.

2. **Connection selection.** `Libp2pKeyPeerNetwork.connect()` reused the first open
   connection, which could be a limited/relayed one even when a direct connection also
   existed (the DCUtR-upgrade window). It now filters to open connections, prefers a
   **direct** one, and falls back to a limited connection (with
   `runOnLimitedConnection: true`) only when that is the sole open path. New
   `isLimitedConnection()` detects relayed connections via the `limits` field with a
   `/p2p-circuit` multiaddr fallback.

## Review findings

**Process:** read the full implement diff (commit `09f9a9f`) with fresh eyes before
the handoff summary, then re-derived the root cause from the live code.

### What was checked

- **Root-cause / fix correctness** — Confirmed the asymmetry in `executeTransaction`:
  `collectPromises` is immediately followed by a super-majority check that **throws**
  (`cluster-coordinator.ts:299-310`) with no backstop, whereas the commit path has the
  broadcast in-line retry + the scheduled commit-retry timer. Adding the immediate
  retry to the promise phase (and not commit-collection) is the correct, minimal fix.
- **DRY / refactor safety** — `updateMember` is shared by promise + broadcast; the
  broadcast refactor is behavior-preserving (the old `consensus-broadcast-retry` log
  event name is now `member-update-retry`; verified no test or other caller asserts on
  the old name).
- **`updateMember` semantics / no double-counting** — local invoked exactly once;
  remote retried then surfaces `lastError`; `collectPromises`' `.catch` still records
  the peer as failed and reports reputation. Promises/commits are keyed by peerId, so
  re-merging an idempotent retry result cannot double-count.
- **Retry idempotency** — a promise/commit `update` adds a signature keyed by peerId;
  retrying after a lost response is safe (no duplicate effect).
- **`connect()` prefer-direct** — verified open-filter → prefer non-limited →
  fall-back-to-limited → empty-set falls through to `dialProtocol`; `isLimitedConnection`
  detection (limits field + `/p2p-circuit` fallback) is type-safe via a defensive cast.
- **Regression interactions** — existing broadcast call-count specs in
  `cluster-coordinator.spec.ts` still pass precisely because commit-collection was left
  un-retried (promise success on first try means `updateMember` adds no extra calls).
- **Build / type safety** — `npm run build` (tsc, incl. `test/`) clean, exit 0. (A
  `TS5101 downlevelIteration` deprecation appears only when invoking `tsc --noEmit`
  directly, bypassing the build tsconfig's `ignoreDeprecations`; it is pre-existing and
  unrelated to this change.)
- **Tests** — full db-p2p default suite **1045 passing / 36 pending / 0 failing**
  (`npm test`). Targeted: `cluster-coordinator-promise-retry`, `libp2p-key-network`,
  `cluster-coordinator`, `cluster-coordinator-supermajority` all green.
- **Docs** — config knobs are self-documented via JSDoc in `db-core` `structs.ts`; the
  new `promiseImmediateRetries` follows the sibling `commitBroadcastImmediateRetries`
  doc style. No external README/config table references these knobs, so nothing else
  needed updating.

### What was found and done

- **Minor (fixed inline):** error-path test gap. The implementer's own suggested review
  focus asked to confirm the local cluster is invoked exactly once and not retried, but
  no test exercised that path. Added a regression to
  `cluster-coordinator-promise-retry.spec.ts` —
  *"does NOT retry the LOCAL cluster on a throw"* — which wires a local cluster whose
  `update` throws and asserts (a) the write fails super-majority and (b) `localCalls === 1`
  despite `promiseImmediateRetries: 1`. Locks the documented "local throw is fatal, not
  transient" contract. Suite now 1045 passing.

- **Major → new ticket:** none newly filed. The external-package FRET limitation
  (`p2p-fret` wire RPCs don't run over limited connections) was already filed during
  implement as `fix/p2p-fret-rpc-over-limited-connection` and is left in `fix/`. It is a
  robustness gap, not a blocker — relay-only peers still converge transitively via a
  directly-connected FRET intermediary.

### Judgment calls validated (left as-is)

- **Commit-collection left un-retried** — backstops (broadcast retry + scheduled timer)
  confirmed; the promise phase throws immediately and has no backstop. The asymmetry is
  correct, not an oversight.
- **`negotiateFully:false` unchanged** — agree with deferring; the prefer-direct +
  immediate-retry combination covers the observed failure and flipping it risks the
  warm-relay-reuse path other specs depend on.
- **Relay integration spec is smoke-only (passes-or-skips)** — it does not
  deterministically reproduce the reset (`applyDefaultLimit:false` + tiny payload). The
  deterministic unit specs are the authoritative regression guard. Acceptable and
  honestly documented.

### Carried-forward / unverified (not blockers)

- **Sereus end-to-end not re-run** (no `../sereus` access in this run): the source
  ticket's two flows — second `storage` node join + cross-party strand formation —
  remain unverified against a live Sereus relay topology and should be checked there.
- **Live DCUtR lingering-limited-connection topology** not exercised; the `connect()`
  prefer-direct selection is proven by unit tests, not a real-node integration test.

## Outcome

Both consensus-level gaps are fixed and locked by deterministic unit regressions; the
2-node coordinator cluster reaches consensus over a relay despite a transient stream
reset. Build and the full db-p2p suite are green. One external-package follow-up
(`fix/p2p-fret-rpc-over-limited-connection`) and the Sereus e2e verification remain as
documented, non-blocking next steps.
