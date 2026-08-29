import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkRuntimeGraph } from './support/source-graph.js';

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
				for (const pkg of walkRuntimeGraph(entryFile).packages) {
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
