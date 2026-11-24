/**
 * Ticket: a-narrowed-ring-sheds-its-large-files.
 *
 * A move-out narrows the slice a node serves, and the blobs that route into the half it gave up are
 * handed over with the blocks (docs/arachnode-ring-handoff.md § Phase C). `selectShedBlobRefs` is the
 * half of that pass which decides WHICH held references are handed over, and this spec pins it with
 * real digests and the real coordinate arithmetic — no faked coordinates — because the one failure
 * here loses data rather than wasting space: a predicate the wrong way round would release the half
 * the node keeps and hold the half it gave away.
 *
 * The release itself is the reaction's existing arm, specced in `blob-cohort-reaction.spec.ts`; the
 * coverage predicate the selection shares with the block side is specced in
 * `ring-shift-coordinator.spec.ts`.
 */

import { expect } from 'chai';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { hashKey } from 'p2p-fret';
import { parseBlobRef, pieceIdOfCid, RAW_CODEC, routingKeyForBlob, type BlobRef } from '@optimystic/db-core';
import { selectShedBlobRefs } from '../src/blob/ring-shed-pass.js';
import { extractPrefix, type RingNarrowing } from '../src/storage/arachnode-partition.js';

/** A canonical reference over deterministic bytes, so its routing key is a real 32-byte digest. */
async function refOf(seed: number): Promise<BlobRef> {
	const digest = await sha256.digest(new Uint8Array([seed & 0xff, (seed >> 8) & 0xff]));
	return parseBlobRef(pieceIdOfCid(CID.createV1(RAW_CODEC, digest)));
}

/** The leading `bits` of a reference's ring coordinate — what a partition prefix is compared against. */
async function prefixOf(ref: BlobRef, bits: number): Promise<number> {
	return extractPrefix(await hashKey(routingKeyForBlob(ref)), bits);
}

describe('selectShedBlobRefs — which blobs a narrowed ring hands over', () => {
	/** Two references per leading-two-bit value, so a selection that stops after the first is caught. */
	const byPrefix = new Map<number, BlobRef[]>([[0, []], [1, []], [2, []], [3, []]]);

	before(async () => {
		for (let seed = 0; [...byPrefix.values()].some(refs => refs.length < 2); seed++) {
			if (seed > 10_000) throw new Error('could not classify references'); // real digests → all four appear fast
			const ref = await refOf(seed);
			const bucket = byPrefix.get(await prefixOf(ref, 2))!;
			if (bucket.length < 2) bucket.push(ref);
		}
	});

	it('sheds exactly what the old slice covered and the new one does not — never what is outside the old slice or inside the new one', async () => {
		// Ring 1 → ring 2: the node covered the `1x` half and keeps only `10`, so it gives up `11`.
		const narrowing: RingNarrowing = {
			from: { prefixBits: 1, prefixValue: 1 },
			to: { prefixBits: 2, prefixValue: 0b10 }
		};
		const outsideOldSlice = [...byPrefix.get(0)!, ...byPrefix.get(1)!];
		const insideNewSlice = byPrefix.get(0b10)!;
		const givenUp = byPrefix.get(0b11)!;
		const held = [...outsideOldSlice, ...insideNewSlice, ...givenUp];

		const shed = await selectShedBlobRefs(held, narrowing);

		expect(shed).to.have.members(givenUp);
		expect(shed, 'nothing the new slice still covers, and nothing the old slice never covered')
			.to.have.lengthOf(givenUp.length);
	});
});
