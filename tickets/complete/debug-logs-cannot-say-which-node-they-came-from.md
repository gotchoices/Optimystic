description: Debug log lines from routing and cluster-repair decisions now say which node produced them, so multi-node-in-one-process test runs (every integration test) can be diagnosed per node.
files: packages/db-p2p/src/logger.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/support/capture-log.ts, packages/db-p2p/test/logger.spec.ts, docs/debugging.md
----

# Per-node debug logs now carry a peer id

## What shipped

`createLogger(subNamespace, peerId?)` in `packages/db-p2p/src/logger.ts` takes an optional peer id
and appends its first 12 characters to the `debug` namespace as `:<truncated-id>`. Omitted, the
namespace is byte-for-byte what it was before — no `:undefined`, no change for the ~30 callers that
don't opt in.

Namespace shape: `optimystic:db-p2p:<subNamespace>:<first-12-chars-of-peer-id>`. `debug` namespaces
are hierarchical, so any existing wildcard filter (`DEBUG=optimystic:db-p2p:*`) keeps matching
unchanged. Newly possible: `DEBUG=optimystic:db-p2p:coordinator-repo:12D3KooWAbCd` to isolate one
node's lines out of a 3-node-in-one-process integration run.

Two classes opt in — the two the ticket scoped, deliberately not a sweep:

- **`Libp2pKeyPeerNetwork`** (`libp2p-key-network.ts`) — `log` moved from a class-field initializer
  to a constructor-body assignment, because field initializers run before the constructor body and
  `this.libp2p` (a parameter property) isn't assigned yet at that point. `libp2p.peerId` is
  required on this class, so every instance is suffixed.
- **`CoordinatorRepo`** (`repo/coordinator-repo.ts`) — `log` went from a module-level `const`
  shared by every instance in the process to a per-instance private field built from the optional
  `localPeerId` constructor parameter. All ~26 in-class call sites became `this.log(...)`. An
  instance built without a `localPeerId` (the single-node/test construction, which several existing
  specs use) logs under the exact original un-suffixed namespace.

**`test/support/capture-log.ts`** widened its enable pattern from
`optimystic:db-p2p:${namespace}` to `optimystic:db-p2p:${namespace},optimystic:db-p2p:${namespace}:*`.
`debug.enable` without a wildcard matches the namespace string *exactly*, so once `CoordinatorRepo`
started suffixing, the helper stopped enabling it and every capture silently came back empty —
15 `hasTag`/`hasTagAtRev` assertions across the two read-repair spec files failed. The widening is
the real fix, not a workaround.

**`docs/debugging.md`** documents the peer-id suffix: which sub-namespaces carry one, how to filter
for a single node, the exact-match caveat, and `createLogger`'s second argument.

## Review findings

Read the implement diff (`2e58046`) before the handoff summary. Checked: namespace-construction
correctness and the no-peer-id degradation path, class-field vs. constructor-body initialization
order, `debug`'s enable/match semantics against both the widened `captureLog` pattern and every
other hardcoded namespace string in the repo, per-instance logger lifetime, the mechanical
`log(` → `this.log(` conversion, docs currency, source hygiene, and test coverage of the seam that
actually broke.

**Fixed in this pass (minor):**

- **Stray UTF-8 byte-order mark added to `coordinator-repo.ts`.** The implement commit prefixed the
  file's first byte with `EF BB BF`; the parent revision had none. Invisible in a diff view, shows
  up as a spurious one-line change on the import statement and can confuse tooling that reads the
  first line. Stripped. (Two unrelated files in `db-p2p-storage-fs` carry pre-existing BOMs — left
  alone, out of scope.)
- **`this.log = createLogger(...)` was wedged between a comment and the code it explains** in
  `libp2p-key-network.ts`'s constructor — the `NOTE:` block above it documents
  `SelfCoordinationConfig` defaults, not logging. Moved the assignment above that block and gave it
  its own one-line comment stating *why* it can't be a field initializer, which was the
  non-obvious part and was undocumented.
- **Leftover double blank line** in `coordinator-repo.ts` where the module-level `const log` was
  deleted. Collapsed.
- **`docs/debugging.md` was stale.** It documents the sub-namespace table and the `DEBUG` recipes
  operators actually copy from, and said nothing about the peer-id suffix — the entire point of the
  ticket was undiscoverable from the doc that exists to make logging discoverable. Added a *Telling
  nodes apart in one process* section (namespace shape, single-node filter, the exact-match caveat
  that bit `captureLog`), marked the two suffixed sub-namespaces in the table, and corrected the
  "Adding new loggers" section for the new signature.
