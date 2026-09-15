#!/usr/bin/env node
/**
 * Undeclared-dependency guard — fails when a workspace's source, tests or config files import a
 * package that workspace's own `package.json` never lists.
 *
 * `packages/db-core/test/reactivity/recover.spec.ts` imported `@noble/curves/ed25519.js` while
 * `db-core`'s manifest declared only `@noble/hashes`. It built anyway, because the tree's untracked
 * `.yarnrc.yml` selects Yarn's `node_modules` linker, which happens to nest a copy of `@noble/curves`
 * under `packages/db-core/node_modules` for one of db-core's libp2p dependencies. A checkout that
 * installs with Yarn's default Plug'n'Play linker enforces declared dependencies strictly and fails
 * immediately with `Cannot find module '@noble/curves/ed25519.js'` (gotchoices/Optimystic, filed as
 * `a-package-can-import-a-dependency-it-does-not-declare`). Nothing else in the toolchain notices:
 * TypeScript resolves through whatever `node_modules` layout it is given, and `yarn constraints`
 * only looks at declared ranges, never at what source actually imports.
 *
 * This script reads every workspace's own manifest, walks every tracked JS/TS file under that
 * workspace (`src/`, `test/`, and root files like `register.mjs` or `tsup.config.ts`) for static
 * import/re-export/dynamic-import/require specifiers, and flags any bare (non-relative,
 * non-builtin) specifier whose package name is not in that workspace's `dependencies`,
 * `devDependencies`, `peerDependencies` or `optionalDependencies`.
 *
 * Following `check-doc-citations.mjs` and `check-libp2p-majors.mjs`: plain .mjs, no dependencies,
 * no build step. Wired into `yarn lint:deps`, chained into `yarn check`.
 *
 * NOTE: accepted tradeoff — this is a standalone script, not an ESLint rule
 * (`eslint-plugin-import`'s `no-extraneous-dependencies` is the closest fit). That plugin adds a new
 * dependency, needs resolver configuration to follow this repo's NodeNext-style subpath specifiers
 * (e.g. `@noble/curves/ed25519.js`), and its flat-config support has been uneven; `eslint.config.js`
 * also deliberately stays off the `typescript-eslint`/`@eslint/js` recommended presets (see its SCOPE
 * comment), so a plugin rule would be the first of its kind here. A standalone script matching the
 * sibling guards' pattern was faster to get right and easier to audit. Revisit if a maintained rule
 * later covers this cleanly without those costs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { stdout, stderr, exit, argv } from 'node:process';

/** Tracked (and staged-but-uncommitted) files, straight from git — never a filesystem walk, so a
 * stray local `node_modules` or `dist` never gets scanned as if it were source. */
function trackedFiles() {
	let raw;
	try {
		raw = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	} catch (err) {
		stderr.write('check-undeclared-deps: could not run `git ls-files`. This check needs a git working\n');
		stderr.write('tree (a tarball export will not do). Underlying error:\n');
		stderr.write(`  ${err && err.message ? err.message : String(err)}\n`);
		exit(1);
	}
	// A conflicted merge lists a path once per index stage; dedupe so it is not reported three times.
	return [...new Set(raw.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')))];
}

const SOURCE_FILE_RE = /^packages\/([^/]+)\/.*\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

/** The Node builtins a bare specifier may legitimately name, with or without the `node:` prefix. */
const BUILTIN_NAMES = new Set(builtinModules.filter((m) => !m.startsWith('_')));

// -- Extracting import specifiers -------------------------------------------------------------

// Static `import ... from 'x'` / `export ... from 'x'`, including multi-line named-import lists —
// the `[^'";]*?` gap excludes quotes and semicolons, so it cannot cross into a neighbouring
// statement, but happily spans the newlines inside a brace list.
const FROM_IMPORT_RE = /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g;
// Side-effect-only `import 'x'` (no `from`).
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
// Dynamic `import('x')`.
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]/g;
// `require('x')` — this repo is ESM-first, but a stray CommonJS require is still worth catching.
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]/g;

// Quoted strings, template literals, line comments and block comments, matched in one left-to-right
// pass so whichever opens first wins — a backtick inside a `//` comment, or `/*` inside a glob
// string, cannot swallow the real code that follows it.
const LEXEME_RE = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Blank comments and template literals, preserving line breaks and length. Both host free-form prose
 * that can read as an import statement — a JSDoc `{@link import("pkg").thing}`, or a spec's fixture
 * array of import-syntax strings (`packages/db-core/test/no-fret-import.spec.ts`). Plain
 * `'...'`/`"..."` strings are kept: that is the shape a real import specifier takes.
 *
 * NOTE: regex literals are not recognised. One containing a quote is harmless (at worst the rest of
 * its line reads as a string), but one containing a backtick, `//` or `/*` can blank real code after
 * it and hide an import. None do today — the extracted specifiers matched TypeScript's
 * `ts.preProcessFile` on every scanned file at review time; if a miss is ever suspected, re-run that
 * comparison, or switch extraction to `ts.preProcessFile` outright.
 */
