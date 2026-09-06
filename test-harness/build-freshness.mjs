/**
 * Refuses a test run that would exercise a stale build.
 *
 * Every package here resolves its workspace and sibling-repo dependencies through a
 * `node_modules` symlink to a working copy, whose manifest points at `dist`. So a spec that
 * imports `@optimystic/db-core` loads `packages/db-core/dist/src/index.js` — the *previous*
 * build — while a spec that imports `../src/...` loads live source. Editing `db-core/src` and
 * running `yarn workspace @optimystic/db-p2p test` therefore exercises code that is no longer on
 * disk, with no warning. Both failure directions are real: a change that should have broken
 * something is absent from the run (false green), or a fix that is present in source is absent
 * from the run (false regression). This has already produced one wrong conclusion.
 *
 * `assertBuildFresh(import.meta.url)` is called from each package's `register.mjs`, above its
 * `register('ts-node/esm', ...)` call, so the check runs before any spec is loaded. It prints a
 * remedy and exits 1 when a dependency's compiled output is older than its source.
 *
 * The list of packages to check is **derived, never hand-written**: the calling `register.mjs`
 * sits next to a `package.json` that already names every dependency its suite can reach, and
 * every such dependency that matters arrives as a `node_modules` symlink we can classify at
 * runtime. A hand-written list drifts; this one cannot.
 *
 * Two traps, both learned the hard way in the sibling `sereus` repository
 * (`../sereus/test-harness/build-freshness.ts`) and both live here:
 *
 *   - **The `node_modules` walk must stop at the first directory holding an entry.** With
 *     `nmHoistingLimits: workspaces` in `.yarnrc.yml` there is no root `node_modules/@optimystic`
 *     at all — each workspace has its own. The package-local copy is the one Node loads, so
 *     carrying on to an ancestor would judge a copy that never runs.
 *   - **This module lives outside `packages/` and is imported by relative path.** A shared
 *     workspace package would itself be consumed from its own `dist`, so the guard against stale
 *     builds would be defeatable by its own stale build. It is plain `.mjs` rather than
 *     TypeScript for a related reason: a `register.mjs` static import is evaluated *before* that
 *     module's body installs the `ts-node/esm` loader, so no TypeScript loader exists yet.
 *
 * NOTE: only *directly declared* dependencies are covered. A package reached transitively is not:
 * `quereus-plugin-optimystic` runs `db-p2p` code which runs `p2p-fret` code, but `p2p-fret` is
 * neither in that package's manifest nor resolvable from its `node_modules`. Fabricating the entry
 * would report "not installed" and send someone to a build that would not help, so it is left
 * uncovered rather than guessed at. If a transitive stale build ever costs real time, the fix is
 * to walk each resolved target's own manifest for further candidates — not to hard-code names.
 *
 * Escape hatch: `OPTIMYSTIC_SKIP_BUILD_CHECK=1` skips the check, loudly (see `assertBuildFresh`).
 */

import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Set to any non-empty value to skip the check entirely. See `assertBuildFresh`. */
const SKIP_ENV = 'OPTIMYSTIC_SKIP_BUILD_CHECK';

/** Test files aren't build inputs — a touched spec must not mark its package stale. */
const SOURCE_EXCLUDE = /\.(test|spec)\.[cm]?tsx?$/;
const SOURCE_EXCLUDE_DIRS = new Set(['test', '__tests__']);

/** Manifest fields whose `workspace:`-ranged entries name a sibling workspace. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

/** Root-manifest `resolutions` prefixes that redirect a name at a working copy on disk. */
const PORTAL_PREFIXES = ['portal:', 'link:'];

/**
 * Problem lines for the package rooted at `packageDir`; empty means every dist-backed dependency
 * is fresh (or is not something this check can judge).
 *
 * Each line names the package, why its output can't be trusted, and — on a second, indented line
 * — the directory to run the remedy in. `yarn workspace` only reaches the current repository, so
 * a sibling checkout's remedy has to say where to go.
 *
 * `options.checkSelf` additionally compares `packageDir`'s own `src` against its own `dist`. It is
 * opt-in because only the two `quereus-plugin-*` packages have specs that import their own `dist`;
 * a package whose suite never touches its own output would otherwise fail on a fresh clone for a
 * reason its tests do not care about.
 *
 * Split out from `assertBuildFresh` so the derivation can be tested without a child process.
 */
export function buildFreshnessProblems(packageDir, options = {}) {
	const manifest = readManifest(join(packageDir, 'package.json'));
	if (manifest === undefined) return [];

	const repoRoot = findWorkspaceRoot(packageDir);
	const problems = [];

	for (const name of candidateNames(manifest, repoRoot)) {
		const problem = checkDependency(packageDir, repoRoot, name);
		if (problem !== undefined) problems.push(problem);
	}

	if (options.checkSelf === true) {
		const self = typeof manifest.name === 'string' ? manifest.name : packageDir;
		const problem = checkPackage(self, packageDir, manifest);
		if (problem !== undefined) problems.push(problem);
	}
	return problems;
}

