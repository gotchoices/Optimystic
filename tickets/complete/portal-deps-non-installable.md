description: A fresh clone now installs from published npm packages with no sibling repositories required; local-folder overrides are opt-in via yarn link.
prereq:
files: package.json, packages/substrate-simulator/package.json, packages/substrate-simulator/README.md, packages/quereus-plugin-crypto/package.json, packages/quereus-plugin-optimystic/package.json, yarn.lock, README.md
difficulty: medium
----

## What this ticket did

Removed the two on-disk sibling-repo dependency overrides (`portal:` locators pointing
*outside* the repo — `@quereus/quereus` and `p2p-fret`) so `git clone` + `yarn install`
works with no other repos checked out, defaulting both to their published npm versions.
Sibling-folder overlay is opt-in via `yarn dev:link` / `yarn dev:unlink`. Switching
`p2p-fret` from a symlinked portal to a real npm copy forced substrate-simulator to declare
`p2p-fret`'s libp2p peer deps (`@libp2p/interface`, `@libp2p/peer-id`, `libp2p`) locally.

See the implement commit `a51cc5e` for the full change; this file is the archived summary
plus the review pass.

## Review findings

Adversarial pass over the implement diff (`a51cc5e`), read before the handoff summary.

### Checked

- **Sibling-independence by construction** — `yarn.lock` has zero `portal:` locators and no
  `../quereus` / `../Fret` / `quereus/packages` / `Fret/packages` filesystem paths.
  `yarn install --immutable` (what CI / a fresh clone runs) → **rc=0**, only pre-existing
  react-native `YN0068` peerDependency notices remain (unrelated to this ticket).
- **Every workspace consumer of the swapped deps** — grepped all `package.json`: only
  `quereus-plugin-crypto` + `quereus-plugin-optimystic` declare `@quereus/quereus` (both
  bumped to `^4.3.0`); only `db-p2p` + `substrate-simulator` declare `p2p-fret` (`^0.6.0`).
  `db-p2p` already declared the three libp2p peer deps at the identical ranges, so removing
  the root `p2p-fret` portal resolution does not break it.
- **Added libp2p version correctness** — substrate-simulator's `@libp2p/interface ^3.1.0`,
  `@libp2p/peer-id ^6.0.4`, `libp2p ^3.1.3` match p2p-fret@0.6.0's declared peer ranges,
  db-p2p's existing declarations, and the `yarn.config.cjs` guards (`SINGLE_RANGE` peer-id
  `^6.0.4`, `SHARED_MAJOR` interface major 3).
- **`yarn constraints`** — the implementer did NOT run it (AGENTS.md requires it after any
  guarded-dep change). Ran it during review: **clean, no violations**. The added ranges all
  conform, so no fix was needed — but this was an unrun gate, now closed.
- **`yarn link` multi-destination syntax** — confirmed via `yarn link --help` that the CLI
  accepts one-or-more destinations (`$ yarn link ~/ts-loader ~/jest`), so `dev:link` passing
  two sibling paths is valid.
- **Lint** — `yarn lint` (eslint . across the monorepo) → **rc=0, clean**.
- **Tests** — `substrate-simulator` **258 passing** (direct npm `p2p-fret` consumer, runtime
  resolution proven); `quereus-plugin-optimystic` **304 passing / 11 pending** (the package
  the implement stage left untested — now run, passes); `quereus-plugin-crypto` **125
  passing**.
- **Docs consistency** — grepped all `*.md` for `portal:` / sibling-path references.

### Found + done

- **Minor (fixed inline): stale sub-package doc.** `packages/substrate-simulator/README.md`
  still described `p2p-fret` as "(via a `portal:` path ref to the sibling FRET repo)". The
  implementer updated the root `README.md` but missed this one. Rewrote it to say it depends
  on the published `p2p-fret` npm package, and added a sentence explaining why the three
  libp2p peer deps are declared there (transitively pulled by loading `p2p-fret`, though the
  mock uses only non-libp2p exports).

### Not found (explicitly empty, with reason)

- **No major findings** — no new fix/plan/backlog tickets filed. The change is a
  version-identical dep-resolution swap (the sibling checkouts sat at exactly the published
  versions), touches no source code, and every gate (immutable install, constraints, lint,
  three test suites, build per the implement stage) passes.
- **No new tripwires.** The one existing conditional concern — `dev:link` writes `portal:`
  resolutions into the tracked `package.json`, so a co-developer must not commit them — is
  already parked as a `NOTE:` HTML comment beside the `dev:link` docs in the root `README.md`
  (a pre-commit guard is reasonable future hardening). Left as-is; not re-filed.

### Deferred (unchanged from implement stage, agreed)

- **Empirical sibling-less clean install** — not run (proven by construction via zero
  portal/sibling paths in `yarn.lock` + `--immutable` rc=0). A throwaway clone elsewhere
  could confirm empirically; the in-place sibling repos must not be moved (locked on this
  box). Not blocking.
- **Full monorepo `yarn test`** — the db-p2p integration suite (real libp2p / network) is
  heavy/flaky and not agent-runnable; worth a CI run. No consumer code changed, so risk is
  low. `docs/cohort-topic.md` lines 90–93 cite `../../Fret/packages/fret/src/...` source
  paths — pre-existing informational design-doc citations, not install instructions and not
  touched by this ticket; left as-is.

## Validation performed (review)

- `yarn install --immutable` → rc=0.
- `yarn constraints` → clean.
- `yarn lint` → rc=0.
- `yarn workspace @optimystic/substrate-simulator test` → 258 passing.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` → 304 passing, 11 pending.
- `yarn workspace @optimystic/quereus-plugin-crypto test` → 125 passing.
- Working tree after review: only `packages/substrate-simulator/README.md` modified (the
  inline doc fix); no lockfile churn from install.
