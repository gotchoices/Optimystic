# Release Process

## Overview

Optimystic uses [bumpp](https://github.com/antfu/bumpp) for version bumping and follows semver.
Tags use the `v` prefix (e.g. `v0.7.0`).

## Prerequisites

- `yarn build` succeeds
- `yarn test` passes
- Clean working tree (`git status` shows no uncommitted changes)

## Quick Release

```bash
yarn release
```

This runs `yarn bump` (interactive version prompt, commits, tags, pushes) then `yarn pub` (clean + build + publish each package).

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

- [ ] `yarn build` succeeds
- [ ] `yarn test` passes
- [ ] Clean working tree
- [ ] `yarn release` (or `yarn bump` + `yarn pub` separately)
- [ ] GitHub release created
