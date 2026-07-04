/**
 * Regression guard for ticket: optimystic-private-key-in-sql-literal-replicated.
 *
 * Concern (from a security review): a DML statement like
 *   INSERT ... VALUES (sign(<data>, '<privkey>'))
 * might capture the private-key literal into the replicated transaction record
 * and ship it to peers to re-execute.
 *
 * Reality this guard pins: the recorded `mutationStatement` is REBUILT by the
 * Quereus engine from the already-EVALUATED row values (buildInsertStatement in
 * @quereus/quereus's util/mutation-statement.ts), NOT from the source SQL text.
 * A function's arguments are evaluated and discarded before the statement is
 * rebuilt, so a secret passed as an ARGUMENT never reaches the record — the
 * record holds only the function's RESULT. The ONLY value that lands in the
 * record is one that becomes a persisted COLUMN value.
 *
 * The first test uses an inline `probe_sign(data, secret)` function (a stand-in
 * for the crypto plugin's real `sign()`, kept hermetic so this suite does not
 * depend on the crypto package being built first). The mechanism it exercises —
 * the engine rebuilding the statement from evaluated values — is identical for
 * the real `sign()`; see docs/transactions.md § "Secrets and the replicated
 * statement record".
 */

import { expect } from 'chai';
import { Database, FunctionFlags, TEXT_TYPE } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import registerOptimystic from '../dist/plugin.js';

const SECRET = 'THIS-IS-A-SECRET-KEY-abcdef0123456789';

function createEnv() {
	const db = new Database();
	const optimystic = registerOptimystic(db, {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false,
	});

	for (const vtable of optimystic.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of optimystic.functions) {
		db.registerFunction(func.schema);
	}

	// Inline stand-in for the crypto plugin's sign(data, privkey): consumes a
	// secret second argument, returns a value derived ONLY from the first. Proves
	// the secret argument is not reflected into the returned (and thus recorded)
	// value.
	db.registerFunction({
		name: 'probe_sign',
		numArgs: 2,
		flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC,
		returnType: { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false },
		implementation: (data: SqlValue, _secret: SqlValue) => `sig(${String(data)})`,
	});

	return { db, optimystic };
}

describe('replicated statement record: secret function-argument redaction', () => {
	it('a secret passed as a function ARGUMENT does not reach the recorded statement', async () => {
		const { db, optimystic } = createEnv();

		await db.exec(`
			CREATE TABLE signatures (
				id INTEGER PRIMARY KEY,
				sig TEXT NOT NULL
			) USING optimystic('tree://test/signatures')
		`);

		// Inspect the accumulated statement BEFORE commit clears it.
		await db.exec('BEGIN');
		await db.exec(
			`INSERT INTO signatures (id, sig) VALUES (1, probe_sign('hello', '${SECRET}'))`
		);
		const statements = optimystic.txnBridge.getStatements();
		await db.exec('ROLLBACK');

		expect(statements.length, 'a statement should be recorded').to.be.greaterThan(0);
		const joined = statements.join('\n');
		expect(joined, 'the recorded statement must hold the function RESULT, not its args').to.include('sig(hello)');
		expect(joined, 'the secret argument must NOT appear in the recorded statement').to.not.include(SECRET);
	});

	it('a secret stored as a COLUMN VALUE is recorded verbatim (documented residual exposure)', async () => {
		const { db, optimystic } = createEnv();

		await db.exec(`
			CREATE TABLE keys (
				id INTEGER PRIMARY KEY,
				priv TEXT NOT NULL
			) USING optimystic('tree://test/keys')
		`);

		await db.exec('BEGIN');
		await db.exec(`INSERT INTO keys (id, priv) VALUES (1, '${SECRET}')`);
		const statements = optimystic.txnBridge.getStatements();
		await db.exec('ROLLBACK');

		// EXPECTED to contain the secret: any persisted column value is replicated,
		// independent of literal-vs-bound. This pins the true exposure boundary so a
		// future change that (correctly) still records column values is not mistaken
		// for a regression of the argument-redaction guarantee above.
		expect(statements.join('\n')).to.include(SECRET);
	});
});
