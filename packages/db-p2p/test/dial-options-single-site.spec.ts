import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Structural guard on BOTH halves of the limited-connection opt-in:
 *
 * - `src/network/open-protocol-stream.ts` is the only file allowed to call `dialProtocol` /
 *   `newStream` — the *dialling* half.
 * - `src/network/register-protocol-handler.ts` is the only file allowed to call `.handle(...)` —
 *   the *answering* half.
 *
 * libp2p refuses to carry a protocol stream over a *limited* (circuit-relay) connection unless
 * `runOnLimitedConnection: true` is present, and it checks each side against its OWN options: the
 * dialer's stream-open options, and the options the answering peer passed when it registered the
 * handler. Both must opt in; either one alone leaves the peer just as unreachable.
 *
 * Forgetting it is invisible — no compile error, no thrown error at the call site, just "that peer
 * never answers" for every peer reachable only through a relay, which is the normal state for
 * phones and machines behind a home router. This package has already shipped the dialling half of
 * that bug twice (all four cohort-topic dial paths, then the Arachnode restoration coordinator's
 * inline dial lambda) and shipped the answering half across all thirteen registration sites at
 * once — every time because the correct logic was hand-copied rather than shared. Nothing in
 * TypeScript can forbid a method on a third-party type, so the rule is enforced here instead: one
 * helper per direction, and a failing test the moment a second copy appears.
 *
 * Modeled on `testing-entry-runtime-deps.spec.ts` — same package, same shape: walk the source
 * files, assert a structural rule.
 *
 * NOTE: the walk covers `packages/db-p2p/src` only, because `db-p2p` is the only package that
 * depends on libp2p directly today. If a second package ever takes a libp2p dependency, this guard
 * will not notice its dial or registration sites — widen `srcRoot` to the other package's `src` at
 * that point.
 *
 * NOTE: `handle` is matched by NAME, exactly like `dialProtocol` / `newStream` — the walk carries no
 * type information, so it cannot tell libp2p's `handle` from some future unrelated object's. Today
 * every `.handle(` call under `src` is a libp2p registration, so the name is exact. If a genuinely
 * unrelated `.handle(` is ever introduced the guard fails loudly on it, and the fix is to rename
 * that method (preferred — this flag's failure mode is silence, so a noisy guard is the cheap side
 * to err on) rather than to weaken the match. A method *definition* named `handle`
 * (`src/testing/cohort-topic-mesh-harness.ts` has one on its `MockNode`) is structurally distinct
 * from a call and does not trip it.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(packageRoot, 'src');

/** The one file permitted to open a protocol stream directly. Keep this a one-element set. */
const ALLOWED = new Set(['src/network/open-protocol-stream.ts']);

/** The one file permitted to register a protocol handler directly. Keep this a one-element set. */
const ALLOWED_REGISTRATION = new Set(['src/network/register-protocol-handler.ts']);

const GUARDED_METHODS = new Set(['dialProtocol', 'newStream']);

const GUARDED_REGISTRATION_METHODS = new Set(['handle']);

/** Per-method remediation, so a failure names the helper the author actually needs. */
const REMEDIATION: Record<string, string> = {
	dialProtocol: 'use openProtocolStream() from src/network/open-protocol-stream.ts instead, so relay-only peers stay reachable (runOnLimitedConnection).',
	newStream: 'use openProtocolStream() from src/network/open-protocol-stream.ts instead, so relay-only peers stay reachable (runOnLimitedConnection).',
	handle: 'use registerProtocolHandler() from src/network/register-protocol-handler.ts instead, so streams from relay-only peers are ACCEPTED (runOnLimitedConnection).',
};

export interface Violation {
	file: string;
	line: number;
	method: string;
}

/**
 * Member calls in `source` whose method name is in `methods`, as 1-indexed lines.
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
export function findMemberCalls(file: string, source: string, methods: ReadonlySet<string>): Violation[] {
	const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
	const found: Violation[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			if (methods.has(method)) {
				const { line } = parsed.getLineAndCharacterOfPosition(node.expression.name.getStart(parsed));
				found.push({ file, line: line + 1, method });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);

	return found;
}

/** Direct `dialProtocol` / `newStream` calls — the dialling half. */
export function findDirectStreamOpens(file: string, source: string): Violation[] {
	return findMemberCalls(file, source, GUARDED_METHODS);
}

/** Direct `.handle(...)` protocol-handler registrations — the answering half. */
export function findDirectHandlerRegistrations(file: string, source: string): Violation[] {
	return findMemberCalls(file, source, GUARDED_REGISTRATION_METHODS);
}

