/**
 * Which `hermesc` binary each platform gets. Only the Windows binary has been run end to end (see the
 * NOTE on `hermescBinary`); this pins the Linux and macOS choices to the installed package's layout, so
 * a `hermes-compiler` upgrade that moves them fails here instead of on someone's first Linux run.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { it } from 'node:test';

import { hermescBinary } from '../scripts/rn-bundle-check.mjs';

const require = createRequire(import.meta.url);

const SUPPORTED = [
	['win32', 'x64', join('hermesc', 'win64-bin', 'hermesc.exe')],
	['linux', 'x64', join('hermesc', 'linux64-bin', 'hermesc')],
	['darwin', 'arm64', join('hermesc', 'osx-bin', 'hermesc')],
	['darwin', 'x64', join('hermesc', 'osx-bin', 'hermesc')],
];

it('picks a binary the installed hermes-compiler actually ships, for each supported platform', () => {
	const packageDir = dirname(require.resolve('hermes-compiler/package.json'));
	for (const [platform, arch, expected] of SUPPORTED) {
		assert.equal(hermescBinary(platform, arch), expected);
		assert.ok(existsSync(join(packageDir, expected)), `hermes-compiler has no ${expected} for ${platform}-${arch}`);
	}
});

it('refuses a platform with no binary instead of skipping the check', () => {
	assert.throws(() => hermescBinary('linux', 'arm64'), /no hermesc for linux-arm64/);
	assert.throws(() => hermescBinary('freebsd', 'x64'), /no hermesc for freebsd-x64/);
});
