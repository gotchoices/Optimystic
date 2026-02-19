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

	describe('key serialization edge cases', () => {
		it('should collide when key contains \\x00 separator (known bug)', () => {
			// BUG: Composite keys using \x00 as separator have no escaping.
			// A key value containing \x00 causes collision during comparison.
			const schema = makeSchema(
				[{ name: 'a', affinity: 'TEXT' }, { name: 'b', affinity: 'TEXT' }],
				[0, 1]
			);
			const codec = new RowCodec(schema);
			const cmp = codec.createPrimaryKeyComparator();

			// ('foo\x00bar', 'baz') serializes to 'foo\x00bar\x00baz'
			// ('foo', 'bar') serializes to 'foo\x00bar'
			// On split, the first becomes ['foo', 'bar', 'baz'] — 3 parts for a 2-part key
			const pk1 = codec.extractPrimaryKey(['foo\x00bar', 'baz']);
			const pk2 = codec.extractPrimaryKey(['foo', 'bar']);
			// These are different rows but collide after the first 2 parts are compared
			expect(cmp(pk1, pk2)).to.equal(0); // BUG: should not be equal
		});

		it('should lose text affinity for numeric-looking strings (known bug)', () => {
			// BUG: deserializeKeyPart() always tries Number() first, ignoring column affinity.
			// TEXT "123" is deserialized as number 123, so comparator uses numeric ordering.
			const textSchema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const textCodec = new RowCodec(textSchema);
			const textCmp = textCodec.createPrimaryKeyComparator();

			const intSchema = makeSchema([{ name: 'id', affinity: 'INTEGER' }]);
			const intCodec = new RowCodec(intSchema);
			const intCmp = intCodec.createPrimaryKeyComparator();

			// TEXT column: "123" vs "9" — should be lexicographic ("1" < "9"), but...
			expect(textCmp('123', '9')).to.be.above(0); // BUG: numeric comparison used
			// INTEGER column: 123 vs 9 — correctly numeric
			expect(intCmp('123', '9')).to.be.above(0);
		});

		it('should sort negative numbers correctly', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'INTEGER' }]);
			const codec = new RowCodec(schema);
			const cmp = codec.createPrimaryKeyComparator();

			// -10 < -2 < 0 < 5
			expect(cmp('-10', '-2')).to.be.below(0);
			expect(cmp('-2', '0')).to.be.below(0);
			expect(cmp('0', '5')).to.be.below(0);
			expect(cmp('-10', '5')).to.be.below(0);
		});

		it('should handle NaN in key serialization', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'REAL' }]);
			const codec = new RowCodec(schema);

			// NaN.toString() === "NaN"
			// deserializeKeyPart("NaN") → Number("NaN") is NaN, isNaN(NaN) is true
			// so it falls through to string — type confusion
			const pk = codec.extractPrimaryKey([NaN]);
			expect(pk).to.equal('NaN');

			// But comparator should handle NaN keys consistently
			const cmp = codec.createPrimaryKeyComparator();
			// NaN compared to anything should be consistent (not crash)
			expect(() => cmp('NaN', '5')).to.not.throw();
		});

		it('should handle Infinity and -Infinity in keys', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'REAL' }]);
			const codec = new RowCodec(schema);

			const posPk = codec.extractPrimaryKey([Infinity]);
			const negPk = codec.extractPrimaryKey([-Infinity]);

			expect(posPk).to.equal('Infinity');
			expect(negPk).to.equal('-Infinity');

			// deserializeKeyPart("Infinity") → Number("Infinity") → Infinity (a number)
			// This actually works for comparison, but let's verify
			const cmp = codec.createPrimaryKeyComparator();
			expect(cmp(negPk, '0')).to.be.below(0);
			expect(cmp('0', posPk)).to.be.below(0);
			expect(cmp(negPk, posPk)).to.be.below(0);
		});

		it('should handle empty string as a key value', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);

			// Empty string key — serializeKeyPart returns ""
			// deserializeKeyPart("") → Number("") is 0, isNaN(0) is false, "" !== ""... wait
			// Actually: Number("") === 0, isNaN(0) === false, but serialized !== '' check:
			// the condition is `!isNaN(num) && serialized !== ''` — so empty string stays as string
			const pk = codec.extractPrimaryKey(['']);
			expect(pk).to.equal('');
		});

		it('should handle empty string in composite key without confusing split', () => {
			const schema = makeSchema(
				[{ name: 'a', affinity: 'TEXT' }, { name: 'b', affinity: 'TEXT' }],
				[0, 1]
			);
			const codec = new RowCodec(schema);

			// ('', 'x') → '\x00x', ('x', '') → 'x\x00'
			const pk1 = codec.extractPrimaryKey(['', 'x']);
			const pk2 = codec.extractPrimaryKey(['x', '']);

			const cmp = codec.createPrimaryKeyComparator();
			expect(cmp(pk1, pk2)).to.not.equal(0);
		});

		it('should treat whitespace-only string as number 0 (known bug)', () => {
			// BUG: Number(" ") === 0, so deserializeKeyPart treats space as 0
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);
			const cmp = codec.createPrimaryKeyComparator();

			// Space key and "0" key should be different, but both deserialize to 0
			expect(cmp(' ', '0')).to.equal(0); // BUG: space becomes number 0
		});

		it('should collide \\x01NULL\\x01 literal with actual null (known bug)', () => {
			// BUG: The NULL sentinel '\x01NULL\x01' has no escaping mechanism.
			// A literal string value of '\x01NULL\x01' is indistinguishable from null.
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);

			const nullPk = codec.extractPrimaryKey([null]);
			const literalPk = codec.extractPrimaryKey(['\x01NULL\x01']);
			expect(nullPk).to.equal(literalPk); // BUG: collision
		});

		it('should treat scientific notation "1e2" as number 100 (known bug)', () => {
			// BUG: deserializeKeyPart("1e2") → Number("1e2") → 100
			// TEXT column with key "1e2" becomes indistinguishable from "100"
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);
			const cmp = codec.createPrimaryKeyComparator();

			expect(cmp('1e2', '100')).to.equal(0); // BUG: "1e2" treated as number 100
		});

		it('should handle hex strings like "0xff" in key deserialization', () => {
			const schema = makeSchema([{ name: 'id', affinity: 'TEXT' }]);
			const codec = new RowCodec(schema);

			// "0xff" → Number("0xff") === 255
			// So deserializeKeyPart will treat "0xff" as the number 255
			const cmp = codec.createPrimaryKeyComparator();

			// For a TEXT column, "0xff" should sort as text, not as 255
			// "0xff" vs "256" — lexicographic: "0" < "2", so "0xff" < "256"
			// but if treated as numbers: 255 < 256
			// The result happens to match but for the wrong reason
			expect(cmp('0xff', '3')).to.not.equal(0);
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

