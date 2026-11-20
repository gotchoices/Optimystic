import { expect } from 'chai';
import { PeerProofMemory } from '../src/cluster/peer-proof-memory.js';

/**
 * The sender half of `BlockTransferRequest.proofRefs`: whether a push may NAME a commit proof to a
 * peer instead of carrying it. Only the degradation policy is pinned here — the wire shape and the
 * retry it drives are end-to-end in `block-transfer-roundtrip.spec.ts`.
 */
describe('PeerProofMemory', () => {
	const PEER = '12D3KooWpeer';
	const HASH = 'zCommitProofHash';

	it('names a proof only once a push has carried it to that peer', () => {
		const memory = new PeerProofMemory();
		expect(memory.holds(PEER, HASH), 'nothing is named to a peer that has never been sent it').to.equal(false);
		memory.remember(PEER, HASH);
		expect(memory.holds(PEER, HASH), 'a confirmed inline push is what warms the pair').to.equal(true);
		expect(memory.holds('12D3KooWother', HASH), 'and it warms that peer alone').to.equal(false);
	});

	/**
	 * One unresolved answer is routinely transient (the peer restarted between two blocks of a commit
	 * and re-filed the proof from the retry), so the reference is tried again. A peer that resolves no
	 * reference ever answers every time, and without this bound each block of the commit would cost
	 * it two pushes indefinitely.
	 */
	it('stops naming a proof to a peer that twice could not resolve it', () => {
		const memory = new PeerProofMemory();
		memory.remember(PEER, HASH);

		memory.recordUnresolved(PEER, HASH);
		expect(memory.holds(PEER, HASH), 'an unresolved answer stops the next reference immediately').to.equal(false);
		memory.remember(PEER, HASH);
		expect(memory.holds(PEER, HASH), 'the first failure is forgiven once the proof is re-sent').to.equal(true);

		memory.recordUnresolved(PEER, HASH);
		memory.remember(PEER, HASH);
		expect(memory.holds(PEER, HASH), 'the second is not — this peer is sent the proof from here on').to.equal(false);
	});
});
