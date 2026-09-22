/**
 * Writes `fixtures/<version>/<backend>.json` for every storage backend the writer knows: the data a
 * PUBLISHED build leaves behind after running the upgrade-check scenario, packed into one file with
 * the manifest describing it.
 *
 *   yarn workspace @optimystic/upgrade-check write-fixture <version> [--force]
 *
 * Needs the network (it installs `@optimystic/*@<version>` from npm into a scratch directory) and
 * is run by a person, at release time — see readme.md. The suite that reads the fixtures needs
 * neither.
 *
 * The installed build is checked before it writes anything: every `@optimystic/*` package must be
 * present exactly once and at exactly `<version>`. Our packages depend on each other by caret range,
 * so a plain install of `@optimystic/quereus-plugin-optimystic@1.0.0-beta.3` resolves
 * `@optimystic/db-core@1.2.0` underneath it, and the fixture would describe a build nobody shipped.
 * The scratch manifest pins them with `overrides`; the check proves the pin held.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { openClassicLevel } from '../writer/classic-level.mjs';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WRITER_DIR = join(PACKAGE_DIR, 'writer');
const WRITER_FILES = ['write-scenario.mjs', 'classic-level.mjs'];
const FIXTURES_DIR = join(PACKAGE_DIR, 'fixtures');
const RN_BACKEND_MANIFEST = join(PACKAGE_DIR, '..', 'db-p2p-storage-rn', 'package.json');

/** Everything the writer imports from `@optimystic`, installed at exactly the fixture's version. */
const OPTIMYSTIC_PACKAGES = [
	'@optimystic/db-core',
	'@optimystic/db-p2p',
	'@optimystic/db-p2p-storage-fs',
	'@optimystic/db-p2p-storage-rn',
	'@optimystic/quereus-plugin-optimystic',
];
/** Resolved by npm from the published manifests, and recorded in the fixture as what wrote it. */
const THIRD_PARTY_PACKAGES = ['@quereus/quereus', 'p2p-fret', 'libp2p', '@libp2p/crypto', 'classic-level'];

/** How each backend's data is read back into a fixture; the names match `BACKENDS` in the writer. */
const PACKERS = {
	fs: async dataDir => ({ files: packDirectory(dataDir) }),
	leveldb: async (dataDir, manifest) => ({ entries: await packLevelDB(join(dataDir, manifest.storage.path)) }),
};

class FixtureError extends Error { }

try {
	await writeFixtures(process.argv.slice(2));
} catch (err) {
	if (!(err instanceof FixtureError)) {
		throw err;
	}
	console.error(`write-fixture: ${err.message}`);
	process.exitCode = 1;
}

async function writeFixtures(args) {
	const force = args.includes('--force');
	const version = args.find(arg => !arg.startsWith('--'));
	if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
		throw new FixtureError('usage: write-fixture <published version, e.g. 1.2.0> [--force]');
	}
	const versionDir = join(FIXTURES_DIR, version);
	if (existsSync(versionDir) && !force) {
		throw new FixtureError(`${relative(process.cwd(), versionDir)} exists. A fixture is what that release wrote; regenerate it only on purpose, with --force.`);
	}

	const scratch = mkdtempSync(join(tmpdir(), `optimystic-upgrade-check-${version}-`));
	try {
		installPublishedBuild(scratch, version);
		const writtenBy = { ...verifyInstalledBuild(scratch, version), node: process.version };
		for (const file of WRITER_FILES) {
			copyFileSync(join(WRITER_DIR, file), join(scratch, file));
		}
		mkdirSync(versionDir, { recursive: true });
		for (const [backend, pack] of Object.entries(PACKERS)) {
			const dataDir = join(scratch, `data-${backend}`);
			const manifestPath = join(scratch, `manifest-${backend}.json`);
			run(process.execPath, ['write-scenario.mjs', backend, dataDir, manifestPath], scratch);
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
			const described = { ...manifest, writtenBy, writtenOn: new Date().toISOString().slice(0, 10) };
			const fixturePath = join(versionDir, `${backend}.json`);
			writeFileSync(fixturePath, serializeFixture(described, await pack(dataDir, manifest)));
			console.log(`wrote ${relative(process.cwd(), fixturePath)}`);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function installPublishedBuild(dir, version) {
	const pinned = Object.fromEntries(OPTIMYSTIC_PACKAGES.map(name => [name, version]));
	writeFileSync(join(dir, 'package.json'), JSON.stringify({
		name: 'optimystic-upgrade-check-writer',
		private: true,
		type: 'module',
		dependencies: {
			...pinned,
			'@quereus/quereus': publishedPeerRange('@optimystic/quereus-plugin-optimystic', version, '@quereus/quereus'),
			// The LevelDB binding the React Native backend's own suite runs on, at that suite's range.
			'classic-level': JSON.parse(readFileSync(RN_BACKEND_MANIFEST, 'utf8')).devDependencies['classic-level'],
		},
		overrides: pinned,
	}, null, '\t'));
	// npm, not yarn: this directory is outside the workspace and must resolve exactly as a consumer's
	// install of the published packages would. `--legacy-peer-deps` because the React Native backend
	// names `rn-leveldb` as a peer, which names React Native, and nothing here runs either; the one
	// peer the writer does need, Quereus, is listed above at the plugin's published range.
	run('npm install --no-audit --no-fund --legacy-peer-deps --loglevel=error', [], dir);
}

/** The range `name@version`'s published manifest declares for its peer dependency `peer`. */
function publishedPeerRange(name, version, peer) {
	const result = spawnSync(`npm view ${name}@${version} peerDependencies --json`, { shell: true, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new FixtureError(`npm view ${name}@${version} failed — is ${version} published?\n${result.stderr}`);
	}
	const range = JSON.parse(result.stdout)[peer];
	if (typeof range !== 'string') {
		throw new FixtureError(`${name}@${version} declares no peer dependency on ${peer}`);
	}
	return range;
}

/** The version of every package the fixture depends on, after proving the `@optimystic` pin held. */
function verifyInstalledBuild(dir, version) {
	const found = new Map();
	for (const manifestPath of findPackageManifests(join(dir, 'node_modules'))) {
		const { name, version: installed } = JSON.parse(readFileSync(manifestPath, 'utf8'));
		if (typeof name === 'string' && (name.startsWith('@optimystic/') || THIRD_PARTY_PACKAGES.includes(name))) {
			found.set(name, [...(found.get(name) ?? []), installed]);
		}
	}
	const problems = [];
	for (const [name, versions] of found) {
		if (name.startsWith('@optimystic/') && (versions.length !== 1 || versions[0] !== version)) {
			problems.push(`${name}: installed ${versions.join(', ')}, expected exactly ${version}`);
		}
	}
	for (const name of [...OPTIMYSTIC_PACKAGES, ...THIRD_PARTY_PACKAGES]) {
		if (!found.has(name)) {
			problems.push(`${name}: not installed`);
		}
	}
	if (problems.length > 0) {
		throw new FixtureError(`the scratch install is not the published ${version} build:\n  ${problems.join('\n  ')}`);
	}
	return Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)).map(([name, versions]) => [name, versions.join(', ')]));
}

