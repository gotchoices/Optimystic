description: Debug log lines from routing and cluster-repair decisions now say which node produced them, so multi-node-in-one-process test runs (every integration test) can be diagnosed per node.
files: packages/db-p2p/src/logger.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/support/capture-log.ts, packages/db-p2p/test/logger.spec.ts
----

# Per-node debug logs now carry a peer id

## What changed

`createLogger(subNamespace, peerId?)` (`packages/db-p2p/src/logger.ts`) now takes an optional
second argument. When given, it truncates the peer id the same way the rest of the codebase
already does (`.substring(0, 12)`, matching `libp2p-key-network.ts`'s existing convention) and
appends it to the `debug` namespace as `:<truncated-id>`. Omitted, the namespace is byte-for-byte
identical to before — no `:undefined`, no behavior change for any caller that doesn't opt in.

Two call sites were switched over (the only two in scope per the ticket — this was a deliberate
narrow change, not a sweep of the ~30 other `createLogger` call sites in this package):

- **`Libp2pKeyPeerNetwork`** (`libp2p-key-network.ts`) — the `log` field used to be a class-field
  initializer (`private readonly log = createLogger('libp2p-key-network')`), which in real
  ECMAScript semantics runs *before* the constructor body — so `this.libp2p` (a parameter
  property) wasn't assigned yet at that point and `this.libp2p.peerId` wasn't available. Moved
  construction into the constructor body (now `private readonly log: ReturnType<typeof
  createLogger>`, assigned as the first statement in the constructor, after
  `this.selfCoordinationConfig`/etc. are computed — actually it's the very first line, before
  everything else) so `this.libp2p.peerId.toString()` can be read. `libp2p.peerId` is required on
  this class (not optional), so every instance now logs under a peer-id-suffixed namespace.

- **`CoordinatorRepo`** (`repo/coordinator-repo.ts`) — `log` used to be a *module-level* `const`
  shared by every `CoordinatorRepo` instance in a process (`const log = createLogger('coordinator-repo')`
  at the top of the file). It's now a private instance field, assigned in the constructor from the
  optional `localPeerId` parameter: `this.log = createLogger('coordinator-repo', localPeerId?.toString())`.
  `localPeerId` is optional (single-node/test construction has always tolerated its absence), so an
  instance built without one logs under the exact original un-suffixed namespace — this was a hard
  requirement, not a nice-to-have, since several existing specs construct `CoordinatorRepo` with no
  `localPeerId` and would break on anything resembling `:undefined`. All ~26 in-class call sites
  (`log('tag', {...})`) were mechanically changed to `this.log('tag', {...})` — verified via grep
  that no bare `log(` call remains in the file.

Resulting namespace shape: `optimystic:db-p2p:<subNamespace>:<first-12-chars-of-peer-id>`. Since
`debug` namespaces are hierarchical and an existing `DEBUG=optimystic:db-p2p:*` matches any suffix,
every existing `DEBUG` filter someone already has configured keeps working unchanged. Newly
possible: `DEBUG=optimystic:db-p2p:coordinator-repo:12D3KooW...` to isolate one node's lines from
a 3-node-in-one-process integration test.

## Why `test/support/capture-log.ts` also changed (not originally in scope, but load-bearing)

This shared test helper (used by `coordinator-repo-read-repair.spec.ts`,
`coordinator-repo-read-repair-content.spec.ts`, and others) does:

```ts
debug.enable(`optimystic:db-p2p:${namespace}`);
```

`debug.enable(...)` with no `*` wildcard does an **exact string match** against each `Debugger`
instance's namespace (confirmed by reading `@types/debug`'s `Debugger.namespace` field and the
`debug` package's own pattern-matching semantics — no wildcard means no partial match). Once
`CoordinatorRepo` started appending a peer-id suffix, every spec that constructs it with a
`localPeerId` (most of them — grep shows ~11 `new CoordinatorRepo(...)` call sites in
`coordinator-repo-read-repair.spec.ts` alone, and `localPeer` is passed as the 6th positional arg
in all of them) produced a namespace like `optimystic:db-p2p:coordinator-repo:12D3KooW...`, which
no longer exact-matched the helper's bare `optimystic:db-p2p:coordinator-repo` enable string. That
silently broke `captureLog`'s capture (the debug instance stopped being "enabled", so its calls
became no-ops), which surfaced as **15 failing assertions** across both read-repair spec files —
all of the form "expected false to equal true" on `hasTag(...)`/`hasTagAtRev(...)` checks.

