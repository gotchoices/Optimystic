/**
 * The routing assertion judges where Metro actually resolved a specifier: one that lands on its
 * expected file passes, one that lands elsewhere is reported with both paths, and one the bundle never
 * imports is reported rather than silently left unchecked. Every importer's resolution is judged, so a
 * second importer landing elsewhere is reported even when the first landed right.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundle, createOutputDir, createRouteRecorder } from '../scripts/rn-bundle-check.mjs';

const FIXTURES = 'packages/rn-bundle-check/test/fixtures';
const TARGET = `${FIXTURES}/routed-target.js`;
const NESTED_TARGET = `${FIXTURES}/nested/routed-target.js`;

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
		onResolve: (...resolution) => {
			correct.onResolve(...resolution);
			wrong.onResolve(...resolution);
		},
	});

	assert.deepEqual([...correct.misroutes(), ...correct.unreached()], []);

	const misroutes = wrong.misroutes();
	assert.equal(misroutes.length, 1, misroutes.join('\n'));
	assert.match(misroutes[0], /^\.\/routed-target\.js resolved to packages\/rn-bundle-check\/test\/fixtures\/routed-target\.js \(imported by packages\/rn-bundle-check\/test\/fixtures\/routed\.js\) instead of packages\/db-p2p\/dist\/src\/rn\.js\./);

	const unreached = wrong.unreached();
	assert.equal(unreached.length, 1, unreached.join('\n'));
	assert.match(unreached[0], /^\.\/never-imported\.js was never imported/);
});

// entry.js and the Quereus plugin both import bare `@optimystic/db-p2p`. Metro resolves a specifier
// once per importing directory, and the plugin's import must be judged even though entry.js's
// resolution of the same specifier is right. Each recorder expects one of the two resolutions, so a
// recorder that kept only the first (or only the last) resolution per specifier fails one of them,
// whichever order Metro resolves them in.
it('judges every importer of a specifier, not only the first', async (t) => {
	const outDir = createOutputDir();
	t.after(() => rmSync(outDir, { recursive: true, force: true }));

	const expectsTop = createRouteRecorder(new Map([['./routed-target.js', TARGET]]));
	const expectsNested = createRouteRecorder(new Map([['./routed-target.js', NESTED_TARGET]]));
	await bundle({
		entry: fileURLToPath(new URL('./fixtures/routed-twice.js', import.meta.url)),
		outDir,
		onResolve: (...resolution) => {
			expectsTop.onResolve(...resolution);
			expectsNested.onResolve(...resolution);
		},
	});

	assertOneMisroute(expectsTop, `./routed-target.js resolved to ${NESTED_TARGET} (imported by ${FIXTURES}/nested/routed.js) instead of ${TARGET}.`);
	assertOneMisroute(expectsNested, `./routed-target.js resolved to ${TARGET} (imported by ${FIXTURES}/routed-twice.js) instead of ${NESTED_TARGET}.`);
});

function assertOneMisroute(recorder, expectedStart) {
	const misroutes = recorder.misroutes();
	assert.equal(misroutes.length, 1, misroutes.join('\n'));
	assert.ok(misroutes[0].startsWith(expectedStart), misroutes[0]);
	assert.deepEqual(recorder.unreached(), []);
}
