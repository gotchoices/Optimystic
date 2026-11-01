import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString, fromString as u8FromString } from 'uint8arrays';
import { clusterVoteSigningPayload, clusterVoteVerificationPayload, type ClusterVote, type Signature } from '../src/cluster/structs.js';

/**
 * The vote preimage gained two two-field encodings: the expiry vote (a `reject` carrying `expiredAt`) and
 * the validity vote (a `reject` carrying `validity`). Two properties are pinned: every vote without
 * either field still signs exactly the bytes it did before they existed, so records signed by older
 * builds keep verifying; and the new encodings cannot be read as a different vote, so no field can be
 * added, removed or altered in transit.
 */
describe('clusterVoteSigningPayload', () => {
	const hash = 'aGFzaA';
	const text = (vote: ClusterVote): string => new TextDecoder().decode(clusterVoteSigningPayload(hash, vote));

	it('encodes every vote without expiredAt or validity as <hash>:<type>[:<extra>], as before the fields existed', () => {
		expect(text({ type: 'approve' })).to.equal('aGFzaA:approve');
		expect(text({ type: 'reject' })).to.equal('aGFzaA:reject');
		expect(text({ type: 'reject', rejectReason: 'stale commit: x:5' })).to.equal('aGFzaA:reject:stale commit: x:5');
		expect(text({ type: 'conflict', conflictWith: 'winner' })).to.equal('aGFzaA:conflict:winner');
		expect(text({ type: 'held', heldBy: 'a-rival' })).to.equal('aGFzaA:held:a-rival');
	});

	it('never encodes an expiry vote as the same bytes as a different vote', () => {
		const expiry = text({ type: 'reject', rejectReason: 'x', expiredAt: 5 });
		// A reason that happens to contain the delimiter must not pass for a reason plus a clock reading.
		expect(text({ type: 'reject', rejectReason: 'x:5' })).to.not.equal(expiry);
		expect(text({ type: 'reject', rejectReason: '5:x' })).to.not.equal(expiry);
		// Nor may the reason be smuggled into the clock field, which the wire does not type-check.
		expect(text({ type: 'reject', expiredAt: '5:x' as unknown as number })).to.not.equal(expiry);
		expect(text({ type: 'reject', expiredAt: '5' as unknown as number, rejectReason: 'x' })).to.not.equal(expiry);
	});

	it('binds a validity marker to its vote signature: added, removed or altered, it no longer verifies', async () => {
		const key = await generateKeyPair('Ed25519');
		const sign = async (vote: ClusterVote): Promise<Signature> =>
			({ ...vote, signature: u8ToString(await key.sign(clusterVoteSigningPayload(hash, vote)), 'base64url') }) as Signature;
		const verifies = (sig: Signature): Promise<boolean> =>
			Promise.resolve(key.publicKey.verify(clusterVoteVerificationPayload(hash, sig), u8FromString(sig.signature, 'base64url')));

		const marked = await sign({ type: 'reject', rejectReason: 'Operations hash mismatch', validity: { computedHash: 'ops.v1:aa' } });
		const unmarked = await sign({ type: 'reject', rejectReason: 'Operations hash mismatch' });
		expect(await verifies(marked), 'the marked vote as signed').to.equal(true);
		expect(await verifies(unmarked), 'the unmarked vote as signed').to.equal(true);

		const { validity: _removed, ...withoutMarker } = marked as Extract<Signature, { validity: object }>;
		expect(await verifies({ ...withoutMarker } as Signature), 'marker removed').to.equal(false);
		expect(await verifies({ ...unmarked, validity: { computedHash: 'ops.v1:aa' } } as Signature), 'marker added').to.equal(false);
		expect(await verifies({ ...unmarked, validity: {} } as Signature), 'empty marker added').to.equal(false);
		expect(await verifies({ ...marked, validity: { computedHash: 'ops.v1:bb' } } as Signature), 'computedHash altered').to.equal(false);
		expect(await verifies({ ...marked, validity: {} } as Signature), 'computedHash dropped').to.equal(false);
	});
});
