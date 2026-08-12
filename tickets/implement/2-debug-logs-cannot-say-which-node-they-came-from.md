description: When several nodes run inside one process (which every integration test does), the debug log lines from routing and cluster-repair decisions don't say which node produced them, so the lines are unusable for diagnosing anything node-specific.
prereq:
files: packages/db-p2p/src/logger.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/coordinator-repo.ts
difficulty: easy
----

# Per-node debug logs carry no peer id

Split out of `fix/collection-view-forks-silently-when-repair-cannot-reach-quorum`, which
hit this head-on: diagnosing that bug required knowing *which* of three nodes made each
routing decision, and no existing log line says. The workaround was to monkey-patch
`Libp2pKeyPeerNetwork.prototype.findCoordinator` / `findCluster` from the test harness and
read `this.libp2p.peerId` inside the patch. Every future diagnosis of this class pays that
cost again.

## Why it bites

`createLogger` (`packages/db-p2p/src/logger.ts`) builds a `debug` namespace from a static
string: `optimystic:db-p2p:libp2p-key-network`. In production one process is one node, so
the omission is invisible. In the integration harnesses — and in the field reproducer for
the ticket above — three nodes share one process and interleave into one stream, so a line
like

```
findCoordinator:done key=abc… source=fret
```

cannot be attributed at all. Counting "node B picked itself 930 of 930 times for this
block" was only possible via the patch.

## Shape

`debug` namespaces are hierarchical and `DEBUG=optimystic:db-p2p:*` already matches any
suffix, so appending a short peer id to the namespace keeps every existing `DEBUG` filter
working while making per-node filtering (`DEBUG=optimystic:db-p2p:libp2p-key-network:12D3Koo…`)
newly possible.

The two classes that matter are the ones whose decisions are per-node:

- `Libp2pKeyPeerNetwork` (`libp2p-key-network.ts:233`) — routing. It has `this.libp2p.peerId`.
  The logger is currently a field initializer; it likely has to move into the constructor
  body (or become a lazy getter) so the peer id is available when it is built.
- `CoordinatorRepo` (`repo/coordinator-repo.ts:17`) — cluster-repair verdicts
  (`cluster-fetch:no-quorum`, `cluster-tx:read-repair-*`). Its `localPeerId` is
  **optional** (the single-node/test construction has always tolerated its absence), so the
  suffix must degrade to today's exact namespace when it is unset rather than emitting
  something like `…:undefined`.

Truncate the peer id the way the existing lines already truncate peer ids for readability
(`libp2p-key-network.ts` uses `.substring(0, 12)` throughout) — match that, don't invent a
second convention.

Only these two are in scope. Sweeping every `createLogger` call site is a bigger,
lower-value change and is not what this ticket asks for.

## TODO

- [ ] Give `createLogger` an optional per-instance suffix (or add a sibling helper) that
      appends a truncated peer id to the namespace, and returns today's namespace unchanged
      when no id is supplied.
- [ ] Adopt it in `Libp2pKeyPeerNetwork`, moving the logger construction to wherever
      `this.libp2p.peerId` is actually available.
- [ ] Adopt it in `CoordinatorRepo`, degrading to the un-suffixed namespace when
      `localPeerId` is unset.
- [ ] Add a spec asserting two instances with different peer ids log under different
      namespaces, and that an instance with no peer id logs under the original one.
- [ ] `yarn build && yarn typecheck && yarn test` from root.
