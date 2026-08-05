import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tsFiles } from './source-scan.js';

/**
 * Guardrail for `debt-db-core-single-spec-import-cycle`:
 * `registerBlockType` / `registerCollectionType` must be imported directly from the module
 * that defines them, never through the package root barrel (`src/index.ts`). Importing through
 * the root barrel pulls the call into the barrel's import cycle, which can leave the
 * registry's module-scope `Map` in its temporal-dead-zone when a registrar call runs —
 * a `ReferenceError` that only reproduces when a spec is run standalone (see ticket for the
 * full trace). The two registry modules are direct-import-safe only because they have zero
 * runtime imports of their own; the second assertion below protects that invariant.
 */
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/** The package root barrel, as an emitted-JS specifier target. */
const ROOT_BARREL = resolve(SRC_DIR, 'index.js');

const REGISTRY_FILES = [
	resolve(SRC_DIR, 'collection/collection-type-registry.ts'),
	resolve(SRC_DIR, 'blocks/block-types.ts'),
];

const REGISTRARS = ['registerBlockType', 'registerCollectionType'];

/**
 * Matches a named-binding `import`/`export ... from` clause, capturing the bound names and the
 * module specifier. An optional default-import prefix (`import Foo, { bar } from '...'`) is
 * tolerated so that form can't slip past. Bare side-effect imports, `export * from`, and dynamic
 * `import()` are deliberately out of scope: none of them can bind a registrar name.
 *
 * `import type { ... }` is captured too but tagged type-only, because under
 * `verbatimModuleSyntax` only the clause-level `type` keyword erases the module edge — an
 * inline `import { type X }` still emits `import {} from '...'`, a real runtime edge.
 */
const IMPORT_RE = /(?:import|export)\b\s*(type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/** One parsed `import { ... } from '...'` clause. */
type ParsedImport = {
	isTypeOnly: boolean;
	names: string[];
	spec: string;
};

function parseImports(text: string): ParsedImport[] {
	const out: ParsedImport[] = [];
	for (const m of text.matchAll(IMPORT_RE)) {
		const [, typeKeyword, namesRaw, spec] = m;
		const names = (namesRaw ?? '')
			.split(',')
			.map(n => n.trim())
			.filter(Boolean)
			.map(n => (n.replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '').trim());
		out.push({ isTypeOnly: Boolean(typeKeyword), names, spec: spec ?? '' });
	}
	return out;
}

/**
 * Does `spec`, resolved from the importing file, land on the package root barrel? Resolving
 * rather than pattern-matching `../index.js` covers every depth including a sibling of the
 * barrel itself (`./index.js`).
 */
function isRootBarrel(spec: string, fromFile: string): boolean {
	return spec.startsWith('.') && resolve(dirname(fromFile), spec) === ROOT_BARREL;
}

/** Registrar names that `text` (living at `file`) pulls in through the root barrel at runtime. */
function registrarViolations(text: string, file: string): string[] {
	const violations: string[] = [];
	for (const imp of parseImports(text)) {
		if (imp.isTypeOnly || !isRootBarrel(imp.spec, file)) {
			continue;
		}
		for (const name of REGISTRARS) {
			if (imp.names.includes(name)) {
				violations.push(`${file}: imports '${name}' from root barrel '${imp.spec}'`);
			}
		}
	}
	return violations;
}

describe('db-core — registrar imports cannot re-enter the root-barrel import cycle', () => {
	it('no runtime import of registerBlockType/registerCollectionType from the root barrel', async () => {
		const files = await tsFiles(SRC_DIR);
		expect(files.length).to.be.greaterThan(0);
		const violations: string[] = [];
		for (const file of files) {
			violations.push(...registrarViolations(await readFile(file, 'utf8'), file));
		}
		expect(violations, `registrar imports must bypass the root barrel:\n${violations.join('\n')}`).to.deep.equal([]);
	});

	it('registry modules (collection-type-registry.ts, block-types.ts) have zero runtime imports', async () => {
		for (const file of REGISTRY_FILES) {
			const text = await readFile(file, 'utf8');
			const runtimeImports = parseImports(text).filter(imp => !imp.isTypeOnly);
			expect(runtimeImports, `${file} must have no runtime imports (found: ${JSON.stringify(runtimeImports)})`).to.deep.equal([]);
		}
	});

	// The two guards above only prove "no violation exists *today*". These cases run the same
	// detector over synthetic sources, proving it actually fires across the import forms a
	// violation could take, so it can't silently rot into a no-op.
	const NESTED = resolve(SRC_DIR, 'collections/diary/x.ts');
	const AT_SRC_ROOT = resolve(SRC_DIR, 'x.ts');

	it('detects forbidden registrar imports in every form', () => {
		const forbidden: [string, string][] = [
			[`import { registerBlockType } from "../../index.js";`, NESTED],
			[`import { Collection, registerCollectionType } from "../../index.js";`, NESTED],          // multi-name
			[`import {\n\tregisterBlockType,\n\tregisterCollectionType,\n} from "../../index.js";`, NESTED], // multi-line
			[`import Collection, { registerBlockType } from "../../index.js";`, NESTED],               // default prefix
			[`export { registerBlockType } from "../../index.js";`, NESTED],                           // re-export edge
			[`import { registerCollectionType } from "./index.js";`, AT_SRC_ROOT],                     // barrel sibling
		];
		for (const [snippet, file] of forbidden) {
			expect(registrarViolations(snippet, file).length, `should flag: ${JSON.stringify(snippet)}`).to.be.greaterThan(0);
		}
	});

	it('does not flag allowed registrar imports or unrelated root-barrel imports', () => {
		const allowed: [string, string][] = [
			[`import { registerBlockType } from "../../blocks/block-types.js";`, NESTED],
			[`import { registerCollectionType } from "../../collection/collection-type-registry.js";`, NESTED],
			[`import { registerBlockType } from "../index.js";`, NESTED],       // subtree barrel, not the root one
			[`import type { registerBlockType } from "../../index.js";`, NESTED], // erased entirely
			[`import { Collection } from "../../index.js";`, NESTED],            // root barrel, unrelated name
		];
		for (const [snippet, file] of allowed) {
			expect(registrarViolations(snippet, file), `should NOT flag: ${JSON.stringify(snippet)}`).to.deep.equal([]);
		}
	});
});
