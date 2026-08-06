import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tsFiles } from './source-scan.js';

/**
 * Guardrail for `debt-db-core-src-imports-own-root-barrel`:
 * no module under `src/` may import the package root barrel (`src/index.ts`) at runtime.
 *
 * The root barrel re-exports every module under `src/`, so a module that imports it depends on
 * a module that depends on the module — Node evaluates the whole group as a cycle, and whichever
 * module is entered first decides which parts of the cycle are still half-built when the rest
 * runs. That produced one real failure already (`debt-db-core-single-spec-import-cycle`): three
 * specs died with `ReferenceError: Cannot access 'collectionTypes' before initialization` when
 * run standalone and passed when run as part of the whole suite, because the collection-type
 * registry's module-scope `Map` was still in its temporal dead zone. Any module-load-time work
 * added later — another registry, a plugin table, a self-registering handler — falls into the
 * same trap, so the fix is to keep the cycle from existing rather than to dodge it per-symbol.
 *
 * Type-only imports are exempt: with `verbatimModuleSyntax` (see `tsconfig.base.json`) a
 * clause-level `import type` / `export type` is erased whole, leaving no runtime module edge.
 * An *inline* `import { type X }` is NOT exempt — it still emits `import {} from '...'`.
 */
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/** The package root barrel, as an emitted-JS specifier target. */
const ROOT_BARREL = resolve(SRC_DIR, 'index.js');

const REGISTRY_FILES = [
	resolve(SRC_DIR, 'collection/collection-type-registry.ts'),
	resolve(SRC_DIR, 'blocks/block-types.ts'),
];

/**
 * Matches every `import ... from '...'` / `export ... from '...'` statement, capturing the clause
 * between the keyword and `from` (used to tell clause-level `type` apart) and the specifier.
 * The clause is `[^'"]*?` so multi-line and multi-name lists are covered while the match can't
 * run past the statement's own quotes. Statement-start anchoring (`^`, newline, or `;`) keeps
 * the keyword from matching inside an identifier or a string.
 */
