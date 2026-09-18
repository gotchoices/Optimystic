/**
 * Ticket: a-member-that-missed-a-commit-refuses-every-later-write (review).
 *
 * The one rule both rival scans apply (`StorageRepo.pend` at apply, `ClusterMember.validatePendOperations`
 * at the promise vote), pinned as a table so a change to it is a visible decision rather than a side
 * effect of a storage or cluster edit. The mesh and storage specs cover the rule through its callers;
 * this is the rule itself.
 */

import { expect } from 'chai';
import type { ActionId } from '@optimystic/db-core';
import { isReservationAgainst } from '../src/storage/pending-claim.js';

const rival = 'rival' as ActionId;

describe('isReservationAgainst — a pending record reserves the block only for the slot it claims', () => {
	const cases: { claim: number | undefined; requested: number | undefined; reserves: boolean; why: string }[] = [
		{ claim: 2, requested: 3, reserves: false, why: 'the collection moved past the claimed slot: superseded' },
		{ claim: 2, requested: 2, reserves: true, why: 'the same slot: a live rival inside its pend-to-commit window' },
		{ claim: 3, requested: 2, reserves: true, why: 'a later slot: the requester is stale against the cohort' },
		{ claim: undefined, requested: 3, reserves: true, why: 'unknown claim (pre-upgrade or rev-less record): the strongest kind' },
		{ claim: 2, requested: undefined, reserves: true, why: 'a rev-less request cannot be placed past anything' },
		{ claim: undefined, requested: undefined, reserves: true, why: 'nothing known on either side' },
	];

	for (const { claim, requested, reserves, why } of cases) {
		it(`claim ${claim ?? 'unknown'} vs requested ${requested ?? 'none'} → ${reserves ? 'reserves' : 'superseded'} (${why})`, () => {
			expect(isReservationAgainst(claim === undefined ? { actionId: rival } : { actionId: rival, rev: claim }, requested)).to.equal(reserves);
		});
	}

	it('is monotone in the requested revision: once superseded, superseded for every later request', () => {
		for (let requested = 3; requested < 20; requested++) {
			expect(isReservationAgainst({ actionId: rival, rev: 2 }, requested), `requested ${requested}`).to.equal(false);
		}
	});
});
