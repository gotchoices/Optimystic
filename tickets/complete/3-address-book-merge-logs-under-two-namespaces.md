description: The log line that proves a peer's network address was learned used to land on two different debug channels depending on which code path produced it, so turning on the one channel the project's own docs recommend showed only half the picture. Both paths now log to the same channel tree, and the two sibling warning lines on the same code path were moved there as well.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/logger.ts, packages/db-p2p/test/logger.spec.ts, docs/debugging.md
----

# Complete: `peer-address-book:*` logs under one namespace tree

Upstream: [gotchoices/Optimystic#12](https://github.com/gotchoices/Optimystic/issues/12).

## What shipped

**Implement stage** — one line, `src/libp2p-node-base.ts:559`. The inbound address-book sink (the
`ClusterService` / coordinator → member ingress path) was built from libp2p's own logger factory,
`components.logger.forComponent('db-p2p:peer-address-book')`. libp2p's `defaultLogger()` adds no
prefix, so the resulting namespace was literally `db-p2p:peer-address-book` — never matched by
`DEBUG=optimystic:db-p2p:*`, the filter `docs/debugging.md` tells operators to set. Replaced with
`createLogger('peer-address-book', components.peerId?.toString())`, so it now emits
`optimystic:db-p2p:peer-address-book:<12-char-peer-id>` alongside the outbound path's lines.

**Review stage** — the same defect, two more sinks on the same code path (see findings below):
`ClusterService.learnPeerAddresses` and both services' `getPeerAddrs` fallbacks were passing
`(fmt, ...args) => this.log.error(fmt, ...args)` as their `AddressLog`. That routes
`peer-address-book:record-capped` and the unparseable-peer-id warning to libp2p's
`db-p2p:cluster:error` / `db-p2p:repo-service:error` namespaces — same tag family as the merge
line, different tree, equally invisible under the documented filter. Both services now hold a
`private readonly addressLog = createLogger('peer-address-book', components.peerId?.toString())`
and use it at all three sites.

Docs: `docs/debugging.md` gained a `peer-address-book` row in the db-p2p sub-namespace table, a
paragraph naming both places address learning is reported from (inbound under
`peer-address-book`, outbound under `libp2p-key-network` — enabling only one still shows half),
and two now-stale sentences were corrected ("only these **two** sub-namespaces carry a peer id" →
three). `src/logger.ts`'s peer-id `NOTE:` had the same stale claim and was corrected.

## Review findings

**Checked:** the implement diff read before the handoff summary; every `AddressLog` sink in the
repo (`grep -rn AddressLog packages/*/src packages/*/test`); every `forComponent(` call site in
`db-p2p`; libp2p's `@libp2p/logger` source, to confirm `.error` writes to a separate `:error`
namespace rather than the base one; `docs/debugging.md` line by line against the namespaces the
code actually emits; the new tests' independence from the code under test (mutation-checked, see
below); lint, typecheck, and the full `@optimystic/db-p2p` suite.

### Major — the ticket's own claim was only two-thirds fixed (fixed in this pass)

`mergePeerAddresses` was not the only address-book reporter on the inbound path.
`ClusterService.learnPeerAddresses` (`src/cluster/service.ts`) hands `mergeRecordPeerAddresses` a
sink built from `this.log.error`, and both `ClusterService.getPeerAddrs` and
`RepoService.getPeerAddrs` did the same for `publishableConnectionAddr`. Those emit
`peer-address-book:record-capped` and `WARN: record carried an unparseable peer id …` — the same
tag family the ticket was filed about — under `db-p2p:cluster:error` and
`db-p2p:repo-service:error`, which `DEBUG=optimystic:db-p2p:*` does not match and which are not
enabled by default. The handoff's audit stopped at `libp2p-node-base.ts` and listed only the six
unrelated *service* loggers, so these three sinks were missed. Root cause is one decision repeated
at three sites (which logger an `AddressLog` is built from), so it is fixed here rather than
filed: each service now owns one `addressLog` field. Verified load-bearing by reverting the
`learnPeerAddresses` sink and re-running the spec — the new test fails with "an unparseable id in
record.peers must be reported: expected undefined to not equal undefined", exactly the original
symptom.

