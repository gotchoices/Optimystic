/**
 * A Node built-in module with no row in the readme's shim table fails the bundle, and the error says
 * what to do about it rather than only "Unable to resolve".
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundle, createOutputDir } from '../scripts/rn-bundle-check.mjs';

it('fails to bundle an unshimmed Node built-in, pointing at the readme shim table', async (t) => {
	const outDir = createOutputDir();
	t.after(() => rmSync(outDir, { recursive: true, force: true }));

	await assert.rejects(
		bundle({ entry: fileURLToPath(new URL('./fixtures/node-builtin.js', import.meta.url)), outDir }),
		(error) => {
			assert.match(error.message, /Unable to resolve module node:path/);
			assert.match(error.message, /"node:path" is a Node built-in module/);
			assert.match(error.message, /Node\.js built-in module shims/);
			return true;
		}
	);
});