/**
 * Fails the run when `buildFreshnessProblems` finds anything, printing the remedies to stderr.
 *
 * `registerUrl` is the calling `register.mjs`'s own `import.meta.url`: the `node_modules` walk
 * starts at that module's directory, so a package-local install is found before any ancestor's.
 *
 * `process.exit(1)` rather than `throw`: a thrown error makes node echo the offending source line
 * and five stack frames above the message, burying the one thing the reader needs. Exiting 1 also
 * makes `yarn workspaces foreach -At` halt rather than carry on to the next package.
 *
 * The `OPTIMYSTIC_SKIP_BUILD_CHECK` hatch exists for one specific, observed situation: an ordinary
 * `git checkout` in a sibling repository can bump `src` mtimes with the bytes unchanged, after
 * which the compiler's content-based change detection makes a rebuild a no-op and this check keeps
 * reporting stale — a rebuild that appears not to work. Without an escape, a developer is stuck on
 * a repository they are not even editing. The skip prints on *every* run so a hatch left set in a
 * shell profile stays visible rather than silently killing the guard forever.
 */
export function assertBuildFresh(registerUrl, options = {}) {
	if ((process.env[SKIP_ENV] ?? '') !== '') {
		process.stderr.write(`build-freshness: skipped by ${SKIP_ENV}\n`);
		return;
	}

	// Eager, and deliberately unguarded: a call site passing a plain path rather than a URL should
	// fail here and loudly, not resolve somewhere plausible.
	const packageDir = dirname(fileURLToPath(registerUrl));

	const problems = buildFreshnessProblems(packageDir, options);
	if (problems.length === 0) return;

	process.stderr.write(
		'Stale build detected: these tests run real compiled output.\n' +
		problems.map((p) => `  - ${p}\n`).join('')
	);
	process.exit(1);
}

// -- Deriving the target list --------------------------------------------------------------------

/**
 * Names worth trying to resolve, in stable alphabetical order.
 *
 * Two sources, both read from manifests rather than listed in this file: dependency ranges that
 * start `workspace:` (a sibling workspace in this repository), and every name the *root* manifest's
 * `resolutions` redirects at a working copy with `portal:` or `link:` (a sibling repository checked
 * out beside this one). Resolution names are offered for every package rather than cross-checked
 * against its own dependencies: a name the package cannot actually reach simply resolves to nothing
 * and is skipped, which is cheaper and less brittle than reasoning about who depends on what.
 */
function candidateNames(manifest, repoRoot) {
	const names = new Set();

	for (const field of DEPENDENCY_FIELDS) {
		const deps = manifest[field];
		if (deps === null || typeof deps !== 'object') continue;
		for (const [name, range] of Object.entries(deps)) {
			if (typeof range === 'string' && range.startsWith('workspace:')) names.add(name);
		}
	}

	const rootManifest = repoRoot === undefined ? undefined : readManifest(join(repoRoot, 'package.json'));
	const resolutions = rootManifest?.resolutions;
	if (resolutions !== null && typeof resolutions === 'object' && resolutions !== undefined) {
		for (const [name, range] of Object.entries(resolutions)) {
			if (typeof range === 'string' && PORTAL_PREFIXES.some((prefix) => range.startsWith(prefix))) names.add(name);
		}
	}

	return [...names].sort();
}

/** The problem with `name` as reached from `packageDir`, as a printable line; `undefined` when fine. */
function checkDependency(packageDir, repoRoot, name) {
	const resolved = resolvePackageFrom(packageDir, repoRoot, name);

	// A registry-installed copy is skipped, never judged: its `src` and `dist` mtimes are whatever
	// packing happened to record, so the comparison is meaningless and would report a permanent,
	// unfixable "stale". Only a symlink points at a working copy someone can actually rebuild.
	// Nothing found anywhere is skipped for a different reason: the suite cannot be running that
	// package's compiled output if it cannot load it at all.
	if (resolved.status === 'not-linked' || resolved.status === 'absent') return undefined;
	if (resolved.status === 'unresolved') return `${name}: ${resolved.detail}.\n    Run: yarn install`;

	return checkPackage(name, resolved.root, readManifest(join(resolved.root, 'package.json')));
}

