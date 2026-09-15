/**
 * The compile stage catches syntax Metro's Babel preset lets through but legacy Hermes rejects, and
 * reports it against the original source file rather than only a position in the bundle.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundle, compile, createOutputDir, HermesCompileError } from '../scripts/rn-bundle-check.mjs';

it('bundles a v-flag regular expression, then fails it at hermesc with the source position', async (t) => {
	const outDir = createOutputDir();
	t.after(() => rmSync(outDir, { recursive: true, force: true }));

	const bundled = await bundle({ entry: fileURLToPath(new URL('./fixtures/unicode-sets-regex.js', import.meta.url)), outDir });

	assert.throws(() => compile(bundled), (error) => {
		assert.ok(error instanceof HermesCompileError, `expected a HermesCompileError, got: ${error}`);
		assert.notEqual(error.status, 0);
		assert.match(error.message, /Invalid regular expression/);
		// A bare `bundle.js:L:C` names no file anyone edits; the source map adds the fixture and its line.
		assert.match(error.message, /bundle\.js:\d+:\d+ \[packages\/rn-bundle-check\/test\/fixtures\/unicode-sets-regex\.js:5:\d+\]/);
		return true;
	});
});