/** Every `package.json` of an installed package under `nodeModules`, nested installs included. */
function findPackageManifests(nodeModules) {
	const manifests = [];
	const visit = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) {
				continue;
			}
			const child = join(dir, entry.name);
			if (entry.name.startsWith('@')) {
				visit(child);
				continue;
			}
			if (existsSync(join(child, 'package.json'))) {
				manifests.push(join(child, 'package.json'));
			}
			if (existsSync(join(child, 'node_modules'))) {
				visit(join(child, 'node_modules'));
			}
		}
	};
	visit(nodeModules);
	return manifests;
}

/**
 * Every file under `root`, keyed by its `/`-separated path relative to `root`, sorted. Directories
 * are not recorded: every read in the filesystem backend treats a missing directory as empty.
 */
function packDirectory(root) {
	const files = {};
	const visit = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.isFile()) {
				files[relative(root, path).split(sep).join('/')] = packBytes(readFileSync(path));
			}
		}
	};
	visit(root);
	return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Every key and value in the database at `path`, in key order, the key as hex. */
async function packLevelDB(path) {
	const db = await openClassicLevel(path);
	const iterator = db.iterator();
	const entries = [];
	try {
		for (let entry = await iterator.next(); entry; entry = await iterator.next()) {
			entries.push([Buffer.from(entry[0]).toString('hex'), packBytes(entry[1])]);
		}
	} finally {
		await iterator.close();
		await db.close();
	}
	return entries;
}

/**
 * One stored value, in the most readable form that gives back exactly these bytes: the parsed value
 * when the bytes are JSON that `JSON.stringify` reproduces byte for byte, else the UTF-8 text, else
 * base64. `test/fixture.ts` turns each back into the bytes read here.
 */
function packBytes(bytes) {
	let text;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch (err) {
		if (!(err instanceof TypeError)) {
			throw err;
		}
		return { base64: Buffer.from(bytes).toString('base64') };
	}
	try {
		const value = JSON.parse(text);
		if (JSON.stringify(value) === text) {
			return { json: value };
		}
	} catch (err) {
		if (!(err instanceof SyntaxError)) {
			throw err;
		}
	}
	return { text };
}

/**
 * The fixture as `{ manifest, files }` or `{ manifest, entries }`, one stored value per line: the
 * manifest is for a person to read, the stored values for a diff to show which ones changed.
 */
function serializeFixture(manifest, { files, entries }) {
	const manifestText = JSON.stringify(manifest, null, '\t').replace(/\n/g, '\n\t');
	const store = files
		? `"files": {\n${Object.entries(files).map(([path, packed]) => `\t\t${JSON.stringify(path)}: ${JSON.stringify(packed)}`).join(',\n')}\n\t}`
		: `"entries": [\n${entries.map(entry => `\t\t${JSON.stringify(entry)}`).join(',\n')}\n\t]`;
	return `{\n\t"manifest": ${manifestText},\n\t${store}\n}\n`;
}

/**
 * Run `command` in `cwd`, inheriting stdio. With no `commandArgs` the command is one string run by
 * the shell — how `npm` is started, since on Windows it is a `.cmd` shim that cannot be spawned
 * directly, and Node refuses to pass an argument array through a shell. Only literal commands
 * written in this file go that way.
 */
function run(command, commandArgs, cwd) {
	const result = commandArgs.length === 0
		? spawnSync(command, { cwd, stdio: 'inherit', shell: true })
		: spawnSync(command, commandArgs, { cwd, stdio: 'inherit' });
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new FixtureError(`${command} ${commandArgs.join(' ')} exited with status ${result.status}`);
	}
}