/** The problem with the built output of the package `name` rooted at `root`; `undefined` when fine. */
function checkPackage(name, root, manifest) {
	const entry = builtEntry(manifest);
	if (entry === undefined) return `${name}: its package.json names no built entry point.\n    Run: yarn install`;

	const reason = checkBuildFreshness(root, entry);
	if (reason === undefined) return undefined;

	const repoRoot = findWorkspaceRoot(root);
	const where = repoRoot === undefined ? root : repoRoot;
	const build = repoRoot === undefined ? 'yarn build' : `yarn workspace ${name} build`;
	// The forced rewrite comes first because the plain rebuild is the one that can appear not to
	// work — see the mtime-is-not-content NOTE on `checkBuildFreshness`.
	const rebuild = repoRoot === undefined
		? 'yarn clean && yarn build'
		: `yarn workspace ${name} clean && yarn workspace ${name} build`;

	switch (reason) {
		case 'missing':
			return `${name}: not built (missing ${entry}).\n    Run in ${where}: ${build}`;
		case 'stale':
			return `${name}: dist is stale — src was edited after the last build.\n    Run in ${where}: ${rebuild}`;
		default:
			return undefined;
	}
}

/**
 * The built entry point a manifest advertises, relative to the package root.
 *
 * Deliberately not a conditional-exports resolver. The entry is used for exactly two things:
 * detecting "not built at all", and taking its first path segment as the output root. A slightly
 * imprecise pick inside the same `dist` tree changes neither answer.
 */
function builtEntry(manifest) {
	if (manifest === undefined) return undefined;

	const exported = manifest.exports;
	const dot = typeof exported === 'string'
		? exported
		: (exported !== null && typeof exported === 'object' ? exported['.'] : undefined);
	const fromExports = typeof dot === 'string'
		? dot
		: (dot !== null && typeof dot === 'object' && dot !== undefined ? (dot.import ?? dot.default) : undefined);

	const entry = typeof fromExports === 'string'
		? fromExports
		: (typeof manifest.main === 'string' ? manifest.main : undefined);
	return entry === undefined ? undefined : entry.replace(/^\.[\\/]/, '');
}

// -- Locating a package the way Node would --------------------------------------------------------

/**
 * Classify `nodeModulesDir/<name>`: a symlink into a working copy, a real directory, or nothing.
 *
 * Linkedness is decided by `lstat`, never by inspecting the name — which dependencies are linked
 * changes with the contents of `resolutions` and with whoever last ran `yarn install`. Windows
 * junctions, which is what yarn writes there, also report as symbolic links.
 *
 * This looks at one directory only. `absent` is its answer for "not here", which is what lets
 * `resolvePackageFrom` tell *keep walking* from *found, and unusable*.
 */
function classifyEntry(nodeModulesDir, name) {
	const entry = join(nodeModulesDir, name);

	let entryStat;
	try {
		entryStat = lstatSync(entry);
	} catch (error) {
		// Only "nothing here" continues the walk. A directory that exists but can't be read is
		// reported: swallowing it would carry on to an ancestor and judge a copy this suite does
		// not load, which is the whole failure this walk exists to avoid.
		const code = errorCode(error);
		if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'absent' };
		return { status: 'unresolved', detail: `${entry} could not be read (${code ?? 'unknown error'})` };
	}
	if (!entryStat.isSymbolicLink()) return { status: 'not-linked' };

	try {
		// `realpath` both follows the link and normalises the platform's spelling of its target (a
		// Windows junction target carries a long-path prefix). It throws when the working copy has
		// been moved or deleted.
		return { status: 'linked', root: realpathSync(entry) };
	} catch {
		return { status: 'unresolved', detail: `links to ${linkTarget(entry)}, which no longer exists` };
	}
}

/**
 * Walks the `node_modules` chain above `fromDir` and classifies the first hit.
 *
 * The first directory holding an entry wins, whatever that entry turns out to be: it is the copy
 * Node itself would load, so it is the one whose freshness matters. A package-local install that
 * turns out to be a registry copy, or a link that dangles, therefore ends the walk — "recovering"
 * by carrying on to the root would judge a copy the suite never runs.
 */
function resolvePackageFrom(fromDir, repoRoot, name) {
	for (const nodeModulesDir of nodeModulesChain(fromDir, repoRoot)) {
		const entry = classifyEntry(nodeModulesDir, name);
		if (entry.status !== 'absent') return entry;
	}
	return { status: 'absent' };
}

/**
 * The `node_modules` directories Node would consult from `fromDir`, nearest first, bounded above by
 * `stopAt` (inclusive) so a `node_modules` outside the repository is never consulted.
 *
 * When `stopAt` is `undefined` — no ancestor declares `workspaces`, only reachable from temp-dir
 * fixtures — the walk runs to the filesystem root instead of throwing: a guard that crashes on an
 * odd layout is worse than one that searches a little far.
 */
