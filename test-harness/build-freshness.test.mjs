/**
 * Tests for the stale-build guard, run by node's built-in test runner
 * (`yarn test:harness` at the repository root).
 *
 * `node --test` rather than mocha on purpose: the module whose whole job is to be un-defeatable by
 * the build system should not acquire a stake in it, so this file pulls in no dependency at all.
 *
 * Every fixture is a throwaway tree under the OS temp directory, with mtimes set explicitly by
 * `utimesSync` — never by the order in which the fixture happens to be written. Directory symlinks
 * are created as Windows **junctions**: a plain directory symlink needs elevation on Windows
 * whereas a junction does not, `lstatSync` reports a junction as a symbolic link, and the `type`
 * argument is ignored on every other platform. That is also why the production code classifies an
 * entry with `lstat` rather than by inspecting its name.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { buildFreshnessProblems, checkBuildFreshness, findWorkspaceRoot } from './build-freshness.mjs';

const MODULE_URL = new URL('./build-freshness.mjs', import.meta.url).href;

/** Two mtimes far enough apart that no filesystem timestamp granularity can confuse them. */
const OLD = Date.now() - 10 * 60 * 1000;
const NEW = Date.now() - 1 * 60 * 1000;

const roots = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fresh empty temp directory, removed when the file's tests finish. */
function tempRoot() {
	const root = mkdtempSync(join(tmpdir(), 'optimystic-build-freshness-'));
	roots.push(root);
	return root;
}

function write(path, content, whenMs) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	if (whenMs !== undefined) utimesSync(path, new Date(whenMs), new Date(whenMs));
}

