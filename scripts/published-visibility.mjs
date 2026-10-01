/**
 * The pure half of the post-publish wait: which packages a release publishes, what `npm view` and a
 * request for each package's tarball said about it, and when to stop asking.
 *
 * Nothing here runs a command, reads a file or exits. `scripts/await-published.mjs` does that, and is
 * the place to read about why the wait exists. The two are separate files for the reason
 * `scripts/libp2p-majors.mjs` gives: the tests (`test-harness/published-visibility.test.mjs`) import
 * these functions without the entry script having to work out whether it was run directly.
 */
import { PACKAGE_NAME_RE, cliCommand } from './cli-command.mjs';

/**
 * @typedef {object} PackageSpec  One package a release publishes, at the version it publishes.
 * @property {string} name     e.g. `@optimystic/db-core`
 * @property {string} version  e.g. `1.3.0`
 *
 * @typedef {{ listed: true, tarball: string } | { listed: false, reason: string }} ViewAnswer
 *   What `npm view` said: the registry lists the version, with the URL its tarball is served from.
 *
 * @typedef {{ visible: true } | { visible: false, reason: string }} Visibility
 *   Whether a package counts as published: listed, and its tarball downloadable.
 *
 * @typedef {object} Straggler  A package the registry did not yet show at its version.
 * @property {PackageSpec} spec
 * @property {string} reason  Why it counts as not visible, from the most recent answer.
 *
 * @typedef {object} Progress
 * @property {Straggler[]} stragglers
 * @property {number} total      How many packages the wait is for.
 * @property {number} elapsedMs
 */

/** The reason given for a package the registry simply does not list at its version yet. */
export const NOT_YET_VISIBLE = 'not on the registry yet';

/** The reason given for a package the registry lists, but whose tarball it does not serve yet. */
export const TARBALL_NOT_YET_DOWNLOADABLE = 'tarball not downloadable yet';

/** Semver, restricted to the characters semver allows — none of which cmd.exe interprets. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** How long one registry request — npm's, or the tarball check — may take before it counts as failed. */
export const FETCH_TIMEOUT_MS = 30_000;

/** `name@version`, the form npm takes and the form every report prints. */
export function specString({ name, version }) {
	return `${name}@${version}`;
}

// -- Which packages ------------------------------------------------------------------------------

/** The workspace listing, with the same `--no-private` filter `yarn pub` publishes under. */
export const WORKSPACE_LIST_ARGS = ['workspaces', 'list', '--json', '--no-private'];

/**
 * Parse `yarn workspaces list --json` output: NDJSON, one `{ location, name }` record per workspace.
 * Anything else throws, for the reason `parseYarnInfo` in `scripts/libp2p-majors.mjs` gives.
 *
 * @param {string} text
 * @returns {{ name: string, location: string }[]}
 */
export function parseWorkspaceList(text) {
	return text.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
		let record;
		try {
			record = JSON.parse(line);
		} catch (err) {
			throw new Error(`yarn workspaces list printed a line that is not JSON: ${line}`, { cause: err });
		}
		if (typeof record?.name !== 'string' || typeof record?.location !== 'string') {
			throw new Error(`yarn workspaces list printed a record this script does not understand: ${line}`);
		}
		return { name: record.name, location: record.location };
	});
}

/**
 * Each listed workspace at the version its own manifest names — the version `npm publish` reads, so
 * after `yarn bump` it is the version the release just published.
 *
 * @param {{ name: string, location: string }[]} workspaces
 * @param {(location: string) => { version?: unknown }} manifestAt  The parsed `package.json` at a location.
 * @returns {PackageSpec[]}
 */
export function expectedPackages(workspaces, manifestAt) {
	// An empty list would otherwise "succeed" at once, printing the release-finished line over nothing.
	if (workspaces.length === 0) throw new Error('yarn workspaces list named no public workspace to wait for');
	return workspaces.map(({ name, location }) => {
		const { version } = manifestAt(location);
		if (typeof version !== 'string' || !VERSION_RE.test(version)) {
			throw new Error(`${location}/package.json names no publishable version (found ${JSON.stringify(version)})`);
		}
		return { name, version };
	});
}

