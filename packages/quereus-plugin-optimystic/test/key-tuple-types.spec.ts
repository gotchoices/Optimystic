/**
 * Compile-time guards for the nominal key-tuple types (src/schema/key-tuples.ts).
 *
 * Three differently-addressed value lists reach the key-building machinery — a FULL ROW
 * (one cell per table column, addressed by column position), a PRIMARY KEY TUPLE (one
 * cell per primary-key column, in key order, addressed positionally), and an INDEX
 * COLUMN TUPLE. When all three were plain `SqlValue[]`, substituting one for another
 * compiled, ran, and produced a wrong-but-valid tree key. Two shipped bugs came from
 * exactly that.
 *
 * The runtime arity checks catch most substitutions but are blind whenever the two
 * shapes happen to be the SAME LENGTH — e.g. `create table R (a text, b text, primary
 * key (b, a))`, where a full row is `[a, b]` and the key tuple is `[b, a]`, both
 * length 2. That residual hole is what these type-level guards close.
 *
 * HOW THIS FILE WORKS: the assertions are `@ts-expect-error` annotations, which are
 * errors themselves if the line beneath them ever STOPS being an error. So this file
 * fails `yarn typecheck` (in the root `check` chain, and again under ts-node when mocha
 * loads it) the moment any guard is weakened. The forbidden calls live inside a function
 * that is never invoked — they must be type-checked, never executed.
 */

import { expect } from 'chai';
import type { Row, SqlValue } from '@quereus/quereus';
import { RowCodec } from '../src/schema/row-codec.js';
import { IndexManager, indexKeyFromValues } from '../src/schema/index-manager.js';
import { KEY_PREFIX_END } from '../src/schema/key-encoding.js';
import type { StoredTableSchema, StoredIndexSchema } from '../src/schema/schema-manager.js';

/**
 * `create table R (a text, b text, primary key (b, a))` — the equal-length, rotated
 * shape the arity guards cannot tell apart. A full row is `[a, b]`; the key tuple is
 * `[b, a]`.
 */
const ROTATED_SCHEMA: StoredTableSchema = {
	name: 'R',
	schemaName: 'main',
	columns: [
		{ name: 'a', affinity: 'TEXT', notNull: false, primaryKey: true, pkOrder: 1, collation: 'BINARY', generated: false },
		{ name: 'b', affinity: 'TEXT', notNull: false, primaryKey: true, pkOrder: 0, collation: 'BINARY', generated: false },
	],
	// Key order (b, a) — the REVERSE of column order.
	primaryKeyDefinition: [{ index: 1 }, { index: 0 }],
	indexes: [],
	vtabModuleName: 'optimystic',
};

const IDX_A: StoredIndexSchema = { name: 'idx_a', columns: [{ index: 0 }] };

/** Two-column index over a three-column table — the shape a PREFIX seek needs. */
const WIDE_SCHEMA: StoredTableSchema = {
	name: 'W',
	schemaName: 'main',
	columns: [
		{ name: 'id', affinity: 'INTEGER', notNull: false, primaryKey: true, pkOrder: 0, collation: 'BINARY', generated: false },
		{ name: 'x', affinity: 'TEXT', notNull: false, primaryKey: false, pkOrder: -1, collation: 'BINARY', generated: false },
		{ name: 'y', affinity: 'TEXT', notNull: false, primaryKey: false, pkOrder: -1, collation: 'BINARY', generated: false },
	],
	primaryKeyDefinition: [{ index: 0 }],
	indexes: [{ name: 'idx_xy', columns: [{ index: 1 }, { index: 2 }] }],
	vtabModuleName: 'optimystic',
};

const IDX_XY: StoredIndexSchema = WIDE_SCHEMA.indexes[0]!;

/** IndexManager whose tree factory is never reached — these tests only build keys. */
function makeIndexManager(schema: StoredTableSchema): IndexManager {
	return new IndexManager(schema, () => {
		throw new Error('index tree factory must not be used by key-building tests');
	});
}

