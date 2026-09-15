/**
 * Tests for the resolved-major guard's pure half (`scripts/libp2p-majors.mjs`), run by node's
 * built-in test runner (`yarn test:harness` at the repository root). The guard itself —
 * `scripts/check-libp2p-majors.mjs`, which runs yarn and sets the exit code — is not imported here.
 *
 * Every input is a hand-built resolution list or a literal line of `yarn info` output, so no test
 * invokes yarn and the suite needs no install. The versions and dependents are drawn from this
 * repository's real tree — including the `@libp2p/peer-id-factory` rows that were the last
 * cross-major dependency here before the guard landed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	checkResolvedMajors,
	describeLocator,
	majorOf,
	parseYarnInfo,
	yarnInfoCommand
} from '../scripts/libp2p-majors.mjs';
import sharedMajors from '../scripts/shared-majors.cjs';

const { SHARED_MAJOR } = sharedMajors;
const EXPECTED = { '@libp2p/interface': 3 };

/** One resolved version of `ident`, pulled in by `dependents` (raw Yarn locators). */
function resolution(ident, version, ...dependents) {
	return { ident, version, dependents };
}

/** The shape of this tree's `@libp2p/interface` rows: one major, three minors. */
const HEALTHY_INTERFACE = [
	resolution('@libp2p/interface', '3.1.0', 'libp2p@npm:3.1.3', '@libp2p/identify@npm:4.0.10', '@optimystic/db-p2p@workspace:packages/db-p2p'),
	resolution('@libp2p/interface', '3.2.3', '@libp2p/autonat@npm:3.0.21', '@libp2p/dcutr@npm:3.0.21'),
	resolution('@libp2p/interface', '3.2.4', '@optimystic/db-core@workspace:packages/db-core')
];

/** How `yarn info` really reports the portal-linked FRET checkout as a dependent. */
const PORTAL_FRET = 'p2p-fret@virtual:690d261bb1d9ef8baf7cb8fc1cbaf89411836dd704328ab837e27d1d46056be0c655755061b05135a46290d27d7d20b23fe470cf1265ff2486d004acfba1b02b#portal:../Fret/packages/fret::locator=%40optimystic%2Foptimystic%40workspace%3A.';

/** The report for a healthy tree plus one 2.x copy of `@libp2p/interface` pulled in by `dependents`. */
function reportWithMajorTwo(...dependents) {
	return checkResolvedMajors([...HEALTHY_INTERFACE, resolution('@libp2p/interface', '2.10.0', ...dependents)], EXPECTED).message;
}

describe('checkResolvedMajors', () => {
	it('passes several versions that share the expected major', () => {
		const { problems, message } = checkResolvedMajors(HEALTHY_INTERFACE, EXPECTED);

		assert.deepEqual(problems, []);
		assert.equal(message, '');
	});

	it('reports a second major, and names the dependents that pull it in', () => {
		const { problems, message } = checkResolvedMajors([
			...HEALTHY_INTERFACE,
			resolution('@libp2p/interface', '1.7.0', '@libp2p/crypto@npm:4.1.9', '@libp2p/peer-id-factory@npm:4.2.4')
		], EXPECTED);

		assert.equal(problems.length, 1);
		assert.equal(problems[0].kind, 'wrong-major');
		assert.match(message, /^@libp2p\/interface resolves to 2 majors in this project; expected only major 3\.$/m);
		assert.match(message, /^ {2}major 3 \(expected\)$/m);
		assert.match(message, /^ {2}major 1 \(UNEXPECTED\)$/m);
		// A version number alone gives the reader nothing to act on; what matters is who asked for it.
		assert.match(message, /^ {4}1\.7\.0 +@libp2p\/crypto@4\.1\.9, @libp2p\/peer-id-factory@4\.2\.4$/m);
	});

	it('reports a tree that sits wholly on a major other than the expected one', () => {
		// A "more than one distinct major" rule would pass this, which is why the major is declared.
		const { problems, message } = checkResolvedMajors([
			resolution('@libp2p/interface', '4.0.0', 'libp2p@npm:4.0.0'),
			resolution('@libp2p/interface', '4.1.2', '@libp2p/identify@npm:5.0.0')
		], EXPECTED);

		assert.equal(problems.length, 1);
		assert.match(message, /^@libp2p\/interface resolves only to major 4 in this project; expected major 3\.$/m);
		assert.match(message, /^ {2}major 4 \(UNEXPECTED\)$/m);
	});

	it('fails, calling the list stale, when a guarded package is not installed at all', () => {
		const { problems, message } = checkResolvedMajors(HEALTHY_INTERFACE, { ...EXPECTED, '@libp2p/no-longer-used': 2 });

		assert.deepEqual(problems, [{ kind: 'not-installed', ident: '@libp2p/no-longer-used', expected: 2 }]);
		assert.match(message, /^@libp2p\/no-longer-used is guarded by scripts\/shared-majors\.cjs \(expected major 2\), but is not installed/m);
		assert.match(message, /The list is stale\./);
	});

	it('reads an empty answer from yarn as every package missing, never as a clean tree', () => {
		const { problems } = checkResolvedMajors(parseYarnInfo(''), { '@libp2p/interface': 3, '@libp2p/crypto': 5 });

		assert.deepEqual(problems.map((p) => p.kind), ['not-installed', 'not-installed']);
	});

	it('reports a version it cannot read as semver rather than skipping it', () => {
		const { problems, message } = checkResolvedMajors([
			...HEALTHY_INTERFACE,
			resolution('@libp2p/interface', 'latest', 'some-fork@npm:1.0.0')
		], EXPECTED);

		assert.equal(problems.length, 1);
		assert.match(message, /^ {2}a version that is not semver \(UNEXPECTED\)$/m);
		assert.match(message, /some-fork@1\.0\.0/);
	});

	it('judges each guarded package on its own and ignores packages it does not guard', () => {
		const { problems } = checkResolvedMajors([
			...HEALTHY_INTERFACE,
			resolution('@libp2p/crypto', '5.1.13', 'libp2p@npm:3.1.3'),
			resolution('@libp2p/crypto', '4.1.9', '@libp2p/peer-id-factory@npm:4.2.4'),
			// Split across two majors on purpose in this tree, and deliberately not guarded.
			resolution('multiformats', '13.4.1', 'libp2p@npm:3.1.3'),
			resolution('multiformats', '14.0.0', '@libp2p/crypto@npm:5.1.19')
		], { '@libp2p/interface': 3, '@libp2p/crypto': 5 });

		assert.deepEqual(problems.map((p) => p.ident), ['@libp2p/crypto']);
	});
});

