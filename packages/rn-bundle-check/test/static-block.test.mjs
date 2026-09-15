/**
 * The bundle stage refuses a class `static { }` block — the construct that broke a downstream React
 * Native app on 2026-09-14 — and its error names the file holding it.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundle, createOutputDir } from '../scripts/rn-bundle-check.mjs';

it('rejects a class static block at the bundle stage, naming the file', async (t) => {
	const outDir = createOutputDir();
	t.after(() => rmSync(outDir, { recursive: true, force: true }));

	await assert.rejects(
		bundle({ entry: fileURLToPath(new URL('./fixtures/static-block.js', import.meta.url)), outDir }),
		(error) => {
			assert.match(error.message, /static-block\.js/);
			assert.match(error.message, /Static class blocks are not enabled/);
			return true;
		}
	);
});
