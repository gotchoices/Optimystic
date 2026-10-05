import { expect } from 'chai';
import { clusterVoteSigningPayload, type ClusterVote } from '../src/cluster/structs.js';

/**
 * The vote preimage gained a two-field encoding for the expiry vote (a `reject` carrying `expiredAt`).
 * Two properties are pinned: every vote without the field still signs exactly the bytes it did before
 * the field existed, so records signed by older builds keep verifying; and the new encoding cannot be
 * read as a different vote, so neither field can be altered in transit.
 */
describe('clusterVoteSigningPayload', () => {
	const hash = 'aGFzaA';
	const text = (vote: ClusterVote): string => new TextDecoder().decode(clusterVoteSigningPayload(hash, vote));

	it('encodes every vote without expiredAt as <hash>:<type>[:<extra>], as before the field existed', () => {
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
});
