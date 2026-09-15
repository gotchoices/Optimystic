#!/usr/bin/env node
/**
 * Resolved-major guard — fails when a guarded package is *installed* at a major other than the one
 * this project is built on.
 *
 * libp2p components interoperate only when they were built against the same major of
 * `@libp2p/interface`, and nothing else in the toolchain notices when they were not. The package
 * manager installs a second copy beside ours and reports success, TypeScript does not reliably
 * object, and the test suite passes. `@chainsafe/libp2p-gossipsub@14` shipped that way here: built
 * against major 2 inside a major-3 tree, it threw on every message it sent (gotchoices/Optimystic#9).
 *
 * `yarn.config.cjs` could not have caught it. Yarn constraints see only the ranges our own workspaces
 * declare, and the offending range lived in gossipsub's manifest, one level down. This script asks
 * Yarn what actually resolved — every transitive dependency, and the portal-linked sibling
 * repositories — and checks the major of each resolution against `scripts/shared-majors.cjs`, the
 * one list both guards read.
 *
 * This file is only the shell-out: run `yarn info`, hand its output to the pure functions in
 * `scripts/libp2p-majors.mjs`, print, and set the exit code. Following `check-doc-citations.mjs`:
 * plain .mjs, no build step, no dependencies. Wired as half of `yarn lint:deps`, chained into
 * `yarn check`.
 */
import { execFileSync } from 'node:child_process';
import { argv, exit, stderr, stdout } from 'node:process';

import { checkResolvedMajors, parseYarnInfo, yarnInfoCommand } from './libp2p-majors.mjs';
// A default import, not a named one: Node infers a CommonJS module's named exports by scanning its
// source, and that inference fails for anything but the simplest `module.exports` shapes.
import sharedMajors from './shared-majors.cjs';

const { SHARED_MAJOR } = sharedMajors;

/** Yarn's stdout. On failure, throws with everything yarn said — its usage errors go to stdout, not stderr. */
function runYarn({ file, args }) {
	try {
		return execFileSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (err) {
		const said = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
		throw new Error([
			`\`yarn info\` failed (${err.status != null ? `exit ${err.status}` : err.code}), so the installed tree could not be checked.`,
			said ? `yarn said:\n${said.replace(/^(?=.)/gm, '  ')}` : 'yarn printed nothing.',
			'Likely causes: no `yarn install` has run; a sibling checkout that a portal: resolution needs',
			'(../quereus, ../Fret) is missing; or no package in scripts/shared-majors.cjs is installed at all,',
			'which yarn reports as "No package matched your request".'
		].join('\n'), { cause: err });
	}
}

function main() {
	const idents = Object.keys(SHARED_MAJOR);
	const resolutions = parseYarnInfo(runYarn(yarnInfoCommand(idents)));
	const { problems, message } = checkResolvedMajors(resolutions, SHARED_MAJOR);
	if (problems.length > 0) {
		stdout.write(message);
		exit(1);
	}
	stdout.write(`check-libp2p-majors: ${idents.length} guarded packages, ${resolutions.length} installed versions — each on its expected major.\n`);
}

if (argv.includes('--help') || argv.includes('-h')) {
	stdout.write('Usage: node scripts/check-libp2p-majors.mjs\n\n');
	stdout.write('Checks that every package listed in scripts/shared-majors.cjs is installed only at its\n');
	stdout.write('expected major, transitive dependencies included. Exits non-zero, naming the offending\n');
	stdout.write('versions and what pulls them in, when one is not. See AGENTS.md § Dependencies.\n');
	exit(0);
}

try {
	main();
} catch (err) {
	stderr.write(`check-libp2p-majors: ${err.message}\n`);
	exit(1);
}
