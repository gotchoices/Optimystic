description: The setting that tells Yarn how to install packages lives only in each maintainer's own untracked config file, so a fresh clone installs a different way than every existing checkout; a maintainer needs to decide whether to commit that setting for everyone.
files: .gitignore (the `.yarnrc.yml` entry, under "Yarn configuration with secrets"), .yarnrc.yml (untracked, local), package.json (`packageManager: yarn@4.12.0`, `resolutions` portal links), AGENTS.md (§ Dependencies)
----

# The situation

This repo uses Yarn 4. Yarn 4 can install packages in two ways:

- **node_modules linker** — the classic layout: a `node_modules` folder tree on disk. Packages can sometimes import things they never declared, because a copy happens to sit in a nearby `node_modules` folder.
- **Plug'n'Play (PnP)** — Yarn 4's *default*. No `node_modules` folder. Strict: a package can only import what its own `package.json` declares.

Which one is used is set by `nodeLinker:` in `.yarnrc.yml` at the repo root. In this repo that file is **gitignored** (`.gitignore`, under the comment "Yarn configuration with secrets"), so it is never committed. The maintainer checkout this was reviewed on has `nodeLinker: node-modules` locally. A fresh clone has no `.yarnrc.yml` at all, so Yarn falls back to PnP.

# Why it matters

This mismatch is how the bug in `a-package-can-import-a-dependency-it-does-not-declare` stayed hidden: a db-core test imported `@noble/curves` without declaring it, and that worked in maintainer checkouts (node_modules layout) but failed right away in a fresh-worktree install (PnP). That specific class of bug is now caught by `scripts/check-undeclared-deps.mjs` under `yarn lint:deps`, whichever linker is in use.

The broader mismatch is still there, though. Nobody has confirmed that a fresh clone installs, builds and tests at all under PnP. The ts-node ESM loader in each package's `register.mjs`, the `portal:` resolutions to sibling repositories in the root `package.json`, and any tool that expects a real `node_modules` folder are all things PnP commonly breaks. Right now contributors and CI get different install layouts, depending on whether a `.yarnrc.yml` happens to exist on their machine.

# The decision needed

- **Commit a secrets-free `.yarnrc.yml`** that pins `nodeLinker: node-modules` (and anything else non-secret), stop ignoring it, and move the secrets (for example an npm publish token) into the user-level `~/.yarnrc.yml` or environment variables. Every checkout then installs the same way.
- **Standardize on PnP instead**: commit a `.yarnrc.yml` that keeps the default, then fix whatever breaks. This is stricter, but likely more work up front.
- **Leave it machine-specific**, and accept that fresh clones and CI may behave differently from maintainer checkouts. If so, document the required local setting in AGENTS.md.

This is filed in `blocked/` because it changes how every contributor's install works and moves where secrets live. Only a maintainer can make that call. Unconfirmed: which secrets the local `.yarnrc.yml` holds, and whether a PnP install of this repo works at all. Both need checking by someone with access before choosing.
