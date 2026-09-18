/**
 * Tickets: a-member-that-missed-a-commit-refuses-every-later-write (review), and
 * a-rival-pend-is-superseded-only-by-a-writer-that-built-on-it (the base arm).
 *
 * The one rule both rival scans apply (`StorageRepo.pend` at apply, `ClusterMember.validatePendOperations`
 * at the promise vote), pinned as a table so a change to it is a visible decision rather than a side
 * effect of a storage or cluster edit. The mesh and storage specs cover the rule through its callers;
 * this is the rule itself, and the one reading of an incoming pend both callers feed it
 * (`reservationRequestFor`).
 */

import { expect } from 'chai';
import type { ActionId, BlockId, PendRequest, Transform } from '@optimystic/db-core';
import { isReservationAgainst, reservationRequestFor, usableBase, type ReservationRequest } from '../src/storage/pending-claim.js';

const rival = 'rival' as ActionId;
const claimAt = (rev: number | undefined) => rev === undefined ? { actionId: rival } : { actionId: rival, rev };

describe('isReservationAgainst — a pending record reserves the block only for the slot it claims', () => {
	describe('with no base on the request (the revision rule)', () => {
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
				expect(isReservationAgainst(claimAt(claim), { rev: requested })).to.equal(reserves);
			});
		}

		it('is monotone in the requested revision: once superseded, superseded for every later request', () => {
			for (let requested = 3; requested < 20; requested++) {
				expect(isReservationAgainst(claimAt(2), { rev: requested }), `requested ${requested}`).to.equal(false);
			}
		});
	});

	describe('with a base on the request (superseded only by a writer that built on the record)', () => {
		const cases: { claim: number | undefined; requested: number | undefined; base: number; reserves: boolean; why: string }[] = [
			{ claim: 5, requested: 6, base: 5, reserves: false, why: 'the writer read the block with the claimed change in it' },
			{ claim: 5, requested: 9, base: 7, reserves: false, why: 'the writer read the block past the claimed slot' },
			{ claim: 5, requested: 6, base: 4, reserves: true, why: 'the collection moved past the slot, but the writer read the block without the change' },
			{ claim: 5, requested: 9, base: 3, reserves: true, why: 'however far the request has moved, a base below the claim did not build on it' },
			{ claim: 5, requested: 5, base: 4, reserves: true, why: 'the same slot, unchanged: a live rival' },
			{ claim: 7, requested: 6, base: 5, reserves: true, why: 'a later slot, unchanged: the requester is stale' },
			{ claim: undefined, requested: 6, base: 5, reserves: true, why: 'an unknown claim is still the strongest kind' },
		];

		for (const { claim, requested, base, reserves, why } of cases) {
			it(`claim ${claim ?? 'unknown'} vs requested ${requested} on base ${base} → ${reserves ? 'reserves' : 'superseded'} (${why})`, () => {
				expect(isReservationAgainst(claimAt(claim), { rev: requested, baseRev: base })).to.equal(reserves);
			});
		}

		it('reads the base, not the record\'s own base: a base-less rival record is judged by the newcomer\'s base', () => {
			// A record from a pre-upgrade sender carries a slot and no base; the comparison is between its
			// slot and the NEWCOMER's base, so the record needs none.
			expect(isReservationAgainst({ actionId: rival, rev: 5 }, { rev: 6, baseRev: 5 })).to.equal(false);
			expect(isReservationAgainst({ actionId: rival, rev: 5 }, { rev: 6, baseRev: 4 })).to.equal(true);
			expect(isReservationAgainst({ actionId: rival, rev: 5, baseRev: 1 }, { rev: 6, baseRev: 4 }), 'and ignores the record\'s base when it has one')
				.to.equal(true);
		});
	});

	describe('a base the rule cannot read falls back to the revision rule', () => {
		const malformed: { label: string; base: unknown }[] = [
			{ label: 'equal to the requested revision', base: 6 },
			{ label: 'past the requested revision', base: 9 },
			{ label: 'a string', base: '5' },
			{ label: 'null', base: null },
			{ label: 'NaN', base: Number.NaN },
			{ label: 'an object', base: { rev: 5 } },
		];

		for (const { label, base } of malformed) {
			it(`a base that is ${label} is ignored`, () => {
				const request = { rev: 6, baseRev: base } as unknown as ReservationRequest;
				expect(usableBase(request)).to.equal(undefined);
				// claim 5 vs requested 6: the revision rule supersedes; claim 6: it reserves.
				expect(isReservationAgainst(claimAt(5), request)).to.equal(false);
				expect(isReservationAgainst(claimAt(6), request)).to.equal(true);
			});
		}

		it('a base on a rev-less request is ignored, and the request reserves as before', () => {
			expect(usableBase({ baseRev: 3 })).to.equal(undefined);
			expect(isReservationAgainst(claimAt(2), { baseRev: 3 })).to.equal(true);
		});
	});

	it('is never more permissive than the revision rule: a base can only hold more, never admit more', () => {
		// Every claim, every requested revision, and every honest base below it (plus no base at all).
		let compared = 0;
		let heldMore = 0;
		for (let rev = 1; rev <= 12; rev++) {
			for (let claim = 0; claim <= 13; claim++) {
				const byRevision = isReservationAgainst(claimAt(claim), { rev });
				for (let base = 0; base < rev; base++) {
					const byBase = isReservationAgainst(claimAt(claim), { rev, baseRev: base });
					if (!byBase) {
						expect(byRevision, `claim ${claim}, rev ${rev}, base ${base}: admitted by the base but not by the revision`).to.equal(false);
					}
					if (byBase && !byRevision) heldMore++;
					compared++;
				}
			}
		}
		expect(compared).to.be.greaterThan(500);
		expect(heldMore, 'and it does hold more somewhere, or the base arm would be dead code').to.be.greaterThan(0);
	});
});

