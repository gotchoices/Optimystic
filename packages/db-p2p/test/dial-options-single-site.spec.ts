import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural guard: `src/network/open-protocol-stream.ts` is the ONLY file in this package allowed
 * to call libp2p's `dialProtocol` / `newStream`.
 *
 * libp2p refuses to open a protocol stream over a *limited* (circuit-relay) connection unless the
 * caller passes `runOnLimitedConnection: true`. Forgetting it is invisible — no compile error, no
 * thrown error at the call site, just "that peer never answers" for every peer reachable only
 * through a relay, which is the normal state for phones and machines behind a home router. This
 * package has already shipped that bug twice (all four cohort-topic dial paths, then the Arachnode
 * restoration coordinator's inline dial lambda), because the correct logic was hand-copied rather
 * than shared. Nothing in TypeScript can forbid a method on a third-party type, so the rule is
 * enforced here instead: one helper, and a failing test the moment a second copy appears.
 *
 * Modeled on `testing-entry-runtime-deps.spec.ts` — same package, same shape: walk the source
 * files, assert a structural rule.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(packageRoot, 'src');

/** The one file permitted to open a protocol stream directly. Keep this a one-element set. */
const ALLOWED = new Set(['src/network/open-protocol-stream.ts']);

/**
 * Member-call syntax only, so a *method definition* does not trip the guard —
 * `src/testing/cohort-topic-mesh-harness.ts` defines `dialProtocol(peer, protocols)` on its
 * `MockNode` with no leading dot, and is a legitimate implementation rather than a caller.
 */
const DIRECT_OPEN_RE = /\.(dialProtocol|newStream)\s*\(/g;

export interface Violation {
	file: string;
	line: number;
	method: string;
}

/**
 * Blank out `//` and block comments while preserving every newline, so line numbers survive and
 * prose that merely mentions the method names does not trip the guard (several docblocks in
 * `stream-util.ts` and `libp2p-key-network.ts` legitimately do).
 *
 * String literals are tracked so a `//` inside one is not read as a comment. Regex literals are
 * NOT tracked: a regex containing a lone quote character would put the scanner into string mode
 * and blank out real code after it. That direction is a false negative, never a false positive,
 * and `finds the calls inside the allowlisted file` below pins that the stripper has not started
 * swallowing the tree wholesale.
 */
export function stripComments(source: string): string {
	type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
	let mode: Mode = 'code';
	let out = '';
	let i = 0;
	while (i < source.length) {
		const ch = source[i]!;
		const next = source[i + 1];
		if (mode === 'code') {
			if (ch === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue; }
			if (ch === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue; }
			if (ch === "'") mode = 'single';
			else if (ch === '"') mode = 'double';
			else if (ch === '`') mode = 'template';
			out += ch; i++; continue;
		}
		if (mode === 'line') {
			if (ch === '\n') { mode = 'code'; out += ch; } else out += ' ';
			i++; continue;
		}
		if (mode === 'block') {
			if (ch === '*' && next === '/') { mode = 'code'; out += '  '; i += 2; continue; }
			out += ch === '\n' ? '\n' : ' ';
			i++; continue;
		}
		// Inside a string literal: copied through verbatim, escapes consumed in pairs so a
		// trailing `\'` does not read as the closing quote.
		if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
		if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"') || (mode === 'template' && ch === '`')) {
			mode = 'code';
		}
		out += ch; i++;
	}
	return out;
}

/** Direct `dialProtocol` / `newStream` member calls in `source`, as 1-indexed lines. */
export function findDirectStreamOpens(file: string, source: string): Violation[] {
	const found: Violation[] = [];
	const lines = stripComments(source).split('\n');
	lines.forEach((text, index) => {
		DIRECT_OPEN_RE.lastIndex = 0;
		for (const match of text.matchAll(DIRECT_OPEN_RE)) {
			found.push({ file, line: index + 1, method: match[1]! });
		}
	});
	return found;
}

/** Human-readable failure text, naming the file and line so the fix is obvious from the run. */
export function describeViolations(violations: Violation[]): string {
	return violations
		.map(v => `${v.file}:${v.line} calls .${v.method}() directly — use openProtocolStream() from src/network/open-protocol-stream.ts instead, so relay-only peers stay reachable (runOnLimitedConnection).`)
		.join('\n');
}

/** Every `.ts` file under `dir`, as package-relative POSIX paths. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(full));
		else if (entry.isFile() && entry.name.endsWith('.ts')) {
			out.push(path.relative(packageRoot, full).split(path.sep).join('/'));
		}
	}
	return out;
}

describe('protocol streams are opened in exactly one place', () => {
	const files = sourceFiles(srcRoot);

	it('walks a non-empty source tree', () => {
		expect(files.length).to.be.greaterThan(0);
	});

	it('finds no direct dialProtocol/newStream call outside the shared helper', () => {
		const violations: Violation[] = [];
		for (const file of files) {
			if (ALLOWED.has(file)) continue;
			violations.push(...findDirectStreamOpens(file, fs.readFileSync(path.join(packageRoot, file), 'utf8')));
		}
		expect(describeViolations(violations)).to.equal('');
	});

	it('keeps the allowlist to the single shared helper', () => {
		expect([...ALLOWED]).to.deep.equal(['src/network/open-protocol-stream.ts']);
		expect(fs.existsSync(path.join(packageRoot, 'src/network/open-protocol-stream.ts'))).to.equal(true);
	});

	it('finds the calls inside the allowlisted file, so the scan is not vacuously passing', () => {
		const helper = 'src/network/open-protocol-stream.ts';
		const hits = findDirectStreamOpens(helper, fs.readFileSync(path.join(packageRoot, helper), 'utf8'));
		expect(hits.map(h => h.method).sort()).to.deep.equal(['dialProtocol', 'newStream']);
	});

	// --- The scan function itself, on synthetic sources ------------------------------------
	describe('findDirectStreamOpens', () => {
		it('flags a second call site and names the file and line', () => {
			const source = 'const a = 1;\nawait node.dialProtocol(peer, [protocol]);\n';
			const violations = findDirectStreamOpens('src/somewhere-else.ts', source);

			expect(violations).to.deep.equal([{ file: 'src/somewhere-else.ts', line: 2, method: 'dialProtocol' }]);
			expect(describeViolations(violations)).to.include('src/somewhere-else.ts:2');
			expect(describeViolations(violations)).to.include('openProtocolStream');
		});

		it('flags `.newStream(` as well as `.dialProtocol(`', () => {
			expect(findDirectStreamOpens('src/x.ts', 'conn.newStream([p], {});')).to.have.length(1);
		});

		it('ignores a method DEFINITION, so the mock node harness keeps passing', () => {
			// `src/testing/cohort-topic-mesh-harness.ts` implements this method on its MockNode.
			const source = 'class MockNode {\n\tdialProtocol(peer: PeerId, protocols: string[]) {\n\t\treturn x;\n\t}\n}\n';
			expect(findDirectStreamOpens('src/testing/mock.ts', source)).to.deep.equal([]);
		});

		it('ignores the names inside a line comment', () => {
			expect(findDirectStreamOpens('src/x.ts', '// falls back to node.dialProtocol(...) here\n')).to.deep.equal([]);
		});

		it('ignores the names inside a block comment, without shifting later line numbers', () => {
			const source = '/**\n * See conn.newStream(...) for why.\n */\nawait node.dialProtocol(p, [q]);\n';
			expect(findDirectStreamOpens('src/x.ts', source)).to.deep.equal([
				{ file: 'src/x.ts', line: 4, method: 'dialProtocol' },
			]);
		});

		it('does not treat `//` inside a string literal as the start of a comment', () => {
			const source = "const url = 'https://example.invalid'; await node.dialProtocol(p, [q]);\n";
			expect(findDirectStreamOpens('src/x.ts', source)).to.have.length(1);
		});
	});
});
