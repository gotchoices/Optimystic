import { expect } from 'chai';
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { generatePrivateKey, getPublicKey, setCryptoBackend, type CryptoBackend } from '../dist/index.js';
import registerCryptoPlugin from '../dist/plugin.js';

// Raw Ed25519 keys wrapped as DER, the form node:crypto (and react-native-quick-crypto) take.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

type Calls = Record<keyof CryptoBackend, number>;

/** A real native backend for node, each member counting its calls. */
function nodeBackend(): { backend: CryptoBackend; calls: Calls } {
	const calls: Calls = { sha256: 0, sha512: 0, ed25519Sign: 0, ed25519Verify: 0 };
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
	};
	return { backend, calls };
}

function resetCalls(calls: Calls): void {
	for (const member of Object.keys(calls) as (keyof Calls)[]) {
		calls[member] = 0;
	}
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

	const seed = generatePrivateKey('ed25519') as string;
	const publicKey = getPublicKey(seed, 'ed25519') as string;
	const content = Buffer.from('hello world');

	const evaluate = () => {
		const signature = sql('sign')('a message', seed, 'ed25519', 'utf8');
		return {
			digest: sql('digest')('a', 1),
			cidSha256: sql('cid')(content),
			cidSha512: sql('cid')(content, 'raw', 'sha2-512'),
			signature,
			valid: sql('verify')('a message', signature, publicKey, 'ed25519', 'utf8'),
			tampered: sql('verify')('a message!', signature, publicKey, 'ed25519', 'utf8'),
		};
	};

	afterEach(() => setCryptoBackend(undefined));

	it('gives byte-identical results through the SQL functions, and is actually used', () => {
		const expected = evaluate();
		expect(expected.valid).to.equal(true);
		expect(expected.tampered).to.equal(false);

		const { backend, calls } = nodeBackend();
		setCryptoBackend(backend);
		resetCalls(calls); // the self-check itself calls every member

		expect(evaluate()).to.deep.equal(expected);
		for (const [member, count] of Object.entries(calls)) {
			expect(count, member).to.be.greaterThan(0);
		}
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

		resetCalls(calls);
		evaluate();
		expect(calls.sha256).to.be.greaterThan(0);
		expect(calls.ed25519Sign).to.be.greaterThan(0);
	});
});
