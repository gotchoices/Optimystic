description: Parts of our networking stack can quietly end up built against different major versions of the same core library, which breaks them in ways nothing reports. Drop the one dependency that still does this, and add a check that fails the build if it happens again.
files:
  - scripts/check-libp2p-majors.mjs (new — the guard)
  - scripts/shared-majors.cjs (new — the one list of guarded packages, shared with the constraints file)
  - yarn.config.cjs (existing workspace-declaration guard; its `SHARED_MAJOR` map moves into the new shared file)
  - package.json (root — add `lint:deps`, wire into `check`, extend `test:harness` glob)
  - test-harness/libp2p-majors.test.mjs (new — unit tests for the guard's pure part)
  - packages/db-core/package.json (drop `@libp2p/peer-id-factory`)
  - packages/db-core/test/simulation.ts (its only importer)
  - packages/db-p2p/src/libp2p-node-base.ts (the `services:` cast — its `NOTE:` becomes an accepted-tradeoff record)
  - AGENTS.md (§ Dependencies)
  - docs/releasing.md (the `yarn check` step table)
  - scripts/release-preflight.mjs (the printed step list)
difficulty: medium
----

# Guard the resolved libp2p major, and remove the last dependency that breaks it

## Background, for a reader with no context

libp2p is split across dozens of small npm packages that all share one package of common type
definitions and base classes, `@libp2p/interface`. Two libp2p components only interoperate if they
were built against the **same major** of it. Nothing in this repository checks that they are.

We learned this the expensive way. `@chainsafe/libp2p-gossipsub@14` was built against
`@libp2p/interface` major 2 while everything else here is on major 3. The shape of a network stream
changed between those majors, so gossipsub threw on every message it tried to send — silently,
because it catches and logs its own errors. It shipped that way and an outside user diagnosed it for
us (gotchoices/Optimystic#9). That service has since been removed
(`tickets/complete/3-bug-gossipsub-pubsub-service-cannot-work-on-libp2p-3.md`).

The package manager cannot help. Gossipsub declared `@libp2p/interface` as a plain dependency rather
than a peer dependency, so the resolver simply installed a second copy beside ours and reported
success. Every version range did exactly what it was told; the incompatibility was invisible to the
resolver, to TypeScript, and to the test suite.

## What already exists, and the exact hole in it

`yarn.config.cjs` (Yarn 4 constraints) already guards this — but only halfway. Its `SHARED_MAJOR` map
walks `Yarn.dependencies()`, which spans the `dependencies`/`devDependencies`/`peerDependencies` of
**our own workspaces** and nothing else. It would not have caught gossipsub, because gossipsub is not
a workspace: the offending `@libp2p/interface@^2` range lived in *its* manifest, one level down.

So the hole is precise and worth stating plainly: **we guard what we declare, and nothing guards what
actually gets installed.** The failure that bit us lives entirely in the second category. Closing it
means checking the *resolved* dependency graph, not the declared ranges.

`yarn constraints` is also not wired into any script today — it only runs when someone types it. That
is a second, smaller hole, and the same change closes it.

## Enumeration, re-run 2026-09-11 (supersedes the numbers in the plan ticket)

`yarn info -A -R --json --name-only '@libp2p/interface' '@libp2p/crypto' '@libp2p/peer-id'`:

```
@libp2p/interface@npm:1.7.0     <- @libp2p/crypto@4.1.9, @libp2p/peer-id-factory@4.2.4, @libp2p/peer-id@4.2.4
@libp2p/interface@npm:3.1.0     <- the libp2p 3 release train + 5 of our workspaces + p2p-fret (portal)
@libp2p/interface@npm:3.2.3     <- @libp2p/autonat, @libp2p/dcutr, @libp2p/crypto@5.1.19, ...
@libp2p/interface@npm:3.2.4     <- @optimystic/db-core, @optimystic/reference-peer
@libp2p/crypto@npm:4.1.9        <- @libp2p/peer-id-factory@4.2.4
@libp2p/crypto@npm:5.1.13       ]  major 5
@libp2p/crypto@npm:5.1.19       ]
@libp2p/peer-id@npm:4.2.4       <- @libp2p/peer-id-factory@4.2.4
@libp2p/peer-id@npm:6.0.4       ]  major 6
@libp2p/peer-id@npm:6.0.10      ]
```

The 2.x rows are gone — the gossipsub removal landed. What remains is one single root of cross-major
skew: `@libp2p/peer-id-factory@4.2.4`, which is the **sole** dependent of `@libp2p/interface@1.7.0`,
`@libp2p/crypto@4.1.9` and `@libp2p/peer-id@4.2.4` (verified against `yarn.lock`: no other manifest in
the tree requests `@libp2p/interface@npm:^1`, `@libp2p/crypto@npm:^4`, or `@libp2p/peer-id-factory`).
Remove that one package and all three majors disappear together. It has exactly one importer in our
source.

## The 3.1 versus 3.2 split is an accepted tradeoff — do not try to close it

The plan ticket proposed raising the `^3.1.0` pins to `^3.2.4` so the `services:` cast in
`createLibp2pNodeBase` could be deleted. **That arm is dropped.** Two independent reasons, both worth
recording so nobody re-derives them:

1. A human already declined it. The `SHARED_MAJOR` comment in `yarn.config.cjs` documents the 3.1/3.2
   minor split as deliberate, and names the completed ticket (`optimystic-db-p2p-libp2p-dep-skew`)
   that left it in place: `@libp2p/interface@3.2.4` pulls `uint8arraylist@^3` and `multiformats@^14`,
   while db-p2p's `it-length-prefixed` / `uint8arraylist@^2` stack builds only against the `^2` line.

2. Raising db-p2p's own pin would not dedupe anything anyway. Every libp2p package db-p2p actually
   builds on — `libp2p@3.1.3` itself, plus `@libp2p/identify`, `@libp2p/kad-dht`, `@libp2p/tcp`,
   `@libp2p/websockets`, `@libp2p/circuit-relay-v2`, `@libp2p/bootstrap` and the ChainSafe
   noise/yamux pair — declares `^3.1.0` or `^3.0.0` and resolves to 3.1.0. Only `@libp2p/autonat`,
   `@libp2p/dcutr` and `@libp2p/crypto@5.1.19` ask for `^3.2.3`. Moving db-p2p's declaration alone
   would type db-p2p against 3.2.x while `Libp2pInit` — the very type the cast is narrowing — stayed
   3.1.x. That relocates the cast rather than removing it.

The cast's current `NOTE:` invites exactly this attempt ("if that dedups … drop the cast"), which is
how the plan ticket came to propose it. Rewrite that comment as an accepted-tradeoff record with a
concrete revisit condition: retry removing the cast when the libp2p release train db-p2p depends on
declares `@libp2p/interface@^3.2.x` or later, not before.

## The guard

A Node script run from the root, not a mocha spec. The choice is settled, for three reasons: the
property is repo-wide rather than a property of `db-p2p`; `yarn test` requires a fresh build, so a
spec would only report a dependency problem *after* paying for a full compile; and a spec asserting
the dependency graph would have to shell out to yarn from inside mocha, which is slow and awkward to
read. It belongs beside `scripts/check-doc-citations.mjs`, which is the same kind of check.

### Data source

One command gives the complete, unpruned answer:

```
yarn info -A -R --json --dependents '@libp2p/interface' '@libp2p/crypto' ...
```

It emits NDJSON, one line per resolved version:

```json
{"value":"@libp2p/interface@npm:1.7.0",
 "children":{"Version":"1.7.0",
             "Dependents":["@libp2p/crypto@npm:4.1.9","@libp2p/peer-id-factory@npm:4.2.4", ...],
             "Dependencies":[ ... ]}}
```

Read the major from `children.Version`, never by parsing the locator string — a guarded package could
resolve through `portal:`, `workspace:` or `patch:`, where the reference carries no version.

**Do not use `yarn why` for detection.** It prunes: its own help says it "will not print the package
listing twice for a single package". Measured on the current tree, `yarn why --json @libp2p/interface`
omits three of our own workspaces (`db-p2p-storage-ns`, `-rn`, `-web`) that genuinely depend on it. It
is fine to *suggest* in the failure message as a follow-up command; it is not sound as the input.

Both `yarn info` and `yarn constraints` measured at well under one second on this tree, so the whole
new step is cheap enough to sit in front of the build.

### What is guarded, and what is deliberately not

| package | expected major | why |
|---|---|---|
| `@libp2p/interface` | 3 | the failure class this ticket exists for |
| `@libp2p/interface-internal` | 3 | same types, same split, currently single-major |
| `@libp2p/crypto` | 5 | already in `SHARED_MAJOR`; carries key and peer-id shapes |
| `@libp2p/peer-id` | 6 | two majors here make `instanceof` fail across copies |
| `uint8arrays` | 6 | already forced single by root `resolutions`; guarding makes that honest |

**Not guarded, on purpose — say so in a comment in the shared list, or the next reader adds them and
breaks the build:** `multiformats` resolves to both 13 and 14, and `uint8arraylist` to both 2 and 3.
Both splits are the downstream consequence of the deliberate `@libp2p/interface` 3.1-versus-3.2 minor
drift described above. Adding either would fail on the first run.

Adding `@libp2p/peer-id` also closes the residual hole the `SINGLE_RANGE` comment in `yarn.config.cjs`
describes and accepts ("transitive copies … this guard cannot reach them"). Once this lands, that
comment is out of date — update it to say the transitive side is now covered.

### One list, two consumers

Put the guarded-major map in a new `scripts/shared-majors.cjs` and have **both** `yarn.config.cjs` and
the new script read it. Two copies of this list would drift, which is the same class of bug the ticket
is about. CommonJS because `yarn.config.cjs` is loaded by Yarn as CJS and cannot `import`. Do not
instead hang an extra export off `yarn.config.cjs`'s `module.exports` — Yarn owns the shape of that
object.

Note the two maps are not identical in meaning: `yarn.config.cjs` also has a `SINGLE_RANGE` map (exact
range, autofixable) that stays where it is. Only `SHARED_MAJOR` moves, extended with the three new
entries.

### Failure message

Must name the offending versions **and their dependents** — the diagnostic value is the `yarn why`
answer, not "versions differ". Shape:

```
@libp2p/interface resolves to 2 majors in this project; expected only major 3.

  major 3 (expected)
    3.1.0   libp2p@3.1.3, @libp2p/identify@4.0.10, @optimystic/db-p2p (workspace), +18 more
    3.2.4   @optimystic/db-core (workspace), @optimystic/reference-peer (workspace)

  major 2 (UNEXPECTED)
    2.10.0  @chainsafe/libp2p-gossipsub@14.1.2

Two majors of @libp2p/interface cannot interoperate: a stream, peer id or key minted
against one copy is structurally incompatible with the class from the other, and
TypeScript does not reliably say so. Replace or remove the dependents listed under the
unexpected major, or move the whole tree onto one major and update scripts/shared-majors.cjs.

Scope: this guard covers packages resolved inside THIS workspace, including portal-linked
sibling repositories. It says NOTHING about the libp2p version running on the other end of
a live connection — a peer can still be a major behind and this check stays green.

  yarn why @libp2p/interface        # full dependency paths (note: yarn prunes repeats)
```

That scope paragraph is required, not decorative. The gossipsub failure arrived over a connection, and
a green guard must not be read as "a libp2p major mismatch cannot reach us". A concrete live instance
exists: the sibling `../sereus` checkout ships a standalone relay/bootstrap container
(`ops/docker/libp2p-infra`) on `libp2p@^2` that dials this stack's `libp2p@^3`. It is a separate
repository with its own lockfile, invisible to any check here, and tracked on that side as
`sereus/tickets/backlog/debt-relay-container-is-a-libp2p-major-behind-its-clients`. Do not widen this
ticket to chase it.

An in-repo example of the same "the peer at the other end is a different build" class already sits in
the backlog as `debt-mixed-version-identify-incompatibility` — a different root cause (a corrected
protocol-id string, not a package version) but the same blind spot. Neither it nor the relay container
is this ticket's problem; both are the reason the scope sentence has to be in the failure output
rather than only in a design document.

Truncate long dependent lists (the current `@libp2p/interface@3.1.0` row has 27) and shorten
`virtual:`/`portal:` locators — `p2p-fret` currently appears as a 200-character URL-encoded locator
that is unreadable as-is. Render workspaces as `@optimystic/db-p2p (workspace)`.

### Structure, so the logic is testable

Keep the shell-out at the edge. Export a pure function — given `[{ ident, version, dependents }]` plus
the expected-major map, return the offenders and the rendered message — and have `main()` do nothing
but run `yarn info`, parse NDJSON, call it, print, and set the exit code. The tests then never invoke
yarn.

`test-harness/` is the established home for this (it runs on node's built-in test runner precisely so
it depends on nothing the build produces). Add `test-harness/libp2p-majors.test.mjs` and widen the root
`test:harness` script from the single filename to `node --test "test-harness/*.test.mjs"` — verified
working on the repo's node 24; the bare-directory form `node --test test-harness/` fails here, so use
the quoted glob.

Tests to write, with their expected outcomes:

- single major across several versions (3.1.0, 3.2.3, 3.2.4) → no offender
- two majors (1.7.0 alongside the 3.x set) → offender reported, and **the message contains the name of
  the dependent that pulls 1.7.0**, not merely the version
- every resolution on an *unexpected* single major (all of `@libp2p/interface` at 4.x) → offender
  reported; this is the case a "more than one distinct major" rule would wrongly pass, and is why the
  expected major is declared rather than inferred
- a guarded ident with **zero** resolutions → error, with a message saying the list is stale. A guard
  silently passing because it is watching a package that no longer exists is worse than no guard
- a prerelease version (`3.2.4-rc.1`) → parsed as major 3
- a `workspace:`/`virtual:` locator among the dependents → rendered readably, not raw
- the rendered message is checked for the scope sentence, so removing it fails a test

### Wiring

Add a root script `lint:deps` that runs `yarn constraints` then the new script, and insert it into
`check` after `lint:docs`. Both halves are fast and need no build, so they belong in front of
`yarn build` where a dependency problem is cheapest to hear about.

While editing the step list: `docs/releasing.md`'s `yarn check` table and the list
`release-preflight.mjs` prints both already omit `lint:docs` and `typecheck` — pre-existing drift, not
caused by this change. Fix both lists to match the real `check` script rather than adding one row to a
list that is already wrong.

## Edge cases & interactions

- **`yarn info` fails or emits nothing.** No install, a missing portal sibling (`../quereus`,
  `../Fret`), a yarn version without `--dependents`. Surface yarn's own stderr and exit non-zero. Never
  treat empty output as "clean" — that is the silent-pass failure mode the guard exists to prevent.
- **Zero resolutions for a guarded ident** (covered above): hard error, not a pass.
- **Non-`npm:` protocols.** Use the reported `Version` field; a `portal:`, `workspace:`, `patch:` or
  `virtual:` locator has no version in its reference.
- **Prerelease and multi-digit majors.** `3.2.4-rc.1` → 3; `10.0.0` → 10, not 1.
- **The guard must pass the moment it is added.** Land the `peer-id-factory` removal and the
  `yarn install` that follows it *before* wiring `lint:deps` into `check`, or the first run of the new
  step fails on `@libp2p/interface@1.7.0`.
- **`yarn.lock` churn.** Removing `@libp2p/peer-id-factory` drops three packages from the lock. That
  diff is expected and must be committed; do not regenerate the lock beyond what `yarn install` does.
- **`yarn constraints` still passes** after `SHARED_MAJOR` moves out of `yarn.config.cjs` into a
  required module — run it directly, not only through the new `lint:deps`.
- **The dropped cast that is *not* the `services:` one.** `simulation.ts` carries
  `peerId as unknown as PeerId` with the comment "Type assertion to bypass the type compatibility
  issue" — that cast exists because the v1-era factory returned a foreign `PeerId`. db-core's `PeerId`
  is its own minimal structural type (`toString`/`equals`) in `packages/db-core/src/network/types.ts`,
  not libp2p's, so after the swap the cast should be unnecessary. Try removing it; keep it with a real
  explanation only if the compiler still objects.
- **Windows paths and shell.** The script is invoked through yarn on Windows; use `execFileSync` with
  an argument array (as `release-preflight.mjs` does), not a composed shell string.
- **`yarn lint:docs` polices this ticket's doc edits.** No line numbers in prose, and every backticked
  path must name a tracked file — `scripts/shared-majors.cjs` will not exist until you create it.

## TODO

### Phase 1 — remove the last cross-major dependency

- Replace the `@libp2p/peer-id-factory` import in `packages/db-core/test/simulation.ts` with a static
  `generateKeyPair` from `@libp2p/crypto/keys` plus `peerIdFromPrivateKey` from `@libp2p/peer-id` — the
  pattern `packages/db-core/test/transaction.spec.ts` already uses. Static import, not inline
  `import()` (AGENTS.md § General).
- Drop the `as unknown as PeerId` cast at the call site if the compiler allows it.
- Remove `@libp2p/peer-id-factory` from `packages/db-core/package.json`. It needs no replacement
  dependency: `@libp2p/crypto@^5.1.13` and `@libp2p/peer-id@^6.0.4` are already devDependencies there.
- `yarn install`, then re-run the enumeration command above and confirm `@libp2p/interface@1.7.0`,
  `@libp2p/crypto@4.1.9` and `@libp2p/peer-id@4.2.4` are all gone.
- `yarn workspace @optimystic/db-core test` — `simulation.ts` backs `simulation.spec.ts` and
  `network-transactor.spec.ts`.

### Phase 2 — the guard

- Create `scripts/shared-majors.cjs` exporting the expected-major map, with the comment explaining why
  `multiformats` and `uint8arraylist` are excluded.
- Rewrite `yarn.config.cjs` to require that map instead of defining `SHARED_MAJOR` inline. Keep
  `SINGLE_RANGE` where it is; update its comment to say the transitive `@libp2p/peer-id` skew it
  describes is now covered by the resolved-major guard.
- Write `scripts/check-libp2p-majors.mjs`: pure evaluate/render function plus a thin `main()`.
- Write `test-harness/libp2p-majors.test.mjs` covering every case listed above.
- Widen root `test:harness` to `node --test "test-harness/*.test.mjs"`.
- Add root `lint:deps`, and insert it into `check` after `lint:docs`.

### Phase 3 — record the decisions and update the docs

- Rewrite the `NOTE:` above the `services:` cast in `packages/db-p2p/src/libp2p-node-base.ts` as an
  accepted-tradeoff record: what was declined (raising db-p2p's `@libp2p/interface` pin to dedupe),
  why (both reasons above), and the revisit condition (the libp2p release train db-p2p depends on
  declaring `^3.2.x` or later).
- AGENTS.md § Dependencies: add the resolved-major guard beside the existing constraints description,
  and say plainly which of the two covers declared ranges and which covers the installed tree.
- `docs/releasing.md` `yarn check` table and the list printed by `scripts/release-preflight.mjs`: add
  `lint:deps`, and fix the pre-existing omission of `lint:docs` and `typecheck` in both.

### Phase 4 — validate

- `yarn lint && yarn lint:docs && yarn lint:deps && yarn test:harness` in the foreground, no output
  redirection.
- `yarn build && yarn typecheck && yarn test`.
- Prove the guard actually fires: temporarily add a bogus expected major to `scripts/shared-majors.cjs`
  (or a throwaway dependency on a package pulling an old `@libp2p/interface`), confirm the failure
  message names the dependents, then revert. A guard nobody has seen fail is a guard nobody knows
  works.