// -- Asking npm ----------------------------------------------------------------------------------

/**
 * The `npm view` call that asks the registry for exactly `spec`, and for the URL of its tarball.
 * Going through npm, rather than fetching from a registry URL, answers with the npm configuration
 * `npm publish` used — registry, scopes, credentials. `--prefer-online` makes npm revalidate its
 * local metadata cache instead of answering from it: the question is what the registry serves now.
 * The fetch flags make one call one bounded request: the wait already asks again every few seconds,
 * and npm's own defaults (two retries, five minutes each) would let a single stalled call outlast the
 * whole deadline.
 *
 * NOTE: `npm view` reads the registry's full metadata document for a package. Installers usually read
 * the abbreviated one (`application/vnd.npm.install-v1+json`), which the registry caches separately,
 * so the two could briefly disagree. If a downstream upgrade is ever seen to resolve an old version
 * after this wait reported success, ask for the abbreviated document too.
 *
 * @param {PackageSpec} spec
 * @param {string} [os]  `process.platform`, injectable for tests.
 */
export function npmViewCommand(spec, os) {
	if (!PACKAGE_NAME_RE.test(spec.name)) throw new Error(`${JSON.stringify(spec.name)} is not a package name`);
	if (!VERSION_RE.test(spec.version)) throw new Error(`${JSON.stringify(spec.version)} is not a version`);
	return cliCommand('npm', ['view', '--prefer-online', '--fetch-retries=0', `--fetch-timeout=${FETCH_TIMEOUT_MS}`, '--json', specString(spec), 'version', 'dist.tarball'], os);
}

/**
 * Read one finished `npm view --json <name>@<version> version dist.tarball`.
 *
 * - An object naming the version and an http(s) `dist.tarball` means the registry lists it, and says
 *   where its tarball is. Listed is not yet published: the tarball is served separately, and later.
 * - The version with no usable `dist.tarball` — npm prints a lone field's value bare, so a missing
 *   one leaves just the version string — gives nothing to download, so it does not count as listed.
 * - An `E404` error object means it is not listed yet. npm gives the same answer for a version the
 *   registry does not list and for a package it has never heard of, so a package's first release
 *   waits the same way as every later one. Older npm answered a missing version with exit 0 and no
 *   output, which means the same.
 * - Any other error — a network failure, a refused credential — also means not listed, and carries
 *   npm's own summary so the report says why.
 *
 * Anything else throws: npm was not answering the question asked, and a wait that read past it could
 * spend its whole deadline misreading one answer, or finish on one it never understood.
 *
 * @param {{ status: number, stdout: string, stderr: string }} result  Exit code and output.
 * @param {PackageSpec} spec
 * @returns {ViewAnswer}
 */
export function readViewAnswer({ status, stdout, stderr }, spec) {
	const text = stdout.trim();
	if (text === '') {
		if (status === 0) return { listed: false, reason: NOT_YET_VISIBLE };
		const said = stderr.trim().split(/\r?\n/)[0];
		return { listed: false, reason: `npm view exited ${status}${said ? `: ${said}` : ' and printed nothing'}` };
	}
	let answer;
	try {
		answer = JSON.parse(text);
	} catch (err) {
		throw new Error(`npm view ${specString(spec)} printed output that is not JSON: ${text}`, { cause: err });
	}
	if (status === 0) return readListing(answer, spec, text);
	const code = answer?.error?.code;
	if (typeof code !== 'string') throw notUnderstood(spec, status, text);
	if (code === 'E404') return { listed: false, reason: NOT_YET_VISIBLE };
	const summary = answer.error.summary;
	return { listed: false, reason: `npm view failed with ${code}${typeof summary === 'string' && summary ? `: ${summary}` : ''}` };
}

