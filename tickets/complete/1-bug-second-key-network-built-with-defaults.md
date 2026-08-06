---
description: Two programs that start a node used to build a second copy of the "which machines hold this data" component from bare defaults instead of reusing the one the node already has; they now reuse the node's own, and the shape that made the wrong path easier has been removed.
prereq:
files: packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/reference-peer/src/cli.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/cluster-size-coupling.spec.ts, packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts, packages/db-p2p/readme.md, docs/internals.md, docs/optimystic.md
difficulty: medium
---

# What landed

A host that starts an Optimystic node needs the component that answers "which peers are
responsible for this key" (`Libp2pKeyPeerNetwork`). The node builds one at startup from its
resolved configuration. But that instance was reachable only through an untyped cast
(`(node as any).keyNetwork`), while `new Libp2pKeyPeerNetwork(node)` — which silently defaulted to
a 16-wide cohort with the network-membership filter off — type-checked cleanly. So the wrong path
was the easy one, and `reference-peer`'s CLI plus six test/harness sites took it: they selected a
16-wide cohort with no network filter where the node's own consensus path selected 10 with the
filter on, for the same key.

The implement stage fixed it at the representation rather than only at the call sites:

- **The node's host-facing surface is typed.** New `packages/db-p2p/src/optimystic-node.ts`
  declares `OptimysticNodeAttachments` (`keyNetwork`, `coordinatedRepo`, `storageRepo`,
  `blockChangeNotifier`, `reputation`, `disputeService?`, `peerPrivateKey`) and
  `OptimysticNode = Libp2p & OptimysticNodeAttachments`; `createLibp2pNodeBase` and both
  `createLibp2pNode` entrypoints (Node and React Native) return it. Type-only, so nothing new
  enters a React Native bundle at runtime.
- **No silent cluster size.** `clusterSize` is a required constructor parameter on
  `Libp2pKeyPeerNetwork`. `DEFAULT_CLUSTER_SIZE = 10` is exported from
  `cluster/cluster-policy.ts` for the one caller that genuinely must construct standalone. A
  public `effectiveProtocolPrefix` getter was added next to `effectiveClusterSize` so a spec can
  assert network scoping without touching a private field.
- **Dead module deleted.** `quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts` had
  zero callers.
- **Call sites converted** — `reference-peer/src/cli.ts`, the Quereus collection-factory, and six
  test/harness files now read `node.keyNetwork`. `db-p2p/readme.md`'s Libp2p Integration snippet
  no longer teaches constructing a second one.

The review pass then closed the completeness gap the implementer flagged, corrected three stale
or inaccurate comments, restored an entry-point asymmetry, fixed two docs the change should have
touched, removed one remaining duplicate of the cluster-size literal, and added the missing test
for the fallback branch. Details below.

# Review findings

Reviewed the implement diff (`b55bda5`) first, then the surrounding code and every doc the change
touched or should have touched. Categories with nothing in them say so explicitly.

## Fixed in this pass (minor)

- **No compile-time completeness check on the attachment block** — the implementer flagged this
  as a known gap: a field added to `OptimysticNodeAttachments` and never assigned in
  `libp2p-node-base.ts` would compile silently, giving hosts an `undefined` behind a non-optional
  type. Fixed by replacing the seven sequential field assignments with a single
  `const attachments: OptimysticNodeAttachments = { … }` object literal followed by
  `Object.assign(node, attachments)`. A missing field is now a compile error; behavior is
  identical. (`packages/db-p2p/src/libp2p-node-base.ts:1284`)

- **`rn.ts` could not reach `DEFAULT_CLUSTER_SIZE`.** The React Native entry point exports
  `libp2p-key-network.js` — so an RN host *can* construct one, and now must state a cluster size —
  but `index.ts` gained `export * from './cluster/cluster-policy.js'` and `rn.ts` did not. The
  required parameter had no reachable constant on that entry point. Added the export; verified
  the built RN bundle resolves it (`DEFAULT_CLUSTER_SIZE = 10`) with no name collision, and
  `cluster-policy.ts`'s imports are RN-safe (db-core, logger, multiformats).
  (`packages/db-p2p/src/rn.ts`)

- **`CoordinatorRepo` still carried its own copy of the cluster-size literal.**
  `clusterSize: cfg?.clusterSize ?? 10` (`repo/coordinator-repo.ts:194`) is the same magic number
  `DEFAULT_CLUSTER_SIZE` was introduced to stop repeating — and `CoordinatorRepo` is directly
  constructible by a host (the readme literally taught it, see below), so the direct path and the
  node assembly could drift apart exactly as the key network's did. Now
  `?? DEFAULT_CLUSTER_SIZE`; behavior identical today, drift impossible tomorrow.

