// Fixture for test/route-recorder.test.mjs: imports `./routed-target.js` itself and through
// nested/routed.js, where the same specifier lands on a different file.

export { routed } from './routed-target.js';
export { routed as nestedRouted } from './nested/routed.js';
