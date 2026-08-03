---
description: A node that has just lost its last connection refuses to handle any of its own data for 30 seconds, so every query fails and a starting node can die outright — even though after those 30 seconds it is allowed to do exactly the same thing. Make it serve the data instead of failing.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts (shouldAllowSelfCoordination ~240-300; findCoordinator FRET-tier self admission ~447-470; last-resort tier ~531-551), packages/db-core/src/network/i-key-network.ts (FindCoordinatorOptions), packages/db-core/src/transactor/network-transactor.ts (get ~111/128/182/192; batchesForPayload ~738; resolveCoordinator ~763; pend ~432/504; cancel ~605/618; commitBlocks ~703/713; cancelBatch ~828), packages/db-p2p/test/libp2p-key-network.spec.ts (~299-315, ~568-601), docs/transactions.md (~1948-2070), docs/correctness.md (~116)
difficulty: medium
---

# An isolated node must degrade to serving its own replica, not fail coordinator selection

## Vocabulary

- **Coordinator** — the node responsible for handling a given key. `findCoordinator` picks it.
- **Self-coordination** — a node picking *itself* as the coordinator, instead of a remote peer.
- **Self-coordination guard** — `shouldAllowSelfCoordination()` in `packages/db-p2p/src/libp2p-key-network.ts`.
  Returns `{ allow: false, reason }` when it judges self-selection unsafe.
- **High-water mark (HWM)** — `networkHighWaterMark`, the largest network this node has ever
  observed. `> 1` means "I have seen peers before".
- **Grace period** — `SelfCoordinationConfig.gracePeriodMs`, default `30_000`. The guard refuses
  self-coordination while the node has been at zero connections for less than this long.

## Reproduced

Reproduced entirely inside `db-p2p` — Sereus is not needed. The scratch spec below was written,
run, and then removed (it asserts the *current, wrong* behavior, so leaving it in the tree would
have been a red test for unrelated tickets). It becomes the regression test in the TODO list
below, with the assertions flipped.

Setup: persisted `networkHighWaterMark: 10`, `lastConnectedTimestamp: Date.now() - 2_300`,
`consecutiveIsolatedSessions: 0`; mock libp2p with **zero** connections; FRET present, reporting
`size_estimate: 10` (so no shrinkage), `detectPartition() === false`, and self as the key's only
neighbour.

```
THREW SELF_COORDINATION_BLOCKED Self-coordination blocked: grace-period-not-elapsed. No coordinator available for key.
  ✔ throws SELF_COORDINATION_BLOCKED right after the last connection drops (1026ms)
after grace: SELF
  ✔ same node, same information, succeeds once 30s have passed
```

The second case is byte-identical to the first except `lastConnectedTimestamp: Date.now() - 31_000`.
Same node, same FRET table, same zero connections, *no new information* — and it returns self.

## Measured facts the design rests on

Each of these was read off the code or the repro run, not assumed:

| Fact | Value | Where measured |
| --- | --- | --- |
| `findCoordinator` retry budget | ~1 s (`maxRetries = 3`, `retryDelayMs = 500`, last attempt does not sleep) | `libp2p-key-network.ts:422-423, 519-528`; repro run took 1026 ms |
| Default grace period | 30 s | `libp2p-key-network.ts:130` |
| Production transaction budget (`NetworkTransactor.timeoutMs`) | 30 s | `quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:250`, `reference-peer/src/cli.ts:436` |
| `allowClusterDownsize` default | `true` at every construction site | `cluster-policy.ts:133`, `libp2p-node-base.ts:618`, `coordinator-repo.ts:199`, `network-manager-service.ts:56`, `mesh-harness.ts:180,271` |
| Consumers branching on `SELF_COORDINATION_BLOCKED` | none | grep across `packages/`: the code is produced in `libp2p-key-network.ts` and asserted in its own spec; nothing reads `.code` for it |

Two consequences follow directly:

1. **The block does not prevent an isolated write; it postpones it by at most 30 s.** Because
   `allowClusterDownsize` defaults to `true`, a self-only cohort commits. So the node that is
   refused at second 2 commits the very same write at second 35, with a warning. Whatever
   split-brain exposure that carries, the grace period does not remove it.
2. **"Just wait out the grace period inside `findCoordinator`" is not available.** The default
   grace period (30 s) is exactly the production transaction budget (30 s), so waiting it out
   consumes the whole budget and the caller times out anyway. That converts a fast failure into a
   slow one, which is why this ticket does *not* propose extending the retry loop to 30 s.

## What to build