- **Comment claimed something untrue at the collection-factory fallback.** It said
  `DEFAULT_CLUSTER_SIZE` is "exactly what a node built here would have resolved to" — but the
  nodes this factory builds itself pass `clusterSize: 1` (`collection-factory.ts:219`), not 10.
  Reworded to say what is actually true: it is what a db-p2p node that declares no cluster size
  resolves to, and it is deliberately not `1` because asserting this factory's edge-profile width
  of a node someone else built would be a guess dressed as knowledge. The value passed is
  unchanged.

- **Stale comment naming a file this ticket deleted.** The `SelfCoordinationConfig` note in
  `libp2p-key-network.ts` listed four construction sites including
  `quereus-plugin-optimystic`'s `key-network.ts` (deleted by this ticket) and `reference-peer`'s
  `cli.ts` (no longer constructs one). Corrected to the two production sites that remain.

- **Two docs the change should have touched but did not.**
  `docs/internals.md:191` still taught `(node as any).blockChangeNotifier` — the untyped shape
  the whole ticket removed; now points at `node.blockChangeNotifier` and names the declaring
  interface. `docs/optimystic.md:68` described the transactor's `keyNetwork` argument as
  "e.g. `Libp2pKeyPeerNetwork` from db-p2p", which reads as an instruction to construct one; now
  says to use `node.keyNetwork`.

