# Release Process

## Overview

Optimystic uses [bumpp](https://github.com/antfu/bumpp) for version bumping and follows semver.
Tags use the `v` prefix (e.g. `v0.7.0`).

## Prerequisites

- `yarn check` passes — the full gate (see below)
- Clean working tree (`git status` shows no uncommitted changes)

### `yarn check`

One command, run before every release:

```bash
yarn check
```

It runs, in order:

| Step | What it covers |
|------|----------------|
| `yarn lint` | eslint across the monorepo |
| `yarn build` | every package compiles |
| `yarn typecheck` | `tsc --noEmit` for the packages whose build does not type-check |
| `yarn test` | unit suites — fast, no sockets |
| `yarn test:integration` | real-socket libp2p suites |

`yarn typecheck` exists because two packages (`quereus-plugin-optimystic`, `quereus-plugin-crypto`)
build with **tsup/esbuild**, which strips types without checking them — every other package builds
with `tsc` and is checked by `yarn build` itself. It must run **after** `yarn build`: those two
packages' specs import their own `dist/index.js`, whose `.d.ts` only exists once the build has run,
so `yarn typecheck` on a clean tree fails with unresolved-module errors rather than real ones.

`yarn test:integration` is the step that matters most and is the easiest to skip by accident: the
integration specs are **env-gated** (`OPTIMYSTIC_INTEGRATION=1`) and live in a separate per-package
`test:integration` script, so **plain `yarn test` does not run them**. They cover real TCP meshes,
FRET cohort assembly, threshold-signed membership certificates, and cross-node reactivity and
matchmaking over real sockets — the behaviour that only appears once packets actually move.

## Quick Release

```bash
yarn check      # run this first
yarn release
```

`yarn release` runs a preflight prompt (`scripts/release-preflight.mjs`) that restates the checklist,
reports the working-tree and upstream state, and waits for you to type `release` to confirm — then
`yarn bump` (interactive version prompt, commits, tags, pushes) then `yarn pub` (clean + build +
publish each package).

The preflight is a **reminder, not a substitute**: it does not run `yarn check` for you. Publishing
is irreversible for a given version number, so the confirmation is deliberate rather than a
y/N keypress.

For automation, `node scripts/release-preflight.mjs --yes` (or `CI=1`) bypasses the prompt. Without a
terminal and without an explicit bypass the preflight aborts rather than assuming consent.

## Step by Step

### 1. Ensure a clean working tree

```bash
git status          # no uncommitted changes
git pull origin main
```

### 2. Bump, commit, tag, and push

```bash
# Interactive — prompts for version type (major / minor / patch / prerelease)
yarn bump

# Or specify the release type directly
yarn bump --release patch
yarn bump --release minor
yarn bump --release major
```

`bumpp` will:
1. Update `version` in all `package.json` files (recursive)
2. Commit the changes
3. Create an annotated tag: `v{version}`
4. Push the commit and tag to `origin`

### 3. Publish to npm

```bash
# Publish all public packages (clean + build + publish each)
yarn pub
```

Or publish individually:

```bash
yarn pub:db-core
yarn pub:db-p2p
yarn pub:quereus-crypto
# etc.
```

### 4. Create a GitHub release (optional)

```bash
gh release create v{version} --generate-notes
```

## Prerelease / RC

```bash
yarn bump --release prerelease --preid rc    # e.g. 0.7.0-rc.0
yarn bump --release prerelease --preid beta  # e.g. 0.7.0-beta.0
```

Publish prereleases with a dist-tag so they don't become `latest`:

```bash
# Manually publish each package with --tag next
```

## Version Alignment

All packages in the monorepo share the same version number. The `--recursive` flag in the bump script ensures this stays in sync. Do not manually edit version numbers in individual `package.json` files.

## Checklist

- [ ] `yarn check` passes (lint + build + typecheck + test + **test:integration**)
- [ ] Clean working tree
- [ ] `yarn release` (or `yarn bump` + `yarn pub` separately)
- [ ] GitHub release created