/** Human-readable failure text, naming the file and line so the fix is obvious from the run. */
export function describeViolations(violations: Violation[]): string {
	return violations
		.map(v => `${v.file}:${v.line} calls .${v.method}() directly — ${REMEDIATION[v.method] ?? 'route it through the matching shared helper in src/network/.'}`)
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

describe('protocol handlers are registered in exactly one place', () => {
	const files = sourceFiles(srcRoot);

	it('finds no direct .handle() registration outside the shared helper', () => {
		// The mirror of the dial-side assertion above. libp2p checks `runOnLimitedConnection` on the
		// ANSWERING side too, against the options passed at registration — so a `.handle(...)` that
		// bypasses `registerProtocolHandler` leaves that protocol unreachable from any relay-only peer
		// even though the dialler opted in correctly.
		const violations: Violation[] = [];
		for (const file of files) {
			if (ALLOWED_REGISTRATION.has(file)) continue;
			violations.push(...findDirectHandlerRegistrations(file, fs.readFileSync(path.join(packageRoot, file), 'utf8')));
		}
		expect(describeViolations(violations)).to.equal('');
	});

	it('keeps the registration allowlist to the single shared helper', () => {
		expect([...ALLOWED_REGISTRATION]).to.deep.equal(['src/network/register-protocol-handler.ts']);
		expect(fs.existsSync(path.join(packageRoot, 'src/network/register-protocol-handler.ts'))).to.equal(true);
	});

	it('finds the call inside the allowlisted helper, so the scan is not vacuously passing', () => {
		const helper = 'src/network/register-protocol-handler.ts';
		const hits = findDirectHandlerRegistrations(helper, fs.readFileSync(path.join(packageRoot, helper), 'utf8'));
		expect(hits.map(h => h.method)).to.deep.equal(['handle']);
	});

	it('every protocol the package serves is registered through the helper', () => {
		// A count, not a list of names: the point is that the migration was exhaustive and that a new
		// protocol added later still routes through the helper. `registerProtocolHandler` calls are
		// plain function calls, not member calls, so they are counted textually here.
		let calls = 0;
		for (const file of files) {
			if (ALLOWED_REGISTRATION.has(file)) continue;
			const source = fs.readFileSync(path.join(packageRoot, file), 'utf8');
			const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerProtocolHandler') calls++;
				ts.forEachChild(node, visit);
			};
			visit(parsed);
		}
		// 13 registration sites at the time of writing (sync, cluster, repo, dispute, block-transfer,
		// cohort-topic request/response + five host protocols, reactivity notify + push-state gossip).
		// Adding a protocol should RAISE this number; a drop means a site went back to `.handle(`,
		// which the assertion above would also catch.
		expect(calls).to.be.greaterThanOrEqual(13);
	});

	describe('findDirectHandlerRegistrations', () => {
		it('flags a bare registration and names the file and line', () => {
			const violations = findDirectHandlerRegistrations('src/x.ts', 'const a = 1;\nawait node.handle(PROTOCOL, onStream);\n');

			expect(violations).to.deep.equal([{ file: 'src/x.ts', line: 2, method: 'handle' }]);
			expect(describeViolations(violations)).to.include('registerProtocolHandler');
			expect(describeViolations(violations)).to.include('runOnLimitedConnection');
		});

		it('flags a registration that already passes options, since those may still omit the flag', () => {
			const source = 'await registrar.handle(p, h, { maxInboundStreams: 4 });';
			expect(findDirectHandlerRegistrations('src/x.ts', source)).to.have.length(1);
		});

		it('flags a registration that passes the flag by hand — the helper is the single site, not the flag', () => {
			// Hand-copying the flag is exactly how the dial half regressed twice.
			const source = 'await node.handle(p, h, { runOnLimitedConnection: true });';
			expect(findDirectHandlerRegistrations('src/x.ts', source)).to.have.length(1);
		});

		it('ignores the MockNode `handle` method DEFINITION', () => {
			const source = 'class MockNode {\n\thandle(protocol: string, handler: ProtocolHandler) {\n\t\treturn x;\n\t}\n}\n';
			expect(findDirectHandlerRegistrations('src/testing/mock.ts', source)).to.deep.equal([]);
		});

		it('ignores a plain `handle(...)` call — the inner request callbacks are named `handle`', () => {
			// `cohort-topic/host.ts` and `stream-util.ts` both invoke a parameter named `handle`.
			expect(findDirectHandlerRegistrations('src/x.ts', 'const reply = await handle(frame, from);')).to.deep.equal([]);
		});

		it('ignores the name inside a comment or a string', () => {
			expect(findDirectHandlerRegistrations('src/x.ts', '// see node.handle(...) for why\n')).to.deep.equal([]);
			expect(findDirectHandlerRegistrations('src/x.ts', "log('node.handle( is forbidden');")).to.deep.equal([]);
		});

		it('flags `unhandle` NOT at all — deregistration carries no options', () => {
			expect(findDirectHandlerRegistrations('src/x.ts', 'await registrar.unhandle(p);')).to.deep.equal([]);
		});
	});
});
