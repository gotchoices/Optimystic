/**
 * metro.config.cjs aliases exactly the modules in the "Node.js built-in module shims" table of
 * packages/db-p2p/readme.md, in both spellings, plus the declared harness-only aliases. Drift either
 * way fails: a readme row the config lacks is a recipe this check no longer proves, and a config
 * alias the readme lacks is a gap every host app following the readme would hit.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'node:test';

const require = createRequire(import.meta.url);

const README = new URL('../../db-p2p/readme.md', import.meta.url);
const TABLE_HEADING = '**Node.js built-in module shims**';
/** Aliases metro.config.cjs adds that are deliberately not readme rows (see shims/react-native.js). */
const HARNESS_ONLY = ['react-native'];

/** Module names from the table's first column: "| `os` / `node:os` | ..." gives `os` and `node:os`. */
function readmeShimModules() {
	const lines = readFileSync(README, 'utf8').split(/\r?\n/);
	const heading = lines.findIndex((line) => line.startsWith(TABLE_HEADING));
	assert.notEqual(heading, -1, `packages/db-p2p/readme.md no longer has a ${TABLE_HEADING} table`);

	const rows = [];
	for (const line of lines.slice(heading + 1)) {
		if (line.startsWith('|')) rows.push(line);
		else if (rows.length > 0 || line.trim() !== '') break;
	}
	// rows[0] is the header row and rows[1] the `|---|` separator.
	return rows.slice(2).flatMap((row) => [...row.split('|')[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]));
}

it('aliases exactly the readme shim table, in both spellings, plus the harness-only aliases', () => {
	const modules = readmeShimModules();
	assert.ok(modules.length > 0, 'parsed no rows from the readme shim table');
	for (const name of modules.filter((module) => !module.startsWith('node:'))) {
		assert.ok(modules.includes(`node:${name}`), `the readme row for \`${name}\` omits its \`node:${name}\` spelling`);
	}

	const { resolver } = require('../metro.config.cjs');
	assert.deepEqual(
		Object.keys(resolver.extraNodeModules).sort(),
		[...modules, ...HARNESS_ONLY].sort(),
		'metro.config.cjs `extraNodeModules` and the readme shim table have drifted apart. Change them together ' +
			'(see the RULE at the top of metro.config.cjs).'
	);
});
