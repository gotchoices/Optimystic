import { register } from 'node:module';
import { assertBuildFresh } from '../../test-harness/build-freshness.mjs';

// Refuses the run when a dependency's `dist` is older than its `src` — see that module's header.
assertBuildFresh(import.meta.url);

register('ts-node/esm', import.meta.url);
