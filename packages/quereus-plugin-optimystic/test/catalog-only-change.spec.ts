/**
 * The two rules that make a catalog-only ALTER safe when several machines run the same schema
 * upgrade: how a CHECK or column change is judged against the table's catalog record, and how an
 * undo of a change this machine adopted (found already in the record) is recognised — plus the
 * record edit of a dropped column, whose renumbering no write-time check can verify. Pure; no
 * database.
 */

import { expect } from 'chai';
import { StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { AdoptedChanges, adoptedChangeKey, classifyCheckChange, classifyColumnChange } from '../src/schema/catalog-only-change.js';
import { toPersistedSchema, withoutColumn } from '../src/schema/schema-manager.js';
import type { StoredCheckConstraint, StoredColumnSchema, StoredTableSchema } from '../src/schema/schema-manager.js';

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

function column(name: string, affinity = 'TEXT', tags?: Record<string, SqlValue>): StoredColumnSchema {
	return {
		name,
		affinity,
		declaredType: affinity.toLowerCase(),
		notNull: false,
		primaryKey: false,
		pkOrder: 0,
		collation: 'BINARY',
		generated: false,
		...(tags && { tags }),
	};
}

describe('catalog-only column changes', () => {
	describe('judged against the record', () => {
		const ours = column('b');
		const base = (...columns: StoredColumnSchema[]): StoredTableSchema => ({
			...recordWith(),
			columns: [{ ...column('id', 'INTEGER'), primaryKey: true, pkOrder: 1 }, ...columns],
			primaryKeyDefinition: [{ index: 0 }],
		});
		const CASES: { change: 'add' | 'drop'; record: StoredTableSchema; verdict: 'owned' | 'adopted' | 'refused'; why: string; code?: StatusCode }[] = [
			{ change: 'add', record: base(), verdict: 'owned', why: 'no column of that name' },
			{ change: 'add', record: base(column('B', 'TEXT', { note: 'other' })), verdict: 'adopted', why: 'the same column (name case and tags aside)' },
			{ change: 'add', record: base(column('b', 'INTEGER')), verdict: 'refused', code: StatusCode.ERROR, why: 'a column of that name with another type' },
			{ change: 'drop', record: base(column('b', 'INTEGER')), verdict: 'owned', why: 'the column, however it is defined' },
			{ change: 'drop', record: base(), verdict: 'adopted', why: 'no column of that name' },
			{
				change: 'drop',
				record: { ...base(column('b')), indexes: [{ name: 'by_b', columns: [{ index: 1 }] }] },
				verdict: 'refused',
				code: StatusCode.UNSUPPORTED,
				why: 'the column, with an index on it this engine has not seen',
			},
		];
		for (const { change, record, verdict, why, code } of CASES) {
			it(`${change} over a record holding ${why}: ${verdict}`, () => {
				const judged = classifyColumnChange(record, change === 'add' ? { op: 'add', after: ours } : { op: 'drop', before: ours });
				expect(judged.kind).to.equal(verdict);
				if (judged.kind === 'refused') {
					expect(judged.code).to.equal(code);
				}
			});
		}
	});

	it('removing a column renumbers every positional field after it', () => {
		// [id, a, b, c, d, g]: the key on id, a FOREIGN KEY on b, an index on c, a UNIQUE on d, and g
		// generated from c and d. Every one of them sits at or after the dropped column but `id`.
		const record: StoredTableSchema = {
			...recordWith(),
			columns: [column('id', 'INTEGER'), column('a'), column('b', 'INTEGER'), column('c'), column('d'), { ...column('g'), generated: true }],
			primaryKeyDefinition: [{ index: 0 }],
			indexes: [{ name: 'by_c', columns: [{ index: 3 }] }],
			uniqueConstraints: [{ name: 'one_d', columns: [4] }],
			foreignKeys: [{ name: 'to_p', columns: [2], referencedTable: 'p', onDelete: 'restrict', onUpdate: 'restrict', deferred: false }],
			generatedColumnDependencies: [[5, [3, 4]]],
			generatedColumnTopoOrder: [5],
		};

		const dropped = withoutColumn(record, 'A');

		expect(dropped.columns.map(col => col.name)).to.deep.equal(['id', 'b', 'c', 'd', 'g']);
		expect(dropped.primaryKeyDefinition).to.deep.equal([{ index: 0 }]);
		expect(dropped.foreignKeys?.map(fk => fk.columns)).to.deep.equal([[1]]);
		expect(dropped.indexes.map(idx => idx.columns)).to.deep.equal([[{ index: 2 }]]);
		expect(toPersistedSchema(dropped).indexes[0]!.columns, 'persisted by the name of the column it was declared on')
			.to.deep.equal([{ name: 'c' }]);
		expect(dropped.uniqueConstraints?.map(uc => uc.columns)).to.deep.equal([[3]]);
		expect(dropped.generatedColumnDependencies).to.deep.equal([[4, [2, 3]]]);
		expect(dropped.generatedColumnTopoOrder).to.deep.equal([4]);
	});
});
