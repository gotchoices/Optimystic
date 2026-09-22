/**
 * Tests for the post-publish wait's pure half (`scripts/published-visibility.mjs`), run by node's
 * built-in test runner (`yarn test:harness` at the repository root). The wait itself —
 * `scripts/await-published.mjs`, which runs yarn and npm and sets the exit code — is not imported here.
 *
 * No test touches the network: the `yarn workspaces list` lines and `npm view` outputs below are
 * copied from real runs against this repository and the public registry, and the registry question
 * the wait asks is injected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	NOT_YET_VISIBLE,
	expectedPackages,
	npmViewCommand,
	parseWorkspaceList,
	readViewAnswer,
	waitForVisibility
} from '../scripts/published-visibility.mjs';

const CORE = { name: '@optimystic/db-core', version: '1.3.0' };
const P2P = { name: '@optimystic/db-p2p', version: '1.3.0' };
const PLUGIN = { name: '@optimystic/quereus-plugin-optimystic', version: '1.3.0' };

describe('expectedPackages', () => {
	it('pairs each listed workspace with the version in its own manifest', () => {
		const listing = [
			'{"location":"packages/db-core","name":"@optimystic/db-core"}',
			'{"location":"packages/db-p2p","name":"@optimystic/db-p2p"}',
			''
		].join('\r\n');
		const manifests = { 'packages/db-core': { version: '1.3.0' }, 'packages/db-p2p': { version: '1.3.0' } };

		assert.deepEqual(expectedPackages(parseWorkspaceList(listing), (location) => manifests[location]), [CORE, P2P]);
	});
});

describe('npmViewCommand', () => {
	it('refuses a version carrying a character cmd.exe would interpret', () => {
		assert.throws(() => npmViewCommand({ name: CORE.name, version: '1.3.0&calc' }, 'win32'), /is not a version/);
	});
});

describe('readViewAnswer', () => {
	const E404 = JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 1.3.0' } }, null, 2);

	it('counts the version echoed back as visible', () => {
		assert.deepEqual(readViewAnswer({ status: 0, stdout: '"1.3.0"\n', stderr: '' }, CORE), { visible: true });
	});

	it('counts both ways npm says a version is not there as not yet visible', () => {
		// Current npm: exit 1 with an E404 object. Older npm: exit 0 and no output.
		assert.deepEqual(readViewAnswer({ status: 1, stdout: E404, stderr: 'npm error code E404' }, CORE), { visible: false, reason: NOT_YET_VISIBLE });
		assert.deepEqual(readViewAnswer({ status: 0, stdout: '', stderr: '' }, CORE), { visible: false, reason: NOT_YET_VISIBLE });
	});

	it('keeps npm\'s own summary for any other failure', () => {
		const refused = JSON.stringify({ error: { code: 'ECONNREFUSED', summary: 'FetchError: request to http://127.0.0.1:9/@optimystic%2fdb-core failed' } });

		const answer = readViewAnswer({ status: 1, stdout: refused, stderr: '' }, CORE);

		assert.equal(answer.visible, false);
		assert.match(answer.reason, /^npm view failed with ECONNREFUSED: FetchError/);
	});

	it('throws on an answer to some other question rather than reading past it', () => {
		assert.throws(() => readViewAnswer({ status: 0, stdout: '"1.2.0"', stderr: '' }, CORE), /does not understand/);
		assert.throws(() => readViewAnswer({ status: 0, stdout: 'npm notice New major version', stderr: '' }, CORE), /not JSON/);
	});
});

/**
 * A wait over a fake clock: `sleep` advances it, and `probe` answers from `script` — for each package,
 * one answer per round in which it is asked, repeating the last.
 */
async function scriptedWait(script, { timeoutMs = 60_000, intervalMs = 5_000 } = {}) {
	let clock = 0;
	const asked = [];
	const stragglers = await waitForVisibility({
		expected: Object.keys(script).map((name) => ({ name, version: '1.3.0' })),
		probe: async (spec) => {
			const answers = script[spec.name];
			const askedBefore = asked.filter((entry) => entry.name === spec.name).length;
			asked.push({ name: spec.name, at: clock });
			return answers[Math.min(askedBefore, answers.length - 1)];
		},
		timeoutMs,
		intervalMs,
		now: () => clock,
		sleep: async (ms) => { clock += ms; }
	});
	return { stragglers, asked, clock };
}

const SEEN = { visible: true };
const NOT_YET = { visible: false, reason: NOT_YET_VISIBLE };

describe('waitForVisibility', () => {
	it('finishes once every package has been seen, asking again only about the ones not yet seen', async () => {
		const { stragglers, asked, clock } = await scriptedWait({
			[CORE.name]: [NOT_YET, NOT_YET, SEEN],
			[P2P.name]: [NOT_YET, SEEN],
			[PLUGIN.name]: [SEEN]
		});

		assert.deepEqual(stragglers, []);
		assert.equal(clock, 10_000);
		assert.deepEqual(asked.map(({ name }) => name).sort(), [CORE.name, CORE.name, CORE.name, P2P.name, P2P.name, PLUGIN.name].sort());
	});

	it('gives up at the deadline, after one last round, naming each straggler with its latest reason', async () => {
		const refused = { visible: false, reason: 'npm view failed with ECONNREFUSED' };

		const { stragglers, asked } = await scriptedWait({
			[CORE.name]: [SEEN],
			[P2P.name]: [NOT_YET, refused]
		}, { timeoutMs: 12_000 });

		assert.deepEqual(stragglers, [{ spec: P2P, reason: refused.reason }]);
		assert.deepEqual(asked.filter(({ name }) => name === P2P.name).map(({ at }) => at), [0, 5_000, 10_000, 12_000]);
	});
});
