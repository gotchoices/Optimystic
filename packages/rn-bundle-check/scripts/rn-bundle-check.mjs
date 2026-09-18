#!/usr/bin/env node
/**
 * `yarn check:rn` — builds the React Native entry the way a phone app's release build does, so code
 * that would break a phone app's build fails in this repository instead of in someone else's project.
 *
 * Every other test here runs on Node. A React Native app instead bundles our packages with Metro
 * (React Native's bundler, which runs Babel with the React Native preset) and compiles the bundle to
 * bytecode with `hermesc`, the compiler for Hermes, React Native's JavaScript engine. Code can pass
 * every Node test and still break either step: a class `static { }` block did, downstream, on
 * 2026-09-14.
 *
 * `main` runs, in order: refuse an install Metro cannot resolve through; refuse a stale or missing
 * `dist/`; bundle `entry.js` with `metro.config.cjs`; assert `@optimystic/db-p2p` and its `/rn` subpath
 * both resolved to the React Native entry; compile the bundle with `hermesc`. Nothing is executed —
 * readme.md says what that leaves unchecked, and why the toolchain versions are pinned together.
 *
 * `bundle`, `compile`, `createOutputDir`, `createRouteRecorder` and `hermescBinary` are exported for `test/`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import { loadConfig, mergeConfig, runBuild } from 'metro';

import { buildFreshnessProblems, SKIP_ENV } from '../../../test-harness/build-freshness.mjs';

const require = createRequire(import.meta.url);

const WORKSPACE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = realpathSync(resolve(WORKSPACE_DIR, '..', '..'));
const CONFIG_PATH = join(WORKSPACE_DIR, 'metro.config.cjs');
const ENTRY_PATH = join(WORKSPACE_DIR, 'entry.js');
/** Parent of every run's private output directory. Under `node_modules`, so git never sees it. */
const OUTPUT_PARENT = join(WORKSPACE_DIR, 'node_modules', '.cache', 'rn-bundle-check', 'runs');

/**
 * Where these specifiers must land when a React Native app imports them, relative to the repository
 * root. The bare specifier is the one that regresses silently: repoint or drop the `react-native`
 * condition in packages/db-p2p/package.json and React Native gets the Node entry while every Node test
 * stays green, packages/db-p2p/test/entry-parity.spec.ts included.
 *
 * Every import of these specifiers is judged, not only entry.js's own: Metro resolves a specifier once
 * per importing directory and reports each resolution, so the bare `@optimystic/db-p2p` imports made
 * by the Quereus plugin and by db-p2p-storage-rn are checked too.
 */
const EXPECTED_ROUTES = new Map([
	['@optimystic/db-p2p', 'packages/db-p2p/dist/src/rn.js'],
	['@optimystic/db-p2p/rn', 'packages/db-p2p/dist/src/rn.js'],
]);

/** Printed on every passing run, so a green check is never read as "works on a phone". */
const DISCLAIMER =
	'Checked: Metro bundles the React Native entry with the React Native 0.83 toolchain, and legacy Hermes compiles it.\n' +
	'Not checked: running it, globals and polyfills, native modules (rn-leveldb), or anything on a device.';

/** `hermesc` names positions in the bundle, e.g. `C:\...\bundle.js:803:25: error: ...`. */
const BUNDLE_POSITION_RE = /bundle\.js:(\d+):(\d+)/g;

/** Thrown by `compile` when `hermesc` exits non-zero. `status` is its exit code (`null` if killed by a signal). */
export class HermesCompileError extends Error {
	constructor(status, signal, diagnostics) {
		super(`hermesc exited with ${status === null ? `signal ${signal}` : `status ${status}`}:\n${diagnostics}`);
		this.name = 'HermesCompileError';
		this.status = status;
	}
}

// -- The two stages --------------------------------------------------------------------------------

/**
 * Bundles `entry` into `outDir/bundle.js` (and `bundle.js.map`) the way a Hermes release build does:
 * Android, production, Hermes transform profile. Left unminified so a `hermesc` diagnostic stays
 * readable even before source-map translation.
 *
 * `onResolve(specifier, filePath, importer)`, when given, sees every module resolution Metro performs.
 * Rejects with Metro's own error, extended with a remedy when the cause is one this repository has met
 * before.
 */
