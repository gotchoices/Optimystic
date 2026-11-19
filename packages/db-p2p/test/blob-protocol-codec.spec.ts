import { expect } from 'chai';
import { pieceIdOfCid, RAW_CODEC, type PieceId } from '@optimystic/db-core';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as lp from 'it-length-prefixed';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { BlobProtocolError, decodeBlobRequest, encodeBlobHeader } from '../src/blob/blob-protocol.js';
import { readBlobFrames } from '../src/blob/blob-frames.js';
import { MAX_BLOB_GET_PIECES, MAX_BLOB_HEADER_BYTES, MAX_BLOB_PIECE_FRAME_BYTES, MAX_BLOB_SCOPE_CHARS } from '../src/protocol-limits.js';

const PEER = 'peer-under-test';

async function rawPieceId(seed: number): Promise<PieceId> {
	return pieceIdOfCid(CID.create(1, RAW_CODEC, await sha256.digest(Uint8Array.of(seed))));
}

const json = (value: unknown): Uint8Array => u8FromString(JSON.stringify(value));

describe('blob protocol header and frames', () => {
	it('refuses every malformed request header with BlobProtocolError, and accepts a well-formed one', async () => {
		const piece = await rawPieceId(1);
		const tooMany = await Promise.all(Array.from({ length: MAX_BLOB_GET_PIECES + 1 }, (_, i) => rawPieceId(i)));
		const malformed: Array<[string, Uint8Array]> = [
			['not JSON', u8FromString('{kind:')],
			['an array', json([])],
			['no kind', json({ refs: [piece] })],
			['unknown kind', json({ kind: 'put' })],
			['empty list', json({ kind: 'stat', refs: [] })],
			['list over its cap', json({ kind: 'get', pieces: tooMany })],
			['non-canonical id', json({ kind: 'get', pieces: [piece.toUpperCase()] })],
			['non-string id', json({ kind: 'stat', refs: [7] })],
			['duplicate piece', json({ kind: 'get', pieces: [piece, piece] })],
			['announce without scope', json({ kind: 'announce', ref: piece })],
		];
		for (const [label, bytes] of malformed) {
			expect(() => decodeBlobRequest(bytes, PEER), label).to.throw(BlobProtocolError);
		}
		expect(decodeBlobRequest(encodeBlobHeader({ kind: 'get', pieces: [piece] }), PEER)).to.deep.equal({ kind: 'get', pieces: [piece] });
	});

	it('bounds an announce scope: empty and over MAX_BLOB_SCOPE_CHARS are malformed, exactly the cap decodes', async () => {
		const ref = await rawPieceId(2);
		const cases: Array<[string, string, boolean]> = [
			['empty', '', false],
			['one over the cap', 'x'.repeat(MAX_BLOB_SCOPE_CHARS + 1), false],
			['exactly the cap', 'x'.repeat(MAX_BLOB_SCOPE_CHARS), true],
		];
		for (const [label, scope, decodes] of cases) {
			const bytes = json({ kind: 'announce', ref, scope });
			if (decodes) expect(decodeBlobRequest(bytes, PEER), label).to.deep.equal({ kind: 'announce', ref, scope });
			else expect(() => decodeBlobRequest(bytes, PEER), label).to.throw(BlobProtocolError);
		}
	});

	it('refuses an oversized header from its length prefix alone, without waiting for its bytes', async () => {
		const prefix = lp.encode.single(new Uint8Array(MAX_BLOB_HEADER_BYTES + 1)).subarray(0, 3);
		// A source that delivers the prefix and then never ends: the refusal must not wait for the body.
		async function* prefixThenSilence(): AsyncGenerator<Uint8Array> {
			yield prefix;
			await new Promise(() => undefined);
		}
		const frames = readBlobFrames(prefixThenSilence(), { touch: () => undefined }, PEER);
		await expectProtocolError(frames.next());
	});

	it('reports a piece over the largest frame, and a stream ending inside a frame, as BlobProtocolError', async () => {
		const header = lp.encode.single(json({ kind: 'get', held: [true] })).subarray();
		const oversized = lp.encode.single(new Uint8Array(MAX_BLOB_PIECE_FRAME_BYTES + 1)).subarray(0, 4);
		const overCap = readBlobFrames(sourceOf(header, oversized), { touch: () => undefined }, PEER);
		await overCap.next();
		await expectProtocolError(overCap.next());

		const truncated = readBlobFrames(sourceOf(header.subarray(0, header.byteLength - 1)), { touch: () => undefined }, PEER);
		await expectProtocolError(truncated.next());
	});
});

async function* sourceOf(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
	yield* chunks;
}

async function expectProtocolError(pending: Promise<unknown>): Promise<void> {
	let caught: unknown;
	try {
		await pending;
	} catch (err) {
		caught = err;
	}
	expect(caught).to.be.instanceOf(BlobProtocolError);
}
