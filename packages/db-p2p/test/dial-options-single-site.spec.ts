import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
 *
 * NOTE: the walk covers `packages/db-p2p/src` only, because `db-p2p` is the only package that
 * depends on libp2p directly today. If a second package ever takes a libp2p dependency, this guard
 * will not notice its dial sites — widen `srcRoot` to the other package's `src` at that point.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(packageRoot, 'src');

/** The one file permitted to open a protocol stream directly. Keep this a one-element set. */
const ALLOWED = new Set(['src/network/open-protocol-stream.ts']);

const GUARDED_METHODS = new Set(['dialProtocol', 'newStream']);

export interface Violation {
	file: string;
	line: number;
	method: string;
}

/**
 * Direct `dialProtocol` / `newStream` member calls in `source`, as 1-indexed lines.
 *
 * Parsed with TypeScript's own parser rather than scanned textually, so the guard sees exactly
 * what the compiler sees: prose in a comment, a name inside a string or template literal, and a
 * method *definition* (`src/testing/cohort-topic-mesh-harness.ts` implements `dialProtocol` on its
 * `MockNode`) are all structurally distinct from a call and cannot trip it, while `node?.newStream(…)`
 * — which a `\.newStream\s*\(` regex misses — cannot slip past it.
 *
 * Only member calls on a named property are matched. Dynamic dispatch (`conn['newStream'](…)`, or
 * the method pulled out into a variable first) is not detected; that direction is a false negative,
 * and `finds the calls inside the allowlisted file` below pins that the walk still sees real calls.
 */
export function findDirectStreamOpens(file: string, source: string): Violation[] {
	const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
	const found: Violation[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			if (GUARDED_METHODS.has(method)) {
				const { line } = parsed.getLineAndCharacterOfPosition(node.expression.name.getStart(parsed));
				found.push({ file, line: line + 1, method });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);

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

		it('flags an optionally-chained call, which a `.method(` text scan would miss', () => {
			expect(findDirectStreamOpens('src/x.ts', 'await node?.dialProtocol(p, [q]);')).to.deep.equal([
				{ file: 'src/x.ts', line: 1, method: 'dialProtocol' },
			]);
		});

		it('is not derailed by a quote character inside a regex literal', () => {
			// A textual scanner tracking string state would enter string mode at the lone `'` and
			// blank out the real call that follows it.
			const source = "const q = /it's/;\nawait node.dialProtocol(p, [q]);\n";
			expect(findDirectStreamOpens('src/x.ts', source)).to.deep.equal([
				{ file: 'src/x.ts', line: 2, method: 'dialProtocol' },
			]);
		});

		it('flags a call interpolated into a template literal', () => {
			expect(findDirectStreamOpens('src/x.ts', 'const s = `${await conn.newStream([p])}`;')).to.have.length(1);
		});

		it('ignores the names inside a string literal', () => {
			expect(findDirectStreamOpens('src/x.ts', "log('conn.newStream(...) is forbidden here');")).to.deep.equal([]);
		});

		it('does not treat `//` inside a string literal as the start of a comment', () => {
			const source = "const url = 'https://example.invalid'; await node.dialProtocol(p, [q]);\n";
			expect(findDirectStreamOpens('src/x.ts', source)).to.have.length(1);
		});
	});
});