export async function bundle({ entry, outDir, onResolve }) {
	const bundlePath = join(outDir, 'bundle.js');
	const sourceMapPath = `${bundlePath}.map`;
	const config = await loadMetroConfig(onResolve);
	try {
		await runBuild(config, {
			entry,
			bundleOut: bundlePath,
			sourceMap: true,
			sourceMapOut: sourceMapPath,
			// Naming the map keeps it out of the bundle; an inline map would double what hermesc parses.
			sourceMapUrl: 'bundle.js.map',
			platform: 'android',
			dev: false,
			minify: false,
			unstable_transformProfile: 'hermes-stable',
		});
	} catch (error) {
		throw explainBundleFailure(error);
	}
	return { bundlePath, sourceMapPath };
}

/**
 * Compiles a bundle to Hermes bytecode with the pinned legacy `hermesc`, using the flags a React
 * Native release build passes. Throws `HermesCompileError` on a non-zero exit, with every
 * `bundle.js:line:column` in hermesc's output followed by the original module, line and column.
 */
export function compile({ bundlePath, sourceMapPath }) {
	const hermesc = hermescPath();
	const bytecodePath = bundlePath.replace(/\.js$/, '.hbc');
	// An argument array, never a composed shell string: the paths may contain spaces.
	const result = spawnSync(hermesc, ['-emit-binary', '-O', '-out', bytecodePath, bundlePath], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error !== undefined) throw spawnFailure(hermesc, result.error);
	if (result.status !== 0) {
		const diagnostics = translateBundlePositions(`${result.stderr}${result.stdout}`, sourceMapPath);
		throw new HermesCompileError(result.status, result.signal, diagnostics);
	}
	return { bytecodePath };
}

/**
 * A fresh, private output directory, so concurrent runs (this check and its tests) never share a file.
 *
 * NOTE: nothing prunes `runs/`. A run kept after a hermesc failure, or one killed mid-bundle, stays on
 * disk (a 22 MB bundle plus its source map). Harmless while such runs are rare; if they pile up, delete
 * old `run-*` directories here before creating a new one.
 */
export function createOutputDir() {
	mkdirSync(OUTPUT_PARENT, { recursive: true });
	return mkdtempSync(join(OUTPUT_PARENT, 'run-'));
}

// -- Metro -----------------------------------------------------------------------------------------

/** `metro.config.cjs`, with a resolver that also reports each resolution when `onResolve` is given. */
async function loadMetroConfig(onResolve) {
	const config = await loadConfig({ config: CONFIG_PATH });
	if (onResolve === undefined) return config;

	const upstream = config.resolver.resolveRequest;
	return mergeConfig(config, {
		resolver: {
			resolveRequest(context, moduleName, platform) {
				// Inside a custom resolver, `context.resolveRequest` is Metro's own default resolver.
				const resolution = (upstream ?? context.resolveRequest)(context, moduleName, platform);
				if (resolution.type === 'sourceFile') onResolve(moduleName, resolution.filePath, context.originModulePath);
				return resolution;
			},
		},
	});
}

/** Metro's error, with a remedy appended when `bundleFailureHint` has one; otherwise untouched. */
function explainBundleFailure(error) {
	const hint = bundleFailureHint(error);
	return hint === undefined ? error : new Error(`${messageOf(error)}\n\n${hint}`, { cause: error });
}

function bundleFailureHint(error) {
	const target = unresolvedModule(error);
	if (target === undefined) return undefined;

	if (isNodeBuiltin(target)) {
		return `"${target}" is a Node built-in module, which React Native does not provide. Either the ` +
			'"Node.js built-in module shims" table in packages/db-p2p/readme.md (§ React Native) is missing a ' +
			'row for it — add the row there and the matching alias in packages/rn-bundle-check/metro.config.cjs — ' +
			'or the package importing it is not React-Native-safe and must not be reachable from the React Native entry.';
	}
	if (target === 'rn-leveldb' || target.startsWith('rn-leveldb/')) {
		return 'rn-leveldb is a native module the host app installs and passes in: @optimystic/db-p2p-storage-rn ' +
			'must never import it statically (see packages/db-p2p-storage-rn/src/rn-opener.ts).';
	}
	return undefined;
}

/** The specifier behind Metro's `UnableToResolveError`; `undefined` for any other failure. */
function unresolvedModule(error) {
	return error !== null && typeof error === 'object' && error.type === 'UnableToResolveError' &&
		typeof error.targetModuleName === 'string'
		? error.targetModuleName
		: undefined;
}

function isNodeBuiltin(specifier) {
	return specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0]);
}

// -- hermesc ---------------------------------------------------------------------------------------

