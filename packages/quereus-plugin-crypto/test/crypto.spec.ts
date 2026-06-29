import { expect } from 'chai';
import {
	digest, encodeFields, hashMod, randomBytes, sign, verify,
	generatePrivateKey, getPublicKey,
} from '../dist/index.js';
import registerCryptoPlugin from '../dist/plugin.js';

const hex = (fields: readonly any[], algo?: any) => digest(fields, algo, 'hex') as string;

describe('Crypto Functions', () => {
	describe('digest() — variadic multi-field', () => {
		it('should produce consistent hashes for the same tuple', () => {
			expect(digest(['hello', 'world'])).to.equal(digest(['hello', 'world']));
		});

		it('should produce different hashes for different tuples', () => {
			expect(digest(['hello'])).to.not.equal(digest(['world']));
		});

		it('should support SHA-512', () => {
			const hash = digest(['test'], 'sha512', 'hex') as string;
			expect(hash).to.have.length(128); // 64 bytes = 128 hex chars
		});

		it('should support BLAKE3', () => {
			const hash = digest(['test'], 'blake3', 'hex') as string;
			expect(hash).to.have.length(64); // 32 bytes = 64 hex chars
		});

		it('should return raw bytes with bytes encoding', () => {
			const hash = digest(['test'], 'sha256', 'bytes');
			expect(hash).to.be.instanceOf(Uint8Array);
			expect(hash).to.have.length(32);
		});

		it('should return base64url string by default', () => {
			const hash = digest(['test']) as string;
			expect(hash).to.be.a('string');
			expect(hash).to.not.contain('+');
			expect(hash).to.not.contain('/');
		});

		it('should throw for unsupported algorithm', () => {
			expect(() => digest(['test'], 'md5' as any)).to.throw();
		});

		it('should throw for a non-finite number field', () => {
			expect(() => digest([Number.NaN])).to.throw();
			expect(() => digest([Number.POSITIVE_INFINITY])).to.throw();
		});

		it('old-style string arg throws migration error (not "Unsupported output encoding")', () => {
			expect(() => digest('hello' as any, 'sha256', 'utf8' as any))
				.to.throw(/digest API changed in v0\.14/);
		});

		it('bare-string arg throws (guards silent char-iteration corruption)', () => {
			expect(() => digest('hello' as any))
				.to.throw(/digest API changed in v0\.14/);
		});

		it('Uint8Array arg throws (guards silent byte-iteration corruption)', () => {
			expect(() => digest(new Uint8Array([1, 2, 3]) as any))
				.to.throw(/digest API changed in v0\.14/);
		});

		it('should accept a Uint8Array (blob) field', () => {
			const a = digest([new Uint8Array([1, 2, 3])]);
			const b = digest([new Uint8Array([1, 2, 3])]);
			expect(a).to.equal(b);
		});
	});

	describe('digest() — injectivity', () => {
		it('distinguishes field boundaries (no delimiter collision)', () => {
			// The classic concat/delimiter-join footgun: these must NOT collide.
			expect(hex(['a', 'bc'])).to.not.equal(hex(['ab', 'c']));
			expect(hex(['a|b', 'c'])).to.not.equal(hex(['a', 'b|c']));
			expect(hex(['a', 'b', 'c'])).to.not.equal(hex(['a|b|c']));
		});

		it('distinguishes NULL from empty string from absent', () => {
			expect(hex([null])).to.not.equal(hex(['']));
			expect(hex([null])).to.not.equal(hex([]));
			expect(hex(['x', null])).to.not.equal(hex(['x', '']));
		});

		it('distinguishes integer from its text form', () => {
			expect(hex([123])).to.not.equal(hex(['123']));
		});

		it('distinguishes boolean from its text form', () => {
			expect(hex([true])).to.not.equal(hex(['true']));
			expect(hex([true])).to.not.equal(hex([1]));
			expect(hex([true])).to.not.equal(hex([false]));
		});

		it('treats equal integer number and bigint identically', () => {
			expect(hex([123])).to.equal(hex([123n]));
		});

		it('distinguishes differing arity', () => {
			expect(hex(['a'])).to.not.equal(hex(['a', '']));
			expect(hex([])).to.not.equal(hex([null]));
		});

		it('is order-sensitive', () => {
			expect(hex(['a', 'b'])).to.not.equal(hex(['b', 'a']));
		});

		it('canonicalizes JSON object key order', () => {
			expect(hex([{ a: 1, b: 2 }])).to.equal(hex([{ b: 2, a: 1 }]));
			expect(hex([{ a: 1 }])).to.not.equal(hex([{ a: 2 }]));
		});
	});

	describe('encodeFields()', () => {
		it('prepends a format version byte', () => {
			const enc = encodeFields([]);
			expect(enc).to.be.instanceOf(Uint8Array);
			expect(enc[0]).to.equal(0x01);
		});

		it('encodes NULL as a bare tag (no length/payload)', () => {
			expect(Array.from(encodeFields([null]))).to.deep.equal([0x01, 0x00]);
		});

		it('encodes empty string as TEXT tag with zero length', () => {
			expect(Array.from(encodeFields(['']))).to.deep.equal([0x01, 0x03, 0x00]);
		});
	});

	describe('digest() — replicability & cross-type', () => {
		it('treats large integer number and bigint identically', () => {
			expect(hex([1e21])).to.equal(hex([10n ** 21n]));
		});

		it('treats integer-valued REAL the same as INTEGER (documented collision)', () => {
			expect(hex([2.0])).to.equal(hex([2]));
			expect(hex([-0])).to.equal(hex([0]));
		});

		it('distinguishes a non-integer REAL from text', () => {
			expect(hex([1.5])).to.not.equal(hex(['1.5']));
		});

		it('distinguishes a blob from a JSON array of the same numbers', () => {
			expect(hex([new Uint8Array([1, 2, 3])])).to.not.equal(hex([[1, 2, 3]]));
		});

		it('throws on non-JSON values inside a JSON field', () => {
			expect(() => digest([{ a: undefined }])).to.throw();
			expect(() => digest([[undefined]])).to.throw();
			expect(() => digest([{ a: Number.NaN }])).to.throw();
			expect(() => digest([{ a: 1n }])).to.throw();
			expect(() => digest([new Date(0) as any])).to.throw();
		});

		// Known-answer vectors: lock the wire format so a silent encoding change
		// (which would break every signed commitment) fails loudly. sha256/hex.
		it('matches golden known-answer vectors', () => {
			expect(hex([])).to.equal('4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a');
			expect(hex(['hello'])).to.equal('8c63cb01ffa849168efebba19cba5a30df610da1de4c765ccec0b671de21e731');
			expect(hex(['alice', 42, null, true])).to.equal('f435dc1ab21023c091234b678f96f175efed048f5ea61f7b604e54bb7ff498cf');
		});

		it('matches the golden encodeFields byte layout', () => {
			const enc = Buffer.from(encodeFields(['alice', 42, null, true])).toString('hex');
			expect(enc).to.equal('010305616c69636501023432000401');
		});
	});

	describe('plugin registration (load-time config)', () => {
		const getDigest = (config?: Record<string, any>): any => {
			const { functions } = registerCryptoPlugin({} as any, config);
			const fn = functions.find((f: any) => f.schema.name === 'digest');
			if (!fn) throw new Error('digest not registered');
			return fn.schema;
		};

		it('registers digest as variadic and replicable', () => {
			const schema = getDigest();
			expect(schema.numArgs).to.equal(-1);
			expect(schema.replicable).to.equal(true);
		});

		it('defaults to sha256/base64url', () => {
			const impl = getDigest().implementation;
			expect(impl('a', 'b')).to.equal(digest(['a', 'b'], 'sha256', 'base64url'));
		});

		it('honors load-time algorithm + encoding config', () => {
			const impl = getDigest({ algorithm: 'sha512', encoding: 'hex' }).implementation;
			expect(impl('a', 'b')).to.equal(digest(['a', 'b'], 'sha512', 'hex'));
		});

		it('throws at registration on an unknown algorithm', () => {
			expect(() => getDigest({ algorithm: 'md5' })).to.throw();
		});

		it('throws at registration on a non-text encoding', () => {
			expect(() => getDigest({ encoding: 'bytes' })).to.throw();
		});
	});

	describe('hashMod()', () => {
		it('should return a value within range for 16 bits', () => {
			const result = hashMod('test', 16, 'sha256', 'utf8');
			expect(result).to.be.a('number');
			expect(result).to.be.at.least(0);
			expect(result).to.be.below(2 ** 16);
		});

		it('should return 0 or 1 for 1 bit', () => {
			const result = hashMod('test', 1, 'sha256', 'utf8');
			expect(result === 0 || result === 1).to.be.true;
		});

		it('should return a value within range for 53 bits', () => {
			const result = hashMod('test', 53, 'sha256', 'utf8');
			expect(result).to.be.a('number');
			expect(result).to.be.at.least(0);
			expect(result).to.be.below(Number.MAX_SAFE_INTEGER + 1);
		});

		it('should be deterministic', () => {
			const a = hashMod('hello', 32, 'sha256', 'utf8');
			const b = hashMod('hello', 32, 'sha256', 'utf8');
			expect(a).to.equal(b);
		});

		it('should throw for bits <= 0', () => {
			expect(() => hashMod('test', 0, 'sha256', 'utf8')).to.throw();
		});

		it('should throw for bits > 53', () => {
			expect(() => hashMod('test', 54, 'sha256', 'utf8')).to.throw();
		});
	});

	describe('randomBytes()', () => {
		it('should generate 256-bit random bytes by default', () => {
			const result = randomBytes();
			expect(result).to.be.a('string'); // base64url default
		});

		it('should generate correct byte count', () => {
			const result = randomBytes(128, 'bytes') as Uint8Array;
			expect(result).to.be.instanceOf(Uint8Array);
			expect(result).to.have.length(16); // 128 bits = 16 bytes
		});

		it('should produce hex output', () => {
			const result = randomBytes(64, 'hex') as string;
			expect(result).to.be.a('string');
			expect(result).to.have.length(16); // 8 bytes = 16 hex chars
		});

		it('should produce unique values on successive calls', () => {
			const a = randomBytes(256, 'hex');
			const b = randomBytes(256, 'hex');
			expect(a).to.not.equal(b);
		});
	});

	describe('generatePrivateKey() and getPublicKey()', () => {
		for (const curve of ['secp256k1', 'p256', 'ed25519'] as const) {
			it(`should generate a valid key pair for ${curve}`, () => {
				const privKey = generatePrivateKey(curve, 'bytes') as Uint8Array;
				expect(privKey).to.be.instanceOf(Uint8Array);
				expect(privKey.length).to.be.greaterThan(0);

				const pubKey = getPublicKey(privKey, curve, 'bytes', 'bytes') as Uint8Array;
				expect(pubKey).to.be.instanceOf(Uint8Array);
				expect(pubKey.length).to.be.greaterThan(0);
			});
		}

		it('should produce different keys on successive calls', () => {
			const a = generatePrivateKey('secp256k1', 'hex');
			const b = generatePrivateKey('secp256k1', 'hex');
			expect(a).to.not.equal(b);
		});

		it('should round-trip through base64url encoding', () => {
			const privB64 = generatePrivateKey('secp256k1') as string;
			const pubB64 = getPublicKey(privB64, 'secp256k1') as string;
			expect(pubB64).to.be.a('string');
			expect(pubB64.length).to.be.greaterThan(0);
		});

		it('should throw for unsupported curve', () => {
			expect(() => generatePrivateKey('invalid' as any)).to.throw();
		});
	});

	describe('sign() and verify()', () => {
		for (const curve of ['secp256k1', 'p256', 'ed25519'] as const) {
			describe(`${curve}`, () => {
				let privKey: Uint8Array;
				let pubKey: Uint8Array;

				beforeEach(() => {
					privKey = generatePrivateKey(curve, 'bytes') as Uint8Array;
					pubKey = getPublicKey(privKey, curve, 'bytes', 'bytes') as Uint8Array;
				});

				it('should produce a verifiable signature', () => {
					const message = new Uint8Array(32).fill(0x42);
					const sig = sign(message, privKey, curve, 'bytes', 'bytes', 'bytes') as Uint8Array;
					expect(sig).to.be.instanceOf(Uint8Array);

					const valid = verify(message, sig, pubKey, curve, 'bytes', 'bytes', 'bytes');
					expect(valid).to.be.true;
				});

				it('should reject a corrupted signature', () => {
					const message = new Uint8Array(32).fill(0x42);
					const sig = sign(message, privKey, curve, 'bytes', 'bytes', 'bytes') as Uint8Array;

					const corrupted = new Uint8Array(sig);
					corrupted[0] = (corrupted[0]! ^ 0xff);

					const valid = verify(message, corrupted, pubKey, curve, 'bytes', 'bytes', 'bytes');
					expect(valid).to.be.false;
				});

				it('should reject signature with wrong public key', () => {
					const message = new Uint8Array(32).fill(0x42);
					const sig = sign(message, privKey, curve, 'bytes', 'bytes', 'bytes') as Uint8Array;

					const otherPriv = generatePrivateKey(curve, 'bytes') as Uint8Array;
					const otherPub = getPublicKey(otherPriv, curve, 'bytes', 'bytes') as Uint8Array;

					const valid = verify(message, sig, otherPub, curve, 'bytes', 'bytes', 'bytes');
					expect(valid).to.be.false;
				});

				it('should round-trip through base64url encoding', () => {
					const message = new Uint8Array(32).fill(0xAB);
					const privB64 = generatePrivateKey(curve) as string;
					const pubB64 = getPublicKey(privB64, curve) as string;

					const sigB64 = sign(
						message, privB64, curve, 'bytes', 'base64url', 'base64url'
					) as string;
					expect(sigB64).to.be.a('string');

					const valid = verify(
						message, sigB64, pubB64, curve, 'bytes', 'base64url', 'base64url'
					);
					expect(valid).to.be.true;
				});
			});
		}

		it('should return false for verify with invalid inputs', () => {
			const valid = verify(
				new Uint8Array(0), new Uint8Array(0), new Uint8Array(0),
				'secp256k1', 'bytes', 'bytes', 'bytes'
			);
			expect(valid).to.be.false;
		});
	});
});

