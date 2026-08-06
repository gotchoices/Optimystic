import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Shared by the source-scanning guard specs (`no-fret-import`, `barrel-import-cycle`). */

/** Every `.ts` file under `dir`, recursively. */
export async function tsFiles(dir: string): Promise<string[]> {
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
