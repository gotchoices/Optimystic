---
description: A peer-to-peer node that failed partway through starting up used to keep running with its network port still open; it now shuts itself down cleanly and reports the original error.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/startup-rollback.spec.ts, packages/db-p2p/readme.md, docs/internals.md
difficulty: medium
---

# Startup rollback for the libp2p node factory

## What shipped

`createLibp2pNodeBase` starts the libp2p node early (`await node.start()`) and then runs roughly 930
lines of async wiring against the already-started node. A throw anywhere in that span used to reject
out of the factory while the node kept running — the caller got an error and **no node handle**, so
it could not stop the node either. The listener stayed bound and the leaked handles kept the host
process alive.

**One rollback for the whole post-start body.** Everything from `await node.start()` to the `return`
is inside a `try`; the `catch` calls `node.stop()` (guarded — a rollback failure is logged through
the existing `wiringLog` and never masks the real error) and rethrows the original error. The three
ad-hoc stop-and-rethrow blocks that used to cover individual sites (the `networkManager.setReputation`
injection, the cohort-topic FRET-unavailable hard-fail, and the `createCohortTopicHost` failure) are
gone — the outer rollback subsumes them, and the errors they raise are unchanged.

**Teardown wrappers moved next to their resources.** `node.stop()` is progressively decorated by stop
wrappers, each capturing the previous `node.stop`. A rollback only unwinds resources whose wrapper
was *already installed* when the throw happened, so a wrapper trailing its resource by hundreds of
lines leaks it. The `clusterMember` dispose wrapper moved up to immediately after `clusterImpl` is
assigned (previously ~500 lines later), and the cohort-topic / reactivity / matchmaking teardown
wrapper moved up to immediately after `createCohortTopicHost` returns (previously ~240 lines later).
The bindings the latter releases are declared ahead of the wrapper as `let … | undefined` and
undefined-guarded inside it — the same idiom the existing `offOwnedBlockFeed` wrapper uses — so it
tears down exactly what exists at the throw point.

**Tests.** `packages/db-p2p/test/startup-rollback.spec.ts` covers a `persistence.load()` throw (the
first throwable step after `node.start()`, and the site the leak was reproduced at) and a
cohort-topic host construction failure (the far end of the span). Both assert the *original* error
surfaces and that the listener port is bindable again.

**Docs.** `packages/db-p2p/readme.md` now states the all-or-nothing startup guarantee next to the
node-setup example; `docs/internals.md` records both the rollback and the invariant that keeps it
working (a stop wrapper is registered immediately after the resource it releases).

Reading the diff: the rollback `try` re-indents ~930 lines by one tab, so read it with `git diff -w`.

## Review findings

### What was checked

- The implement diff read first with `git diff -w`, then the current file, then the surrounding
  wiring — not the handoff summary first.
- Rollback placement and error propagation: original error preserved on the rejection; a rollback
  failure logged and swallowed rather than masking it.
- All seven `node.stop` wrappers: adjacency to the resource each releases, run order
  (last-installed-first), idempotency, and `try`/`finally` shape.
- The teardown-order shift caused by moving the `clusterMember` dispose wrapper.
- `node.unhandle` on never-registered protocols — read libp2p's registrar source rather than
  trusting the claim in the comment.
- `ClusterMember.dispose()` — whether it can throw.
- Whether anything between `node.start()` and the first stop wrapper creates a resource with no
  teardown: checked `Libp2pKeyPeerNetwork`, `PeerReputationService`, `PartitionDetector`; the only
  timer in that span is a retry delay inside a request path, not a long-lived handle.
- **Whether the new tests can actually fail.** Both hinge on one predicate — "is the listener port
  bindable again". A throwaway spec confirmed a running node makes it return `false` and a stopped
  node makes it return `true`, so neither test is vacuous. (Temp spec deleted after the run.)
- Docs the change touched *and should have touched*: `docs/internals.md`, `packages/db-p2p/readme.md`.
- Validation: root `yarn lint` (exit 0); `yarn build` + `npx tsc --noEmit` in `db-p2p` (exit 0);
  the `db-p2p` suite (1544 passing, 44 pending, 0 failing, ~54s); and the full workspace `yarn test`
  — every package green, 0 failing.

