/**
 * The two rules that make a catalog-only ALTER safe when several machines run the same schema
 * upgrade: how a CHECK change is judged against the table's catalog record, and how an undo of a
 * change this machine adopted (found already in the record) is recognised. Pure; no database.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import { AdoptedChanges, adoptedChangeKey, classifyCheckChange } from '../src/schema/catalog-only-change.js';
import type { StoredCheckConstraint, StoredTableSchema } from '../src/schema/schema-manager.js';

function check(name: string, bound: number, tags?: Record<string, SqlValue>): StoredCheckConstraint {
	return {
		name,
		expr: { left: { name: 'a', type: 'column' }, operator: '>', right: { type: 'literal', value: bound }, type: 'binary' },
		operations: 7,
		...(tags && { tags }),
	};
}

function recordWith(...checks: StoredCheckConstraint[]): StoredTableSchema {
	return {
		name: 't',
		schemaName: 'main',
		columns: [],
		primaryKeyDefinition: [],
		indexes: [],
		vtabModuleName: 'optimystic',
		...(checks.length > 0 && { checkConstraints: checks }),
	};
}

describe('catalog-only CHECK changes', () => {
	describe('judged against the record', () => {
		const ours = check('pos', 0);
		const CASES: { change: 'add' | 'drop'; record: StoredTableSchema; verdict: 'owned' | 'adopted'; why: string }[] = [
			{ change: 'drop', record: recordWith(check('POS', 0, { note: 'other' })), verdict: 'owned', why: 'the CHECK as this engine holds it (name case and tags aside)' },
			{ change: 'drop', record: recordWith(), verdict: 'adopted', why: 'no CHECK of that name' },
			{ change: 'drop', record: recordWith(check('pos', 1)), verdict: 'adopted', why: 'a CHECK another machine replaced' },
			{ change: 'add', record: recordWith(), verdict: 'owned', why: 'no CHECK of that name' },
			{ change: 'add', record: recordWith(check('Pos', 0, { note: 'other' })), verdict: 'adopted', why: 'the same CHECK (name case and tags aside)' },
			{ change: 'add', record: recordWith(check('pos', 1)), verdict: 'owned', why: 'a CHECK of that name with another body, which local DDL replaces' },
		];
		for (const { change, record, verdict, why } of CASES) {
			it(`${change} over a record holding ${why}: ${verdict}`, () => {
				const judged = classifyCheckChange(record, change === 'add' ? { op: 'add', after: ours } : { op: 'drop', before: ours });
				expect(judged.kind).to.equal(verdict);
			});
		}
	});

	it('an adopted change is undone only by the change that puts back what the engine held before it', () => {
		// A machine that adopted both halves of a changed-body pair (drop pos, add pos with the new
		// body); the apply then fails and Quereus unwinds the add, then the drop.
		const key = adoptedChangeKey('main.t', 'check', 'POS');
		const adopted = new AdoptedChanges();
		const oldBody = check('pos', 0);
		const newBody = check('pos', 1);

		adopted.adopt(key, oldBody);
		expect(adopted.undoes(key, newBody), 'the forward add of the new body is not an undo').to.equal(false);
		adopted.adopt(key, undefined);

		expect(adopted.undoes(adoptedChangeKey('main.t', 'check', 'pos'), undefined), 'the undo of the add drops it').to.equal(true);
		adopted.release(key);
		expect(adopted.undoes(key, undefined)).to.equal(false);
		expect(adopted.undoes(key, check('pos', 0, { note: 'tags differ' })), 'the undo of the drop re-adds the old body').to.equal(true);
		adopted.release(key);
		expect(adopted.undoes(key, oldBody), 'nothing left to undo').to.equal(false);
		expect(adopted.undoes(adoptedChangeKey('main.u', 'check', 'pos'), undefined), 'keyed per table').to.equal(false);
	});
});
