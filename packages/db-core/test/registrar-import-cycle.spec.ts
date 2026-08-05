import { expect } from 'chai';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Guardrail for `debt-db-core-single-spec-import-cycle`:
 * `registerBlockType` / `registerCollectionType` must be imported directly from the module
 * that defines them, never through the package root barrel (`index.js`). Importing through
 * the root barrel pulls the call into the barrel's import cycle, which can leave the
 * registry's module-scope `Map` in its temporal-dead-zone when a registrar call runs —
 * a `ReferenceError` that only reproduces when a spec is run standalone (see ticket for the
 * full trace). The two registry modules are direct-import-safe only because they have zero
 * runtime imports of their own; the second assertion below protects that invariant.
 */
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

const REGISTRY_FILES = [
	fileURLToPath(new URL('../src/collection/collection-type-registry.ts', import.meta.url)),
	fileURLToPath(new URL('../src/blocks/block-types.ts', import.meta.url)),
];

const REGISTRARS = ['registerBlockType', 'registerCollectionType'];

/**
 * Matches a runtime `import`/`export ... from` clause, capturing the imported names and the
 * module specifier. Deliberately excludes `import type ...` (handled by a separate check on
 * the matched text) and dynamic `import()` / bare side-effect imports, which never bring in a
 * named value the way `registerBlockType`/`registerCollectionType` are consumed.
 */
const IMPORT_RE = /import\s+(type\s+)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;

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

/** A specifier that resolves to the package root barrel: `index.js` at any `../` depth. */
const IS_ROOT_BARREL = (spec: string): boolean => /^(\.\.\/)+index\.js$/.test(spec);

async function tsFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...await tsFiles(full));
		} else if (entry.name.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

describe('db-core — registrar imports cannot re-enter the root-barrel import cycle', () => {
	it('no runtime import of registerBlockType/registerCollectionType from the root barrel', async () => {
		const files = await tsFiles(SRC_DIR);
		expect(files.length).to.be.greaterThan(0);
		const violations: string[] = [];
		for (const file of files) {
			const text = await readFile(file, 'utf8');
			for (const imp of parseImports(text)) {
				if (imp.isTypeOnly || !IS_ROOT_BARREL(imp.spec)) {
					continue;
				}
				for (const name of REGISTRARS) {
					if (imp.names.includes(name)) {
						violations.push(`${file}: imports '${name}' from root barrel '${imp.spec}'`);
					}
				}
			}
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

	// The two guards above only prove "no violation exists *today*". These cases prove the
	// detector actually fires across the import forms a violation could take, so it can't
	// silently rot into a no-op.
	it('detects forbidden registrar imports in every form', () => {
		const forbidden = [
			`import { registerBlockType } from "../../index.js";`,
			`import { registerCollectionType } from "../../../index.js";`,
			`import { Collection, registerCollectionType } from "../../index.js";`,        // multi-name
			`import {\n\tregisterBlockType,\n\tregisterCollectionType,\n} from "../../index.js";`, // multi-line
		];
		for (const snippet of forbidden) {
			const violations: string[] = [];
			for (const imp of parseImports(snippet)) {
				if (imp.isTypeOnly || !IS_ROOT_BARREL(imp.spec)) {
					continue;
				}
				for (const name of REGISTRARS) {
					if (imp.names.includes(name)) {
						violations.push(name);
					}
				}
			}
			expect(violations.length, `should flag: ${JSON.stringify(snippet)}`).to.be.greaterThan(0);
		}
	});

	it('does not flag allowed registrar imports or unrelated root-barrel imports', () => {
		const allowed = [
			`import { registerBlockType } from "../../blocks/block-types.js";`,
			`import { registerCollectionType } from "../../collection/collection-type-registry.js";`,
			`import type { registerBlockType } from "../../index.js";`, // hypothetical type-only form
			`import { Collection } from "../../index.js";`,             // root barrel, unrelated name
		];
		for (const snippet of allowed) {
			const violations: string[] = [];
			for (const imp of parseImports(snippet)) {
				if (imp.isTypeOnly || !IS_ROOT_BARREL(imp.spec)) {
					continue;
				}
				for (const name of REGISTRARS) {
					if (imp.names.includes(name)) {
						violations.push(name);
					}
				}
			}
			expect(violations, `should NOT flag: ${JSON.stringify(snippet)}`).to.deep.equal([]);
		}
	});
});
