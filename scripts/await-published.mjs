#!/usr/bin/env node
/**
 * Post-publish wait — the last step of `yarn release`, and runnable on its own as
 * `yarn await-published`.
 *
 * `yarn pub` returns once `npm publish` has returned for every public workspace, but the registry
 * starts serving each new version at its own moment. For 1.3.0, `@optimystic/db-core` and
 * `@optimystic/db-p2p` appeared 30–90 s after the rest, and a downstream upgrade run inside that gap
 * installed the new versions of some packages beside the old versions of those two. Publishing is
 * already dependencies-first (`yarn workspaces foreach -t`), so the spread is registry visibility,
 * not publish order, and nothing printed when `yarn pub` returns could be trusted.
 *
 * Listing a version is not the same as serving it. `npm view` reads the package's metadata, while
 * `npm install` downloads the tarball, which the registry makes available separately and later: for
 * sereus 1.8.0 every version was listed while three tarballs still answered 404 minutes afterwards.
 *
 * This script lists the workspaces `yarn pub` publishes and, for each one at its manifest's version,
 * asks npm whether it is listed and then whether its tarball can be downloaded. It asks again until
 * every package passes both or the deadline passes, and ends with one line saying which. Re-run it
 * after a partial or interrupted publish: it reports the packages still missing.
 *
 * Following `check-libp2p-majors.mjs`: this file is only the shell-out and the printing; the logic is
 * in `scripts/published-visibility.mjs`. Plain .mjs, no build step, no dependencies.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { cliCommand } from './cli-command.mjs';
import {
	FETCH_TIMEOUT_MS,
	WORKSPACE_LIST_ARGS,
	expectedPackages,
	npmViewCommand,
	parseWorkspaceList,
	progressLine,
	readTarballAnswer,
	readViewAnswer,
	specString,
	successLine,
	timeoutReport,
	waitForVisibility
} from './published-visibility.mjs';

/** The repository root: workspace locations are relative to it, wherever the script is run from. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TIMEOUT_ENV = 'OPTIMYSTIC_PUBLISH_WAIT_SECONDS';
const DEFAULT_TIMEOUT_S = 600;
const INTERVAL_MS = 5_000;
/**
 * Backstop for an `npm view` that neither answers nor fails; npm's own fetch timeout
 * (`FETCH_TIMEOUT_MS`) is the bound that normally applies.
 *
 * NOTE: on Windows this kills cmd.exe but not the npm process under it, which keeps the output pipe
 * open, so the call only returns when npm itself gives up. That is why the fetch timeout is set on
 * npm rather than relied on here; if a Windows wait is ever seen to overrun its deadline, kill the
 * process tree (`taskkill /t`) instead.
 */
const PROBE_TIMEOUT_MS = 60_000;
/** An unchanged waiting line is repeated this often, so a long wait does not look hung. */
const HEARTBEAT_MS = 30_000;
/**
 * Asks every cache between here and the registry to revalidate the tarball rather than answer from
 * what it holds: an edge that cached the 404 from before the tarball existed would otherwise keep
 * the wait going after the registry serves it.
 *
 * NOTE: a CDN edge is not bound to honour this, and an installer elsewhere reaches its own edge. If a
 * wait is ever seen to finish while an install elsewhere still 404s the tarball, that edge was stale;
 * retry from the installer's side, or add a short settle delay after the wait.
 */
const REVALIDATE = { 'cache-control': 'no-cache' };

const execFileAsync = promisify(execFile);

/**
 * Exit code and output of a finished command, whatever the exit code. Throws only when the command
 * could not be started at all; resolves `timedOut` when it had to be killed.
 */
async function run({ file, args }, timeout = 0) {
	try {
		const { stdout: out, stderr: err } = await execFileAsync(file, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout, windowsHide: true });
		return { status: 0, stdout: out, stderr: err, timedOut: false };
	} catch (err) {
		if (err.killed) return { status: null, stdout: '', stderr: '', timedOut: true };
		if (typeof err.code !== 'number') throw err;
		return { status: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '', timedOut: false };
	}
}