describe('majorOf', () => {
	it('reads the major of a prerelease or a build-tagged version', () => {
		assert.equal(majorOf('3.2.4-rc.1'), 3);
		assert.equal(majorOf('3.2.4+build.5'), 3);
	});

	it('reads a multi-digit major whole', () => {
		assert.equal(majorOf('10.0.0'), 10);
	});

	it('returns null for anything that is not a semver version', () => {
		for (const version of ['', 'latest', '3', '3.2', 'v3.2.4', 'workspace:^']) {
			assert.equal(majorOf(version), null, version);
		}
	});
});

describe('the failure report', () => {
	it('renders workspace, portal and virtual locators the way a reader would write them', () => {
		const message = reportWithMajorTwo(
			'@optimystic/db-p2p@workspace:packages/db-p2p',
			PORTAL_FRET,
			'@chainsafe/libp2p-gossipsub@virtual:abc123#npm:14.1.2'
		);

		assert.match(message, /^ {4}2\.10\.0 +@optimystic\/db-p2p \(workspace\), p2p-fret \(portal:\.\.\/Fret\/packages\/fret\), @chainsafe\/libp2p-gossipsub@14\.1\.2$/m);
		assert.ok(!message.includes('virtual:'), message);
		assert.ok(!message.includes('%40'), message);
	});

	it('lists our own workspaces ahead of third-party dependents', () => {
		const message = reportWithMajorTwo('libp2p@npm:3.1.3', '@optimystic/db-core@workspace:packages/db-core');

		assert.match(message, /^ {4}2\.10\.0 +@optimystic\/db-core \(workspace\), libp2p@3\.1\.3$/m);
	});

	it('names three dependents per version under the expected major, and ten under an unexpected one', () => {
		const many = Array.from({ length: 27 }, (_, i) => `@libp2p/pkg-${i}@npm:1.0.0`);
		const { message } = checkResolvedMajors([
			resolution('@libp2p/interface', '3.1.0', ...many),
			resolution('@libp2p/interface', '2.10.0', ...many)
		], EXPECTED);

		assert.match(message, /^ {4}3\.1\.0 +@libp2p\/pkg-0@1\.0\.0, @libp2p\/pkg-1@1\.0\.0, @libp2p\/pkg-2@1\.0\.0, \+24 more$/m);
		assert.match(message, /^ {4}2\.10\.0 +(?:@libp2p\/pkg-\d+@1\.0\.0, ){10}\+17 more$/m);
	});

	it('suggests `yarn why` for the offending package', () => {
		assert.match(reportWithMajorTwo('x@npm:1.0.0'), /^ {2}yarn why @libp2p\/interface +#/m);
	});

	it('says the check does not cover the libp2p version a remote peer runs', () => {
		// Gossipsub's failure arrived over a connection. A green run must not be read as "a major
		// mismatch cannot reach us": a peer on another build has a lockfile no check here can see.
		const flat = reportWithMajorTwo('x@npm:1.0.0').replace(/\s+/g, ' ');

		assert.ok(flat.includes('this guard covers packages resolved inside THIS workspace, including portal-linked sibling repositories.'), flat);
		assert.ok(flat.includes('It says NOTHING about the libp2p version running on the other end of a live connection'), flat);
	});
});

describe('describeLocator', () => {
	it('drops the protocol from a registry locator', () => {
		assert.equal(describeLocator('@libp2p/crypto@npm:4.1.9'), '@libp2p/crypto@4.1.9');
		assert.equal(describeLocator('libp2p@npm:3.1.3'), 'libp2p@3.1.3');
	});

	it('labels a workspace, including the root one', () => {
		assert.equal(describeLocator('@optimystic/db-core@workspace:packages/db-core'), '@optimystic/db-core (workspace)');
		assert.equal(describeLocator('@optimystic/optimystic@workspace:.'), '@optimystic/optimystic (workspace)');
	});

	it('unwraps a virtual portal and drops its encoded binding', () => {
		assert.equal(describeLocator(PORTAL_FRET), 'p2p-fret (portal:../Fret/packages/fret)');
	});

	it('labels a patched package without printing its patch path', () => {
		assert.equal(describeLocator('left-pad@patch:left-pad@npm%3A1.3.0#~/.yarn/patches/left-pad.patch::version=1.3.0&hash=abc'), 'left-pad (patched)');
	});

	it('returns a string that is not a locator unchanged', () => {
		assert.equal(describeLocator('not a locator'), 'not a locator');
	});
});

describe('parseYarnInfo', () => {
	it('reads the ident, version and dependents from each line', () => {
		const text = [
			JSON.stringify({ value: '@libp2p/interface@npm:3.1.0', children: { Version: '3.1.0', Dependents: ['libp2p@npm:3.1.3'], Dependencies: [] } }),
			'',
			JSON.stringify({ value: 'uint8arrays@npm:6.1.1', children: { Version: '6.1.1', Dependents: [PORTAL_FRET] } })
		].join('\r\n') + '\r\n';

		assert.deepEqual(parseYarnInfo(text), [
			{ ident: '@libp2p/interface', version: '3.1.0', dependents: ['libp2p@npm:3.1.3'] },
			{ ident: 'uint8arrays', version: '6.1.1', dependents: [PORTAL_FRET] }
		]);
	});

	it('takes the version from the manifest field, since a portal reference carries none', () => {
		const text = JSON.stringify({ value: 'p2p-fret@portal:../Fret/packages/fret::locator=%40optimystic%2Foptimystic%40workspace%3A.', children: { Version: '0.4.2' } });

		assert.deepEqual(parseYarnInfo(text), [{ ident: 'p2p-fret', version: '0.4.2', dependents: [] }]);
	});

	it('throws on a line that is not JSON rather than skipping it', () => {
		assert.throws(
			() => parseYarnInfo('! Corepack is about to download https://repo.yarnpkg.com/4.12.0/packages/yarnpkg-cli/bin/yarn.js\n'),
			/not JSON/
		);
	});

	it('throws on a record with no version', () => {
		assert.throws(
			() => parseYarnInfo(JSON.stringify({ value: '@libp2p/interface@npm:3.1.0', children: {} })),
			/does not understand/
		);
	});
});

describe('yarnInfoCommand', () => {
	const idents = ['@libp2p/interface', 'uint8arrays'];
	const yarnArgs = ['info', '--all', '--recursive', '--json', '--dependents', ...idents];

	it('runs yarn directly where it is a real executable', () => {
		assert.deepEqual(yarnInfoCommand(idents, 'linux'), { file: 'yarn', args: yarnArgs });
	});

	it('routes through cmd.exe on Windows, keeping every argument separate', () => {
		// There `yarn` is a .cmd shim, which Node refuses to spawn without going through a shell.
		const { file, args } = yarnInfoCommand(idents, 'win32');

		assert.match(file, /cmd\.exe$/i);
		assert.deepEqual(args, ['/d', '/s', '/c', 'yarn', ...yarnArgs]);
	});

	it('refuses an ident that is not a package name', () => {
		assert.throws(() => yarnInfoCommand(['@libp2p/interface & calc'], 'win32'), /is not a package name/);
	});
});

describe('this repository', () => {
	it('declares a well-formed list of guarded packages', () => {
		const entries = Object.entries(SHARED_MAJOR);

		assert.ok(entries.length > 0);
		assert.doesNotThrow(() => yarnInfoCommand(entries.map(([ident]) => ident), 'win32'));
		for (const [ident, major] of entries) {
			assert.ok(Number.isInteger(major) && major >= 0, `${ident}: ${major}`);
		}
	});
});
