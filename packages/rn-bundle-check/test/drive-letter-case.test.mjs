/**
 * `yarn check:rn` gives the same answer however the shell spells the drive. metro-file-map compares
 * path prefixes case-sensitively, so any path reaching Metro under `c:` beside others under `C:` splits
 * its file map: started from a lowercase-drive cwd, the check failed with "Unable to resolve module
 * p2p-fret".
 */

import { rmSync } from 'node:fs';
import process from 'node:process';
import { it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'only Windows paths carry a drive letter' };

// From a lowercase cwd, `yarn` loads the script under the lowercase spelling. Metro's defaults then
// hold paths Metro resolved from its own location, and every bundle starts with one of them (Metro's
// module-system polyfill), so any entry fails unless Metro itself was loaded canonically.
it('bundles when the script and the entry are spelled with a lowercase drive letter', WINDOWS_ONLY, async (t) => {
	const script = lowercaseDrive(fileURLToPath(new URL('../scripts/rn-bundle-check.mjs', import.meta.url)));
	// A URL spelled differently is a separate module instance, so this is the script as such a run loads it.
	const { bundle, createOutputDir } = await import(pathToFileURL(script).href);
	const outDir = createOutputDir();
	t.after(() => rmSync(outDir, { recursive: true, force: true }));

	await bundle({ entry: lowercaseDrive(fileURLToPath(new URL('./fixtures/routed-target.js', import.meta.url))), outDir });
});

function lowercaseDrive(path) {
	return path[0].toLowerCase() + path.slice(1);
}
