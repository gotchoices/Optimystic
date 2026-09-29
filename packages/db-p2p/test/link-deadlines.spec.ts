/**
 * Ticket: declared-link-round-trip-derives-every-dial-deadline.
 *
 * `resolveLinkDeadlines` turns one declared link round trip into every network deadline a node
 * applies. These specs pin its specification: undeclared is exactly the pre-declaration constants,
 * every derived value floors at the constant it replaces, a slow link scales each by its own number
 * of round trips, and an unusable declaration throws rather than silently keeping the LAN deadlines.
 */

import { expect } from 'chai';
import { MAX_LINK_ROUND_TRIP_MS, resolveLinkDeadlines, type LinkDeadlines } from '../src/rpc-deadline.js';

const UNDECLARED: LinkDeadlines = {
	dialTimeoutMs: 3000,
	responseTimeoutMs: 10_000,
	connectionTimeoutMs: 10_000,
	cohortQueryTimeoutMs: 1000,
	transferTimeoutMs: 30_000,
};

describe('resolveLinkDeadlines', () => {
	it('undeclared yields exactly the constants in force before the declaration existed', () => {
		expect(resolveLinkDeadlines()).to.deep.equal(UNDECLARED);
	});

	it('a round trip fast enough that no multiple exceeds its floor changes nothing', () => {
		expect(resolveLinkDeadlines(300)).to.deep.equal(UNDECLARED);
	});

	it('a 3 s round trip scales each deadline by its own number of round trips', () => {
		expect(resolveLinkDeadlines(3000)).to.deep.equal({
			dialTimeoutMs: 18_000,
			// 3 x 3000 = 9000 is still under the 10 s floor.
			responseTimeoutMs: 10_000,
			connectionTimeoutMs: 15_000,
			cohortQueryTimeoutMs: 9000,
			// The dial (18 s) is still under the 30 s floor.
			transferTimeoutMs: 30_000,
		});
	});

	it('the transfer deadline never falls below the dial deadline', () => {
		const deadlines = resolveLinkDeadlines(10_000);
		expect(deadlines.dialTimeoutMs).to.equal(60_000);
		expect(deadlines.transferTimeoutMs).to.equal(60_000);
	});

	for (const declared of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_LINK_ROUND_TRIP_MS + 1]) {
		it(`throws on ${String(declared)} rather than keeping the LAN deadlines`, () => {
			expect(() => resolveLinkDeadlines(declared)).to.throw(/linkRoundTripMs must be a finite number/);
		});
	}

	it('accepts the ceiling itself, and every derived delay there fits a 32-bit timer after the reconcile pass multiplies the cohort budget by five', () => {
		const deadlines = resolveLinkDeadlines(MAX_LINK_ROUND_TRIP_MS);
		const largest = Math.max(deadlines.dialTimeoutMs, deadlines.connectionTimeoutMs, deadlines.transferTimeoutMs, 5 * deadlines.cohortQueryTimeoutMs);
		expect(largest).to.be.at.most(2 ** 31 - 1);
	});
});
