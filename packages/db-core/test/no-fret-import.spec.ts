import { expect } from 'chai';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Guardrail enforcing the layering rule from `cohort-topic-package-layering`:
 * **db-core has zero FRET / libp2p dependency.** Any `import`/`export ... from` that resolves
 * to `p2p-fret`, `libp2p`, or an `@libp2p/*` package in `packages/db-core/src/**` is a layering
 * violation — that code belongs in db-p2p behind a port.
 */
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/** Matches the module specifier of an `import`/`export ... from` / dynamic `import()`. */
const IMPORT_RE = /(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const FORBIDDEN = (spec: string): boolean =>
	spec === 'p2p-fret' || spec.startsWith('p2p-fret/') ||
	spec === 'libp2p' || spec.startsWith('libp2p/') ||
	spec.startsWith('@libp2p/');

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

describe('db-core layering — no FRET / libp2p imports', () => {
	it('packages/db-core/src/** never imports p2p-fret or libp2p', async () => {
		const files = await tsFiles(SRC_DIR);
		expect(files.length).to.be.greaterThan(0);
		const violations: string[] = [];
		for (const file of files) {
			const text = await readFile(file, 'utf8');
			for (const m of text.matchAll(IMPORT_RE)) {
				const spec = m[1] ?? m[2];
				if (spec && FORBIDDEN(spec)) {
					violations.push(`${file}: imports '${spec}'`);
				}
			}
		}
		expect(violations, `db-core must stay FRET/libp2p-free:\n${violations.join('\n')}`).to.deep.equal([]);
	});
});
