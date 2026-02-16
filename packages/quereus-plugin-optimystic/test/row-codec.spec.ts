import { expect } from 'aegir/chai';
import { RowCodec, type StoredTableSchema } from '../dist/index.js';

/**
 * Helper to build a minimal StoredTableSchema for testing
 */
function makeSchema(
	columns: Array<{ name: string; affinity: string }>,
	pkIndices: number[] = [0]
): StoredTableSchema {
	return {
		name: 'test_table',
		schemaName: 'main',
		columns: columns.map((col, i) => ({
			name: col.name,
			affinity: col.affinity,
			notNull: false,
			primaryKey: pkIndices.includes(i),
			pkOrder: pkIndices.indexOf(i),
			collation: 'BINARY',
			generated: false,
		})),
		primaryKeyDefinition: pkIndices.map(idx => ({ index: idx })),
		indexes: [],
		vtabModuleName: 'optimystic',
	};
}

describe('RowCodec', () => {
	describe('basic encode/decode round-trip', () => {
		it('should round-trip string values', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }, { name: 'name', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);

			const row = ['abc', 'Alice'];
			const encoded = codec.encodeRow(row);
			const decoded = codec.decodeRow(encoded);

			expect(decoded[0]).to.equal('abc');
			expect(decoded[1]).to.equal('Alice');
		});

		it('should round-trip numeric values', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }, { name: 'val', affinity: 'REAL' }]);
			const codec = new RowCodec(schema);

			const row = [42, 3.14];
			const encoded = codec.encodeRow(row);
			const decoded = codec.decodeRow(encoded);

			expect(decoded[0]).to.equal(42);
			expect(decoded[1]).to.be.closeTo(3.14, 0.001);
		});

		it('should round-trip null values', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }, { name: 'opt', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);

			const row = [1, null];
			const encoded = codec.encodeRow(row);
			const decoded = codec.decodeRow(encoded);

			expect(decoded[0]).to.equal(1);
			expect(decoded[1]).to.be.null;
		});

		it('should round-trip boolean values', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }, { name: 'flag', affinity: 'INTEGER' }]);
			const codec = new RowCodec(schema);

			const row = [1, true];
			const encoded = codec.encodeRow(row);
			const decoded = codec.decodeRow(encoded);

			expect(decoded[0]).to.equal(1);
			expect(decoded[1]).to.equal(true);
		});
	});

	describe('bigint handling (HUNT-7.4.3 bug)', () => {
		it('should encode small bigints without precision loss', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }]);
			const codec = new RowCodec(schema);

			const row = [BigInt(42)];
			const encoded = codec.encodeRow(row);
			const decoded = codec.decodeRow(encoded);

			expect(decoded[0]).to.equal(42);
		});

		it('should lose precision for bigints > 2^53 (known bug)', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }]);
			const codec = new RowCodec(schema);

			const largeBigint = BigInt('9007199254740993'); // 2^53 + 1
			const row = [largeBigint];
			const encoded = codec.encodeRow(row);
			const decoded = codec.decodeRow(encoded);

			// Documents the known precision loss bug (HUNT-7.4.3 line 190):
			// normalizeValue() converts bigint to Number, which truncates to 2^53.
			// The original value (2^53 + 1) is irrecoverably lost.
			expect(decoded[0]).to.equal(9007199254740992); // got 2^53, not 2^53+1
		});
	});

	describe('Uint8Array handling (HUNT-7.4.3 bug)', () => {
		it('should encode Uint8Array to base64 string', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }, { name: 'data', affinity: 'BLOB' }]);
			const codec = new RowCodec(schema);

			const row = [1, new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])];
			const encoded = codec.encodeRow(row);
			const parsed = JSON.parse(encoded as string);

			// Verify the Uint8Array was encoded to base64
			expect(parsed.data).to.be.a('string');
		});

		it('should not restore Uint8Array on decode (known bug)', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }, { name: 'data', affinity: 'BLOB' }]);
			const codec = new RowCodec(schema);

			const original = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
			const row = [1, original];
			const encoded = codec.encodeRow(row);
			const decoded = codec.decodeRow(encoded);

			// This documents the known round-trip bug (HUNT-7.4.3 line 193)
			// Uint8Array is encoded to base64 but decodeRow() returns the raw base64 string
			expect(decoded[1]).to.be.a('string');
			expect(decoded[1]).to.not.be.instanceOf(Uint8Array);
		});
	});

	describe('primary key extraction', () => {
		it('should extract a single-column primary key', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }, { name: 'name', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);

			const pk = codec.extractPrimaryKey(['abc', 'Alice']);
			expect(pk).to.equal('abc');
		});

		it('should extract a composite primary key joined with \\x00', () => {
			const schema = makeSchema(
				[{ name: 'a', affinity: 'TEXT' }, { name: 'b', affinity: 'TEXT' }, { name: 'val', affinity: 'TEXT' }],
				[0, 1]
			);
			const codec = new RowCodec(schema);

			const pk = codec.extractPrimaryKey(['foo', 'bar', 'data']);
			expect(pk).to.equal('foo\x00bar');
		});

		it('should represent NULL in keys as \\x01NULL\\x01', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);

			const pk = codec.extractPrimaryKey([null]);
			expect(pk).to.equal('\x01NULL\x01');
		});

		it('should serialize numeric key parts as strings', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }]);
			const codec = new RowCodec(schema);

			const pk = codec.extractPrimaryKey([42]);
			expect(pk).to.equal('42');
		});
	});

	describe('createPrimaryKey()', () => {
		it('should create a key from values array', () => {
			const schema = makeSchema(
				[{ name: 'a', affinity: 'TEXT' }, { name: 'b', affinity: 'TEXT' }],
				[0, 1]
			);
			const codec = new RowCodec(schema);

			const pk = codec.createPrimaryKey(['x', 'y']);
			expect(pk).to.equal('x\x00y');
		});

		it('should throw when value count mismatches PK definition', () => {
			const schema = makeSchema(
				[{ name: 'a', affinity: 'TEXT' }, { name: 'b', affinity: 'TEXT' }],
				[0, 1]
			);
			const codec = new RowCodec(schema);

			expect(() => codec.createPrimaryKey(['x'])).to.throw();
		});
	});

	describe('primary key comparator', () => {
		it('should compare single-column string keys', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);
			const cmp = codec.createPrimaryKeyComparator();

			expect(cmp('aaa', 'bbb')).to.be.below(0);
			expect(cmp('bbb', 'aaa')).to.be.above(0);
			expect(cmp('aaa', 'aaa')).to.equal(0);
		});

		it('should compare numeric key parts numerically', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }]);
			const codec = new RowCodec(schema);
			const cmp = codec.createPrimaryKeyComparator();

			expect(cmp('2', '10')).to.be.below(0);
			expect(cmp('10', '2')).to.be.above(0);
		});

		it('should handle NULL keys (sorted first)', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);
			const cmp = codec.createPrimaryKeyComparator();

			expect(cmp('\x01NULL\x01', 'abc')).to.be.below(0);
			expect(cmp('abc', '\x01NULL\x01')).to.be.above(0);
			expect(cmp('\x01NULL\x01', '\x01NULL\x01')).to.equal(0);
		});

		it('should return 0 for empty PK definition (singleton table)', () => {
			const schema: StoredTableSchema = {
				name: 'singleton',
				schemaName: 'main',
				columns: [{ name: 'val', affinity: 'TEXT', notNull: false, primaryKey: false, pkOrder: 0, collation: 'BINARY', generated: false }],
				primaryKeyDefinition: [],
				indexes: [],
				vtabModuleName: 'optimystic',
			};
			const codec = new RowCodec(schema);
			const cmp = codec.createPrimaryKeyComparator();

			expect(cmp('anything', 'else')).to.equal(0);
		});
	});

	describe('schema utilities', () => {
		it('should report column count', () => {
			const schema = makeSchema([{ name: 'a', affinity: 'TEXT' }, { name: 'b', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);
			expect(codec.getColumnCount()).to.equal(2);
		});

		it('should look up column index by name (case-insensitive)', () => {
			const schema = makeSchema([{ name: 'Id', affinity: 'TEXT' }, { name: 'Name', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);
			expect(codec.getColumnIndex('id')).to.equal(0);
			expect(codec.getColumnIndex('NAME')).to.equal(1);
			expect(codec.getColumnIndex('missing')).to.equal(-1);
		});

		it('should identify primary key columns', () => {
			const schema = makeSchema(
				[{ name: 'a', affinity: 'TEXT' }, { name: 'b', affinity: 'TEXT' }, { name: 'c', affinity: 'TEXT' }],
				[0, 2]
			);
			const codec = new RowCodec(schema);

			expect(codec.isColumnInPrimaryKey(0)).to.be.true;
			expect(codec.isColumnInPrimaryKey(1)).to.be.false;
			expect(codec.isColumnInPrimaryKey(2)).to.be.true;
		});

		it('should throw for msgpack encoding', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema, 'msgpack');
			expect(() => codec.encodeRow(['test'])).to.throw('msgpack');
			expect(() => codec.decodeRow('test')).to.throw('msgpack');
		});
	});
});

