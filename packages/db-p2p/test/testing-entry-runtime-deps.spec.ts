import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';

// Regression guard for the `chai`-in-the-`./testing`-barrel bug: `src/testing/index.ts` used to
// re-export `raw-storage-conformance.ts`, which imports `chai` — a devDependency consumers never
// install — so any consumer importing `@optimystic/db-p2p/testing` crashed at import time.
//
// Every published `exports` subpath must be reachable using only runtime `dependencies`. This
// walks the *source* graph (not `dist`, so the guard holds whether or not the package is built)
// from each subpath's entry file and asserts every bare specifier it reaches resolves to a
// declared runtime dependency.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Subpaths that legitimately need devDependencies — test-only helpers, opted into explicitly. */
const DEV_ONLY_SUBPATHS = new Set(['./testing/conformance']);

type PackageManifest = {
	exports?: Record<string, unknown>;
	dependencies?: Record<string, string>;
};

const manifest = JSON.parse(
	fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
) as PackageManifest;

/** `./dist/src/testing/index.js` → absolute path of `src/testing/index.ts`. */
function sourceFileForDistTarget(target: string): string {
	const rel = target.replace(/^\.\//, '').replace(/^dist\//, '').replace(/\.js$/, '.ts');
	return path.join(packageRoot, rel);
}

/** Every distinct `dist/**.js` target an exports entry can resolve to, across all conditions. */
function distTargets(entry: unknown): string[] {
	if (typeof entry === 'string') return [entry];
	if (entry === null || typeof entry !== 'object') return [];
	return Object.entries(entry as Record<string, unknown>)
		.filter(([condition]) => condition !== 'types')
		.flatMap(([, value]) => distTargets(value));
}

/** `@libp2p/crypto/keys` → `@libp2p/crypto`; `it-all` → `it-all`. */
function packageNameOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/** Specifiers whose module is actually loaded at runtime. `verbatimModuleSyntax` erases only
 *  whole-statement `import type` / `export type`, so inline `{ type X }` still loads the module. */
function runtimeSpecifiers(source: string): string[] {
	const found: string[] = [];
	for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
		re.lastIndex = 0;
		for (const match of source.matchAll(re)) {
			const specifier = match[1];
			if (specifier !== undefined) found.push(specifier);
		}
	}
	return found;
}

/** Bare package names transitively reachable at runtime from `entryFile`. */
function reachablePackages(entryFile: string): Set<string> {
	const packages = new Set<string>();
	const visited = new Set<string>();
	const queue = [entryFile];

	while (queue.length > 0) {
		const file = queue.pop()!;
		if (visited.has(file)) continue;
		visited.add(file);
		if (!fs.existsSync(file)) continue;

		for (const specifier of runtimeSpecifiers(fs.readFileSync(file, 'utf8'))) {
			if (specifier.startsWith('.')) {
				queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')));
			} else if (!isBuiltin(specifier)) {
				packages.add(packageNameOf(specifier));
			}
		}
	}
	return packages;
}

describe('published exports entries', () => {
	const runtimeDeps = new Set(Object.keys(manifest.dependencies ?? {}));
	const subpaths = Object.entries(manifest.exports ?? {}).filter(
		([subpath]) => !DEV_ONLY_SUBPATHS.has(subpath)
	);

	it('declares at least one consumer-facing subpath', () => {
		expect(subpaths.length).to.be.greaterThan(0);
	});

	for (const [subpath, entry] of subpaths) {
		it(`"${subpath}" reaches only runtime dependencies`, () => {
			const leaked = new Set<string>();
			for (const target of distTargets(entry)) {
				const entryFile = sourceFileForDistTarget(target);
				expect(fs.existsSync(entryFile), `missing source for ${target}`).to.equal(true);
				for (const pkg of reachablePackages(entryFile)) {
					if (!runtimeDeps.has(pkg)) leaked.add(pkg);
				}
			}
			expect(
				[...leaked].sort(),
				`"${subpath}" transitively imports package(s) that are not runtime dependencies`
			).to.deep.equal([]);
		});
	}
});
