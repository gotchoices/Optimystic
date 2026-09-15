/**
 * Metro configuration for `yarn check:rn`, standing in for a React Native host app's own
 * `metro.config.js`. Loaded by `scripts/rn-bundle-check.mjs`.
 *
 * It starts from `@react-native/metro-config`'s `getDefaultConfig`, which supplies React Native's
 * resolver main fields, its `react-native` export condition, and its Babel transformer and preset.
 * That is what makes a green bundle mean "a phone app's bundler accepts this" rather than "some
 * bundler does".
 *
 * RULE: `resolver.extraNodeModules` holds exactly the rows of the "Node.js built-in module shims"
 * table in packages/db-p2p/readme.md (§ React Native), each under its bare and its `node:` spelling.
 * If the bundle only succeeds with an alias that is not in that table, that is a gap in the readme —
 * add the row to the readme in the same change. `test/shim-table-parity.test.mjs` fails when the two
 * drift apart. The one extra alias, `react-native`, is harness-only (see `shims/react-native.js`).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { FileStore } = require('metro-cache');

const workspaceDir = __dirname;
const repoRoot = fs.realpathSync(path.resolve(workspaceDir, '..', '..'));
/** Under `node_modules`, so it is gitignored, and private to this workspace rather than the machine-wide `%TEMP%/metro-cache`. */
const cacheDir = path.join(workspaceDir, 'node_modules', '.cache', 'rn-bundle-check');

/** The readme's shim table, keyed by bare module name. `withNodeSpellings` adds the `node:` forms. */
const NODE_BUILTIN_SHIMS = {
	os: path.join(workspaceDir, 'shims', 'node-os.js'),
	crypto: path.join(workspaceDir, 'shims', 'node-crypto.js'),
	stream: packageDir('readable-stream'),
	buffer: packageDir('buffer'),
};

/** Aliases a real app never needs, because it has the real package installed. Not readme rows. */
const HARNESS_ONLY_ALIASES = {
	'react-native': path.join(workspaceDir, 'shims', 'react-native.js'),
};

/**
 * Metro's default terminal reporter opens with an ASCII-art banner and redraws a progress bar, which
 * buries the lines that matter in `yarn check` output. This forwards only warnings and errors.
 *
 * Expect a handful of resolver warnings about `multiformats` (it imports files its own `exports`
 * map does not list, and Metro falls back to file-based resolution). A host app sees the same ones;
 * they are printed once each, and never fail the check.
 */
const printedWarnings = new Set();
const quietReporter = {
	update(event) {
		switch (event.type) {
			case 'resolver_warning':
				// Metro repeats a warning for every module that makes the same import.
				if (!printedWarnings.has(event.message)) {
					printedWarnings.add(event.message);
					process.stderr.write(`WARN ${event.message}\n`);
				}
				break;
			case 'transform_cache_reset':
				process.stderr.write('WARN the Metro transform cache was reset.\n');
				break;
			case 'worker_stderr_chunk':
				process.stderr.write(event.chunk);
				break;
			case 'unstable_server_log':
				if (event.level === 'warn' || event.level === 'error') {
					process.stderr.write(`${event.level.toUpperCase()} ${[].concat(event.data).join(' ')}\n`);
				}
				break;
			default:
				break;
		}
	},
};

const defaults = getDefaultConfig(workspaceDir);