function stripCommentsAndTemplates(text) {
	return text.replace(LEXEME_RE, (m) => (m[0] === "'" || m[0] === '"' ? m : m.replace(/[^\n]/g, ' ')));
}

function extractSpecifiers(text) {
	const specifiers = new Set();
	for (const re of [FROM_IMPORT_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
		re.lastIndex = 0;
		let match;
		while ((match = re.exec(text)) !== null) specifiers.add(match[1]);
	}
	return specifiers;
}

/** The npm package name a bare specifier names, or null for a relative path, a builtin, or another URL scheme. */
function packageNameOf(specifier) {
	if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
	if (specifier.startsWith('node:')) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null; // data:, http:, etc — never an npm package
	const match = /^(@[^/]+\/[^/]+|[^@/][^/]*)/.exec(specifier);
	if (!match) return null;
	if (BUILTIN_NAMES.has(match[1])) return null;
	return match[1];
}

// -- Declared dependencies ------------------------------------------------------------------

function declaredNames(manifest) {
	const names = new Set([manifest.name]);
	for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
		for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
	}
	return names;
}

// -- The check -------------------------------------------------------------------------------

/** File text, or null for a path git still indexes but the working tree has deleted (not yet staged). */
function readSource(file) {
	try {
		return readFileSync(file, 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw err;
	}
}

function run() {
	const tracked = trackedFiles();
	const byPackage = new Map();
	for (const path of tracked) {
		const match = SOURCE_FILE_RE.exec(path);
		if (!match) continue;
		const pkgDir = `packages/${match[1]}`;
		if (!byPackage.has(pkgDir)) byPackage.set(pkgDir, []);
		byPackage.get(pkgDir).push(path);
	}

	if (byPackage.size === 0) {
		stderr.write('check-undeclared-deps: found zero packages/* JS/TS files to scan. That is a bug in\n');
		stderr.write('this script, not a clean tree — refusing to report success.\n');
		exit(1);
	}

	const findings = [];
	let filesScanned = 0;

	for (const [pkgDir, files] of [...byPackage].sort(([a], [b]) => a.localeCompare(b))) {
		const manifestPath = `${pkgDir}/package.json`;
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		} catch (err) {
			findings.push({ file: manifestPath, message: `could not read/parse this workspace's manifest: ${err.message}` });
			continue;
		}
		const declared = declaredNames(manifest);

		for (const file of files) {
			const raw = readSource(file);
			if (raw === null) continue;
			filesScanned++;
			const text = stripCommentsAndTemplates(raw);
			for (const specifier of extractSpecifiers(text)) {
				const pkgName = packageNameOf(specifier);
				if (pkgName === null || declared.has(pkgName)) continue;
				findings.push({ file, message: `imports \`${specifier}\` — \`${pkgName}\` is not declared in ${manifestPath}` });
			}
		}
	}

	findings.sort((a, b) => a.file.localeCompare(b.file) || a.message.localeCompare(b.message));
	for (const f of findings) stdout.write(`${f.file}: ${f.message}\n`);

	if (findings.length) {
		stdout.write(`\ncheck-undeclared-deps: ${findings.length} finding(s) across ${byPackage.size} packages.\n`);
		stdout.write('Add the package to the workspace\'s own dependencies/devDependencies/peerDependencies —\n');
		stdout.write('an import that only resolves because another workspace happens to hoist it is one\n');
		stdout.write('install layout away from breaking (see AGENTS.md § Dependencies).\n');
		exit(1);
	}
	stdout.write(`check-undeclared-deps: ${filesScanned} files across ${byPackage.size} packages — every import is declared.\n`);
}

if (argv.includes('--help') || argv.includes('-h')) {
	stdout.write('Usage: node scripts/check-undeclared-deps.mjs\n\n');
	stdout.write('Checks that every bare import in a workspace\'s tracked JS/TS files names a package that\n');
	stdout.write('workspace\'s own package.json declares, or a Node builtin. Exits non-zero, naming the\n');
	stdout.write('offending imports, when one is not. See AGENTS.md § Dependencies.\n');
	exit(0);
}

run();