describe('reservationRequestFor — the one reading of an incoming pend both rival scans feed the rule', () => {
	const BLOCK = 'b1' as BlockId;
	const update: Transform = { updates: [['entries', 0, 0, ['x']]] } as unknown as Transform;
	const insert: Transform = { insert: { header: { id: BLOCK } } } as unknown as Transform;
	const del: Transform = { delete: true } as unknown as Transform;
	const pend = (baseRevs?: Record<string, unknown>, rev: number | undefined = 6): Pick<PendRequest, 'rev' | 'baseRevs'> =>
		({ rev, ...(baseRevs === undefined ? {} : { baseRevs: baseRevs as PendRequest['baseRevs'] }) });

	it('carries the revision and the block\'s base for an update-only transform', () => {
		expect(reservationRequestFor(pend({ [BLOCK]: 5 }), BLOCK, update)).to.deep.equal({ request: { rev: 6, baseRev: 5 } });
	});

	it('carries the revision alone when the pend names no base, and names nothing ignored', () => {
		expect(reservationRequestFor(pend(), BLOCK, update)).to.deep.equal({ request: { rev: 6 } });
		expect(reservationRequestFor(pend({ other: 5 }), BLOCK, update), 'another block\'s base is not this one\'s')
			.to.deep.equal({ request: { rev: 6 } });
	});

	it('drops a base on an inserted or deleted block — storage keeps none for them either — and reports it', () => {
		expect(reservationRequestFor(pend({ [BLOCK]: 5 }), BLOCK, insert)).to.deep.equal({ request: { rev: 6 }, ignoredBase: 5 });
		expect(reservationRequestFor(pend({ [BLOCK]: 5 }), BLOCK, del)).to.deep.equal({ request: { rev: 6 }, ignoredBase: 5 });
	});

	it('drops a malformed base and reports it', () => {
		expect(reservationRequestFor(pend({ [BLOCK]: '5' }), BLOCK, update)).to.deep.equal({ request: { rev: 6 }, ignoredBase: '5' });
	});

	it('reports a base not below the revision, which the rule ignores', () => {
		const { request, ignoredBase } = reservationRequestFor(pend({ [BLOCK]: 6 }), BLOCK, update);
		expect(ignoredBase).to.equal(6);
		expect(usableBase(request)).to.equal(undefined);
		expect(isReservationAgainst(claimAt(5), request), 'the revision rule applies').to.equal(false);
	});
});