/**
 * Never invoked — exists only so the compiler checks the annotations inside it. Calling
 * it would run the very substitutions being forbidden.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _compileTimeGuards(codec: RowCodec, indexes: IndexManager): void {
	const row: Row = ['a-value', 'b-value'];
	const pkTuple = codec.asPrimaryKeyTuple(['b-value', 'a-value']);
	const idxTuple = indexes.asIndexColumnTuple(IDX_A, ['a-value']);

	// ---- These five MUST compile (the intended, correct calls) --------------------
	codec.extractPrimaryKey(row);
	codec.createPrimaryKey(pkTuple);
	indexes.createIndexKey(IDX_A, row);
	indexes.createIndexKeyFromTuple(idxTuple);
	indexes.asIndexColumnTuple(IDX_A, ['a-value']);

	// ---- These MUST NOT compile ---------------------------------------------------

	// A key tuple where a full row is expected. Blocked by readonly-vs-mutable: `Row`
	// is quereus's mutable `SqlValue[]`. This is the substitution that made a same-key
	// UPDATE report itself as a UNIQUE collision.
	// @ts-expect-error PrimaryKeyTuple is not a Row
	codec.extractPrimaryKey(pkTuple);

	// A full row where a key tuple is expected. Blocked by the brand. This is the
	// substitution that made a composite-PK point lookup match nothing.
	// @ts-expect-error Row is not a PrimaryKeyTuple
	codec.createPrimaryKey(row);

	// Cross-tuple substitution: the two tuple kinds are addressed by different orders
	// (PK order vs index order) and are not interchangeable.
	// @ts-expect-error IndexColumnTuple is not a PrimaryKeyTuple
	codec.createPrimaryKey(idxTuple);

	// @ts-expect-error PrimaryKeyTuple is not an IndexColumnTuple
	indexes.createIndexKeyFromTuple(pkTuple);

	// A bare array literal must go through the checked constructor, which is where the
	// arity is validated.
	// @ts-expect-error must be built via asPrimaryKeyTuple
	codec.createPrimaryKey(['b-value', 'a-value']);

	// @ts-expect-error must be built via asIndexColumnTuple
	indexes.createIndexKeyFromTuple(['a-value']);

	// An index tuple where a full row is expected (createIndexKey addresses
	// row[indexCol.index]).
	// @ts-expect-error IndexColumnTuple is not a Row
	indexes.createIndexKey(IDX_A, idxTuple);

	// A tuple must not reach index maintenance, which addresses both sides by column
	// position.
	// @ts-expect-error PrimaryKeyTuple is not a Row
	void indexes.insertIndexEntries(pkTuple, 'some-pk');

	// Laundering one tuple kind into the other THROUGH the checked constructor. The
	// arity check cannot see this whenever the two happen to be the same width, so the
	// constructors take `UnbrandedValues` and refuse anything already branded.
	// @ts-expect-error an IndexColumnTuple cannot be re-branded as a PrimaryKeyTuple
	codec.asPrimaryKeyTuple(idxTuple);

	// @ts-expect-error a PrimaryKeyTuple cannot be re-branded as an IndexColumnTuple
	indexes.asIndexColumnTuple(IDX_A, pkTuple);

	// Re-wrapping a tuple as its OWN kind is pointless and likewise refused, so the
	// constructor stays a one-way door from unbranded values.
	// @ts-expect-error already a PrimaryKeyTuple
	codec.asPrimaryKeyTuple(pkTuple);

	// A full row and a bare literal remain valid constructor inputs — `UnbrandedValues`
	// must not have made the constructors unusable.
	codec.asPrimaryKeyTuple(row);
	indexes.asIndexColumnTuple(IDX_A, ['a-value']);
}

/**
 * The branded types are erased at runtime — a tuple is still an ordinary array, so the
 * method bodies (`.map`, `.length`, indexing) need no adaptation. If the brand ever
 * became a real property this would break.
 */
describe('key-tuple nominal types', () => {
	it('brands are type-only: a tuple behaves as an ordinary readonly array at runtime', () => {
		const codec = new RowCodec(ROTATED_SCHEMA);
		const tuple = codec.asPrimaryKeyTuple(['b-value', 'a-value']);

		expect(Array.isArray(tuple)).to.equal(true);
		expect(tuple.length).to.equal(2);
		expect(tuple[0]).to.equal('b-value');
		expect(tuple.map((v: SqlValue) => String(v))).to.deep.equal(['b-value', 'a-value']);
		// No runtime brand property was added.
		expect(Object.keys(tuple)).to.deep.equal(['0', '1']);
	});

	it('the compile-time guards are checked, not executed', () => {
		// _compileTimeGuards is deliberately never called; tsc (and ts-node, which
		// type-checks each spec as it loads) is what enforces its @ts-expect-error lines.
		expect(typeof _compileTimeGuards).to.equal('function');
	});

	it('index tuples are branded but still ordinary readonly arrays', () => {
		const indexes = makeIndexManager(WIDE_SCHEMA);
		const tuple = indexes.asIndexColumnTuple(IDX_XY, ['x-val']);

		expect(Array.isArray(tuple)).to.equal(true);
		expect(tuple.length).to.equal(1);
		expect(Object.keys(tuple)).to.deep.equal(['0']);
	});

	it('the rotated all-column PK really is the equal-length blind spot', () => {
		// Both shapes are length 2, so neither arity guard can reject the other's input —
		// this is the case the types exist for.
		expect(ROTATED_SCHEMA.columns.length).to.equal(ROTATED_SCHEMA.primaryKeyDefinition.length);
		const codec = new RowCodec(ROTATED_SCHEMA);
		// The full row [a, b] and the key tuple [b, a] hold the same cells in different
		// order, and produce DIFFERENT keys — swapping them is silent corruption, not a
		// no-op.
		const fromRow = codec.extractPrimaryKey(['a-value', 'b-value']);
		const fromTuple = codec.createPrimaryKey(codec.asPrimaryKeyTuple(['a-value', 'b-value']));
		expect(fromRow).to.not.equal(fromTuple);
		// Addressed correctly, the two agree byte-for-byte.
		expect(fromRow).to.equal(
			codec.createPrimaryKey(codec.asPrimaryKeyTuple(['b-value', 'a-value'])),
		);
	});
});