- **Test gap at the seam that actually broke.** Nothing pinned `captureLog`'s widened pattern
  directly; it was covered only incidentally by the read-repair specs, where a regression surfaces
  as a wall of "expected false to equal true" rather than as a named failure. Added two specs to
  `logger.spec.ts`: one asserting a bare *and* a peer-id-suffixed logger are both captured, one
  asserting a sibling namespace sharing a prefix (`capture-probe-sibling`) is *not* — pinning that
  the widening didn't over-broaden into `:*`-adjacent matches.
- **Unnecessary lint suppression** in `logger.spec.ts` — `makeClusterClient` carried an
  `eslint-disable-next-line @typescript-eslint/no-unused-vars` for a parameter it didn't need to
  name. Rewrote the cast without the parameter and removed the suppression.

**Checked and found clean (not findings):**

- **Per-instance logger lifetime.** `CoordinatorRepo` went from one process-wide `debug` instance
  to one per repo instance, which would leak on `debug` 4.1.x's global `createDebug.instances`
  array. This repo is on **4.4.3**, where that registry is gone and `enabled` is a lazy getter
  recomputed against a namespaces cache — so no accumulation, and loggers built before
  `debug.enable()` still pick the change up (which the pre-existing module-level logger already
  relied on).
- **Initialization order.** `log` is declared without an initializer *after* the constructor in
  `libp2p-key-network.ts`. Field initialization still runs before the constructor body under both
  `useDefineForClassFields` settings, and parameter-property assignment precedes user constructor
  statements, so `this.libp2p` is live at the assignment. Confirmed by the passing specs.
- **No other exact-match consumer of the two changed namespace strings.** Grepped every `.ts`,
  `.md`, `.json`, `.js` and `.yml` in the repo for `optimystic:db-p2p`: the only non-wildcard
  consumer was `capture-log.ts`, already fixed. `docs/architecture.md`'s reference is a wildcard
  and stays correct.
- **New specs don't leak resources.** `Libp2pKeyPeerNetwork`'s constructor calls
  `setupConnectionTracking()`, which registers one `connection:open` listener and starts no timers;
  the spec's mock `addEventListener` is a no-op, so the two un-stopped instances hold nothing.

**Tripwires recorded (not tickets):**

- **Only ~4 characters of the suffix actually distinguish nodes.** Every Ed25519 peer id begins
  with the constant `12D3KooW`, so a 12-character truncation leaves four base58 characters (~11M
  combinations) doing the work — ample for the handful of nodes a test process runs, misleading if
  someone assumes 12 characters of entropy. `NOTE:` at `packages/db-p2p/src/logger.ts`.
- **Adoption is partial by design.** The package's other ~30 `createLogger` call sites
  (`cluster-coordinator.ts`, `storage-repo.ts`, `block-storage.ts`, reputation and reactivity
  modules) still log flat and are not node-attributable. Conditional, not a defect: it only becomes
  work if a diagnosis needs per-node attribution from one of those, and the mechanism to thread a
  peer id through is already there. `NOTE:` at `packages/db-p2p/src/logger.ts`, plus a closing
  paragraph in `docs/debugging.md`'s new section, which is where someone hitting the need will look.

**Considered and not filed:**

- **`peerId.substring(0, 12)` is duplicated at ~15 sites** across three packages. A shared
  `shortPeerId()` helper is tempting, but the duplication is a pre-existing convention this diff
  merely follows once more, and consolidating it is a cosmetic sweep across package boundaries with
  no correctness payoff. Not worth a ticket.

**No major findings.** Nothing in the diff produces a wrong result, loses a resource, or leaves a
dormant path that breaks when it runs — so no `fix/`, `plan/`, or `backlog/` tickets were spawned.
The one genuine defect (the stray BOM) and the doc, hygiene, and coverage gaps were all small
enough to close in this pass.

## Validation

- `yarn lint` (root, `eslint .`) — clean.
- `yarn typecheck` (root, all workspaces) — clean.
- `yarn build` (root, all workspaces) — clean.
- `yarn workspace @optimystic/db-p2p test` — **1570 passing, 44 pending, 0 failing** (1568 before
  this review pass; +2 from the new `captureLog` specs).
- `yarn test` (root, full monorepo, 5m 25s) — all workspaces green, 0 failing. Log grepped for
  `failing` / `AssertionError` — no hits.

## Known gaps

- Nobody has run a multi-node integration test with `DEBUG=optimystic:db-p2p:*` and eyeballed the
  resulting stream end-to-end. The specs pin the namespace mechanism, and `docs/debugging.md` now
  documents the filter, but the "can a human actually read a 3-node log now" question is confirmed
  by construction rather than by observation.
