/**
 * Tests for the undeclared-dependency guard (`scripts/check-undeclared-deps.mjs`), run by node's
 * built-in test runner (`yarn test:harness` at the repository root).
 *
 * The guard is a script, not a module — it calls `run()` at import time and sets the exit code — so
 * every case here spawns it as a subprocess against a throwaway fixture instead of importing it.
 * Each fixture is a real `git init` tree under the OS temp directory, because the guard takes its
 * file list from `git ls-files` and refuses to scan a plain directory. Nothing is committed: the
 * `--others --exclude-standard` half of that listing already covers untracked files, which keeps
 * the fixtures free of any need for a configured committer identity.
 *
 * The two regressions pinned here pull in opposite directions, and a change that fixes either one
 * carelessly breaks the other:
 *
 *   - a quoted string *ending* in the word `import` (`spawnSync(execPath, ['--import', mod])`) must
 *     not read as an import statement — the guard used to report a package named `, ` for it;
 *   - a file's *first* import must still be found when the file opens with a UTF-8 BOM, which sits
 *     between the start of the text and the keyword the statement-start anchor looks for.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const GUARD = fileURLToPath(new URL('../scripts/check-undeclared-deps.mjs', import.meta.url));

const roots = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fresh temp directory that is a git repository, removed when this file's tests finish. */
function tempRepo() {
	const root = mkdtempSync(join(tmpdir(), 'optimystic-undeclared-deps-'));
	roots.push(root);
	execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
	return root;
}

function write(root, relPath, content) {
	const full = join(root, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
}

/**
 * A fixture with one workspace, `packages/<name>`, declaring `deps` and holding `files`.
 *
 * Keys of `files` are paths relative to the package directory; a value may start with `﻿` to
 * give that file a UTF-8 BOM.
 */
function fixture({ name = 'probe', deps = {}, files }) {
	const root = tempRepo();
	write(root, `packages/${name}/package.json`, JSON.stringify({ name: `@fixture/${name}`, dependencies: deps }, null, 2));
	for (const [rel, content] of Object.entries(files)) write(root, `packages/${name}/${rel}`, content);
	return root;
}

/** Run the guard against a fixture root. */
function runGuard(root) {
	const res = spawnSync(process.execPath, [GUARD], { cwd: root, encoding: 'utf8' });
	assert.equal(res.error, undefined, `spawning the guard failed: ${res.error?.message}`);
	return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe('check-undeclared-deps', () => {
	it('passes a workspace whose every import is declared or a builtin', () => {
		const root = fixture({
			deps: { chai: '^5.0.0' },
			files: {
				'test/a.spec.ts': [
					"import { expect } from 'chai';",
					"import { spawnSync } from 'node:child_process';",
					"import { thing } from '../src/thing.js';",
					'export { expect, spawnSync, thing };',
					''
				].join('\n')
			}
		});

		const { status, out } = runGuard(root);
		assert.equal(status, 0, `expected a clean run, got:\n${out}`);
		assert.match(out, /every import is declared/);
	});

	it('reports an undeclared package', () => {
		const root = fixture({ files: { 'src/a.ts': "import x from 'not-declared';\nexport { x };\n" } });

		const { status, out } = runGuard(root);
		assert.equal(status, 1, `expected a finding, got:\n${out}`);
		assert.match(out, /`not-declared` is not declared/);
	});

	// The regression: `\bimport` matched inside the string `'--import'`, whose *closing* quote then
	// read as a specifier's opening quote, so the `, ` before the next argument was reported as an
	// undeclared package. Modelled on `packages/db-p2p/test/module-load-globals.spec.ts`, which
	// spawns a probe process exactly this way.
	it('does not read a quoted string ending in `import` as an import statement', () => {
		const root = fixture({
			deps: { chai: '^5.0.0' },
			files: {
				'test/spawn.spec.ts': [
					"import { expect } from 'chai';",
					"import { spawnSync } from 'node:child_process';",
					'',
					"const run = spawnSync(process.execPath, ['--import', './register.mjs', PROBE], {",
					"\tencoding: 'utf8'",
					'});',
					'expect(run.status).to.equal(0);',
					''
				].join('\n')
			}
		});

		const { status, out } = runGuard(root);
		assert.equal(status, 0, `expected a clean run, got:\n${out}`);
		assert.doesNotMatch(out, /is not declared/);
	});

	// The counterweight: anchoring the import patterns to a statement start must not lose a BOM'd
	// file's first import, since the BOM precedes the keyword. Two first-party files carry one
	// (`packages/db-p2p-storage-fs/src/{logger,index}.ts`).
	it('still finds the first import of a file that opens with a UTF-8 BOM', () => {
		const root = fixture({
			files: {
				'src/bom.ts': '﻿' + "import debug from 'not-declared-bom';\nexport { debug };\n",
				'src/bom-side-effect.ts': '﻿' + "import 'not-declared-bom-side-effect';\n",
				'src/bom-star.ts': '﻿' + "export * from 'not-declared-bom-star';\n"
			}
		});

		const { status, out } = runGuard(root);
		assert.equal(status, 1, `expected findings, got:\n${out}`);
		for (const pkg of ['not-declared-bom', 'not-declared-bom-side-effect', 'not-declared-bom-star']) {
			assert.match(out, new RegExp(`\`${pkg}\` is not declared`));
		}
	});

	it('finds an undeclared import in every statement shape it accepts', () => {
		const root = fixture({
			files: {
				'src/shapes.ts': [
					"import a from 'undeclared-default';",
					"import 'undeclared-side-effect';",
					"\timport c from 'undeclared-indented';",
					"const x = 1; import e from 'undeclared-after-semicolon';",
					'import {',
					'\tf,',
					"} from 'undeclared-multiline';",
					"export * from 'undeclared-star';",
					"const h = await import('undeclared-dynamic');",
					"const i = require('undeclared-require');",
					'export { a, c, e, f, h, i, x };',
					''
				].join('\n')
			}
		});

		const { status, out } = runGuard(root);
		assert.equal(status, 1, `expected findings, got:\n${out}`);
		for (const pkg of [
			'undeclared-default',
			'undeclared-side-effect',
			'undeclared-indented',
			'undeclared-after-semicolon',
			'undeclared-multiline',
			'undeclared-star',
			'undeclared-dynamic',
			'undeclared-require'
		]) {
			assert.match(out, new RegExp(`\`${pkg}\` is not declared`));
		}
	});

	// `stripCommentsAndTemplates` blanks comments and template literals precisely so prose that
	// reads like an import cannot raise a finding.
	it('ignores import-shaped text in comments and template literals', () => {
		const root = fixture({
			files: {
				'src/prose.ts': [
					"// import ghost from 'commented-out';",
					'/**',
					" * Example: `import thing from 'jsdoc-example';`",
					' */',
					"const snippet = `import templated from 'in-a-template';`;",
					'export { snippet };',
					''
				].join('\n')
			}
		});

		const { status, out } = runGuard(root);
		assert.equal(status, 0, `expected a clean run, got:\n${out}`);
		assert.doesNotMatch(out, /is not declared/);
	});
});
