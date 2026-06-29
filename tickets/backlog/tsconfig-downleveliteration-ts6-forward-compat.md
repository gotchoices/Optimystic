description: Remove the deprecated `downlevelIteration` compiler option (a no-op at the ES2022 target) from all package tsconfigs before the repo upgrades to TypeScript 6.x/7.0 — under TS 6.0+ it raises a fatal TS5101 config error that aborts compilation. Not currently failing: the repo pins TS 5.9.3, which builds cleanly.
prereq:
files:
  - packages/db-p2p/tsconfig.json (line 19, downlevelIteration)
  - packages/db-p2p-storage-fs/tsconfig.json (line 21)
  - packages/db-core/tsconfig.json (line 19)
  - packages/demo/tsconfig.json (line 19)
  - packages/substrate-simulator/tsconfig.json (line 19)
  - packages/db-p2p-storage-rn/tsconfig.json (line 19)
  - packages/db-p2p-storage-web/tsconfig.json (line 19)
  - packages/db-p2p-storage-ns/tsconfig.json (line 19)
  - packages/reference-peer/tsconfig.json (line 18)
  - packages/quereus-plugin-optimystic/tsconfig.json (line 19)
----

# Drop deprecated `downlevelIteration` ahead of a TypeScript 6.x upgrade

## Context

A prior triage flagged this command as a "pre-existing build error" in `packages/db-p2p`:

```
cd packages/db-p2p && npx tsc --noEmit
tsconfig.json(19,3): error TS5101: Option 'downlevelIteration' is deprecated and will
stop functioning in TypeScript 7.0. Specify compilerOption '"ignoreDeprecations": "6.0"'
to silence this error.
Exit code: 2
```

**This is not a real failure under the repo's toolchain.** It is an artifact of `npx`
resolving the wrong `tsc`:

- `npx tsc --version` → **6.0.3** (a stray global/cached install; there is no `typescript`
  in the repo-root `node_modules`).
- `packages/db-p2p` pins `typescript: ^5.9.3` and its `build` script is plain `tsc`, which
  runs the package-local binary `node_modules/.bin/tsc` (resolves to **5.9.3**).
- TS 5.9.3 does **not** deprecate `downlevelIteration`, so the real build is unaffected.

Verification at HEAD:

```
$ node -e "console.log(require('typescript').version)"   # from packages/db-p2p
5.9.3
$ ./node_modules/.bin/tsc --noEmit
EXIT: 0          # clean — no type errors
```

The 47 mesh/cohort spec tests also pass (they run via mocha + ts-node, not via `tsc`).

So there is nothing to fix today, and no code/config change was committed by this triage
(an exploratory edit removing the option was reverted; the tsconfigs are unchanged at HEAD).

## Why this is still worth a ticket

`downlevelIteration` only affects emit when `target` is **below ES2015**. Every listed
package targets **ES2022** (`lib: ["ES2022"]`), so the option is a pure no-op. The moment
the repo bumps its pinned TypeScript to **6.x**, `tsc` will abort every one of these
packages with the fatal `TS5101` config error above — turning a dormant no-op into a
hard build break across the whole monorepo.

## Proposed work

When/if upgrading TypeScript to 6.x (or proactively now, since the option does nothing):

- Remove the `downlevelIteration: true` line from all 10 package tsconfigs listed above.
  This is the clean fix — it deletes dead configuration rather than masking the warning.
- (Alternative, not preferred) add `"ignoreDeprecations": "6.0"` to silence the warning
  while keeping the no-op option. This only defers the problem to TS 7.0.

Note that bumping to TS 6.x also surfaces a separate, larger pile of pre-existing type
errors in `packages/db-p2p` (1448× TS2593 missing test-runner globals, 378× TS2304, etc.)
that are currently hidden because TS5101 short-circuits compilation before type-checking.
Those errors do **not** occur under the pinned TS 5.9.3 and are out of scope here — they
would need their own investigation as part of any TypeScript 6.x migration.

## Ruled out

- **Not a db-p2p-only issue / not tied to the `mock-tier-mesh-uniform-timeout-headroom`
  ticket** — that ticket only touched `this.timeout()` values in spec files. The tsconfig
  is unchanged in its diff.
- **Not an `@types/node` problem** — `@types/node ^25.1.0` is present in devDependencies;
  the type errors that appear under TS 6.0.3 are a consequence of TS5101 aborting before
  type resolution completes, not of missing type packages.
- **Not fixable by editing one tsconfig** — the deprecation is identical across all 10
  packages; a piecemeal fix would leave the rest to break on the version bump.
