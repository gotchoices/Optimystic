import { expect } from 'aegir/chai';
import {
	digest, hashMod, randomBytes, sign, verify,
	generatePrivateKey, getPublicKey,
	SignatureValid,
} from '../dist/index.js';

describe('Crypto Functions', () => {
	describe('digest()', () => {
		it('should produce consistent SHA-256 hashes for the same input', () => {
			const hash1 = digest('hello', 'sha256', 'utf8');
			const hash2 = digest('hello', 'sha256', 'utf8');
			expect(hash1).to.equal(hash2);
		});

		it('should produce different hashes for different inputs', () => {
			const hash1 = digest('hello', 'sha256', 'utf8');
			const hash2 = digest('world', 'sha256', 'utf8');
			expect(hash1).to.not.equal(hash2);
		});

		it('should support SHA-512', () => {
			const hash = digest('test', 'sha512', 'utf8', 'hex') as string;
			expect(hash).to.be.a('string');
			expect(hash).to.have.length(128); // 64 bytes = 128 hex chars
		});

		it('should support BLAKE3', () => {
			const hash = digest('test', 'blake3', 'utf8', 'hex') as string;
			expect(hash).to.be.a('string');
			expect(hash).to.have.length(64); // 32 bytes = 64 hex chars
		});

		it('should return raw bytes with bytes encoding', () => {
			const hash = digest('test', 'sha256', 'utf8', 'bytes');
			expect(hash).to.be.instanceOf(Uint8Array);
			expect(hash).to.have.length(32);
		});

		it('should return base64url string by default', () => {
			const hash = digest('test', 'sha256', 'utf8') as string;
			expect(hash).to.be.a('string');
			expect(hash).to.not.contain('+');
			expect(hash).to.not.contain('/');
		});

		it('should accept Uint8Array input', () => {
			const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
			const hash = digest(bytes, 'sha256', 'bytes', 'hex');
			const strHash = digest('hello', 'sha256', 'utf8', 'hex');
			expect(hash).to.equal(strHash);
		});

		it('should throw for unsupported algorithm', () => {
			expect(() => digest('test', 'md5' as any, 'utf8')).to.throw();
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

describe('SignatureValid', () => {
	for (const curve of ['secp256k1', 'p256', 'ed25519'] as const) {
		describe(`${curve}`, () => {
			let privKey: Uint8Array;
			let pubKey: Uint8Array;
			let message: Uint8Array;
			let sig: Uint8Array;

			beforeEach(() => {
				privKey = generatePrivateKey(curve, 'bytes') as Uint8Array;
				pubKey = getPublicKey(privKey, curve, 'bytes', 'bytes') as Uint8Array;
				message = new Uint8Array(32).fill(0x42);
				sig = sign(message, privKey, curve, 'bytes', 'bytes', 'bytes') as Uint8Array;
			});

			it('should verify a valid signature', () => {
				const valid = SignatureValid(message, sig, pubKey, { curve });
				expect(valid).to.be.true;
			});

			it('should reject a corrupted signature', () => {
				const corrupted = new Uint8Array(sig);
				corrupted[0] = (corrupted[0]! ^ 0xff);
				expect(SignatureValid(message, corrupted, pubKey, { curve })).to.be.false;
			});

			it('should work via convenience method', () => {
				const valid = SignatureValid[curve](message, sig, pubKey);
				expect(valid).to.be.true;
			});
		});
	}

	it('should batch verify multiple signatures', () => {
		const verifications = (['secp256k1', 'p256', 'ed25519'] as const).map(curve => {
			const priv = generatePrivateKey(curve, 'bytes') as Uint8Array;
			const pub = getPublicKey(priv, curve, 'bytes', 'bytes') as Uint8Array;
			const msg = new Uint8Array(32).fill(0x99);
			const s = sign(msg, priv, curve, 'bytes', 'bytes', 'bytes') as Uint8Array;
			return { digest: msg, signature: s, publicKey: pub, options: { curve } };
		});

		const results = SignatureValid.batch(verifications);
		expect(results).to.deep.equal([true, true, true]);
	});

	it('should return detailed verification info', () => {
		const priv = generatePrivateKey('secp256k1', 'bytes') as Uint8Array;
		const pub = getPublicKey(priv, 'secp256k1', 'bytes', 'bytes') as Uint8Array;
		const msg = new Uint8Array(32).fill(0x01);
		const s = sign(msg, priv, 'secp256k1', 'bytes', 'bytes', 'bytes') as Uint8Array;

		const detail = SignatureValid.detailed(msg, s, pub, { curve: 'secp256k1' });
		expect(detail.valid).to.be.true;
		expect(detail.curve).to.equal('secp256k1');
		expect(detail.signatureFormat).to.be.a('string');
	});

	it('should return false for completely invalid inputs', () => {
		expect(SignatureValid(new Uint8Array(0), new Uint8Array(0), new Uint8Array(0))).to.be.false;
	});

	it('should return false for wrong curve', () => {
		const priv = generatePrivateKey('secp256k1', 'bytes') as Uint8Array;
		const pub = getPublicKey(priv, 'secp256k1', 'bytes', 'bytes') as Uint8Array;
		const msg = new Uint8Array(32).fill(0x42);
		const s = sign(msg, priv, 'secp256k1', 'bytes', 'bytes', 'bytes') as Uint8Array;

		expect(SignatureValid(msg, s, pub, { curve: 'ed25519' })).to.be.false;
	});
});