/**
 * `asIndexColumnTuple` is the checked constructor for the index-key seek shape. Unlike
 * a primary-key tuple it deliberately accepts a leading PREFIX (a partial seek key
 * brackets a range) but rejects an empty tuple (which would range over the whole index).
 */
describe('asIndexColumnTuple() arity', () => {
	it('accepts the full index width', () => {
		const indexes = makeIndexManager(WIDE_SCHEMA);

		expect(indexes.asIndexColumnTuple(IDX_XY, ['x-val', 'y-val']).length).to.equal(2);
	});

	it('accepts a leading prefix', () => {
		const indexes = makeIndexManager(WIDE_SCHEMA);

		expect(indexes.asIndexColumnTuple(IDX_XY, ['x-val']).length).to.equal(1);
	});

	it('rejects an empty tuple', () => {
		const indexes = makeIndexManager(WIDE_SCHEMA);

		expect(() => indexes.asIndexColumnTuple(IDX_XY, [])).to.throw(/requires 1 to 2 values.*got 0/);
	});

	it('rejects an over-wide tuple (the module truncates BEFORE calling it)', () => {
		const indexes = makeIndexManager(WIDE_SCHEMA);

		expect(() => indexes.asIndexColumnTuple(IDX_XY, ['x', 'y', 'z']))
			.to.throw(/requires 1 to 2 values.*got 3/);
	});
});

/**
 * The assertion that pins the two index-key entry points to ONE framing. A seek key
 * built from positional constraint values must be byte-identical to the key an INSERT
 * stored from the full row — a drift between them silently makes the seek match nothing,
 * which is how the composite-PK point-lookup bug presented.
 */
describe('index key byte-identity across entry points', () => {
	const fullRow = (x: SqlValue, y: SqlValue): Row => [1, x, y];

	it('tuple-built and row-built keys are identical at full width', () => {
		const indexes = makeIndexManager(WIDE_SCHEMA);

		const fromTuple = indexes.createIndexKeyFromTuple(
			indexes.asIndexColumnTuple(IDX_XY, ['x-val', 'y-val']),
		);
		const fromRow = indexes.createIndexKey(IDX_XY, fullRow('x-val', 'y-val'));
		expect(fromTuple).to.equal(fromRow);
	});

	it('a partial-prefix key is a string prefix of the full key', () => {
		const indexes = makeIndexManager(WIDE_SCHEMA);

		const prefix = indexes.createIndexKeyFromTuple(indexes.asIndexColumnTuple(IDX_XY, ['x-val']));
		const full = indexes.createIndexKey(IDX_XY, fullRow('x-val', 'y-val'));
		expect(full.startsWith(prefix)).to.equal(true);
		expect(full).to.not.equal(prefix);
	});

	it('NULL stays distinct from the empty string in both entry points', () => {
		const indexes = makeIndexManager(WIDE_SCHEMA);

		const nullTuple = indexes.createIndexKeyFromTuple(indexes.asIndexColumnTuple(IDX_XY, [null, 'y']));
		const emptyTuple = indexes.createIndexKeyFromTuple(indexes.asIndexColumnTuple(IDX_XY, ['', 'y']));
		expect(nullTuple).to.not.equal(emptyTuple);
		expect(nullTuple).to.equal(indexes.createIndexKey(IDX_XY, fullRow(null, 'y')));
		expect(emptyTuple).to.equal(indexes.createIndexKey(IDX_XY, fullRow('', 'y')));
	});

	/**
	 * The one production path that bypasses `asIndexColumnTuple`: an index-served scan
	 * with zero constraint values (a plan of the `idxNum >= 10` legacy shape with
	 * `argc === 0`, e.g. an index-served ORDER BY) calls `indexKeyFromValues([])`
	 * directly, because the constructor deliberately rejects an empty tuple. Pinned
	 * here so the bypass keeps meaning "the whole index".
	 */
	it('the zero-width key frames to the empty string and prefixes every index key', () => {
		const indexes = makeIndexManager(WIDE_SCHEMA);

		expect(indexKeyFromValues([])).to.equal('');
		expect(indexes.createIndexKey(IDX_XY, fullRow('x-val', 'y-val')).startsWith(indexKeyFromValues([])))
			.to.equal(true);
		// And it is strictly below the prefix-range upper bound, so [key, key+END) really
		// does bracket the entire index rather than an empty range.
		expect(indexKeyFromValues([]) < KEY_PREFIX_END).to.equal(true);
	});

	it('numeric values agree between the tuple and row paths', () => {
		// serializeIndexValue's toExponential form must be reached identically from both
		// entry points — a plain-integer form on one side would break REAL range bounds.
		const indexes = makeIndexManager(WIDE_SCHEMA);

		expect(indexes.createIndexKeyFromTuple(indexes.asIndexColumnTuple(IDX_XY, [42, 7])))
			.to.equal(indexes.createIndexKey(IDX_XY, fullRow(42, 7)));
	});
});