async function publishedWorkspaces() {
	const listing = await run(cliCommand('yarn', WORKSPACE_LIST_ARGS));
	if (listing.status !== 0) {
		throw new Error(`\`yarn ${WORKSPACE_LIST_ARGS.join(' ')}\` exited ${listing.status}:\n${[listing.stdout, listing.stderr].join('\n').trim()}`);
	}
	return expectedPackages(parseWorkspaceList(listing.stdout), (location) => JSON.parse(readFileSync(join(ROOT, location, 'package.json'), 'utf8')));
}

/** Whether `spec` counts as published: npm lists it, and then its tarball can be downloaded. */
async function probe(spec) {
	const result = await run(npmViewCommand(spec), PROBE_TIMEOUT_MS);
	if (result.timedOut) return { visible: false, reason: `npm view did not answer within ${PROBE_TIMEOUT_MS / 1000} s` };
	const view = readViewAnswer(result, spec);
	return view.listed ? probeTarball(view.tarball) : { visible: false, reason: view.reason };
}

/**
 * A `HEAD` of the tarball URL npm gave. Not npm itself: npm has no cheap "does this download exist"
 * question — `npm pack` and `npm cache add` fetch the whole file into npm's cache, where a later run
 * could then find it without asking the registry. The URL is npm's own answer, so the registry is
 * still the one npm publishes to. A failed request is a reason, not an error: the wait asks again.
 *
 * NOTE: a plain fetch carries none of npm's credentials, which is fine while every package is
 * published `--access public`. If one is ever published to a registry that requires auth for
 * downloads, this answers 401 and the wait times out naming it; then pass the registry token, or ask
 * npm instead.
 *
 * NOTE: nothing checks that the `latest` dist-tag points at the new version, though a downstream
 * `yarn up` resolves `latest`. `yarn pub` publishes with no `--tag`, so it does; if an upgrade is ever
 * seen to pick the previous version after this wait succeeded, ask for `dist-tags.latest` in the same
 * `npm view` call (for non-prerelease versions).
 */
async function probeTarball(url) {
	try {
		const response = await fetch(url, { method: 'HEAD', headers: REVALIDATE, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		return readTarballAnswer(response.status);
	} catch (err) {
		return { visible: false, reason: `could not reach ${url}: ${[err.message, err.cause?.message].filter(Boolean).join(': ')}` };
	}
}

function timeoutMs() {
	const raw = env[TIMEOUT_ENV];
	if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_S * 1000;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${TIMEOUT_ENV} must be a positive number of seconds, not ${JSON.stringify(raw)}`);
	return value * 1000;
}

/** Prints a waiting line when the stragglers or their reasons change, and at least every `HEARTBEAT_MS`. */
function progressPrinter() {
	let lastKey;
	let lastAt = -Infinity;
	return (progress) => {
		const key = progress.stragglers.map(({ spec, reason }) => `${specString(spec)} ${reason}`).join('\n');
		if (key === lastKey && progress.elapsedMs - lastAt < HEARTBEAT_MS) return;
		lastKey = key;
		lastAt = progress.elapsedMs;
		stdout.write(progressLine(progress));
	};
}

async function main() {
	const deadline = timeoutMs();
	const expected = await publishedWorkspaces();
	stdout.write(`await-published: waiting up to ${deadline / 1000} s for ${expected.length} packages: ${expected.map(specString).join(', ')}\n`);
	const stragglers = await waitForVisibility({
		expected,
		probe,
		timeoutMs: deadline,
		intervalMs: INTERVAL_MS,
		now: () => Date.now(),
		sleep,
		onProgress: progressPrinter()
	});
	if (stragglers.length > 0) {
		stderr.write(timeoutReport(stragglers, expected.length, deadline));
		exit(1);
	}
	stdout.write(successLine(expected));
}

if (argv.includes('--help') || argv.includes('-h')) {
	stdout.write('Usage: node scripts/await-published.mjs\n\n');
	stdout.write('Waits until npm lists every public workspace at the version in its package.json and\n');
	stdout.write('serves the tarball for that version, then prints one line saying so. Exits non-zero,\n');
	stdout.write('naming the packages still missing, when the deadline passes first\n');
	stdout.write(`(default ${DEFAULT_TIMEOUT_S} s; set ${TIMEOUT_ENV} to change it).\n`);
	stdout.write('See docs/releasing.md.\n');
	exit(0);
}

try {
	await main();
} catch (err) {
	stderr.write(`await-published: ${err.message}\n`);
	exit(1);
}
