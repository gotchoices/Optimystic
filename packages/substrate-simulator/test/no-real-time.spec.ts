import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Tokens that smuggle in wall-clock or non-determinism, breaking byte-reproducibility. */
const FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp }> = [
	{ name: 'Math.random', re: /\bMath\s*\.\s*random\b/ },
	{ name: 'Date.now', re: /\bDate\s*\.\s*now\b/ },
	{ name: 'new Date', re: /\bnew\s+Date\b/ },
	{ name: 'setTimeout', re: /\bsetTimeout\b/ },
	{ name: 'setInterval', re: /\bsetInterval\b/ },
	{ name: 'await', re: /\bawait\b/ },
	{ name: 'Promise', re: /\bPromise\b/ }
];

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
			for (const { name, re } of FORBIDDEN) {
				if (re.test(text)) {
					violations.push(`${file}: ${name}`);
				}
			}
		}
		expect(violations, violations.join('\n')).to.deep.equal([]);
	});
});
