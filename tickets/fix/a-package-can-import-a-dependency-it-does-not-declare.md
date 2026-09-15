description: A test in the core package imports a cryptography library the package never lists as a dependency. It only works because the installer happens to place a copy where the import can find it, so a fresh or differently-configured install breaks the build. Declare it, and add a check so no package can rely on an undeclared dependency again.
files: packages/db-core/package.json, packages/db-core/test/reactivity/recover.spec.ts, eslint.config.js, package.json (root scripts), scripts/check-libp2p-majors.mjs (sibling dependency guard, for placement)
difficulty: easy
repro: verified
----

# What happened

`packages/db-core/test/reactivity/recover.spec.ts` imports `@noble/curves/ed25519.js`. `packages/db-core/package.json` declares `@noble/hashes` but not `@noble/curves`.

In the main checkout this resolves because yarn's `node_modules` linker nests a copy of `@noble/curves` under `packages/db-core/node_modules` for one of db-core's libp2p dependencies. Nothing guarantees that placement.

Reproduced on 2026-09-14 by running `yarn install && yarn check` in a fresh `git worktree` of this repository. The repo's `.yarnrc.yml` (which selects the `node_modules` linker) is not tracked, so the fresh checkout installed with Yarn's default Plug'n'Play linker, which enforces declared dependencies strictly. The build of db-core failed immediately:

```
test/reactivity/recover.spec.ts(2,25): error TS2307: Cannot find module '@noble/curves/ed25519.js' or its corresponding type declarations.
The command failed in workspace @optimystic/db-core@workspace:packages/db-core with exit code 2
```

The import is test-only, so no published package is affected, but any contributor or CI job whose install lays packages out differently gets a build that cannot start.

# Expected

- Every bare import in a workspace's `src/` and `test/` names a package that workspace declares (dependencies, devDependencies or peerDependencies), or a Node builtin.
- `@noble/curves` is added to db-core's `devDependencies` at the same range the other workspaces use (`^2.0.1`).
- A check catches the whole class, not just this instance. It should be the highest rung that fits: an ESLint rule if a maintained one works with this flat config without enabling the broad presets the config deliberately avoids (see the SCOPE comment in `eslint.config.js`); otherwise a small script beside `scripts/check-libp2p-majors.mjs` wired into `yarn check` before the build. The first run will likely find more instances; fix them in the same pass rather than allow-listing them.

# Separate observation, not this ticket's job

`.yarnrc.yml` being untracked means a fresh clone does not install the way the maintainers' checkouts do. That may be deliberate (it may hold machine-specific settings); whoever works this ticket should say in the review handoff whether the linker setting belongs in a tracked file, without changing it unilaterally.