- **`db-p2p/readme.md` § "Setting Up a Coordinator Node" taught the bug.** Its example builds a
  `StorageRepo` and a `CoordinatorRepo` by hand immediately after `createLibp2pNode` — the same
  "rebuild what the node already owns" mistake, one section below the snippet this ticket fixed.
  It was also wrong in two other ways: it referenced an undefined `keyNetwork` /
  `createClusterClient`, and ended with `await node.start()` when `createLibp2pNodeBase` already
  starts the node (`libp2p-node-base.ts:683`). Rewritten to read the three handles off the node,
  with the standalone-construction case called out separately and pointed at
  `DEFAULT_CLUSTER_SIZE`. Verified the new snippet's API against the source (`storage?:
  RawStorageProvider`, `new FileRawStorage(basePath)`).

## Test coverage added

The implementer's two new cases in `cluster-size-coupling.spec.ts` pin the *attached* instance
(cluster size and network prefix, read with no cast) and pin `DEFAULT_CLUSTER_SIZE` against what
an unconfigured node resolves to. Both are the right assertions and they pass.

What they left uncovered is the **other** branch of `resolveKeyNetwork` — the foreign-node
fallback, which is the one place whose behavior actually changed (a constructed instance now gets
10 instead of 16). Added a case to
`quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts`: register a node carrying
no key network, then assert the resulting transactor's key network reports
`effectiveClusterSize === DEFAULT_CLUSTER_SIZE` and `effectiveProtocolPrefix === PROTOCOL_PREFIX`.
It fails if the fallback ever goes back to guessing.

## Tripwires parked in code (conditional — deliberately not tickets)

- **`protocolPrefix` is still optional on the `Libp2pKeyPeerNetwork` constructor**, so a caller
  who omits it gets the network-membership filter silently off — the same shape as the cluster
  size defect, one parameter over. It is not reachable today: after this ticket *both* production
  construction sites pass it, and only the mock-based cases in `test/libp2p-key-network.spec.ts`
  omit it. The parameter's doc comment justified the optionality with "most call sites don't know
  the network name", which is no longer true; replaced with a `NOTE:` stating the real situation
  and the revisit condition — a third production construction site, or a rewrite of that spec.
  (`packages/db-p2p/src/libp2p-key-network.ts`, constructor)
- The implementer's two existing tripwires (the seven-positional-parameter list, and widening
  `registerLibp2pNode` to accept a host's own key network) were re-read and left as written; both
  state a condition and neither has tripped.

## Filed as a ticket (major)

- `tickets/backlog/debt-node-attachment-reads-bypass-typed-surface.md` — 38 occurrences of
  `(node as any).<attachment>` remain across 8 test files (19 in
  `db-p2p/test/real-libp2p.integration.spec.ts` alone; counted with a grep quoted in the ticket).
  None of them is wrong — they read the correct instance, so no defect — but they are the
  most-copied examples in the repo of the exact shape that produced this bug. Filed at the
  class-retiring rung rather than as cleanup: the point of the ticket is the guard (lint rule or
  a test running the grep) that keeps the count at zero afterwards, not the mechanical
  conversion. Checked the board first — `libp2p-key-network.ts` is named in three open tickets
  (`debt-mixed-version-identify-incompatibility`,
  `debt-network-manager-coordinator-selection-is-a-stale-duplicate`,
  `feat-cohort-selection-owner-aware-placement`) but none touches the attachment surface or these
  files, so this is a fresh site rather than an arm on an existing ticket.

## Considered and not filed

- **`registerLibp2pNode`'s widened signature** (`node: Libp2p` → `Libp2p & Partial<OptimysticNodeAttachments>`).
  The implementer asked for a second opinion. It is the honest type — an injected node genuinely
  may carry none of the attachments, and `Partial` forces every read to face that — and it is
  source-compatible: every field is optional, so a plain `Libp2p` still satisfies it and all three
  in-repo callers compile unchanged. No overload or parallel `registerOptimysticNode` needed.
- **`reference-peer`'s `startNetwork` has no direct spec** — correctly flagged as a gap. Not
  filed: the absence is pre-existing and covers the whole function, not anything this ticket
  introduced, and the change there is type-checked against attachments the node has always set.
  A ticket for it would be "add coverage for the reference CLI", which is a much broader piece of
  work than this diff justifies.
- **`attachCohortChangeBridge` re-declares `{ blockChangeNotifier?: IBlockChangeNotifier }`**
  inline (`cohort-topic/change-bridge.ts:103`) rather than using the new interface. Left alone:
  it is a deliberately minimal structural parameter that keeps the bridge decoupled from the node
  type, and narrowing it to `Pick<OptimysticNodeAttachments, …>` would couple them for no gain.
- **Node-internal attachments still written untyped** in `libp2p-node-base.ts`
  (`spreadOnChurnMonitor`, `rebalanceMonitor`, `cohortTopicHost`, the reactivity registries, …).
  The implementer drew the line at "host-facing surface" and that line is in the right place —
  these have no external consumers and typing them is a separate decision. Recorded as explicitly
  out of scope in the new backlog ticket so the next person does not widen the interface by
  accident.

## Checked, nothing found

- **No remaining defaults-built key network.** `grep -rn "new Libp2pKeyPeerNetwork"` across
  `packages/` returns two production sites (`libp2p-node-base.ts:696`, which passes the resolved
  policy, and the collection-factory fallback, which passes `DEFAULT_CLUSTER_SIZE` plus the
  prefix); everything else is `test/libp2p-key-network.spec.ts` and
  `identify-push-propagation.spec.ts`, all mock-based and all now stating a size explicitly.
- **No remaining `createKeyNetwork` references** after the module deletion — confirmed across
  `.ts`, `.json` and `.md`.
- **Resource cleanup, error handling** — the diff adds no new lifecycle, no new subscription and
  no new failure path. The two `throw new Error('… not available on node')` guards it removed in
  `cli.ts` (and the equivalents in the collection-factory and three specs) are correctly removed:
  the fields they guarded are non-optional on the attachment type and unconditionally assigned at
  a single site, so the guards were unreachable, not load-bearing.
- **Docs referencing the old defaults.** Swept every `.md` outside `tickets/` for
  `Libp2pKeyPeerNetwork`, the literal 16, and the deleted module. Remaining mentions
  (`packages/db-p2p/docs/cluster.md:646`, `docs/repo.md:270`, `docs/transactions.md`) describe
  membership classification and coordinator priority and are unaffected by this change.
- **Published plugin surface.** `packages/quereus-plugin-optimystic/dist/` is gitignored, so the
  regenerated `.d.ts` files are not part of the change.

# Validation

All run from the repo root, after the review edits.

- `yarn build` — clean. Type-checks `db-p2p` (its tsconfig covers `src` **and** `test`),
  `reference-peer`, and the rest.
- `cd packages/quereus-plugin-optimystic && npx tsc --noEmit` — clean, exit 0. Run separately
  because that package builds with `tsup`, which does not type-check its `test/` tree.
- `npx eslint .` — clean, exit 0.
- `yarn test` (all workspaces) — **0 failing**; 1357 + 1542 + 53 + 50 + 45 + 44 + 12 + 125 + 421 +
  6 + 258 passing, 56 pending. ~5 min. (The 421 is 420 plus the fallback case added here.)
- `OPTIMYSTIC_INTEGRATION=1 yarn test:integration` — **0 failing**; 30 + 424 passing, 10 pending.
  ~2.5 min.
- Targeted, for the specs that own this theme:
  ```
  cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js \
    "test/cluster-size-coupling.spec.ts" "test/fresh-node-ddl-libp2p.spec.ts" \
    "test/cohort-topic/host-node-activation.spec.ts" --colors --reporter spec
  ```
  16 passing. And the plugin's `test/collection-factory-key-network.spec.ts`, 3 passing.
- Runtime check that the React Native entry point resolves the constant it now needs:
  `node -e "import('./packages/db-p2p/dist/src/rn.js').then(m=>console.log(m.DEFAULT_CLUSTER_SIZE))"`
  → `10`.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