const FROM_RE = /(?:^|[\n;])[ \t]*(?:import|export)\b([^'"]*?)\bfrom[ \t]*['"]([^'"]+)['"]/g;

/** Matches a bare side-effect import (`import '...';`). Dynamic `import('...')` cannot match. */
const SIDE_EFFECT_RE = /(?:^|[\n;])[ \t]*import[ \t]*['"]([^'"]+)['"]/g;

/** One module edge declared by a source file. */
type ModuleEdge = {
	/** True only for clause-level `import type` / `export type`, the forms TS erases whole. */
	isTypeOnly: boolean;
	spec: string;
	/** The statement text, for violation messages. */
	text: string;
};

/**
 * Every module edge `text` declares, in any static form: named, default, namespace, star
 * re-export, and bare side-effect. Dynamic `import()` is deliberately out of scope — it is
 * evaluated lazily and so cannot participate in module-initialization order.
 */
function moduleEdges(text: string): ModuleEdge[] {
	const out: ModuleEdge[] = [];
	for (const m of text.matchAll(FROM_RE)) {
		const [full, clause, spec] = m;
		out.push({ isTypeOnly: /^\s*type\s/.test(clause ?? ''), spec: spec ?? '', text: (full ?? '').trim() });
	}
	for (const m of text.matchAll(SIDE_EFFECT_RE)) {
		const [full, spec] = m;
		out.push({ isTypeOnly: false, spec: spec ?? '', text: (full ?? '').trim() });
	}
	return out;
}

/**
 * Does `spec`, resolved from the importing file, land on the package root barrel? Resolving
 * rather than pattern-matching `../index.js` covers every depth including a sibling of the
 * barrel itself (`./index.js`), and correctly leaves subtree barrels alone.
 */
function isRootBarrel(spec: string, fromFile: string): boolean {
	return spec.startsWith('.') && resolve(dirname(fromFile), spec) === ROOT_BARREL;
}

/** Runtime edges from `text` (living at `file`) onto the root barrel. */
function rootBarrelViolations(text: string, file: string): string[] {
	return moduleEdges(text)
		.filter(edge => !edge.isTypeOnly && isRootBarrel(edge.spec, file))
		.map(edge => `${file}: ${edge.text}`);
}

describe('db-core — src modules cannot re-enter the root-barrel import cycle', () => {
	it('no file under src/ imports the root barrel at runtime', async () => {
		const files = await tsFiles(SRC_DIR);
		expect(files.length).to.be.greaterThan(0);
		const violations: string[] = [];
		for (const file of files) {
			violations.push(...rootBarrelViolations(await readFile(file, 'utf8'), file));
		}
		expect(violations, `runtime imports must bypass the root barrel (import type is fine):\n${violations.join('\n')}`).to.deep.equal([]);
	});

	it('registry modules (collection-type-registry.ts, block-types.ts) have zero runtime imports', async () => {
		for (const file of REGISTRY_FILES) {
			const text = await readFile(file, 'utf8');
			const runtimeEdges = moduleEdges(text).filter(edge => !edge.isTypeOnly);
			expect(runtimeEdges, `${file} must have no runtime imports (found: ${JSON.stringify(runtimeEdges)})`).to.deep.equal([]);
		}
	});

	// The two guards above only prove "no violation exists *today*". These cases run the same
	// detector over synthetic sources, proving it actually fires across the import forms a
	// violation could take, so it can't silently rot into a no-op.
	const NESTED = resolve(SRC_DIR, 'collections/diary/x.ts');
	const AT_SRC_ROOT = resolve(SRC_DIR, 'x.ts');

	it('detects forbidden root-barrel imports in every form', () => {
		const forbidden: [string, string][] = [
			[`import { Collection } from "../../index.js";`, NESTED],
			[`import { Collection, registerCollectionType } from "../../index.js";`, NESTED],            // multi-name
			[`import {\n\tapply,\n\tget,\n} from "../../index.js";`, NESTED],                            // multi-line
			[`import Collection, { apply } from "../../index.js";`, NESTED],                             // default prefix
			[`import Collection from "../../index.js";`, NESTED],                                        // default only
			[`import * as core from "../../index.js";`, NESTED],                                         // namespace
			[`import "../../index.js";`, NESTED],                                                        // bare side-effect
			[`export { Collection } from "../../index.js";`, NESTED],                                    // re-export edge
			[`export * from "../../index.js";`, NESTED],                                                 // star re-export
			[`export * as core from "../../index.js";`, NESTED],                                         // namespace re-export
			[`import { type BlockId } from "../../index.js";`, NESTED],                                  // inline type: emits `import {}`
			[`import { apply } from "./index.js";`, AT_SRC_ROOT],                                        // barrel sibling
		];
		for (const [snippet, file] of forbidden) {
			expect(rootBarrelViolations(snippet, file).length, `should flag: ${JSON.stringify(snippet)}`).to.be.greaterThan(0);
		}
	});

	it('does not flag type-only or non-root-barrel imports', () => {
		const allowed: [string, string][] = [
			[`import type { BlockId, IBlock } from "../../index.js";`, NESTED],       // erased entirely
			[`export type { BlockId } from "../../index.js";`, NESTED],               // erased entirely
			[`import { Collection } from "../../collection/collection.js";`, NESTED], // direct, the target shape
			[`import { apply } from "../index.js";`, NESTED],                         // subtree barrel, not the root one
			[`import { apply } from "../../blocks/index.js";`, NESTED],               // subtree barrel
			[`import { apply } from "@optimystic/db-core";`, NESTED],                 // bare specifier, not relative
			[`const core = await import("../../index.js");`, NESTED],                 // dynamic: lazy, no init-order edge
			[`const s = "import { x } from '../../index.js'";`, NESTED],              // inside a string literal
		];
		for (const [snippet, file] of allowed) {
			expect(rootBarrelViolations(snippet, file), `should NOT flag: ${JSON.stringify(snippet)}`).to.deep.equal([]);
		}
	});
});