The root cause is one distinction the code does not currently draw: **`grace-period-not-elapsed`
is a timing condition with no evidence behind it, while `partition-detected`,
`suspicious-shrinkage` and `disabled` are positive evidence or explicit operator config.** Today
all four are collapsed into `allow: false` and all four make the last-resort tier throw.

Introduce that distinction, and let read operations say so.

### Arm 1 — classify denials as *deferrable* or *hard*

Extend `SelfCoordinationDecision` with a hardness signal, e.g.

```ts
export interface SelfCoordinationDecision {
	allow: boolean;
	reason: 'bootstrap-node' | 'partition-detected' | 'suspicious-shrinkage'
		| 'grace-period-not-elapsed' | 'extended-isolation' | 'hwm-decay' | 'disabled';
	warn?: boolean;
	/**
	 * Set on a denial. `true` means "self is not the PREFERRED coordinator right now, but
	 * nothing says it is unsafe" — the last-resort tier degrades to self with a warning
	 * rather than failing the caller. `false` means a positive reason to refuse.
	 */
	deferrable?: boolean;
}
```

Hardness table (`intent` from Arm 2; default `'write'`):

| reason | write | read |
| --- | --- | --- |
| `disabled` | hard | hard |
| `grace-period-not-elapsed` | **deferrable** | **deferrable** |
| `partition-detected` | hard | **deferrable** |
| `suspicious-shrinkage` | hard | **deferrable** |

Rationale for the read column: none of those three protects a read. A read never coordinates a
mutation; self-coordination for a read means "answer from my own replica", which is exactly what
an isolated node must already accept, and the existing machinery already reports how good that
answer is — `CoordinatorRepo.fetchBlockFromCluster` short-circuits a self-only cohort as
*conclusive* (`cluster-fetch:solo-self-skip`, `coordinator-repo.ts:466-476`), and a cohort it
cannot reach comes back flagged `unavailable: 'peers-unreachable'`. Raising
`SELF_COORDINATION_BLOCKED` instead throws that away and reads to the caller as an infrastructure
fault. `disabled` stays absolute for both because it is an explicit switch (and several tests use
it precisely as the one verdict that holds regardless of connection state).

### Arm 2 — carry read/write intent into `findCoordinator`

`FindCoordinatorOptions` (`packages/db-core/src/network/i-key-network.ts`) currently carries only
`excludedPeers`, so the guard cannot tell the two apart. Add:

```ts
export type FindCoordinatorOptions = {
	/** Peers that have already been tried (and failed) */
	excludedPeers?: PeerId[];
	/**
	 * What the caller intends to do with the coordinator. A read may fall back to this
	 * node's own replica when the network is unreachable; a write may not do so on the
	 * strength of the same evidence. Defaults to 'write' (the conservative behavior) when
	 * unset, so existing callers are unchanged.
	 */
	intent?: 'read' | 'write';
};
```

Plumb `intent: 'read'` from `NetworkTransactor.get()` only; every other path stays on the `'write'`
default. `batchesForPayload`/`resolveCoordinator` are shared by `get`, `cancel` and `commitBlocks`,
so they need an `intent` parameter threaded through rather than a hard-coded value. `getStatus()`
needs nothing — it reads through `this.get()`.

### Arm 3 — consume the classification in `findCoordinator`

- **FRET tier** (`isSelfAdmissible`, ~458-470): admit self when `decision.allow`, **or** when the
  denial is deferrable *for a read*. A read on an isolated node then resolves immediately instead
  of paying the ~1 s retry loop first. For a write, keep dropping self exactly as today, so a peer
  that lands during the retry window still wins the key.
- **Last-resort tier** (~531-551): throw `SELF_COORDINATION_BLOCKED` only on a **hard** denial. On
  a deferrable denial, return self on the `warn` path, logging the reason and that the pick was a
  degraded fallback — e.g.
  `findCoordinator:self-selected-degraded key=%s reason=%s intent=%s`.

Net effect: a disconnected read resolves at once from the local replica; a disconnected write
still spends the existing ~1 s retry window hoping for a peer, then self-coordinates with a
warning instead of failing. Both reported symptoms clear — the query that failed at
`convergence-stress.integration.ts:395`, and the cold-start node that died inside control-schema
DDL with `Module 'optimystic' create failed for table 'Revocation'` (a write, so it now completes
about a second later rather than killing startup).

## Explicitly not doing

- **Not extending the retry loop to wait out the grace period.** See measured fact 2 above: the
  default grace period equals the production transaction budget, so the wait cannot fit.
