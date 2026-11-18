import { expect } from 'chai';
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { generatePrivateKey, getPublicKey, setCryptoBackend, type CryptoBackend } from '../dist/index.js';
import registerCryptoPlugin from '../dist/plugin.js';

// Raw Ed25519 keys wrapped as DER, the form node:crypto (and react-native-quick-crypto) take.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

type EcdsaCurve = 'p256' | 'secp256k1';
type EcdsaVerify = NonNullable<CryptoBackend['p256Verify']>;

// SPKI DER prefixes for a raw SEC 1 point (id-ecPublicKey + curve OID + BIT STRING header), by key length.
const SPKI_EC_PREFIX: Record<EcdsaCurve, Record<number, string>> = {
	p256: { 33: '3039301306072a8648ce3d020106082a8648ce3d030107032200', 65: '3059301306072a8648ce3d020106082a8648ce3d030107034200' },
	secp256k1: { 33: '3036301006072a8648ce3d020106052b8104000a032200', 65: '3056301006072a8648ce3d020106052b8104000a034200' },
};
const CURVE_ORDER: Record<EcdsaCurve, bigint> = {
	p256: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
	secp256k1: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
};

/** OpenSSL's verify as is: it accepts high-S signatures and hybrid-encoded keys, which @noble rejects. */
function openSslEcdsaVerify(curve: EcdsaCurve): EcdsaVerify {
	return (signature, message, publicKey) => {
		const prefix = Buffer.from(SPKI_EC_PREFIX[curve][publicKey.length]!, 'hex');
		const key = createPublicKey({ key: Buffer.concat([prefix, publicKey]), format: 'der', type: 'spki' });
		return nodeVerify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature);
	};
}

function scalarsInNobleRange(curve: EcdsaCurve, signature: Uint8Array): boolean {
	if (signature.length !== 64) return false;
	const n = CURVE_ORDER[curve];
	const r = BigInt(`0x${Buffer.from(signature.subarray(0, 32)).toString('hex')}`);
	const s = BigInt(`0x${Buffer.from(signature.subarray(32)).toString('hex')}`);
	return r > 0n && s > 0n && r < n && s <= n / 2n;
}

function nobleKeyPrefix(publicKey: Uint8Array): boolean {
	return (publicKey.length === 33 && (publicKey[0] === 0x02 || publicKey[0] === 0x03))
		|| (publicKey.length === 65 && publicKey[0] === 0x04);
}

/** The adapter the README recommends: OpenSSL behind both guards. */
function guardedEcdsaVerify(curve: EcdsaCurve): EcdsaVerify {
	const openSsl = openSslEcdsaVerify(curve);
	return (signature, message, publicKey) =>
		nobleKeyPrefix(publicKey) && scalarsInNobleRange(curve, signature) && openSsl(signature, message, publicKey);
}

type Calls = Record<keyof CryptoBackend, number>;

/** A real native backend for node, each member counting its calls. */
function nodeBackend(): { backend: CryptoBackend; calls: Calls } {
	const calls: Calls = { sha256: 0, sha512: 0, ed25519Sign: 0, ed25519Verify: 0, p256Verify: 0, secp256k1Verify: 0 };
	const p256Verify = guardedEcdsaVerify('p256');
	const secp256k1Verify = guardedEcdsaVerify('secp256k1');
	const backend: CryptoBackend = {
		sha256: (data) => {
			calls.sha256++;
			return createHash('sha256').update(data).digest();
		},
		sha512: (data) => {
			calls.sha512++;
			return createHash('sha512').update(data).digest();
		},
		ed25519Sign: (message, secretKey) => {
			calls.ed25519Sign++;
			const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, secretKey]), format: 'der', type: 'pkcs8' });
			return nodeSign(null, message, key);
		},
		ed25519Verify: (signature, message, publicKey) => {
			calls.ed25519Verify++;
			const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: 'der', type: 'spki' });
			return nodeVerify(null, message, key, signature);
		},
		p256Verify: (signature, message, publicKey) => {
			calls.p256Verify++;
			return p256Verify(signature, message, publicKey);
		},
		secp256k1Verify: (signature, message, publicKey) => {
			calls.secp256k1Verify++;
			return secp256k1Verify(signature, message, publicKey);
		},
	};
	return { backend, calls };
}

