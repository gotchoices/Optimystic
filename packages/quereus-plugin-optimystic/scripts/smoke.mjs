#!/usr/bin/env node
/**
 * `test:smoke` — loads the built root entry under plain Node ESM (no TypeScript loader) and checks
 * that `QUEREUS_ENGINE_ID` names the installed `@quereus/quereus`.
 *
 * The mocha suite runs through `ts-node/esm`, which resolves differently from what a consumer's Node
 * does. A plain import is the check that `dist/index.js` loads at all for a consumer. Comparing the id
 * to the installed version, rather than only its format, fails a `dist` built against an older Quereus.
 */

import process from 'node:process';
import { installedQuereusVersion } from './write-quereus-version.mjs';

const REBUILD = 'yarn workspace @optimystic/quereus-plugin-optimystic build';

try {
	const { QUEREUS_ENGINE_ID } = await import('../dist/index.js');
	const expected = `quereus@${installedQuereusVersion()}`;
	if (QUEREUS_ENGINE_ID !== expected) {
		console.error(`smoke: dist/index.js has QUEREUS_ENGINE_ID ${QUEREUS_ENGINE_ID}, but the installed Quereus is ${expected}. Run \`${REBUILD}\`.`);
		process.exit(1);
	}
	console.log('smoke ok', QUEREUS_ENGINE_ID);
} catch (error) {
	console.error('smoke: importing dist/index.js threw', error?.code ?? error?.message ?? error);
	process.exit(1);
}