/**
 * The `hermesc` binary inside the `hermes-compiler` package for a platform, relative to that package.
 * Throws for a platform it ships no binary for: a skipped check would read as a passed one.
 *
 * NOTE: only the Windows binary has been exercised. The Linux and macOS choices follow the package's
 * layout (`hermesc/linux64-bin`, `hermesc/osx-bin`) but have not been run.
 */
export function hermescBinary(platform, arch) {
	if (platform === 'win32') return join('hermesc', 'win64-bin', 'hermesc.exe');
	if (platform === 'linux' && arch === 'x64') return join('hermesc', 'linux64-bin', 'hermesc');
	if (platform === 'darwin') return join('hermesc', 'osx-bin', 'hermesc');
	throw new Error(
		`hermes-compiler ships no hermesc for ${platform}-${arch} (only Windows x64, Linux x64 and macOS), ` +
		'so this check cannot run on this machine.'
	);
}

function hermescPath() {
	return join(dirname(require.resolve('hermes-compiler/package.json')), hermescBinary(process.platform, process.arch));
}

function spawnFailure(hermesc, error) {
	switch (error.code) {
		case 'EACCES':
			return new Error(
				`${hermesc} is not executable (EACCES). An install can drop a binary's exec bit; restore it with: chmod +x "${hermesc}"`,
				{ cause: error }
			);
		case 'ENOENT':
			return new Error(`hermesc is missing at ${hermesc}.\n    Run: yarn install`, { cause: error });
		default:
			return new Error(`could not run ${hermesc}: ${error.message}`, { cause: error });
	}
}

/** Appends ` [<module>:<line>:<column>]` to every bundle position in `text`, from the source map. */
function translateBundlePositions(text, sourceMapPath) {
	let map;
	try {
		map = new TraceMap(readFileSync(sourceMapPath, 'utf8'));
	} catch (error) {
		return `${text}\n(positions not translated: could not read ${sourceMapPath}: ${messageOf(error)})`;
	}
	return text.replace(BUNDLE_POSITION_RE, (position, line, column) => {
		// hermesc columns are 1-based; trace-mapping's are 0-based.
		const original = originalPositionFor(map, { line: Number(line), column: Math.max(0, Number(column) - 1) });
		return original.source === null
			? position
			: `${position} [${displayPath(original.source)}:${original.line}:${original.column + 1}]`;
	});
}

// -- Export routing --------------------------------------------------------------------------------

/**
 * Records, through `onResolve` (pass it to `bundle`), every file each expected specifier resolved to,
 * and which modules imported it there, so a misroute names the importer that got the wrong file.
 * `expected` maps a specifier to its repository-relative target; `main` uses `EXPECTED_ROUTES`.
 */
export function createRouteRecorder(expected = EXPECTED_ROUTES) {
	/** specifier → resolved path → importers. */
	const routes = new Map();
	return {
		onResolve(specifier, filePath, importer) {
			if (!expected.has(specifier)) return;
			const byTarget = routes.get(specifier) ?? new Map();
			const resolved = repoRelative(filePath);
			const importers = byTarget.get(resolved) ?? new Set();
			importers.add(repoRelative(importer));
			byTarget.set(resolved, importers);
			routes.set(specifier, byTarget);
		},

		/** Expected specifiers that resolved anywhere but their target. */
		misroutes() {
			return [...expected].flatMap(([specifier, target]) => {
				const wrong = [...(routes.get(specifier) ?? [])]
					.filter(([path]) => path !== target)
					.map(([path, importers]) => `${path} (imported by ${[...importers].join(', ')})`);
				return wrong.length === 0 ? [] : [
					`${specifier} resolved to ${wrong.join(', ')} instead of ${target}. A React Native app importing ` +
					'it gets the wrong entry point. Check the `react-native` condition and the `./rn` subpath in the ' +
					'`exports` of packages/db-p2p/package.json, and that the importer reaches the workspace copy of ' +
					'the package rather than a copy of its own.',
				];
			});
		},

		/** Expected specifiers the bundle never resolved, so their routing went unchecked. */
		unreached() {
			return [...expected.keys()]
				.filter((specifier) => !routes.has(specifier))
				.map((specifier) => `${specifier} was never imported, so its React Native routing went unchecked. entry.js must import it.`);
		},
	};
}

// -- The CLI ---------------------------------------------------------------------------------------