function resetCalls(calls: Calls): void {
	for (const member of Object.keys(calls) as (keyof Calls)[]) {
		calls[member] = 0;
	}
}

function expectEveryMemberCalled(calls: Calls): void {
	for (const [member, count] of Object.entries(calls)) {
		expect(count, member).to.be.greaterThan(0);
	}
}

/** The same signature with s replaced by n − s: valid to OpenSSL, refused by @noble. */
function highSCopy(curve: EcdsaCurve, signature: string): string {
	const bytes = Buffer.from(signature, 'base64url');
	const s = BigInt(`0x${bytes.subarray(32).toString('hex')}`);
	const flipped = Buffer.from((CURVE_ORDER[curve] - s).toString(16).padStart(64, '0'), 'hex');
	return Buffer.concat([bytes.subarray(0, 32), flipped]).toString('base64url');
}

describe('Native crypto backend', () => {
	// Registered once, before any backend is set: the hook must reach SQL functions that
	// were resolved earlier, and from the `/plugin` bundle, not the package root it is set through.
	const { functions } = registerCryptoPlugin({} as any);
	const sql = (name: string): (...args: any[]) => any => {
		const fn = functions.find((f: any) => f.schema.name === name);
		if (!fn) throw new Error(`${name} not registered`);
		return fn.schema.implementation;
	};

	const content = Buffer.from('hello world');
	const keys = (['ed25519', 'p256', 'secp256k1'] as const).map((curve) => {
		const secret = generatePrivateKey(curve) as string;
		return { curve, secret, publicKey: getPublicKey(secret, curve) as string };
	});

	const evaluate = () => ({
		digest: sql('digest')('a', 1),
		cidSha256: sql('cid')(content),
		cidSha512: sql('cid')(content, 'raw', 'sha2-512'),
		signatures: keys.map(({ curve, secret, publicKey }) => {
			const signature = sql('sign')('a message', secret, curve, 'utf8');
			const verify = (message: string, sig: string) => sql('verify')(message, sig, publicKey, curve, 'utf8');
			return {
				signature,
				valid: verify('a message', signature),
				tampered: verify('a message!', signature),
				highS: curve === 'ed25519' ? undefined : verify('a message', highSCopy(curve, signature)),
			};
		}),
	});

	afterEach(() => setCryptoBackend(undefined));

	it('gives byte-identical results through the SQL functions, and is actually used', () => {
		const expected = evaluate();
		for (const { valid, tampered, highS } of expected.signatures) {
			expect(valid).to.equal(true);
			expect(tampered).to.equal(false);
			expect(highS).to.not.equal(true);
		}

		const { backend, calls } = nodeBackend();
		setCryptoBackend(backend);
		resetCalls(calls); // the self-check itself calls every member

		expect(evaluate()).to.deep.equal(expected);
		expectEveryMemberCalled(calls);
	});

	it('refuses a backend that disagrees with @noble and keeps the one installed', () => {
		const { backend, calls } = nodeBackend();
		setCryptoBackend(backend);

		// A common adapter mistake: hashing the view's whole underlying buffer.
		const wholeBuffer: CryptoBackend = {
			sha256: (data) => createHash('sha256').update(new Uint8Array(data.buffer)).digest(),
		};
		expect(() => setCryptoBackend(wholeBuffer)).to.throw(/sha256/);

		const wrongSignature: CryptoBackend = {
			ed25519Sign: (message, secretKey) => {
				const signature = backend.ed25519Sign!(message, secretKey);
				signature[0]! ^= 0x01;
				return signature;
			},
		};
		expect(() => setCryptoBackend(wrongSignature)).to.throw(/ed25519Sign/);

		// OpenSSL as is, then OpenSSL behind the scalar guard but not the key-prefix guard.
		expect(() => setCryptoBackend({ p256Verify: openSslEcdsaVerify('p256') })).to.throw(/p256Verify accepted a high-S/);
		const openSsl = openSslEcdsaVerify('secp256k1');
		const noPrefixGuard: CryptoBackend = {
			secp256k1Verify: (signature, message, publicKey) =>
				scalarsInNobleRange('secp256k1', signature) && openSsl(signature, message, publicKey),
		};
		expect(() => setCryptoBackend(noPrefixGuard)).to.throw(/secp256k1Verify accepted a hybrid-encoded/);

		resetCalls(calls);
		evaluate();
		expectEveryMemberCalled(calls);
	});
});
