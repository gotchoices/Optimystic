import { expect } from 'chai';
import {
	leafDigest, setCommit, setDisclose, setVerify,
	resolveHasher, resolveOutputEncoder,
	type SaltedLeaf, type SetDisclosure,
} from '../dist/index.js';
import registerCryptoPlugin from '../dist/plugin.js';

const sha256 = resolveHasher('sha256');
const hexEnc = resolveOutputEncoder('hex');
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// Deterministic salts (16 bytes each) — golden vectors are pinned against these.
const SALT1 = Uint8Array.from({ length: 16 }, (_, i) => i);       // 0001..0f
const SALT2 = Uint8Array.from({ length: 16 }, (_, i) => i + 16);  // 1011..1f
const SALT1_B64 = 'AAECAwQFBgcICQoLDA0ODw';
const SALT2_B64 = 'EBESExQVFhcYGRobHB0eHw';

// A representative registration field set.
const FIELDS = (): SaltedLeaf[] => [
	{ name: 'first', value: 'alice', salt: SALT1 },
	{ name: 'age', value: 42, salt: SALT2 },
	{ name: 'citizen', value: true, salt: SALT1 },
	{ name: 'middle', value: null, salt: SALT2 },
];

describe('Selective-disclosure set commitment', () => {
	describe('setCommit() — root', () => {
		it('is deterministic for the same set', () => {
			expect(setCommit(FIELDS())).to.equal(setCommit(FIELDS()));
		});

		it('is independent of input order (sort by raw leaf-digest bytes)', () => {
			const a = setCommit(FIELDS());
			const shuffled = [...FIELDS()].reverse();
			expect(setCommit(shuffled)).to.equal(a);
		});

		it('treats a base64url-string salt and the equivalent raw bytes identically', () => {
			const withBytes = setCommit([{ name: 'x', value: 'v', salt: SALT1 }]);
			const withText = setCommit([{ name: 'x', value: 'v', salt: SALT1_B64 }]);
			expect(withText).to.equal(withBytes);
		});

		it('handles the empty set deterministically (not an error)', () => {
			expect(() => setCommit([])).to.not.throw();
			expect(setCommit([])).to.equal(setCommit([]));
		});

		it('handles a single-leaf set', () => {
			const r = setCommit([{ name: 'only', value: 1, salt: SALT1 }]);
			expect(r).to.be.a('string');
		});

		it('throws on a duplicate leaf name', () => {
			expect(() => setCommit([
				{ name: 'dup', value: 'a', salt: SALT1 },
				{ name: 'dup', value: 'b', salt: SALT2 },
			])).to.throw(/duplicate/);
		});

		it('throws on a missing or empty salt', () => {
			expect(() => setCommit([{ name: 'x', value: 'v', salt: undefined as any }])).to.throw(/salt/);
			expect(() => setCommit([{ name: 'x', value: 'v', salt: '' }])).to.throw(/salt/);
			expect(() => setCommit([{ name: 'x', value: 'v', salt: new Uint8Array(0) }])).to.throw(/salt/);
		});
	});

	describe('setDisclose() / setVerify() — round trip', () => {
		it('verifies a disclosure of a subset against the signed root', () => {
			const leaves = FIELDS();
			const root = setCommit(leaves);
			const disclosure = setDisclose(leaves, ['first', 'citizen']);
			expect(disclosure.disclosed.map((l) => l.name)).to.deep.equal(['first', 'citizen']);
			expect(disclosure.hidden).to.have.length(2); // age + middle withheld
			expect(setVerify(root, disclosure)).to.be.true;
		});

		it('verifies an all-disclosed and a none-disclosed (all-hidden) disclosure', () => {
			const leaves = FIELDS();
			const root = setCommit(leaves);
			expect(setVerify(root, setDisclose(leaves, leaves.map((l) => l.name)))).to.be.true;
			expect(setVerify(root, setDisclose(leaves, []))).to.be.true;
		});

		it('does not leak withheld values or salts in the disclosure', () => {
			const leaves = FIELDS();
			const disclosure = setDisclose(leaves, ['first']);
			const blob = JSON.stringify(disclosure);
			expect(blob).to.not.contain('42');     // age value
			expect(blob).to.not.contain(SALT2_B64); // a withheld salt
			expect(disclosure.hidden.every((h) => typeof h === 'string')).to.be.true;
		});

		it('verifies a disclosure over the empty set', () => {
			const root = setCommit([]);
			expect(setVerify(root, { disclosed: [], hidden: [] })).to.be.true;
		});

		it('verifies a NULL-valued disclosed leaf', () => {
			const leaves = FIELDS();
			const root = setCommit(leaves);
			expect(setVerify(root, setDisclose(leaves, ['middle']))).to.be.true;
		});

		it('round-trips through a Uint8Array root (bytes comparison path)', () => {
			const leaves = FIELDS();
			const rootBytes = setCommit(leaves, sha256, resolveOutputEncoder('bytes')) as Uint8Array;
			const disclosure = setDisclose(leaves, ['age']);
			expect(setVerify(rootBytes, disclosure)).to.be.true;
		});

		it('throws on a duplicate name during disclose', () => {
			expect(() => setDisclose([
				{ name: 'dup', value: 'a', salt: SALT1 },
				{ name: 'dup', value: 'b', salt: SALT2 },
			], ['dup'])).to.throw(/duplicate/);
		});
	});

	describe('setVerify() — tamper & forgery resistance', () => {
		const leaves = FIELDS();
		const root = setCommit(leaves);

		it('rejects a changed disclosed value', () => {
			const d = setDisclose(leaves, ['first']);
			const tampered: SetDisclosure = {
				disclosed: [{ ...d.disclosed[0]!, value: 'mallory' }],
				hidden: d.hidden,
			};
			expect(setVerify(root, tampered)).to.be.false;
		});

		it('rejects a changed disclosed salt', () => {
			const d = setDisclose(leaves, ['first']);
			const tampered: SetDisclosure = {
				disclosed: [{ ...d.disclosed[0]!, salt: SALT2 }],
				hidden: d.hidden,
			};
			expect(setVerify(root, tampered)).to.be.false;
		});

		it('rejects a tampered hidden digest', () => {
			const d = setDisclose(leaves, ['first']);
			const badHidden = [...d.hidden];
			// flip a character in the first hidden digest (still base64url-shaped)
			const h = badHidden[0]!;
			badHidden[0] = (h[0] === 'A' ? 'B' : 'A') + h.slice(1);
			expect(setVerify(root, { disclosed: d.disclosed, hidden: badHidden })).to.be.false;
		});

		it('rejects a dropped leaf (full-set reconstruction binds the count)', () => {
			const d = setDisclose(leaves, ['first']);
			expect(setVerify(root, { disclosed: d.disclosed, hidden: d.hidden.slice(1) })).to.be.false;
		});

		it('rejects an added leaf', () => {
			const d = setDisclose(leaves, ['first']);
			const extra = toBase64url(leafDigest({ name: 'ghost', value: 'x', salt: SALT1 }, sha256));
			expect(setVerify(root, { disclosed: d.disclosed, hidden: [...d.hidden, extra] })).to.be.false;
		});

		it('rejects a name-binding replay: a (value, salt) proof presented under another name', () => {
			// Build a set with two boolean attributes; reveal `over18` then re-present its
			// (value, salt) as `citizen` — the name is bound into the leaf, so it must fail.
			const set: SaltedLeaf[] = [
				{ name: 'over18', value: true, salt: SALT1 },
				{ name: 'citizen', value: false, salt: SALT2 },
			];
			const r = setCommit(set);
			const honest = setDisclose(set, ['over18']);
			expect(setVerify(r, honest)).to.be.true;
			const replayed: SetDisclosure = {
				disclosed: [{ ...honest.disclosed[0]!, name: 'citizen' }],
				hidden: honest.hidden,
			};
			expect(setVerify(r, replayed)).to.be.false;
		});

		it('rejects a disclosure verified against an unrelated root', () => {
			const other = setCommit([{ name: 'z', value: 'z', salt: SALT1 }]);
			expect(setVerify(other, setDisclose(leaves, ['first']))).to.be.false;
		});

		it('rejects a duplicated disclosed leaf (multiset/count binding)', () => {
			// Holder presents the same genuine leaf twice — count becomes N+1, root mismatch.
			const d = setDisclose(leaves, ['first']);
			const doubled: SetDisclosure = { disclosed: [d.disclosed[0]!, d.disclosed[0]!], hidden: d.hidden };
			expect(setVerify(root, doubled)).to.be.false;
		});

		it('rejects a disclosed leaf that is also re-listed among the hidden digests', () => {
			// Same leaf counted as both disclosed AND hidden double-counts → root mismatch.
			const d = setDisclose(leaves, ['first']);
			const dupHidden = toBase64url(leafDigest(d.disclosed[0]!, sha256));
			expect(setVerify(root, { disclosed: d.disclosed, hidden: [...d.hidden, dupHidden] })).to.be.false;
		});

		it('returns false (does not throw) on malformed disclosure input', () => {
			expect(setVerify(root, null as any)).to.be.false;
			expect(setVerify(root, { disclosed: undefined as any, hidden: [] })).to.be.false;
			expect(setVerify(root, { disclosed: [{ name: 'x', value: 'v', salt: '' }], hidden: [] })).to.be.false;
		});
	});

	describe('domain separation', () => {
		it('a leaf digest can never equal the root of its singleton set (distinct domains)', () => {
			const leaf: SaltedLeaf = { name: 'a', value: 'v', salt: SALT1 };
			const leafHex = toHex(leafDigest(leaf, sha256));
			const rootHex = setCommit([leaf], sha256, hexEnc) as string;
			expect(leafHex).to.not.equal(rootHex);
		});

		it('a crafted leaf whose value mimics the set framing still does not equal a root', () => {
			// Even if an attacker stuffs the set-domain string / a digest-shaped value into a
			// leaf, the leading leaf-domain field keeps the leaf space disjoint from the root space.
			const innerLeaf = leafDigest({ name: 'real', value: 'x', salt: SALT1 }, sha256);
			const crafted: SaltedLeaf = { name: 'optimystic/sd-set/v1', value: innerLeaf, salt: SALT1 };
			const craftedLeafHex = toHex(leafDigest(crafted, sha256));
			const singletonRootHex = setCommit([{ name: 'real', value: 'x', salt: SALT1 }], sha256, hexEnc) as string;
			expect(craftedLeafHex).to.not.equal(singletonRootHex);
		});
	});

	describe('golden vectors (sha256/hex) — lock the wire format', () => {
		it('matches the pinned leaf digest', () => {
			const leaf: SaltedLeaf = { name: 'first', value: 'alice', salt: SALT1 };
			expect(toHex(leafDigest(leaf, sha256))).to.equal(
				'5dedfe78306a8b4d53fb78e87fa7d76c781b7f9378318e30e20ffd045f4f7308'
			);
		});

		it('matches the pinned empty-set root', () => {
			expect(setCommit([], sha256, hexEnc)).to.equal(
				'd95ab2c8057826757534800e334a98a7b6d9d12b4a51d74a6a70fd0872764bd0'
			);
		});

		it('matches the pinned single-leaf root', () => {
			expect(setCommit([{ name: 'first', value: 'alice', salt: SALT1 }], sha256, hexEnc)).to.equal(
				'512966997922aecf2ca3e6490c6018f1b9ebd43edad0e8002367d8b50e7b4952'
			);
		});

		it('matches the pinned three-leaf root (order-independent)', () => {
			const set: SaltedLeaf[] = [
				{ name: 'first', value: 'alice', salt: SALT1 },
				{ name: 'age', value: 42, salt: SALT2 },
				{ name: 'citizen', value: true, salt: SALT1 },
			];
			const expected = '1294291e58f5f7874e47946174923118b554ff6f1951696d6913f6182b78fce9';
			expect(setCommit(set, sha256, hexEnc)).to.equal(expected);
			expect(setCommit([set[2]!, set[0]!, set[1]!], sha256, hexEnc)).to.equal(expected);
		});
	});

	describe('plugin registration (SQL surface)', () => {
		const getFn = (name: string, config?: Record<string, any>): any => {
			const { functions } = registerCryptoPlugin({} as any, config);
			const fn = functions.find((f: any) => f.schema.name === name);
			if (!fn) throw new Error(`${name} not registered`);
			return fn.schema;
		};

		const leavesJson = JSON.stringify([
			['first', 'alice', SALT1_B64],
			['age', 42, SALT2_B64],
			['citizen', true, SALT1_B64],
		]);

		it('registers set_commit as replicable + deterministic and set_verify as deterministic-only', () => {
			expect(getFn('set_commit').replicable).to.equal(true);
			expect(getFn('set_verify').replicable).to.not.equal(true);
		});

		it('set_commit() SQL agrees with the JS setCommit (default base64url config)', () => {
			const impl = getFn('set_commit').implementation;
			const jsRoot = setCommit([
				{ name: 'first', value: 'alice', salt: SALT1_B64 },
				{ name: 'age', value: 42, salt: SALT2_B64 },
				{ name: 'citizen', value: true, salt: SALT1_B64 },
			]);
			expect(impl(leavesJson)).to.equal(jsRoot);
		});

		it('set_commit() SQL accepts both array and object leaf forms identically', () => {
			const impl = getFn('set_commit').implementation;
			const objForm = JSON.stringify([
				{ name: 'first', value: 'alice', salt: SALT1_B64 },
				{ name: 'age', value: 42, salt: SALT2_B64 },
				{ name: 'citizen', value: true, salt: SALT1_B64 },
			]);
			expect(impl(objForm)).to.equal(impl(leavesJson));
		});

		it('set_commit() SQL honors load-time algorithm/encoding config', () => {
			const impl = getFn('set_commit', { algorithm: 'sha256', encoding: 'hex' }).implementation;
			expect(impl(leavesJson)).to.equal(
				'1294291e58f5f7874e47946174923118b554ff6f1951696d6913f6182b78fce9'
			);
		});

		it('set_commit() SQL throws on unparseable / non-array JSON', () => {
			const impl = getFn('set_commit').implementation;
			expect(() => impl('not json')).to.throw();
			expect(() => impl('{"name":"x"}')).to.throw(/array/);
			expect(() => impl('[["x","v"]]')).to.throw(); // leaf missing salt
		});

		it('set_verify() SQL true/false paths mirror the JS API', () => {
			const commit = getFn('set_commit').implementation;
			const verifyImpl = getFn('set_verify').implementation;
			const root = commit(leavesJson);

			const disclosed = JSON.stringify([['first', 'alice', SALT1_B64]]);
			// derive hidden digests via the JS API for the two withheld leaves
			const { hidden } = setDisclose([
				{ name: 'first', value: 'alice', salt: SALT1_B64 },
				{ name: 'age', value: 42, salt: SALT2_B64 },
				{ name: 'citizen', value: true, salt: SALT1_B64 },
			], ['first']);

			expect(verifyImpl(root, disclosed, JSON.stringify(hidden))).to.be.true;
			// tampered disclosed value
			const bad = JSON.stringify([['first', 'mallory', SALT1_B64]]);
			expect(verifyImpl(root, bad, JSON.stringify(hidden))).to.be.false;
		});

		it('set_verify() SQL round-trips under a non-default (hex) encoding config', () => {
			// The root is hex but hidden digests are always base64url internally; verify must
			// reconstruct correctly regardless of the configured output encoding.
			const commit = getFn('set_commit', { encoding: 'hex' }).implementation;
			const verifyImpl = getFn('set_verify', { encoding: 'hex' }).implementation;
			const root = commit(leavesJson);
			expect(root).to.have.length(64); // sha256 hex
			const disclosed = JSON.stringify([['first', 'alice', SALT1_B64]]);
			const { hidden } = setDisclose([
				{ name: 'first', value: 'alice', salt: SALT1_B64 },
				{ name: 'age', value: 42, salt: SALT2_B64 },
				{ name: 'citizen', value: true, salt: SALT1_B64 },
			], ['first']);
			expect(verifyImpl(root, disclosed, JSON.stringify(hidden))).to.be.true;
			expect(verifyImpl(root, JSON.stringify([['first', 'mallory', SALT1_B64]]), JSON.stringify(hidden))).to.be.false;
		});

		it('set_commit() SQL requires an explicit value key in object-form leaves', () => {
			const impl = getFn('set_commit').implementation;
			// Missing value key throws (symmetric with the array form requiring [name, value, salt])...
			expect(() => impl(JSON.stringify([{ name: 'x', salt: SALT1_B64 }]))).to.throw(/value/);
			// ...but an explicit null value is accepted and equals the array form's null.
			const obj = impl(JSON.stringify([{ name: 'x', value: null, salt: SALT1_B64 }]));
			const arr = impl(JSON.stringify([['x', null, SALT1_B64]]));
			expect(obj).to.equal(arr);
		});

		it('set_verify() SQL returns false (never throws) on malformed input', () => {
			const verifyImpl = getFn('set_verify').implementation;
			expect(verifyImpl('cm9vdA', 'not json', '[]')).to.be.false;
			expect(verifyImpl('cm9vdA', '[]', 'not json')).to.be.false;
			expect(verifyImpl(123 as any, '[]', '[]')).to.be.false;
			expect(verifyImpl('cm9vdA', '[]', '[1,2,3]')).to.be.false; // hidden not strings
		});

		it('models a schema CHECK: set_commit accepts the correct root and rejects a forged one', () => {
			const commit = getFn('set_commit').implementation;
			const root = commit(leavesJson);
			// CHECK (SelectiveCid = set_commit(SelectiveDetails)) — equality holds for the
			// genuine root and fails for any other value, so a forged root cannot be stored.
			expect(root === commit(leavesJson)).to.be.true;
			expect('forged-root' === commit(leavesJson)).to.be.false;
		});
	});
});

function toBase64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}
