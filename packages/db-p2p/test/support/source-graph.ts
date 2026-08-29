/**
 * Walks the *source* import graph from an entry `.ts` file — not `dist`, so the guards built on it
 * hold whether or not the package has been built.
 *
 * Only specifiers whose module is actually loaded at runtime are followed: `verbatimModuleSyntax`
 * erases whole-statement `import type` / `export type`, but an inline `{ type X }` still loads the
 * module, so those count.
 *
 * Shared by the two published-entry guards, which assert different properties of the same walk:
 * `testing-entry-runtime-deps.spec.ts` checks the reached *packages* are all declared runtime
 * dependencies; `entry-parity.spec.ts` checks the React Native entry reaches no Node *builtin*.
 *
 * Not a `.spec.ts` file on purpose — mocha's glob would otherwise load it as a suite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBuiltin } from 'node:module';

export type SourceGraph = {
	/** Absolute paths of the first-party source files reached, including the entry itself. */
	readonly files: ReadonlySet<string>;
	/** Bare package names reached — `@libp2p/crypto/keys` is recorded as `@libp2p/crypto`. */
	readonly packages: ReadonlySet<string>;
	/** Node builtin specifier → the source files importing it, sorted. */
	readonly builtins: ReadonlyMap<string, readonly string[]>;
};

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/** `@libp2p/crypto/keys` → `@libp2p/crypto`; `it-all` → `it-all`. */
export function packageNameOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** Specifiers whose module is actually loaded at runtime by `source`. */
export function runtimeSpecifiers(source: string): string[] {
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

/** Everything transitively reachable at runtime from `entryFile` (an absolute `.ts` path). */
export function walkRuntimeGraph(entryFile: string): SourceGraph {
	const files = new Set<string>();
	const packages = new Set<string>();
	const builtins = new Map<string, string[]>();
	const queue = [entryFile];

	while (queue.length > 0) {
		const file = queue.pop()!;
		if (files.has(file)) continue;
		if (!fs.existsSync(file)) continue;
		files.add(file);

		for (const specifier of runtimeSpecifiers(fs.readFileSync(file, 'utf8'))) {
			if (specifier.startsWith('.')) {
				queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')));
			} else if (isBuiltin(specifier)) {
				const importers = builtins.get(specifier) ?? [];
				importers.push(file);
				builtins.set(specifier, importers);
			} else {
				packages.add(packageNameOf(specifier));
			}
		}
	}

	for (const [specifier, importers] of builtins) builtins.set(specifier, importers.sort());
	return { files, packages, builtins };
}
