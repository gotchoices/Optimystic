----
description: The project has eleven near-identical TypeScript configuration files that have quietly drifted apart, causing subtle per-package build inconsistencies; design a single shared base they all extend.
prereq:
files: packages/db-core/tsconfig.json, packages/db-p2p/tsconfig.json, packages/db-p2p-storage-fs/tsconfig.json, packages/db-p2p-storage-ns/tsconfig.json, packages/db-p2p-storage-rn/tsconfig.json, packages/db-p2p-storage-web/tsconfig.json, packages/reference-peer/tsconfig.json, packages/quereus-plugin-optimystic/tsconfig.json, packages/quereus-plugin-crypto/tsconfig.json, packages/substrate-simulator/tsconfig.json, packages/demo/tsconfig.json
difficulty: medium
----

Review finding eh-3, tsconfig portion (docs/review.html, Section 9 "Cross-cutting engineering health").

There are eleven copy-pasted `tsconfig.json` files across the packages, and they have visibly drifted:

- `db-p2p-storage-fs` is missing `downlevelIteration` that its siblings have.
- Module resolution is inconsistent (`NodeNext` vs `Node16`).
- `db-core`'s config carries a byte-order mark (BOM).

Expected end state: a single `tsconfig.base.json` at the repository root holds the shared compiler options, and each package's `tsconfig.json` extends it and declares only its genuinely package-specific settings (paths, `outDir`, references). The drift items above are resolved in the base. The plan should also settle whether to adopt two stricter options the review raised — `verbatimModuleSyntax` and `exactOptionalPropertyTypes` (currently enabled in no package) — either turning them on in the base or documenting why not, since flipping `exactOptionalPropertyTypes` in particular can surface new type errors that must be triaged.

## Edge cases & interactions

- Turning on `exactOptionalPropertyTypes` and/or `verbatimModuleSyntax` in the shared base may break compilation in some packages; the plan must decide whether to enable now (and fix the fallout as part of the work), enable behind a follow-up ticket, or defer with a documented rationale — not leave it ambiguous for the implementer.
- Standardizing module resolution (`NodeNext` vs `Node16`) must not change emitted module semantics for any package; verify each package still builds and its emitted output resolves the same.
- Per-package `outDir`, project `references`, and any `paths` must be preserved when factoring shared options up into the base; a package that silently loses its `outDir` will emit into the wrong place.
- Removing the BOM from db-core's config must not disturb tooling that reads it.
- Confirm every package's build still passes after extending the base, including the ones (storage-fs, storage-rn) that are easy to overlook because they are excluded from parts of the root script chain.