async function main() {
	const refusal = linkerProblem() ?? freshnessProblem();
	if (refusal !== undefined) return fail(refusal);

	const timings = [];
	const outDir = createOutputDir();
	let failure;
	try {
		failure = await bundleAndCompile(outDir, timings);
	} finally {
		if (failure?.keepOutput !== true) rmSync(outDir, { recursive: true, force: true });
	}

	if (failure === undefined) {
		process.stdout.write(`rn-bundle-check: passed (${formatTimings(timings)})\n${DISCLAIMER}\n`);
		return;
	}
	const kept = failure.keepOutput ? `\n\nBundle and source map kept for inspection in ${outDir}` : '';
	fail(`${failure.message}${kept}`, timings);
}

/**
 * Both stages plus the routing assertion. Returns what to report — `keepOutput` when the bundle is
 * worth inspecting — or `undefined` when everything passed.
 */
async function bundleAndCompile(outDir, timings) {
	const routes = createRouteRecorder();
	let bundled;
	try {
		bundled = await timed(timings, 'Metro bundle', () => bundle({ entry: ENTRY_PATH, outDir, onResolve: routes.onResolve }));
	} catch (error) {
		// A misrouted entry usually fails the bundle itself — the Node entry reaches `@libp2p/tcp`, which
		// imports `net` — and Metro's message then points at a shim, not at the cause. Routing first.
		return { message: [...routes.misroutes(), messageOf(error)].join('\n\n'), keepOutput: false };
	}

	const routeProblems = [...routes.misroutes(), ...routes.unreached()];
	if (routeProblems.length > 0) return { message: routeProblems.join('\n'), keepOutput: false };

	try {
		await timed(timings, 'hermesc compile', () => compile(bundled));
	} catch (error) {
		return { message: messageOf(error), keepOutput: error instanceof HermesCompileError };
	}
	return undefined;
}

/**
 * Metro resolves through real `node_modules` directories, and metro.config.cjs finds portal links in
 * each workspace's own `node_modules`, so both settings named below are needed.
 */
function linkerProblem() {
	const found = unusableInstall();
	if (found === undefined) return undefined;
	return `Metro needs Yarn's \`nodeLinker: node-modules\` with \`nmHoistingLimits: workspaces\`, but ${found}.\n` +
		'`.yarnrc.yml` is gitignored, so a fresh clone defaults to Plug\'n\'Play: create it with those two\n' +
		'settings, then run `yarn install`.\n' +
		'Whether to commit that setting is an open decision (decide-whether-to-commit-the-yarn-linker-setting).';
}

function unusableInstall() {
	if (process.versions.pnp !== undefined) return 'this install uses Plug\'n\'Play';
	if (!existsSync(join(WORKSPACE_DIR, 'node_modules'))) {
		return 'packages/rn-bundle-check has no node_modules of its own (dependencies hoisted to the root?)';
	}
	return undefined;
}

/** The same derivation and escape hatch as `assertBuildFresh`, worded for a bundle rather than a test run. */
function freshnessProblem() {
	if ((process.env[SKIP_ENV] ?? '') !== '') {
		process.stderr.write(`build-freshness: skipped by ${SKIP_ENV}\n`);
		return undefined;
	}
	const problems = buildFreshnessProblems(WORKSPACE_DIR);
	if (problems.length === 0) return undefined;
	return 'Build first: this check bundles compiled dist/ output, and some of it is missing or stale.\n' +
		problems.map((problem) => `  - ${problem}\n`).join('');
}

async function timed(timings, label, step) {
	const started = performance.now();
	try {
		return await step();
	} finally {
		timings.push([label, performance.now() - started]);
	}
}

function formatTimings(timings) {
	return timings.map(([label, ms]) => `${label} ${(ms / 1000).toFixed(1)}s`).join(', ');
}

function fail(message, timings = []) {
	const took = timings.length > 0 ? ` (${formatTimings(timings)})` : '';
	// Metro colours its code frames; keep the escape codes out of logs and pipes.
	const text = process.stderr.isTTY ? message : stripVTControlCharacters(message);
	process.stderr.write(`rn-bundle-check: FAILED${took}\n${text}\n`);
	process.exitCode = 1;
}

// -- Small helpers ---------------------------------------------------------------------------------

/** `filePath` relative to the repository root with `/` separators; absolute when it lies outside. */
function repoRelative(filePath) {
	const rel = relative(REPO_ROOT, filePath);
	return rel.split(sep)[0] === '..' || isAbsolute(rel) ? filePath : rel.split(sep).join('/');
}

function displayPath(source) {
	return isAbsolute(source) ? repoRelative(source) : source;
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** True when node was started on this file, rather than a test importing it. */
function invokedDirectly() {
	const script = process.argv[1];
	return script !== undefined && realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) await main();
