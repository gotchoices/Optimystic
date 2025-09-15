# @optimystic/fret

FRET (Finger Ring Ensemble Topology) overlay and tests for Optimystic.

## Test infrastructure

This package uses Aegir for build/lint/test. Tests include:

- Unit tests under `test/**/*.spec.ts`
- Optional mesh sanity test `test/mesh.sanity.spec.ts` that spins up a small mesh using `@optimystic/test-peer` CLI and performs a diary roundtrip.

### Prerequisites

- Build peer packages so the CLI is available:

```bash
# from repo root
yarn workspace @optimystic/db-core build
yarn workspace @optimystic/db-p2p build
yarn workspace @optimystic/test-peer build
```

### Run tests

```bash
# unit tests (Node)
yarn workspace @optimystic/fret test:node
```

The mesh sanity spec is currently skipped by default. To try it locally:

```bash
# un-skip in test/mesh.sanity.spec.ts by removing `.skip`
# then run
DEBUG=optimystic:* yarn workspace @optimystic/fret test:node
```

Notes:
- The mesh helper writes node info to `.mesh-tests/` and cleans up child processes on exit.
- Uses in-repo CLI at `packages/test-peer/dist/cli.js`, so ensure it’s built first.