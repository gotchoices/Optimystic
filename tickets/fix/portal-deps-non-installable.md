----
description: A fresh clone of this project cannot install its dependencies unless two unrelated sibling projects happen to already be checked out in neighbouring folders on the same machine, which breaks continuous integration and blocks any new contributor.
prereq:
files: package.json, packages/substrate-simulator/package.json, yarn.lock, README.md
difficulty: medium
----

Review finding eh-1 (docs/review.html, Section 9 "Cross-cutting engineering health").

The root `package.json` `resolutions` block pins two dependencies to on-disk sibling checkouts:

- `@quereus/quereus: portal:../quereus/packages/quereus`
- `p2p-fret: portal:../Fret/packages/fret`

`packages/substrate-simulator/package.json` also references `p2p-fret` via a portal directly. A `portal:` protocol resolves the dependency to a path outside the repository. As a result:

- A fresh `git clone` followed by `yarn install` fails unless `../quereus` and `../Fret` are also checked out, at mutually compatible versions.
- CI cannot install the workspace at all without staging those sibling repos first.
- The committed `yarn.lock` pins whatever local disk state existed when it was generated, so lock contents depend on a developer's folder layout rather than a published version.

Expected end state: a clean checkout installs with no sibling repositories present. The default dependency source for `@quereus/quereus` and `p2p-fret` should be a published/tagged version from a registry. The `portal:` overlay should be opt-in for developers who are actively co-developing the sibling packages (for example via a separate, git-ignored resolutions overlay, an environment-gated install, or documented manual step), and the intended sibling-checkout layout should be documented in the README.

Research to settle during the fix: confirm whether `@quereus/quereus` and `p2p-fret` are published to a registry and at which versions the workspace currently needs. If neither package is published anywhere, the "consume published versions by default" path is not yet available and the choice of remediation (publish them first, vendor them, or accept a documented sibling-checkout requirement) becomes a decision a human must sign off on — surface that explicitly rather than guessing.
