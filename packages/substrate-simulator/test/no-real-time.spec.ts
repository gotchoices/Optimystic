import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Tokens that smuggle in wall-clock or non-determinism, breaking byte-reproducibility — banned
 * everywhere in src/.
 */
const FORBIDDEN_ALWAYS: ReadonlyArray<{ name: string; re: RegExp }> = [
	{ name: 'Math.random', re: /\bMath\s*\.\s*random\b/ },
	{ name: 'Date.now', re: /\bDate\s*\.\s*now\b/ },
	{ name: 'new Date', re: /\bnew\s+Date\b/ },
	{ name: 'setTimeout', re: /\bsetTimeout\b/ },
	{ name: 'setInterval', re: /\bsetInterval\b/ }
];

/**
 * The discrete-event engine is fully synchronous, so `await`/`Promise` are banned in the engine
 * core. They are permitted only in the FRET model layer, which wraps FRET's async `hashKey`
 * (sha256) to seed coordinates: async is sequenced at build time, never inside a scheduler
 * event, and sha256 is deterministic — so byte-reproducibility is unaffected.
 */
const FORBIDDEN_ENGINE: ReadonlyArray<{ name: string; re: RegExp }> = [
	{ name: 'await', re: /\bawait\b/ },
	{ name: 'Promise', re: /\bPromise\b/ }
];

/** Files allowed to be async because they wrap FRET's async hashing. */
const ASYNC_ALLOWED = new Set(['ring-model.ts', 'fret-model.ts']);

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...sourceFiles(full));
		} else if (entry.name.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

describe('no real time in src/', () => {
	it('contains no wall-clock, real-timer, randomness, or async tokens', () => {
		const files = sourceFiles(srcDir);
		expect(files.length).to.be.greaterThan(0);
		const violations: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, 'utf8');
			const isAsyncAllowed = ASYNC_ALLOWED.has(file.split(/[\\/]/).pop() ?? '');
			const checks = isAsyncAllowed ? FORBIDDEN_ALWAYS : [...FORBIDDEN_ALWAYS, ...FORBIDDEN_ENGINE];
			for (const { name, re } of checks) {
				if (re.test(text)) {
					violations.push(`${file}: ${name}`);
				}
			}
		}
		expect(violations, violations.join('\n')).to.deep.equal([]);
	});
});
