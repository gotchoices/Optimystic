import { expect } from 'chai';
import { cid, cidV1, cidDecode, digest } from '../dist/index.js';
import registerCryptoPlugin from '../dist/plugin.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

// The canonical, publicly verifiable IPFS CID for raw "hello world"
// (raw codec, sha2-256, base32). If this changes, interop is broken.
const HELLO_WORLD_CID = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e';

describe('CID Functions', () => {
	describe('cid() — hash then frame', () => {
		it('matches the canonical IPFS CIDv1 for the same bytes (interop)', () => {
			expect(cid(utf8('hello world'))).to.equal(HELLO_WORLD_CID);
		});

		it('is deterministic', () => {
			expect(cid(utf8('abc'))).to.equal(cid(utf8('abc')));
		});

		it('defaults to raw / sha2-256 / base32 (the b… prefix)', () => {
			const c = cid(utf8('x'));
			expect(c).to.match(/^b/); // base32 multibase prefix
			const parts = cidDecode(c);
			expect(parts.version).to.equal(1);
			expect(parts.codec).to.equal('raw');
			expect(parts.hashCode).to.equal('sha2-256');
			expect(parts.digest).to.have.length(32);
		});

		it('renders each supported multibase with its prefix and round-trips', () => {
			const prefixes: Record<string, string> = {
				base32: 'b', base58btc: 'z', base64url: 'u', base16: 'f',
			};
			for (const [base, prefix] of Object.entries(prefixes)) {
				const c = cid(utf8('hello world'), 'raw', 'sha2-256', base as any);
				expect(c.startsWith(prefix), `${base} prefix`).to.be.true;
				// every base addresses the same content → same decoded digest
				expect(Array.from(cidDecode(c).digest)).to.deep.equal(
					Array.from(cidDecode(HELLO_WORLD_CID).digest)
				);
			}
		});

		it('distinguishes content codecs (raw vs dag-cbor)', () => {
			const raw = cid(utf8('x'), 'raw');
			const cbor = cid(utf8('x'), 'dag-cbor');
			expect(raw).to.not.equal(cbor);
			expect(cidDecode(raw).codec).to.equal('raw');
			expect(cidDecode(cbor).codec).to.equal('dag-cbor');
		});

		it('supports each multihash code with the right digest length', () => {
			expect(cidDecode(cid(utf8('x'), 'raw', 'sha2-256')).digest).to.have.length(32);
			expect(cidDecode(cid(utf8('x'), 'raw', 'sha2-512')).digest).to.have.length(64);
			expect(cidDecode(cid(utf8('x'), 'raw', 'blake3')).digest).to.have.length(32);
			expect(cidDecode(cid(utf8('x'), 'raw', 'sha2-512')).hashCode).to.equal('sha2-512');
			expect(cidDecode(cid(utf8('x'), 'raw', 'blake3')).hashCode).to.equal('blake3');
		});

		it('throws on an unsupported codec / hash / base', () => {
			expect(() => cid(utf8('x'), 'bogus' as any)).to.throw();
			expect(() => cid(utf8('x'), 'raw', 'md5' as any)).to.throw();
			expect(() => cid(utf8('x'), 'raw', 'sha2-256', 'base99' as any)).to.throw();
		});
	});

	describe('cidV1() — frame an already-computed digest', () => {
		it('frames a digest without re-hashing (decoded digest equals input)', () => {
			const d = digest(['a', 'b', 'c'], 'sha256', 'bytes') as Uint8Array;
			const c = cidV1(d, 'sha2-256');
			expect(Array.from(cidDecode(c).digest)).to.deep.equal(Array.from(d));
		});

		it('composes with digest() to make a CID over a field tuple', () => {
			const d = digest(['alice', 42, null, true], 'sha256', 'bytes') as Uint8Array;
			const c = cidV1(d, 'sha2-256', 'dag-cbor');
			const parts = cidDecode(c);
			expect(parts.codec).to.equal('dag-cbor');
			expect(parts.hashCode).to.equal('sha2-256');
			expect(Array.from(parts.digest)).to.deep.equal(Array.from(d));
		});

		it('rejects a digest whose length mismatches the asserted hash', () => {
			expect(() => cidV1(new Uint8Array(31), 'sha2-256')).to.throw(/length/);
			// a 32-byte digest cannot have been produced by sha2-512 (64 bytes)
			const d256 = digest(['x'], 'sha256', 'bytes') as Uint8Array;
			expect(() => cidV1(d256, 'sha2-512')).to.throw(/length/);
		});
	});

	describe('cidDecode() — round-trip / validation', () => {
		it('returns the expected parts for a known CID', () => {
			const parts = cidDecode(HELLO_WORLD_CID);
			expect(parts.version).to.equal(1);
			expect(parts.codec).to.equal('raw');
			expect(parts.hashCode).to.equal('sha2-256');
			expect(parts.digest).to.be.instanceOf(Uint8Array).with.length(32);
		});

		it('decodes a CID produced in any supported base', () => {
			for (const base of ['base32', 'base58btc', 'base64url', 'base16'] as const) {
				const c = cid(utf8('round-trip'), 'raw', 'sha2-256', base);
				expect(cidDecode(c).codec).to.equal('raw');
			}
		});

		it('throws cleanly on malformed input', () => {
			expect(() => cidDecode('not-a-cid')).to.throw();
			expect(() => cidDecode('')).to.throw();
			expect(() => cidDecode('zzzzz!!!!')).to.throw();
		});
	});

	describe('plugin registration (SQL surface)', () => {
		const getFn = (name: string, config?: Record<string, any>): any => {
			const { functions } = registerCryptoPlugin({} as any, config);
			const fn = functions.find((f: any) => f.schema.name === name);
			if (!fn) throw new Error(`${name} not registered`);
			return fn.schema;
		};

		it('registers cid / cid_v1 / cid_decode as replicable + deterministic', () => {
			for (const name of ['cid', 'cid_v1', 'cid_decode']) {
				expect(getFn(name).replicable, name).to.equal(true);
			}
		});

		it('cid() SQL accepts both a BLOB and a base64url TEXT argument identically', () => {
			const impl = getFn('cid').implementation;
			const bytes = utf8('hello world');
			const b64 = digest([new Uint8Array(bytes)], 'sha256', 'base64url'); // any base64url text
			// BLOB path
			expect(impl(bytes)).to.equal(HELLO_WORLD_CID);
			// TEXT path: a base64url string decodes to the same bytes the JS API hashes
			const asText = Buffer.from(bytes).toString('base64url');
			expect(impl(asText)).to.equal(impl(bytes));
			void b64;
		});

		it('cid_v1() SQL composes with the base64url string digest() returns', () => {
			const cidV1Impl = getFn('cid_v1').implementation;
			const dBytes = digest(['a', 'b', 'c'], 'sha256', 'bytes') as Uint8Array;
			const dText = digest(['a', 'b', 'c'], 'sha256', 'base64url') as string;
			// BLOB digest and its base64url text form yield the same CID
			expect(cidV1Impl(dText, 'sha2-256')).to.equal(cidV1(dBytes, 'sha2-256'));
		});

		it('cid_v1() SQL requires the hash argument', () => {
			const impl = getFn('cid_v1').implementation;
			const d = digest(['x'], 'sha256', 'bytes') as Uint8Array;
			expect(() => impl(d)).to.throw(/hash/);
			expect(() => impl(d, null)).to.throw(/hash/);
		});

		it('cid_decode() SQL returns parseable JSON with the expected shape', () => {
			const impl = getFn('cid_decode').implementation;
			const json = impl(HELLO_WORLD_CID);
			const parsed = JSON.parse(json);
			expect(parsed.version).to.equal(1);
			expect(parsed.codec).to.equal('raw');
			expect(parsed.hashCode).to.equal('sha2-256');
			// digest is base64url text in the JSON projection
			expect(parsed.digest).to.be.a('string');
			expect(Buffer.from(parsed.digest, 'base64url')).to.have.length(32);
		});

		it('cid_decode() SQL throws on garbage input', () => {
			const impl = getFn('cid_decode').implementation;
			expect(() => impl('not-a-cid')).to.throw();
		});
	});
});
