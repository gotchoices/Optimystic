import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for entry-point drift between the two published entries.
//
// `src/index.ts` is the Node entry; `src/rn.ts` is what React Native and browsers get
// (`package.json` routes the `react-native` condition on `.` there, plus the explicit `./rn`
// subpath). Nothing used to keep them in step, so `withReadCache` went missing from `rn.ts` and
// surfaced as a *downstream build failure* rather than as anything red in this repo.
//
// The guard works at module-specifier granularity on the source text, deliberately. A runtime
// `Object.keys(namespace)` comparison would only see *value* exports, and the sharpest reported
// gaps — `BlockCommitProof` and `IKVStore` — are type-only, so they erase at runtime and would
// sail straight past such a check. A "does it bundle?" check has no discriminating power either:
// bundling the *Node* entry under react-native/browser conditions succeeds cleanly, because
// `@libp2p/tcp` ships a `browser` field remapping to a stub that throws only when constructed.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_ENTRY = 'src/index.ts';
const RN_ENTRY = 'src/rn.ts';

/** Modules deliberately present on only one entry, mapped to the reason. Empty by design: every
 *  module in db-p2p is browser-safe except the libp2p transport wiring, and that asymmetry is
 *  handled by ENTRY_SUBSTITUTIONS below rather than by exclusion. This is the seam a genuinely
 *  Node-only module would get added to — its emptiness is the point. */
const NODE_ONLY: ReadonlyMap<string, string> = new Map();

/** The one intended asymmetry: the Node entry wires TCP/WebSocket transports, the RN entry does
 *  not. Both modules export exactly the same names (`createLibp2pNode`, `Libp2pTransports`,
 *  `NodeOptions`, `RawStorageProvider`), so this is invisible at the export-name level and has to
 *  be modelled as a mapping — a plain set diff would report it as two spurious findings. */
const ENTRY_SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
	['./libp2p-node.js', './libp2p-node-rn.js']
]);

/** `export * from './x.js';`, tolerating either quote style and a trailing `// note`. Anchored so
 *  anything else on the line fails the shape assertion below. */
const STAR_EXPORT_RE = /^export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?\s*(?:\/\/.*)?$/;

type Entry = { readonly file: string; readonly specifiers: readonly string[]; readonly stray: readonly string[] };

/** Parse an entry file into its `export *` specifiers plus any line that is not one. Block
 *  comments are stripped first; line comments and blank lines are skipped. Matching the quoted
 *  specifier as a unit means a `//` *inside* a specifier can never be mistaken for a comment. */
function readEntry(relative: string): Entry {
	const source = fs
		.readFileSync(path.join(packageRoot, relative), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '');
	const specifiers: string[] = [];
	const stray: string[] = [];

	for (const raw of source.split('\n')) {
		const line = raw.trim();
		if (line === '' || line.startsWith('//')) continue;
		const match = STAR_EXPORT_RE.exec(line);
		if (match?.[1] !== undefined) specifiers.push(match[1]);
		else stray.push(line);
	}
	return { file: relative, specifiers, stray };
}

/** `./cluster/client.js` in `src/rn.ts` → the source file it actually resolves to, or undefined. */
function resolveSpecifier(entryFile: string, specifier: string): string | undefined {
	const base = path.resolve(packageRoot, path.dirname(entryFile), specifier);
	const candidates = [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base];
	return candidates.find(candidate => fs.existsSync(candidate));
}

describe('entry point parity', () => {
	const node = readEntry(NODE_ENTRY);
	const rn = readEntry(RN_ENTRY);

	// Specifier-set equality only implies export-name equality while every line is `export *`. A
	// selective `export { x }` would silently break that implication, so fail loudly instead.
	for (const entry of [node, rn]) {
		it(`${entry.file} contains only \`export * from\` lines`, () => {
			expect(
				entry.stray,
				`${entry.file} has line(s) this spec cannot compare. Keep the entry to plain ` +
					'`export * from` lines, or extend entry-parity.spec.ts to handle the new shape ' +
					'— otherwise specifier equality stops implying export-name equality.'
			).to.deep.equal([]);
			expect(entry.specifiers.length).to.be.greaterThan(0);
		});
	}

	it('declares substitutions that both entries actually use', () => {
		const nodeSet = new Set(node.specifiers);
		const rnSet = new Set(rn.specifiers);
		for (const [nodeSpecifier, rnSpecifier] of ENTRY_SUBSTITUTIONS) {
			expect(
				nodeSet.has(nodeSpecifier),
				`ENTRY_SUBSTITUTIONS maps "${nodeSpecifier}" but ${NODE_ENTRY} does not export it — ` +
					'the mapping has rotted (rename?) and is now a no-op'
			).to.equal(true);
			expect(
				rnSet.has(rnSpecifier),
				`ENTRY_SUBSTITUTIONS maps to "${rnSpecifier}" but ${RN_ENTRY} does not export it — ` +
					'the mapping has rotted (rename?) and is now a no-op'
			).to.equal(true);
		}
	});

	it('declares NODE_ONLY entries that the Node entry actually exports', () => {
		const nodeSet = new Set(node.specifiers);
		for (const [specifier, reason] of NODE_ONLY) {
			expect(
				nodeSet.has(specifier),
				`NODE_ONLY excludes "${specifier}" (${reason}) but ${NODE_ENTRY} does not export it`
			).to.equal(true);
		}
	});

	it('re-exports the same modules from both entries', () => {
		// Project the Node set onto RN's naming, then drop the deliberate exclusions.
		const expected = new Set(
			node.specifiers
				.filter(specifier => !NODE_ONLY.has(specifier))
				.map(specifier => ENTRY_SUBSTITUTIONS.get(specifier) ?? specifier)
		);
		const actual = new Set(rn.specifiers);

		// Reported separately: "in index.ts but not rn.ts" is the drift that broke the downstream
		// build, but the reverse direction is real drift too and is currently also empty.
		expect(
			[...expected].filter(specifier => !actual.has(specifier)).sort(),
			`exported from ${NODE_ENTRY} but missing from ${RN_ENTRY} — React Native and browser ` +
				'consumers cannot import these. Add them to rn.ts, or add them to NODE_ONLY with a reason.'
		).to.deep.equal([]);
		expect(
			[...actual].filter(specifier => !expected.has(specifier)).sort(),
			`exported from ${RN_ENTRY} but missing from ${NODE_ENTRY} — Node consumers cannot import ` +
				'these. Add them to index.ts, or declare the asymmetry in ENTRY_SUBSTITUTIONS/NODE_ONLY.'
		).to.deep.equal([]);
	});

	// Cheap, and catches a typo'd re-export that `export *` would otherwise only surface at build
	// time (or, for the RN entry, in a downstream consumer's build).
	for (const entry of [node, rn]) {
		it(`${entry.file} re-exports only specifiers that exist on disk`, () => {
			const missing = entry.specifiers.filter(
				specifier => resolveSpecifier(entry.file, specifier) === undefined
			);
			expect(missing.sort(), `${entry.file} re-exports non-existent module(s)`).to.deep.equal([]);
		});
	}
});