function nodeModulesChain(fromDir, stopAt) {
	const dirs = [];
	let dir = fromDir;
	for (;;) {
		dirs.push(join(dir, 'node_modules'));
		if (dir === stopAt) return dirs;
		const parent = dirname(dir);
		if (parent === dir) return dirs;
		dir = parent;
	}
}

/** Nearest ancestor of `from` (inclusive) whose `package.json` declares `workspaces`. */
export function findWorkspaceRoot(from) {
	let dir = from;
	for (;;) {
		if (readManifest(join(dir, 'package.json'))?.workspaces !== undefined) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

// -- The freshness comparison ---------------------------------------------------------------------

/**
 * Compares the newest source mtime under `packageRoot/src` against the newest mtime anywhere under
 * the build output root. Returns `'missing'`, `'stale'`, or `undefined` when the output can be
 * trusted. Exported for unit tests — `assertBuildFresh` is the caller everything else should use.
 *
 * The comparison spans the whole output tree rather than `entry` alone. Today's compiler settings
 * (`tsconfig.base.json` sets neither `incremental` nor `composite`) rewrite the whole tree on every
 * build, so judging the entry point alone would also work — but under `incremental` an entry point
 * keeps its old mtime across rebuilds that do not touch it, and such a package would be reported
 * stale forever, with `yarn build` succeeding and changing nothing the check can see. That
 * unfixable, ignore-me failure is exactly what the guard's value depends on not producing.
 *
 * NOTE: an absent or unreadable `src` reports fresh. A package consumed without its sources cannot
 * be shown stale, and a hard failure there would break for a reason the caller cannot act on.
 *
 * NOTE: mtime is not content. A git operation in a sibling checkout can bump a `src` file's mtime
 * with its bytes unchanged; the compiler's change detection is content-based, so a rebuild no-ops
 * and this still reports stale — a rebuild that appears not to work. The two answers are the
 * `clean &&` in the stale remedy line and the `OPTIMYSTIC_SKIP_BUILD_CHECK` hatch.
 *
 * NOTE: this walks the whole `src` and output tree of every target on every suite start-up —
 * measured at 5710 files in 56 ms across the four heaviest targets, against suites that run for
 * minutes. If it ever shows up, compare the newest `src` entry against a single always-rewritten
 * output artifact (the `.tsbuildinfo` that `incremental` would produce) instead of walking the
 * whole output tree.
 */
export function checkBuildFreshness(packageRoot, entry) {
	const entryMtime = mtimeMs(join(packageRoot, entry));
	if (entryMtime === undefined) return 'missing';

	const newestSrc = newestMtime(join(packageRoot, 'src'), isBuildInput);
	if (newestSrc === undefined) return undefined;

	// The entry point is the fallback for an unreadable output root, and for an `entry` that sits at
	// the package root with no directory above it.
	const newestBuild = newestMtime(join(packageRoot, outputRoot(entry)), acceptAll) ?? entryMtime;
	return newestSrc > newestBuild ? 'stale' : undefined;
}

/** The build output directory: the leading segment of `dist/src/index.js` is `dist`. */
function outputRoot(entry) {
	const [first] = entry.split(/[\\/]/);
	return first === undefined || first === '' ? entry : first;
}

/** Sources the build reads: test files and their directories are not among them. */
const isBuildInput = (entry) =>
	entry.isDirectory() ? !SOURCE_EXCLUDE_DIRS.has(entry.name) : !SOURCE_EXCLUDE.test(entry.name);

/** Everything the compiler writes counts, `.tsbuildinfo` and compiled tests included. */
const acceptAll = () => true;

/** Newest mtime (ms) under `dir`, recursively, over the entries `accept` keeps. */
function newestMtime(dir, accept) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}

	let newest;
	for (const entry of entries) {
		if (!accept(entry)) continue;
		const candidate = entry.isDirectory()
			? newestMtime(join(dir, entry.name), accept)
			: (entry.isFile() ? mtimeMs(join(dir, entry.name)) : undefined);
		if (candidate !== undefined && (newest === undefined || candidate > newest)) newest = candidate;
	}
	return newest;
}

// -- Small helpers --------------------------------------------------------------------------------

/** mtime in ms, or `undefined` when the path doesn't exist / can't be stat'd. */
function mtimeMs(path) {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

/** Parsed manifest, or `undefined` when there is no readable `package.json` there. */
function readManifest(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

/** A thrown value's `errno` code, when it carries one. */
function errorCode(error) {
	return error instanceof Error && typeof error.code === 'string' ? error.code : undefined;
}

/** The raw symlink target, for a message about a link that can't be followed. */
function linkTarget(entry) {
	try {
		return readlinkSync(entry);
	} catch {
		return 'an unreadable path';
	}
}