- **Not plumbing `SelfCoordinationConfig`.** It is still passed as `undefined` at every
  construction site (`libp2p-node-base.ts:684`,
  `quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:388`,
  `.../key-network.ts:46`, `reference-peer/src/cli.ts:418`), so `gracePeriodMs` is always the 30 s
  default and no consumer can tune it. This fix shrinks what that knob controls from "the node is
  unusable for 30 s" to "a write on an isolated node spends its ~1 s retry window before
  self-coordinating", which removes the urgency. Worth a `NOTE:` at the config site rather than a
  ticket.
- **Not changing `allowClusterDownsize`.** Whether a self-only cohort should be able to commit is
  the real split-brain question, and it is governed by that flag, not by this guard. Out of scope
  here; the fix does not make it worse (a write that this ticket unblocks at second 2 is a write
  that already commits at second 35 today).

## Test expectations

Two existing tests interact with this change:

- `libp2p-key-network.spec.ts:299-315` — "blocks when HWM>1 and only 1 isolated session" asserts
  `shouldAllowSelfCoordination().allow === false`. It should keep passing: the guard's own verdict
  is unchanged, only how the last-resort tier consumes it changes. Add an assertion that the
  decision is now marked deferrable.
- `libp2p-key-network.spec.ts:568-601` — "honours the self-coordination guard on the FRET path"
  asserts `SELF_COORDINATION_BLOCKED` for a grace-period denial. Its real intent — *self must not
  slip past the guard just because it sits in the key's FRET neighbourhood* — is still valid, but
  it must be re-expressed with a denial that stays hard (`allowSelfCoordination: false`, or a FRET
  mock whose `detectPartition()` returns `true`), because a grace-period denial is exactly what
  this ticket stops turning into a throw.

## TODO

- [ ] Add `deferrable` (or equivalent hardness signal) to `SelfCoordinationDecision` and set it on
      every denial branch in `shouldAllowSelfCoordination()`; take an `intent: 'read' | 'write'`
      parameter defaulting to `'write'` and apply the hardness table above.
- [ ] Add `intent?: 'read' | 'write'` to `FindCoordinatorOptions` in
      `packages/db-core/src/network/i-key-network.ts`, documented as defaulting to `'write'`.
- [ ] `Libp2pKeyPeerNetwork.findCoordinator`: pass `_options?.intent` to both
      `shouldAllowSelfCoordination()` call sites (FRET tier and last-resort tier).
- [ ] FRET tier: admit self when the denial is deferrable *and* intent is `'read'`, so an isolated
      read does not pay the ~1 s retry loop. Leave write behavior as-is.
- [ ] Last-resort tier: throw `SELF_COORDINATION_BLOCKED` only on a hard denial; on a deferrable
      denial return self with a distinct degraded-fallback log line carrying `reason` and `intent`.
- [ ] Thread `intent` through `NetworkTransactor.batchesForPayload` and `resolveCoordinator`; pass
      `'read'` from `get()` (three `findCoordinator` lambdas at ~128, ~182, ~192 plus the
      `batchesForPayload` call at ~111). Leave `pend`/`commit`/`cancel`/`cancelBatch`/
      `consolidateCoordinators` on the `'write'` default.
- [ ] Add regression tests in `packages/db-p2p/test/libp2p-key-network.spec.ts` (the repro above,
      assertions flipped):
      - HWM>1, zero connections, disconnected 2.3 s ago, no partition, no shrinkage → a **read**
        (`intent: 'read'`) returns self, and does so well inside one 500 ms retry delay.
      - Same node, a **write** (default intent) also returns self, after the retry window, and
        does not throw.
      - Same node with `detectPartition() === true` → a write still throws
        `SELF_COORDINATION_BLOCKED`; a read returns self.
      - `allowSelfCoordination: false` → both read and write still throw.
      - A connected peer that lands during the write retry window still wins the key over self
        (guards against the FRET-tier change leaking into the write path).
- [ ] Rework `libp2p-key-network.spec.ts:568-601` per the note above so it exercises a hard denial.
- [ ] Add a `NOTE:` at the `SelfCoordinationConfig` defaults in `libp2p-key-network.ts` recording
      that the config is never plumbed by any construction site; if an operator ever needs to tune
      `gracePeriodMs`, the four construction sites listed above have to pass it through first.
- [ ] Update `docs/transactions.md` (~1948-2070 — the guard walkthrough quotes the case-4 code and
      the "3 attempts, 500ms delay" retry description) and `docs/correctness.md:116` ("blocks
      writes") to describe degrade-with-warning rather than refuse, and to state that reads are
      never denied their own replica.
- [ ] Run `yarn build` and `yarn test` in `packages/db-core` and `packages/db-p2p`.
