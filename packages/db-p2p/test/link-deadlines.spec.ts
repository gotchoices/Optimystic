/**
 * Ticket: declared-link-round-trip-derives-every-dial-deadline.
 *
 * `resolveLinkDeadlines` turns one declared link round trip into every network deadline a node
 * applies. These specs pin its specification: undeclared is exactly the pre-declaration constants,
 * every derived value floors at the constant it replaces, a slow link scales each by its own number
 * of round trips, and an unusable declaration throws rather than silently keeping the LAN deadlines.
 */

import { expect } from 'chai';
import { MAX_LINK_ROUND_TRIP_MS, MAX_RPC_DIAL_TIMEOUT_MS, resolveLinkDeadlines, type LinkDeadlines } from '../src/rpc-deadline.js';

const UNDECLARED: LinkDeadlines = {
	dialTimeoutMs: 3000,
	responseTimeoutMs: 10_000,
	libp2pDialTimeoutMs: 10_000,
	inboundUpgradeTimeoutMs: 10_000,
	addressDialTimeoutMs: 6000,
	cohortQueryTimeoutMs: 1000,
	transferTimeoutMs: 30_000,
	transactionTimeoutMs: 30_000,
};

describe('resolveLinkDeadlines', () => {
	it('undeclared yields exactly the constants in force before the declaration existed', () => {
		expect(resolveLinkDeadlines()).to.deep.equal(UNDECLARED);
	});

	it('a round trip fast enough that no multiple exceeds its floor changes nothing', () => {
		expect(resolveLinkDeadlines(250)).to.deep.equal(UNDECLARED);
	});

	it('a 3 s round trip scales each deadline by its own number of round trips', () => {
		expect(resolveLinkDeadlines(3000)).to.deep.equal({
			// A cold relayed open (10 round trips) plus stream negotiation.
			dialTimeoutMs: 33_000,
			// 3 x 3000 = 9000 is still under the 10 s floor.
			responseTimeoutMs: 10_000,
			// Never shorter than the per-address limit, which a cold relayed dial can use all of.
			libp2pDialTimeoutMs: 30_000,
			// The listener's timer runs over its own upgrade only, never over the dialer's relay open.
			inboundUpgradeTimeoutMs: 15_000,
			// One address has to carry a whole cold relayed open, relay connection included.
			addressDialTimeoutMs: 30_000,
			cohortQueryTimeoutMs: 9000,
			transferTimeoutMs: 33_000,
			transactionTimeoutMs: 132_000,
		});
	});

	it('the transfer deadline never falls below the dial deadline', () => {
		const deadlines = resolveLinkDeadlines(10_000);
		expect(deadlines.dialTimeoutMs).to.equal(110_000);
		expect(deadlines.transferTimeoutMs).to.equal(110_000);
	});

	for (const declared of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_LINK_ROUND_TRIP_MS + 1]) {
		it(`throws on ${String(declared)} rather than keeping the LAN deadlines`, () => {
			expect(() => resolveLinkDeadlines(declared)).to.throw(/linkRoundTripMs must be a finite number/);
		});
	}

	it('accepts the ceiling itself, and every derived delay there fits a 32-bit timer, including the reconcile pass bound and a timer armed 5 s past the transaction budget', () => {
		const deadlines = resolveLinkDeadlines(MAX_LINK_ROUND_TRIP_MS);
		const largest = Math.max(
			deadlines.dialTimeoutMs,
			deadlines.libp2pDialTimeoutMs,
			deadlines.inboundUpgradeTimeoutMs,
			deadlines.addressDialTimeoutMs,
			deadlines.transferTimeoutMs,
			deadlines.transactionTimeoutMs + 5000,
			5 * deadlines.cohortQueryTimeoutMs
		);
		expect(largest).to.be.at.most(2 ** 31 - 1);
	});
});

describe('resolveLinkDeadlines with explicit rpcDeadlines', () => {
	it('an explicit dial deadline replaces the derived one exactly, even below its floor', () => {
		expect(resolveLinkDeadlines(3000, { dialTimeoutMs: 1000 }).dialTimeoutMs).to.equal(1000);
	});

	it('the transfer and transaction budgets follow an explicit dial, and nothing else moves', () => {
		expect(resolveLinkDeadlines(3000, { dialTimeoutMs: 40_000 })).to.deep.equal({
			...resolveLinkDeadlines(3000),
			dialTimeoutMs: 40_000,
			transferTimeoutMs: 40_000,
			transactionTimeoutMs: 160_000,
		});
	});

	it('an explicit response deadline replaces the derived one exactly, and nothing else moves', () => {
		expect(resolveLinkDeadlines(3000, { responseTimeoutMs: 2500 })).to.deep.equal({
			...resolveLinkDeadlines(3000),
			responseTimeoutMs: 2500,
		});
	});

	const fields = [
		{ field: 'dialTimeoutMs', ceiling: MAX_RPC_DIAL_TIMEOUT_MS },
		{ field: 'responseTimeoutMs', ceiling: 2 ** 31 - 1 },
	] as const;
	for (const { field, ceiling } of fields) {
		for (const declared of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, ceiling + 1]) {
			it(`throws on ${field} ${String(declared)}`, () => {
				expect(() => resolveLinkDeadlines(undefined, { [field]: declared }))
					.to.throw(new RegExp(`rpcDeadlines\\.${field} must be a finite number`));
			});
		}
	}

	it('accepts the dial ceiling itself, and a timer armed 5 s past the transaction budget there fits a 32-bit timer', () => {
		const deadlines = resolveLinkDeadlines(undefined, { dialTimeoutMs: MAX_RPC_DIAL_TIMEOUT_MS });
		expect(deadlines.dialTimeoutMs).to.equal(MAX_RPC_DIAL_TIMEOUT_MS);
		expect(deadlines.transactionTimeoutMs + 5000).to.be.at.most(2 ** 31 - 1);
	});
});
