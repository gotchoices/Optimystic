import { expect } from 'chai';
import type { ClusterRecord } from '@optimystic/db-core';
import { validityRejectionOf } from '../src/repo/cluster-coordinator.js';

/**
 * Which rejected records the coordinator classifies as a judgement of the transaction itself — the
 * answer a writer stops on for good. Only when every reject that sank the record is a validity vote or
 * an expiry vote, and at least one is a validity vote. An unmarked reject beside them could be a stale
 * revision only members ahead of the coordinator can see, so the rejection stays unclassified rather
 * than risk a writer dropping a change a rebase would have saved.
 */

type Votes = ClusterRecord['promises'];

const approve = { type: 'approve', signature: 'sig' } as const;
const invalid = (computedHash?: string) => ({
	type: 'reject', signature: 'sig', rejectReason: 'Operations hash mismatch',
	validity: computedHash === undefined ? {} : { computedHash }
}) as const;
const expired = { type: 'reject', signature: 'sig', rejectReason: 'transaction-expired: …', expiredAt: 1_700_000_000_000 } as const;
const unmarked = { type: 'reject', signature: 'sig', rejectReason: 'stale revision' } as const;

describe('validityRejectionOf — when a rejected record is final', () => {
	it('classifies a rejection every reject of which is a validity vote, naming each refuser', () => {
		const votes: Votes = { a: approve, b: invalid('hash-b'), c: invalid() };

		expect(validityRejectionOf(votes)).to.deep.equal({
			refusals: [
				{ peerId: 'b', reason: 'Operations hash mismatch', computedHash: 'hash-b' },
				{ peerId: 'c', reason: 'Operations hash mismatch' }
			]
		});
	});

	it('classifies validity votes beside expiry votes, counting only the validity votes as refusals', () => {
		const votes: Votes = { a: approve, b: invalid('hash-b'), c: expired };

		expect(validityRejectionOf(votes)).to.deep.equal({
			refusals: [{ peerId: 'b', reason: 'Operations hash mismatch', computedHash: 'hash-b' }]
		});
	});

	it('leaves a validity vote beside an unmarked reject unclassified', () => {
		const votes: Votes = { a: approve, b: invalid('hash-b'), c: unmarked };

		expect(validityRejectionOf(votes)).to.equal(undefined);
	});

	it('leaves an all-expiry rejection to the expiry rule', () => {
		const votes: Votes = { a: approve, b: expired, c: expired };

		expect(validityRejectionOf(votes)).to.equal(undefined);
	});
});