Fixed by widening the enable pattern to match both shapes:

```ts
debug.enable(`optimystic:db-p2p:${namespace},optimystic:db-p2p:${namespace}:*`);
```

This is a real behavior-preserving fix, not a workaround — confirmed by re-running the full
`db-p2p` suite before and after (15 failing → 0 failing, and the failures were exclusively the
`hasTag`/`hasTagAtRev` assertions in the two read-repair spec files; nothing else moved).

## New coverage

`packages/db-p2p/test/logger.spec.ts` (new file) — 5 specs:

- `createLogger` unit-level: bare namespace with no peer id; suffixed + truncated namespace with one.
- `Libp2pKeyPeerNetwork`: two instances constructed with different peer ids (via a minimal mock
  `Libp2p`) land on two different, correctly-suffixed namespaces.
- `CoordinatorRepo`: constructed with a `localPeerId` → suffixed namespace; constructed without
  one → exact original un-suffixed namespace.

All specs reach the private `log` field via a cast (`(instance as { log: { namespace: string } })`),
following the existing pattern in this package's specs of casting to reach private members for
white-box assertions (see e.g. `(network as any).retryCouldImprove(...)` in
`libp2p-key-network.spec.ts`).

## Validation performed

- `yarn typecheck` (root) — clean.
- `yarn build` (root, all workspaces including `quereus-plugin-optimystic`, `quereus-plugin-crypto`) — clean.
- `yarn workspace @optimystic/db-p2p test` — 1568 passing, 44 pending, **0 failing** (was 1548
  passing / 15 failing before the `capture-log.ts` fix; the 5-test delta from 1563→1568 is the new
  `logger.spec.ts`).
- `yarn test` (root, full monorepo suite across all workspaces, ~5.5 min) — all green, no failures
  anywhere (grepped the full log for `failing`/`Error:` — no hits).

## Known gaps / things the reviewer should double check

- **Scope is deliberately narrow.** Only `Libp2pKeyPeerNetwork` and `CoordinatorRepo` were
  switched over, per the ticket's explicit instruction ("Only these two are in scope... a bigger,
  lower-value change"). The other ~30 `createLogger(...)` call sites in `packages/db-p2p/src/**`
  (e.g. `cluster-coordinator.ts`, `storage-repo.ts`, `block-storage.ts`, reactivity/dispute
  modules, etc.) are untouched and still log under a flat, non-node-attributable namespace. If a
  future diagnosis needs per-node attribution from one of those, it pays the same cost this ticket
  was filed to eliminate for these two classes.
- **`capture-log.ts` fix is broader than the two files this ticket names in `files:`.** It wasn't
  anticipated by the ticket description, but was required to keep the existing suite green — flagging
  explicitly in case the reviewer wants to scrutinize it separately from the two in-scope production
  files.
- I did not verify the *content* of what a 3-node-in-one-process integration test's log stream now
  looks like end-to-end (i.e. didn't run one of the multi-node p2p tests with `DEBUG=optimystic:db-p2p:*`
  piped to a terminal and eyeball that lines are now attributable). The unit-level specs confirm the
  namespace mechanism works correctly in isolation; I'm relying on that plus code reading rather than
  an end-to-end visual check.
- Didn't grep beyond this repo for any external tooling/dashboards that might parse the literal
  namespace strings `optimystic:db-p2p:coordinator-repo` / `optimystic:db-p2p:libp2p-key-network`
  out of log lines (none found inside this repo besides the new spec and this ticket).
