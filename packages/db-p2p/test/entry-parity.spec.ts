import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkRuntimeGraph } from './support/source-graph.js';

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

// NOTE: this spec compares the two entry *files*; it takes on faith that `package.json` still routes
// the `react-native` condition (and the `./rn` subpath) at `rn.ts`. Repoint or drop that condition
// and React Native silently gets the Node entry while everything here stays green. Not guarded
// because the exports map is stable, hand-edited config; if it starts changing, assert the routing
// here too — `testing-entry-runtime-deps.spec.ts` already parses the same manifest.

/** Modules deliberately present on only one entry, mapped to the reason. Empty by design: every
 *  module in db-p2p is browser-safe except the libp2p transport wiring, and that asymmetry is
 *  handled by ENTRY_SUBSTITUTIONS below rather than by exclusion. This is the seam a genuinely
 *  Node-only module would get added to — its emptiness is the point, and the builtin-reachability
 *  test at the bottom of this file is what keeps that emptiness honest. */
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

const EXPORT_LIST_RE = /export\s+(?:type\s+)?\{([^}]*)\}/g;
const EXPORT_DECL_RE =
	/export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_OPAQUE_RE = /export\s+(?:\*|default)[^\n]*/g;

/** Comments removed, so a commented-out `export` cannot be mistaken for a real one. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The names a single module declares as its own exports. Handles the two shapes the substituted
 *  modules use — `export { … }` / `export type { … }` lists, and `export <declaration> Name` — and
 *  reports anything it cannot attribute to a name (`export *`, `export default`) as unparsed, so a
 *  shape this cannot compare fails the spec rather than silently shrinking the compared set. */
function readExportedNames(absoluteFile: string): {
	readonly names: readonly string[];
	readonly unparsed: readonly string[];
} {
	const source = stripComments(fs.readFileSync(absoluteFile, 'utf8'));
	const names: string[] = [];

	for (const match of source.matchAll(EXPORT_LIST_RE)) {
		for (const item of (match[1] ?? '').split(',')) {
			// `x`, `type x`, and `x as y` all export the *last* identifier in the clause.
			const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
			if (name !== undefined && name !== '') names.push(name);
		}
	}
	for (const match of source.matchAll(EXPORT_DECL_RE)) {
		const name = match[1];
		if (name !== undefined) names.push(name);
	}

	return {
		names: [...new Set(names)].sort(),
		unparsed: [...source.matchAll(EXPORT_OPAQUE_RE)].map(match => match[0].trim())
	};
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
			// A repeated line is legal ESM but makes the set comparison below narrower than the
			// file it is comparing, which is how a stale duplicate hides a real edit.
			const duplicates = entry.specifiers.filter(
				(specifier, index) => entry.specifiers.indexOf(specifier) !== index
			);
			expect(
				[...new Set(duplicates)].sort(),
				`${entry.file} re-exports the same module more than once`
			).to.deep.equal([]);
		});
	}

	// The substitution is the one seam where specifier equality stops implying export-name
	// equality — the spec deliberately treats two *different* modules as interchangeable. Nothing
	// else checks they still export the same names, so an export added to `libp2p-node.ts` and not
	// to `libp2p-node-rn.ts` would reintroduce exactly the drift this file exists to catch, with
	// every other assertion here still green.
	for (const [nodeSpecifier, rnSpecifier] of ENTRY_SUBSTITUTIONS) {
		it(`${nodeSpecifier} and ${rnSpecifier} export the same names`, () => {
			const nodeFile = resolveSpecifier(NODE_ENTRY, nodeSpecifier);
			const rnFile = resolveSpecifier(RN_ENTRY, rnSpecifier);
			if (nodeFile === undefined || rnFile === undefined) {
				throw new Error(
					`ENTRY_SUBSTITUTIONS maps "${nodeSpecifier}" -> "${rnSpecifier}" but one of them does ` +
						'not resolve to a file on disk'
				);
			}

			const nodeExports = readExportedNames(nodeFile);
			const rnExports = readExportedNames(rnFile);
			expect(
				[...nodeExports.unparsed, ...rnExports.unparsed],
				'a substituted module uses an export shape this spec cannot compare by name. Extend ' +
					'readExportedNames — otherwise the substitution stops being name-invisible without ' +
					'anything going red.'
			).to.deep.equal([]);
			expect(nodeExports.names.length).to.be.greaterThan(0);
			expect(
				rnExports.names,
				`"${rnSpecifier}" is substituted for "${nodeSpecifier}", so the two must export the same ` +
					'names. They no longer do — React Native or Node consumers lose whichever names are ' +
					'missing from their side.'
			).to.deep.equal([...nodeExports.names]);
		});
	}

	// The assertions above prove the two entries expose the same *modules*. They say nothing about
	// whether those modules run under React Native, and `NODE_ONLY` being empty is the claim that
	// they do. This checks the half of that claim a test can actually settle: no first-party module
	// reachable from the RN entry imports a Node builtin. Node-only third-party *packages* stay
	// uncovered on purpose — `@libp2p/tcp` ships a browser stub that resolves and bundles cleanly
	// and throws only on construction, so no bundle- or manifest-based check can see them.
	it('reaches no Node builtin from the React Native entry', () => {
		const { builtins } = walkRuntimeGraph(path.join(packageRoot, RN_ENTRY));
		const offenders = [...builtins].map(
			([specifier, importers]) =>
				`${specifier} <- ${importers.map(file => path.relative(packageRoot, file)).join(', ')}`
		);
		expect(
			offenders.sort(),
			`${RN_ENTRY} transitively imports Node builtin(s), which React Native and browsers do not ` +
				'provide. Keep the importing module behind the Node entry and declare it in NODE_ONLY.'
		).to.deep.equal([]);
	});

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