### Minor — fixed in this pass

- **`packages/db-p2p/src/libp2p-node-base.ts`** — the `clusterMember` dispose wrapper called
  `dispose()` then `await previousStop()` with no `try`/`finally`, unlike every sibling wrapper. A
  dispose failure would have stranded the transports — the exact class of leak this ticket exists to
  close. Wrapped.
- **`packages/db-p2p/src/libp2p-node-base.ts`** — the comment justifying unconditional `node.unhandle`
  on a mid-rollback teardown claimed the registrar "deletes from a Map". It also awaits a peer-store
  patch of the advertised protocol list. The conclusion (safe on never-registered protocols) holds;
  the reason was wrong, so the comment now says what actually happens.
- **`packages/db-p2p/test/startup-rollback.spec.ts`** — if the factory unexpectedly *succeeded*, the
  test left the created node running, so the leaked handles would have hung mocha before the failure
  could be reported. Extracted a `rejectionFrom()` helper that stops a node that unexpectedly
  resolves, then fails loudly; it also DRYs the two cases.
- **`packages/db-p2p/test/startup-rollback.spec.ts`** — added an explicit note naming the two rollback
  sites the spec cannot reach (the FRET-unavailable hard-fail and the `setReputation` injection) and
  why: both services are registered unconditionally by the factory and `NodeOptions` has no seam to
  suppress or substitute one.
- **`packages/db-p2p/readme.md`** — the node-setup example passed a `services: { repo, cluster }`
  option that `NodeOptions` does not have (stale, pre-existing). Removed, with a line saying the
  factory registers those services itself. Added the all-or-nothing startup guarantee below the
  snippet.
- **`docs/internals.md`** — the cohort-topic wiring bullet said a missing FRET service or a host
  construction failure hard-fails startup, but not that the node is now stopped first. It now states
  the rollback, points at the spec, and records the placement invariant that makes rollback
  complete.

### Assessed, no change needed

- **The teardown-order shift the implementer flagged for a second opinion.** Moving the
  `clusterMember` dispose wrapper earlier makes `dispose()` run *later* in the stop chain — last
  before the transports close, rather than second. `dispose()` only clears intervals/timeouts and
  empties its maps, and no monitor touches `clusterImpl`. The new order is in fact strictly safer:
  under the old order a monitor stopping *after* dispose could register a timer post-dispose; now
  dispose runs after all monitor teardown.
- **The spread and rebalance wiring blocks** swallow their own failures by design ("a resilience
  optimization must not hard-fail startup"), so they never reach the rollback. Correct and unchanged.
- **The implement-stage tripwire** (the `register*Handler` helpers registering protocols
  fire-and-forget, so a registration failure bypasses the rollback) is in place as a `NOTE:` at the
  composition root and correctly scoped. Left as is; no new tripwire was needed this pass.

### Major — ticket filed

- **`tickets/backlog/debt-node-factory-wiring-steps-own-their-teardown.md`.** The root cause behind
  this whole class: `createLibp2pNodeBase` is 1283 lines in one function (lines 369–1651 of a
  1651-line file; measured with `wc -l` and `grep -n` on the function signature), and seven
  hand-written stop wrappers are tied to the resources they release by nothing but physical
  proximity. That is why two wrappers had drifted away from their resources in the first place and
  why finding them meant reading the whole span. Filed at the representation rung rather than as a
  point fix: each wiring step returns its own `stop`, and one ordered teardown list serves both
  normal shutdown and rollback — which makes "a resource with no teardown" unrepresentable instead
  of merely reviewable.

### Known gaps

- The rollback's own failure branch (`node.stop()` throws → log, rethrow the original error) has no
  test. There is no seam through `NodeOptions` to make `node.stop` throw. Four lines, and the
  filed restructuring ticket would give it a natural injection point — recorded here rather than
  filed separately.
- The two moved wrappers still have no direct regression test proving a throw *between* a resource
  and its old wrapper position now clears that resource; neither span is failure-injectable through
  `NodeOptions`. The moves are justified by the wrapper chain plus the normal-stop tests staying
  green (`cohort-topic/host-node-activation.spec.ts`, `spread-on-churn-node-wiring.spec.ts`,
  `rebalance-monitor-node-wiring.spec.ts`).
