----
description: One package requires an older major version of a shared peer-identity library than the rest of the project, which can make runtime identity checks fail unexpectedly; and there is no automated guard to keep shared dependency versions aligned across packages.
prereq:
files: packages/reference-peer/package.json, package.json, packages/db-core/package.json
difficulty: medium
----

Review finding eh-3, dependency-drift portion (docs/review.html, Section 9 "Cross-cutting engineering health").

`packages/reference-peer/package.json` pins `@libp2p/peer-id` at `^5.1.8`, while every other package uses `^6` (for example `db-core` is at `^6.0.4`). When two different major versions of `@libp2p/peer-id` load at runtime, peer-id objects created by one copy fail `instanceof` checks against the class from the other copy, producing intermittent, hard-to-diagnose identity/routing failures.

This is distinct from the already-completed `optimystic-db-p2p-libp2p-dep-skew` ticket, which resolved a `protons-runtime` v5/v6 skew and deliberately left an `@libp2p/interface` version split in place; it did not address the `@libp2p/peer-id` major-version divergence in reference-peer.

Expected end state:

- Align `@libp2p/peer-id` across the workspace onto a single major version (bring reference-peer up to `^6`, verifying reference-peer builds and its tests pass afterward). Watch for the interaction noted in the completed dep-skew ticket, where an `@libp2p/interface` bump in db-p2p reintroduced a peer-id-vs-db-p2p structural-typing split in tests — confirm the alignment does not resurface that.
- Add an automated version-alignment guard (`yarn constraints`) so shared libp2p/uint8arrays/interface dependencies cannot drift to divergent versions across packages again. Encode the shared-major expectation for `@libp2p/peer-id` (and the other cross-package libp2p deps) so a future divergent pin fails `yarn constraints` in CI. Also fold in the assorted minor drift the review flagged (e.g. `uint8arrays` declared `^5.1.0` in db-core while the root resolutions force `^6.1.1`).
