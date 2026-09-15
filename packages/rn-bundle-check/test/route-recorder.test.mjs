/**
 * The routing assertion judges where Metro actually resolved a specifier: one that lands on its
 * expected file passes, one that lands elsewhere is reported with both paths, and one the bundle never
 * imports is reported rather than silently left unchecked.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundle, createOutputDir, createRouteRecorder } from '../scripts/rn-bundle-check.mjs';

const TARGET = 'packages/rn-bundle-check/test/fixtures/routed-target.js';

it('passes a correct route and reports a wrong or unreached one', async (t) => {
	const outDir = createOutputDir();
	t.after(() => rmSync(outDir, { recursive: true, force: true }));

	const correct = createRouteRecorder(new Map([['./routed-target.js', TARGET]]));
	const wrong = createRouteRecorder(new Map([
		['./routed-target.js', 'packages/db-p2p/dist/src/rn.js'],
		['./never-imported.js', TARGET],
	]));
	await bundle({
		entry: fileURLToPath(new URL('./fixtures/routed.js', import.meta.url)),
		outDir,
		onResolve: (specifier, filePath) => {
			correct.onResolve(specifier, filePath);
			wrong.onResolve(specifier, filePath);
		},
	});

	assert.deepEqual([...correct.misroutes(), ...correct.unreached()], []);

	const misroutes = wrong.misroutes();
	assert.equal(misroutes.length, 1, misroutes.join('\n'));
	assert.match(misroutes[0], /^\.\/routed-target\.js resolved to packages\/rn-bundle-check\/test\/fixtures\/routed-target\.js instead of packages\/db-p2p\/dist\/src\/rn\.js\./);

	const unreached = wrong.unreached();
	assert.equal(unreached.length, 1, unreached.join('\n'));
	assert.match(unreached[0], /^\.\/never-imported\.js was never imported/);
});