### Major — the trap that produces this class (filed, not fixed here)

The ticket asked for more than the one-line swap: *"a new call site inside this package should get
the `optimystic:db-p2p:` tree without its author choosing between two factories."* That was not
done, and three tickets have now fixed instances of the same class one call site at a time. Six
services still log under bare `db-p2p:*` via `forComponent`, two of them (`db-p2p:cluster`,
`db-p2p:repo-service`) colliding by name with real `optimystic:db-p2p:*` namespaces covering the
same subsystem — so two of `docs/debugging.md`'s own DEBUG recipes silently show half a subsystem.
Filed at the invariant rung rather than as six point fixes:
`tickets/backlog/debt-service-logs-split-across-two-logger-factories.md`. Grepped the board first
(`grep -rn forComponent tickets/…`) — nothing open claimed those sites. Not fixed inline because
the design question (what happens to libp2p `Logger`'s `.error`/`.trace`/`.enabled` surface, and
whether the guard is a wrapper or a lint rule) is real work, not a mechanical swap.

### Minor — stale docs (fixed in this pass)

The implement stage grepped the docs for the *old* namespace string, found nothing, and concluded
there was nothing to update. That is the wrong direction: the change also *created* a namespace
and *invalidated* two counts. `docs/debugging.md`'s db-p2p table omitted `peer-address-book`
entirely, and both it and `src/logger.ts`'s `NOTE:` asserted only two sub-namespaces carry a
peer-id suffix — false the moment this fix landed. Corrected, plus a paragraph documenting the
two-places-report-address-learning split (that one is by design: the outbound path's merge lines
legitimately belong to `libp2p-key-network`) so nobody re-reads it as a bug.

### Verified, no action

- **The implement stage's mutation check was re-run, not taken on trust.** Reverted
  `libp2p-node-base.ts:559` to `forComponent`, re-ran `test/logger.spec.ts`: the inbound case
  fails ("expected undefined to not equal undefined") and the outbound case passes, matching the
  handoff exactly. Restored.
- **Type safety of the swap.** `AddressLog` is `(fmt: string, ...args: unknown[]) => void`; no
  consumer of any of these sinks touches libp2p `Logger`'s `.error`/`.trace`/`.enabled`. Confirmed
  by reading all four `peer-address-book.ts` consumers.
- **`components.peerId` availability** at service-construction time in all three services —
  optional in every components interface, and `createLogger` degrades to the un-suffixed namespace
  when absent, so no new failure mode.
- **Resource cleanup in the new spec.** `afterEach` nulls the handle before awaiting `stop()`, so a
  failed stop cannot leak the node into the next test.

### Considered and not filed

- **No end-to-end `DEBUG=` environment-variable test.** The specs drive `debug.enable(...)`, which
  is what env-var parsing feeds into; nothing spawns a child process with a real env var and greps
  stdout. Agreeing with the implement stage's call — process-spawn overhead is not worth it for a
  namespace-string fix, and the enable path is the same code.
- **`libp2p-node-base.ts` and `ClusterService` now each build their own `peer-address-book`
  logger** (identical namespace, one for the wired closures, one for the service's own lines).
  Two `debug` instances on one namespace is exactly how `debug` is meant to be used; collapsing
  them would mean plumbing a logger through the components interface for no observable gain.
- **No changelog entry**, as the implement stage flagged: this repo has no `.changeset/` or
  package `CHANGELOG.md`, so the ticket's "note in release notes" TODO has no target. Left as-is
  rather than inventing a mechanism inside a logging ticket.

**No tripwires recorded** — every conditional-looking concern here resolved into either a fix or
the filed `debt-` ticket; nothing was left in the "fine now, only matters if X" shape.

## Validation

```
yarn workspace @optimystic/db-p2p test          # 1872 passing, 44 pending, 0 failing
cd packages/db-p2p && npx tsc --noEmit          # clean
npx eslint <the five changed files>             # clean (from repo root)
```

The suite was 1871 before this pass; the extra test is the new inbound record-traversal namespace
assertion. Both new specs were individually mutation-checked against a reverted fix and fail as
expected.