function writeManifest(dir, manifest) {
	write(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
}

/**
 * A package directory with one source file and one compiled file.
 *
 * `srcAt`/`distAt` are the mtimes to stamp on them, which is the entire input to the freshness
 * comparison. `entry` defaults to the `dist/src/index.js` layout `tsc` produces here; the two
 * plugin packages' bundler writes a flat `dist/index.js` instead, which some tests pass explicitly.
 */
function writePackage(dir, { name, entry = 'dist/src/index.js', srcAt = OLD, distAt = NEW, src = true, dist = true }) {
	writeManifest(dir, { name, main: entry });
	if (src) write(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', srcAt);
	if (dist) write(join(dir, entry), 'export const x = 1;\n', distAt);
	return dir;
}

/**
 * A repository root, a consumer workspace inside it, and a `dep-a` working copy the consumer
 * reaches through a `node_modules` junction — the shape every package in this repo actually has.
 */
function writeRepo({ dep = {}, consumer = {}, link = true } = {}) {
	const root = tempRoot();
	writeManifest(root, { name: 'fixture-root', private: true, workspaces: ['packages/*'] });

	const depDir = writePackage(join(root, 'packages', 'dep-a'), { name: 'dep-a', ...dep });

	const consumerDir = join(root, 'packages', 'consumer');
	writeManifest(consumerDir, { name: 'consumer', dependencies: { 'dep-a': 'workspace:^' }, ...consumer });
	if (link) linkPackage(join(consumerDir, 'node_modules', 'dep-a'), depDir);

	return { root, consumerDir, depDir };
}

/** Junction at `linkPath` pointing at `target`, with the parent `node_modules` created for it. */
function linkPackage(linkPath, target) {
	mkdirSync(dirname(linkPath), { recursive: true });
	symlinkSync(target, linkPath, 'junction');
}

describe('buildFreshnessProblems', () => {
	it('reports a dependency whose src was edited after the last build', () => {
		const { root, consumerDir } = writeRepo({ dep: { srcAt: NEW, distAt: OLD } });

		const problems = buildFreshnessProblems(consumerDir);

		assert.equal(problems.length, 1);
		assert.match(problems[0], /^dep-a: dist is stale/);
		// Naming the directory matters most for a sibling repository, where `yarn workspace` from
		// here would not reach the package at all.
		assert.ok(problems[0].includes(`Run in ${root}: yarn workspace dep-a clean && yarn workspace dep-a build`), problems[0]);
	});

	it('accepts a dependency built after its src', () => {
		const { consumerDir } = writeRepo({ dep: { srcAt: OLD, distAt: NEW } });

		assert.deepEqual(buildFreshnessProblems(consumerDir), []);
	});

	it('reports a dependency that was never built, rather than throwing ENOENT', () => {
		const { root, consumerDir } = writeRepo({ dep: { dist: false } });

		const problems = buildFreshnessProblems(consumerDir);

		assert.equal(problems.length, 1);
		assert.match(problems[0], /^dep-a: not built \(missing dist[\\/]src[\\/]index\.js\)/);
		assert.ok(problems[0].includes(`Run in ${root}: yarn workspace dep-a build`), problems[0]);
	});

	it('sends a sibling repository\'s remedy to that repository, not to this one', () => {
		// `@quereus/quereus` and `p2p-fret` are `portal:`-resolved into checkouts beside this one, so
		// `yarn workspace <name> build` run from here would not reach them at all. The remedy has to
		// name the other checkout — and this is also the case that today fails with an opaque
		// `ERR_MODULE_NOT_FOUND` from inside a spec.
		const { consumerDir } = writeRepo({ link: false });
		const sibling = tempRoot();
		writeManifest(sibling, { name: 'sibling-root', private: true, workspaces: ['packages/*'] });
		const depDir = writePackage(join(sibling, 'packages', 'dep-a'), { name: 'dep-a', dist: false });
		linkPackage(join(consumerDir, 'node_modules', 'dep-a'), depDir);

		const problems = buildFreshnessProblems(consumerDir);

		assert.equal(problems.length, 1);
		assert.match(problems[0], /^dep-a: not built/);
		assert.ok(problems[0].includes(`Run in ${sibling}: yarn workspace dep-a build`), problems[0]);
	});

	it('treats a dependency consumed without its sources as fresh', () => {
		// A copy with no `src` cannot be shown stale, and failing there would give the caller
		// nothing to act on.
		const { consumerDir } = writeRepo({ dep: { src: false } });

		assert.deepEqual(buildFreshnessProblems(consumerDir), []);
	});

	it('skips a registry-installed copy instead of judging its packing mtimes', () => {
		const { root, consumerDir } = writeRepo({ link: false });
		// A real directory, not a junction: its src/dist mtimes are whatever packing recorded, so
		// comparing them would report a permanent, unfixable "stale".
		writePackage(join(consumerDir, 'node_modules', 'dep-a'), { name: 'dep-a', srcAt: NEW, distAt: OLD });
		assert.ok(findWorkspaceRoot(consumerDir) === root);

		assert.deepEqual(buildFreshnessProblems(consumerDir), []);
	});

	it('skips a dependency that is not installed anywhere', () => {
		const { consumerDir } = writeRepo({ link: false });

		assert.deepEqual(buildFreshnessProblems(consumerDir), []);
	});

	it('reports a symlink whose target is gone, naming the raw link target', () => {
		const { consumerDir, depDir } = writeRepo();
		rmSync(depDir, { recursive: true, force: true });

		const problems = buildFreshnessProblems(consumerDir);

		assert.equal(problems.length, 1);
		assert.match(problems[0], /^dep-a: links to .*, which no longer exists\.\n {4}Run: yarn install$/s);
		assert.ok(problems[0].includes('dep-a'), problems[0]);
	});

	it('stops the node_modules walk at the first directory that has an entry', () => {
		// The single most important behaviour, and live in this repo: `nmHoistingLimits: workspaces`
		// means each workspace has its own `node_modules`, so the package-local copy is the one Node
		// loads. Here that copy is a registry install (skipped) while an ancestor holds a junction to
		// a stale working copy — carrying on to the ancestor would report a package the suite never
		// runs.
		const { root, consumerDir } = writeRepo({ link: false });
		writePackage(join(consumerDir, 'node_modules', 'dep-a'), { name: 'dep-a', srcAt: OLD, distAt: NEW });
		const stale = writePackage(join(tempRoot(), 'dep-a'), { name: 'dep-a', srcAt: NEW, distAt: OLD });
		linkPackage(join(root, 'node_modules', 'dep-a'), stale);

		assert.deepEqual(buildFreshnessProblems(consumerDir), []);
	});

	it('lets a dangling link nearest the consumer end the walk too', () => {
		const { root, consumerDir, depDir } = writeRepo();
		rmSync(depDir, { recursive: true, force: true });
		// A perfectly good ancestor copy must not rescue the walk: Node would have loaded the
		// nearest entry, so the nearest entry is the one whose state matters.
		const other = writePackage(join(tempRoot(), 'dep-a'), { name: 'dep-a', srcAt: OLD, distAt: NEW });
		linkPackage(join(root, 'node_modules', 'dep-a'), other);

		const problems = buildFreshnessProblems(consumerDir);

		assert.equal(problems.length, 1);
		assert.match(problems[0], /no longer exists/);
	});

	it('never consults a node_modules above the repository root', () => {
		const outer = tempRoot();
		const root = join(outer, 'repo');
		writeManifest(root, { name: 'fixture-root', private: true, workspaces: ['packages/*'] });
		const consumerDir = join(root, 'packages', 'consumer');
		writeManifest(consumerDir, { name: 'consumer', dependencies: { 'dep-a': 'workspace:^' } });
		// Outside the repository, so out of scope however stale it is.
		const stale = writePackage(join(outer, 'dep-a-source'), { name: 'dep-a', srcAt: NEW, distAt: OLD });
		linkPackage(join(outer, 'node_modules', 'dep-a'), stale);

		assert.equal(findWorkspaceRoot(consumerDir), root);
		assert.deepEqual(buildFreshnessProblems(consumerDir), []);
	});

	it('terminates at the filesystem root when no ancestor declares workspaces', () => {
		// Only reachable from a temp-dir fixture, but a guard that hangs or throws on an odd layout
		// is worse than one that searches a little far.
		const dir = join(tempRoot(), 'loose-package');
		writeManifest(dir, { name: 'loose', dependencies: { 'dep-a-nowhere-on-this-machine': 'workspace:^' } });

		assert.equal(findWorkspaceRoot(dir), undefined);
		assert.deepEqual(buildFreshnessProblems(dir), []);
	});

	it('does not mark a dependency stale because one of its specs was edited', () => {
		// `db-core`'s tsconfig compiles `src` and `test` together, so its dist mtimes move when specs
		// change; the source side has to exclude them or every spec edit reports the package stale.
		const { consumerDir, depDir } = writeRepo({ dep: { srcAt: OLD, distAt: NEW } });
		write(join(depDir, 'src', 'thing.spec.ts'), 'it("x", () => {});\n', Date.now());
		write(join(depDir, 'src', 'test', 'helper.ts'), 'export const h = 1;\n', Date.now());
		write(join(depDir, 'src', '__tests__', 'helper.ts'), 'export const h = 1;\n', Date.now());

		assert.deepEqual(buildFreshnessProblems(consumerDir), []);

		// The same fixture with a real source edit must still be caught.
		write(join(depDir, 'src', 'real.ts'), 'export const y = 2;\n', Date.now());
		assert.equal(buildFreshnessProblems(consumerDir).length, 1);
	});

	it('reads the built entry point from exports before falling back to main', () => {
		const { consumerDir, depDir } = writeRepo({ dep: { dist: false } });
		writeManifest(depDir, {
			name: 'dep-a',
			main: 'does-not-exist.js',
			exports: { '.': { types: './dist/src/index.d.ts', import: './dist/src/index.js' } }
		});
		write(join(depDir, 'dist', 'src', 'index.js'), 'export const x = 1;\n', NEW);

		assert.deepEqual(buildFreshnessProblems(consumerDir), []);
	});

	describe('checkSelf', () => {
		it('catches the calling package\'s own stale dist in the flat bundler layout', () => {
			// What `quereus-plugin-optimystic` and `quereus-plugin-crypto` need: their specs import
			// `../dist/plugin.js` outright, and their bundler writes a flat `dist/` with no `src/`.
			const root = tempRoot();
			writeManifest(root, { name: 'fixture-root', private: true, workspaces: ['packages/*'] });
			const pkg = writePackage(join(root, 'packages', 'plugin'), {
				name: 'plugin', entry: 'dist/index.js', srcAt: NEW, distAt: OLD
			});

			assert.deepEqual(buildFreshnessProblems(pkg), []);

			const problems = buildFreshnessProblems(pkg, { checkSelf: true });
			assert.equal(problems.length, 1);
			assert.match(problems[0], /^plugin: dist is stale/);
			assert.ok(problems[0].includes(`Run in ${root}: yarn workspace plugin clean && yarn workspace plugin build`), problems[0]);
		});

		it('also handles the dist/src layout, and stays quiet when the package is built', () => {
			const root = tempRoot();
			writeManifest(root, { name: 'fixture-root', private: true, workspaces: ['packages/*'] });
			const fresh = writePackage(join(root, 'packages', 'fresh'), { name: 'fresh', srcAt: OLD, distAt: NEW });
			const stale = writePackage(join(root, 'packages', 'stale'), { name: 'stale', srcAt: NEW, distAt: OLD });

			assert.deepEqual(buildFreshnessProblems(fresh, { checkSelf: true }), []);
			assert.equal(buildFreshnessProblems(stale, { checkSelf: true }).length, 1);
		});
	});
});

describe('checkBuildFreshness', () => {
	it('compares the whole output tree, not the entry point alone', () => {
		// Under `incremental` an untouched entry point keeps its old mtime across a rebuild. Judged
		// by the entry alone such a package reads stale forever, and `yarn build` never clears it.
		const pkg = writePackage(join(tempRoot(), 'pkg'), { name: 'pkg', srcAt: NEW, distAt: OLD });
		assert.equal(checkBuildFreshness(pkg, 'dist/src/index.js'), 'stale');

		write(join(pkg, 'dist', 'src', 'other.js'), 'export const y = 2;\n', Date.now());
		assert.equal(checkBuildFreshness(pkg, 'dist/src/index.js'), undefined);
	});
});

describe('assertBuildFresh, as register.mjs calls it', () => {
	/** A workspace whose `register.mjs` guards a stale `dep-a`, ready to run under `--import`. */
	function stalePackageWithRegister() {
		const { consumerDir } = writeRepo({ dep: { srcAt: NEW, distAt: OLD } });
		const registerPath = join(consumerDir, 'register.mjs');
		write(registerPath,
			`import { assertBuildFresh } from ${JSON.stringify(MODULE_URL)};\n` +
			'assertBuildFresh(import.meta.url);\n');
		return registerPath;
	}

	function run(registerPath, extraEnv) {
		const env = { ...process.env, OPTIMYSTIC_SKIP_BUILD_CHECK: '', ...extraEnv };
		return spawnSync(process.execPath, [
			'--import', pathToFileURL(registerPath).href,
			'-e', 'console.log("MAIN RAN")'
		], { encoding: 'utf8', env });
	}

	it('aborts with exit code 1 before the main entry module runs', () => {
		// Exit code 1 is what makes `yarn workspaces foreach -At` halt rather than carry on to the
		// next package, and `--import` is the only hook early enough to beat the first spec import.
		const result = run(stalePackageWithRegister());

		assert.equal(result.status, 1);
		assert.ok(!result.stdout.includes('MAIN RAN'), result.stdout);
		assert.match(result.stderr, /^Stale build detected: these tests run real compiled output\./m);
		assert.match(result.stderr, /^ {2}- dep-a: dist is stale/m);
	});

	it('skips loudly when OPTIMYSTIC_SKIP_BUILD_CHECK is set', () => {
		// The warning prints on every run so a hatch left set in a shell profile stays visible
		// rather than silently killing the guard forever.
		const result = run(stalePackageWithRegister(), { OPTIMYSTIC_SKIP_BUILD_CHECK: '1' });

		assert.equal(result.status, 0);
		assert.ok(result.stdout.includes('MAIN RAN'), result.stdout);
		assert.match(result.stderr, /^build-freshness: skipped by OPTIMYSTIC_SKIP_BUILD_CHECK$/m);
		assert.ok(!result.stderr.includes('Stale build detected'), result.stderr);
	});

	it('lets a fresh package through', () => {
		const { consumerDir } = writeRepo({ dep: { srcAt: OLD, distAt: NEW } });
		const registerPath = join(consumerDir, 'register.mjs');
		write(registerPath,
			`import { assertBuildFresh } from ${JSON.stringify(MODULE_URL)};\n` +
			'assertBuildFresh(import.meta.url);\n');

		const result = run(registerPath);

		assert.equal(result.status, 0);
		assert.ok(result.stdout.includes('MAIN RAN'), result.stdout);
		assert.equal(result.stderr, '');
	});
});

describe('this repository', () => {
	it('finds its own workspace root from the harness directory', () => {
		const here = dirname(fileURLToPath(import.meta.url));

		assert.equal(findWorkspaceRoot(here), dirname(here));
	});
});
