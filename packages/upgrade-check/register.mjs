import { register } from 'node:module';
import { assertBuildFresh } from '../../test-harness/build-freshness.mjs';

// Refuses the run when a dependency's `dist` is older than its `src` — see that module's header.
// Load-bearing here more than anywhere: the "new build" this suite restarts over old data IS the
// sibling workspaces' `dist`, so a stale build would test an upgrade to code that is no longer on disk.
assertBuildFresh(import.meta.url);

register('ts-node/esm', import.meta.url);
