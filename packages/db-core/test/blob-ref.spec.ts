import { expect } from 'chai';
import { CID } from 'multiformats/cid';
import { base32, base32upper } from 'multiformats/bases/base32';
import { base58btc } from 'multiformats/bases/base58';
import * as Digest from 'multiformats/hashes/digest';
import { BlobRefError, DAG_PB_CODEC, isBlobRef, parseBlobRef, parsePieceId, RAW_CODEC } from '../src/index.js';

/** Vector references from `test/blob-builder.spec.ts`: 1,000 bytes (raw) and 262,145 bytes (dag-pb). */
const RAW_REF = 'bafkreicojquuwmy7piqjti3zx3buxh47ya64i2vumxmzr5gwqpnfgsd6nu';
const DAG_PB_REF = 'bafybeiexg2oqkfnj56l7fcmawswqbijt5shq4b5rg6a546uwpkqqzwjioi';

const SHA2_512_CODE = 0x13;
const IDENTITY_CODE = 0x00;
const DAG_CBOR_CODEC = 0x71;

describe('parseBlobRef', () => {
	it('accepts only the canonical spelling of a raw or dag-pb sha2-256 CIDv1', () => {
		const raw = CID.parse(RAW_REF, base32);
		const dagPb = CID.parse(DAG_PB_REF, base32);
		expect([raw.code, dagPb.code]).to.deep.equal([RAW_CODEC, DAG_PB_CODEC]);

		for (const text of [RAW_REF, DAG_PB_REF]) {
			expect(parseBlobRef(text), text).to.equal(text);
			expect(parsePieceId(text), text).to.equal(text);
			expect(isBlobRef(text), text).to.equal(true);
		}

		const rejected: Record<string, string> = {
			'uppercase base32': raw.toString(base32upper),
			'base58btc': raw.toString(base58btc),
			'CIDv0': dagPb.toV0().toString(),
			'sha2-512': CID.createV1(RAW_CODEC, Digest.create(SHA2_512_CODE, new Uint8Array(64))).toString(base32),
			'identity hash': CID.createV1(RAW_CODEC, Digest.create(IDENTITY_CODE, new Uint8Array(32))).toString(base32),
			'dag-cbor': CID.createV1(DAG_CBOR_CODEC, raw.multihash).toString(base32),
			'last character removed': RAW_REF.slice(0, -1),
			'trailing space': `${RAW_REF} `,
			'base32 padding': `${RAW_REF}=`,
			'200 characters': `b${'a'.repeat(199)}`,
		};
		for (const [label, text] of Object.entries(rejected)) {
			expect(() => parseBlobRef(text), label).to.throw(BlobRefError);
			expect(() => parsePieceId(text), label).to.throw(BlobRefError);
			expect(isBlobRef(text), label).to.equal(false);
		}
		for (const value of [42, undefined, null, {}, [RAW_REF]]) {
			expect(isBlobRef(value), String(value)).to.equal(false);
		}
	});
});