/** The parsed output of an `npm view` that succeeded: the version asked for, and its tarball's URL. */
function readListing(answer, spec, text) {
	const version = typeof answer === 'string' ? answer : answer?.version;
	if (version !== spec.version) throw notUnderstood(spec, 0, text);
	const tarball = answer['dist.tarball'];
	if (tarball === undefined) return { listed: false, reason: 'npm view listed no dist.tarball' };
	if (!isHttpUrl(tarball)) return { listed: false, reason: `npm view listed dist.tarball ${JSON.stringify(tarball)}, which is not an http(s) URL` };
	return { listed: true, tarball };
}

function isHttpUrl(value) {
	return typeof value === 'string' && URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
}

function notUnderstood(spec, status, text) {
	return new Error(`npm view ${specString(spec)} answered something this script does not understand (exit ${status}): ${text}`);
}

/**
 * Read the HTTP status of a `HEAD` request for a listed version's tarball. Only 200 means the
 * download `npm install` makes would succeed now; 404 is the registry not serving it yet.
 *
 * @param {number} status
 * @returns {Visibility}
 */
export function readTarballAnswer(status) {
	if (status === 200) return { visible: true };
	if (status === 404) return { visible: false, reason: TARBALL_NOT_YET_DOWNLOADABLE };
	return { visible: false, reason: `tarball answered HTTP ${status}` };
}

// -- Waiting -------------------------------------------------------------------------------------

/**
 * Ask about every package, then again every `intervalMs` about the ones not yet seen, until all have
 * been seen or `timeoutMs` has passed. A package seen once is not asked about again. The last round
 * runs at the deadline, so a package that lands just before it still counts.
 *
 * @param {object} options
 * @param {PackageSpec[]} options.expected
 * @param {(spec: PackageSpec) => Promise<Visibility>} options.probe  Whether one package counts as published.
 * @param {number} options.timeoutMs
 * @param {number} options.intervalMs
 * @param {() => number} options.now  A millisecond clock.
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {(progress: Progress) => void} [options.onProgress]  Called after each round that leaves stragglers, except the last.
 * @returns {Promise<Straggler[]>}  The packages still not visible at the deadline; empty when every one was seen.
 */
export async function waitForVisibility({ expected, probe, timeoutMs, intervalMs, now, sleep, onProgress }) {
	const start = now();
	let pending = expected;
	for (;;) {
		const answers = await Promise.all(pending.map(async (spec) => ({ spec, answer: await probe(spec) })));
		const stragglers = answers.filter(({ answer }) => !answer.visible).map(({ spec, answer }) => ({ spec, reason: answer.reason }));
		const elapsedMs = now() - start;
		if (stragglers.length === 0 || elapsedMs >= timeoutMs) return stragglers;
		onProgress?.({ stragglers, total: expected.length, elapsedMs });
		pending = stragglers.map(({ spec }) => spec);
		await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
	}
}

// -- Reporting -----------------------------------------------------------------------------------

function seconds(ms) {
	return `${Math.round(ms / 1000)} s`;
}

/** The single line that says the release is finished. */
export function successLine(expected) {
	const versions = [...new Set(expected.map(({ version }) => version))].join(', ');
	return `all ${expected.length} packages published and visible on npm at ${versions}\n`;
}

/** One line of waiting: which packages, and why, when the reason is anything but not-there-yet. */
export function progressLine({ stragglers, total, elapsedMs }) {
	const names = stragglers.map(({ spec, reason }) => reason === NOT_YET_VISIBLE ? specString(spec) : `${specString(spec)} (${reason})`);
	return `waiting for ${stragglers.length} of ${total} packages to show on npm (${seconds(elapsedMs)}): ${names.join(', ')}\n`;
}

/** The report when the deadline passed with packages still missing. */
export function timeoutReport(stragglers, total, timeoutMs) {
	return [
		`${stragglers.length} of ${total} packages still not visible on npm after ${seconds(timeoutMs)}:`,
		...stragglers.map(({ spec, reason }) => `  ${specString(spec)} — ${reason}`),
		'The release is not finished: downstream upgrades may still resolve older versions of these, or fail to download them.',
		'If a publish failed, publish the missing packages, then run `yarn await-published` again.',
		''
	].join('\n');
}
