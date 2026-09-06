import { register } from 'node:module';
import { assertBuildFresh } from '../../test-harness/build-freshness.mjs';

// Refuses the run when a dependency's `dist` is older than its `src` — see that module's header.
// `checkSelf` because this package's own specs import `../dist/...` directly, so its own build has
// to be current too.
assertBuildFresh(import.meta.url, { checkSelf: true });

register('ts-node/esm', import.meta.url);