module.exports = mergeConfig(defaults, {
	watchFolders: [repoRoot, ...outOfRepoLinkTargets()],
	resolver: {
		// Watching `repoRoot` would otherwise crawl this check's own transform cache and run outputs, and
		// print an ENOENT error whenever a concurrent run deletes its output directory mid-crawl.
		blockList: [].concat(defaults.resolver.blockList, directoryPattern(cacheDir)),
		extraNodeModules: { ...withNodeSpellings(NODE_BUILTIN_SHIMS), ...HARNESS_ONLY_ALIASES },
		// Where Metro looks once the importing file's own `node_modules` chain comes up empty — a host
		// app's own `node_modules`, as a monorepo host configures it. Babel's runtime transform adds
		// `@babel/runtime/helpers/*` imports to every module, including ours under packages/*/dist,
		// whose ancestors hold no copy; in an app, that package sits in the app's `node_modules`.
		nodeModulesPaths: [path.join(workspaceDir, 'node_modules')],
		// A one-shot build: Metro's Node crawler builds the same file map without a watchman daemon.
		useWatchman: false,
	},
	serializer: {
		// React Native runs `react-native/Libraries/Core/InitializeCore` ahead of the entry. That
		// module lives in the real `react-native` package, which this harness stubs out.
		getModulesRunBeforeMainModule: () => [],
	},
	cacheStores: [new FileStore({ root: path.join(cacheDir, 'metro') })],
	reporter: quietReporter,
});

/** `{ os: x }` → `{ os: x, 'node:os': x }`: the readme lists both spellings, and code imports both. */
function withNodeSpellings(shims) {
	return Object.fromEntries(
		Object.entries(shims).flatMap(([name, target]) => [[name, target], [`node:${name}`, target]])
	);
}

/** `dir` and everything under it, as an absolute-path pattern for `resolver.blockList`. */
function directoryPattern(dir) {
	const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^${escaped}(?:[\\\\/]|$)`);
}

/**
 * An installed package's directory. Resolved through its manifest because `require.resolve('buffer')`
 * answers with Node's built-in `buffer`, not the npm package the readme names.
 */
function packageDir(name) {
	return path.dirname(require.resolve(`${name}/package.json`));
}

/**
 * Real paths of the workspace `node_modules` links that lead outside this repository — today only
 * `p2p-fret`, which the root `resolutions` portal-links to ../Fret/packages/fret. Metro refuses to
 * load a file outside its watch folders, so each such target must be watched. Derived by scanning
 * rather than hard-coded (as the sereus reference app does), so a new portal needs no edit here and a
 * checkout that installed `p2p-fret` from npm simply finds none.
 *
 * NOTE: this watches the linked package directory, not the sibling repository's root. That covers the
 * sibling's own dependencies only while that repository also installs with
 * `nmHoistingLimits: workspaces`, as Fret does today. If it ever hoists them to its root
 * `node_modules`, bundling fails with "Unable to resolve module" from inside the sibling; watch the
 * sibling's workspace root instead.
 */
function outOfRepoLinkTargets() {
	const targets = new Set();
	const packagesDir = path.join(repoRoot, 'packages');
	for (const workspace of listDir(packagesDir)) {
		const nodeModules = path.join(packagesDir, workspace, 'node_modules');
		for (const entry of packageEntries(nodeModules)) {
			const target = linkTarget(entry);
			if (target !== undefined && !isInside(repoRoot, target)) targets.add(target);
		}
	}
	return [...targets].sort();
}

/** `node_modules/<name>` and `node_modules/@scope/<name>` directly inside `nodeModules`; dot-entries (`.bin`, `.cache`) skipped. */
function packageEntries(nodeModules) {
	return listDir(nodeModules)
		.filter((name) => !name.startsWith('.'))
		.flatMap((name) => name.startsWith('@')
			? listDir(path.join(nodeModules, name)).map((scoped) => path.join(nodeModules, name, scoped))
			: [path.join(nodeModules, name)]);
}

/** Where `entry` links to; `undefined` for a real directory. A dangling link throws, naming itself. */
function linkTarget(entry) {
	if (!fs.lstatSync(entry).isSymbolicLink()) return undefined;
	try {
		return fs.realpathSync(entry);
	} catch (error) {
		throw new Error(`${entry} links to a path that no longer exists; run yarn install`, { cause: error });
	}
}

/** Directory entries, or none when the directory does not exist (a workspace that was never installed). */
function listDir(dir) {
	try {
		return fs.readdirSync(dir);
	} catch (error) {
		if (error.code === 'ENOENT') return [];
		throw error;
	}
}

function isInside(root, target) {
	const relative = path.relative(root, target);
	return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
}
