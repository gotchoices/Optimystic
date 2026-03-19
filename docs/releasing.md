# Release Process

## Overview

Optimystic uses [bumpp](https://github.com/antfu/bumpp) for version bumping and follows semver.
Tags use the `v` prefix (e.g. `v0.7.0`).

## Prerequisites

- `yarn build` succeeds
- `yarn test` passes

## Steps

### 1. Ensure a clean working tree

```bash
git status          # no uncommitted changes
git pull origin main
```

### 2. Bump versions

`bumpp` updates all `package.json` files, tags, and pushes. You commit manually first.

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
2. Create an annotated tag: `v{version}`
3. Push the commit and tag to `origin`

It will **not** commit — you do that yourself before running bump:

### 3. Commit

Commit all pending changes (including any work beyond the version bump) before running `yarn bump`:

```bash
git add -A
git commit -m "v{version}"
```

Then `yarn bump` will tag and push.

### 4. Publish to npm

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

### 5. Create a GitHub release (optional)

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
# Publish each package with --tag next manually
```

## Version Alignment

All packages in the monorepo share the same version number. The `--recursive` flag in the bump script ensures this stays in sync. Do not manually edit version numbers in individual `package.json` files.

## Checklist

- [ ] `yarn build` succeeds
- [ ] `yarn test` passes
- [ ] Commit: `git add -A && git commit -m "v{version}"`
- [ ] `yarn bump` (interactive version selection — tags and pushes)
- [ ] `yarn pub`
- [ ] GitHub release created
