description: Our tests run against the exact third-party versions recorded in this repository's lockfile, but an application that installs our published packages gets the newest versions our declared ranges allow. When the two differ, a behaviour change in a dependency reaches users without any test here having run against it. Nothing compares the two before a release.
architecture: docs/releasing.md
files:
  - docs/releasing.md (where a pre-release step would be listed; the "Version Alignment" note is the nearest existing text)
  - scripts/release-preflight.mjs (the prompt that restates the release checklist)
  - scripts/shared-majors.cjs (the list of libp2p-family packages the two existing guards already share)
  - scripts/check-libp2p-majors.mjs, scripts/libp2p-majors.mjs (already ask Yarn what the installed tree resolved, per package)
  - packages/upgrade-check/scripts/write-fixture.mjs (`installPublishedBuild` already installs published packages into a scratch directory; `THIRD_PARTY_PACKAGES` records what that install resolved)
  - packages/upgrade-check/fixtures (each fixture's `writtenBy` holds the versions a fresh install of that release resolved)
tradeoffs: A check like this needs the network, so it can only be a release step rather than part of the offline gate, and it will report a difference on most releases simply because dependencies publish often; a maintainer may reasonably prefer to refresh the lockfile by habit before each release instead of building a comparison.
----
# Tests run on locked versions that a fresh install does not get

## What happened

Ticket `a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout` (gotchoices/sereus#13). libp2p 3.2.1 added a limit of 6 seconds on each address of a peer inside a dial. On a link with a 3 second round trip that limit cut off a relayed connection which every deadline of ours allowed far longer. A Sereus user met it; no test here did, because:

- `@optimystic/db-p2p` declared `libp2p` as `^3.1.3`, so an application installing it fresh resolved 3.3.11;
- this repository's `yarn.lock` held 3.1.3, so every suite, `yarn check` included, ran on 3.1.3, where the limit does not exist.

The lockfile was doing its job, which is to keep an install reproducible. The gap is that a library's lockfile is not shipped: it describes what we test, not what users run.

The difference was already on record and nobody was asked to look at it. `packages/upgrade-check/fixtures/<version>/` holds, for each release, the versions a fresh install of that release resolved (`writtenBy`). All four fixtures (1.0.0-beta.3, 1.2.0, 1.3.0, 1.4.0) say `libp2p` 3.3.11, recorded while the lockfile held 3.1.3.

## The rule this is about

Before a release, for the third-party packages whose behaviour our code depends on, the version the lockfile holds should be the version a fresh install of the packages about to be published would resolve. Where they differ, a person should see the difference and decide: refresh the lockfile and re-run the gate, or accept it knowingly.

The instance above is one case of a class. Any dependency declared with a caret range can move under users the same way: `@libp2p/circuit-relay-v2`, `@libp2p/identify`, `@chainsafe/libp2p-noise`, `p2p-fret`, `@quereus/quereus`.

## What a check has to do

- Cover at least the packages in `scripts/shared-majors.cjs`, plus `libp2p` itself and the other libp2p-family packages `@optimystic/db-p2p` declares. Whether it should cover every dependency of every published package is an open question; the wider it is, the more often it reports something.
- Compare, per package, the locked version against the newest published version that the declared range allows. The range to use is the one in the published manifest, so `workspace:^` between our own packages is not part of it.
- Report every difference with the package, the locked version and the version a fresh install gets. A difference is information for the releaser, not automatically a failure: the decision to refresh is a person's.
- Run where the network is available. `yarn check` runs offline today and should stay that way, so this belongs beside the release steps (`scripts/release-preflight.mjs` already reports working-tree state before a release and is the natural place to show it).

## What it does not cover

- A dependency of a dependency that moves while its parent's version stays the same. Comparing direct dependencies catches the reported case and most like it; the full answer is installing the packed tarballs into a scratch directory and comparing the whole resolved tree, which `installPublishedBuild` shows how to do for packages already on npm.
- A host application's own lockfile. An application that locked months ago runs older versions than ours, and nothing here can see that. Backlog ticket `debt-no-scenario-runs-two-builds-in-one-cohort` is about two such nodes meeting.
- React Native. A phone app resolves through its own package manager and bundler.

## Related

`packages/db-p2p/test/address-dial-timeout-cuts-off-a-signalled-dial.spec.ts` pins the one libp2p behaviour that was missed, and fails if the lockfile slides back to a libp2p without the limit. It guards that instance. This ticket is about seeing the next one before a user does.
