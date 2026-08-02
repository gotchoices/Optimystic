import { expect } from 'chai';
import { isConflictFailure } from '../src/network/stale-failure.js';
import type { ActionPending, ActionTransforms, StaleFailure } from '../src/index.js';

/**
 * Pins `isConflictFailure`, the single rule every pend consumer uses to decide whether a
 * non-success is worth retrying. The subtlety is the `??`-vs-`||` precedence: an explicit
 * `conflict: false` must SUPPRESS the missing/pending fallback (the producer classified this as a
 * hard rejection and its evidence must not override that), while only an absent field may trigger
 * it (a producer on an older build never sets the flag, so its evidence is all we have).
 */
describe('isConflictFailure', () => {
	const rivalPending: ActionPending[] = [{ blockId: 'b1', actionId: 'rival-action' }];
	const committedMissing: ActionTransforms[] = [
		{ actionId: 'winner-action', rev: 4, transforms: { inserts: {}, updates: {}, deletes: [] } }
	];

	const cases: { name: string; failure: StaleFailure; expected: boolean }[] = [
		{
			name: 'conflict: true with no evidence — the confirmed-loss shape from CoordinatorRepo',
			failure: { success: false, conflict: true, reason: 'stale revision: block b1 at rev 3, requested rev 3' },
			expected: true
		},
		{
			name: 'conflict: false with no evidence — an explicitly hard rejection',
			failure: { success: false, conflict: false, reason: 'operations hash mismatch' },
			expected: false
		},
		{
			name: 'conflict: false overrides missing evidence — the flag is authoritative',
			failure: { success: false, conflict: false, missing: committedMissing },
			expected: false
		},
		{
			name: 'conflict: false overrides pending evidence — the flag is authoritative',
			failure: { success: false, conflict: false, pending: rivalPending },
			expected: false
		},
		{
			name: 'absent flag with missing evidence — older-producer fallback',
			failure: { success: false, missing: committedMissing },
			expected: true
		},
		{
			name: 'absent flag with pending evidence — older-producer fallback',
			failure: { success: false, pending: rivalPending },
			expected: true
		},
		{
			name: 'absent flag with empty evidence lists — nothing to infer from',
			failure: { success: false, missing: [], pending: [] },
			expected: false
		},
		{
			name: 'absent flag with reason only — unclassified, so not retryable',
			failure: { success: false, reason: 'Transaction validation failed' },
			expected: false
		},
		{
			name: 'no fields at all',
			failure: { success: false },
			expected: false
		},
		// `staleAt` is diagnostic only. It never makes a failure retryable on its own, and it never
		// rescues one the producer explicitly classified as hard — otherwise a number meant purely
		// for a human-readable error message would silently become retry control flow.
		{
			name: 'staleAt alone with no other field — a number, not a classification',
			failure: { success: false, staleAt: { blockId: 'b1', rev: 7 } },
			expected: false
		},
		{
			name: 'conflict: false with staleAt — stays hard, the flag is still authoritative',
			failure: { success: false, conflict: false, staleAt: { blockId: 'b1', rev: 7 } },
			expected: false
		},
		{
			name: 'conflict: true with staleAt — the confirmed-loss shape, unchanged by the number',
			failure: { success: false, conflict: true, staleAt: { blockId: 'b1', rev: 7 } },
			expected: true
		}
	];

	for (const { name, failure, expected } of cases) {
		it(`${expected ? 'is' : 'is not'} a conflict: ${name}`, () => {
			expect(isConflictFailure(failure)).to.equal(expected);
		});
	}

	it('returns a boolean, never a truthy count leaking from the evidence lists', () => {
		// `Boolean(...)` around the fallback matters: `missing.length || pending.length` would
		// otherwise hand callers a number, and `staleLoss` flows straight onto a public result type.
		expect(isConflictFailure({ success: false, missing: committedMissing })).to.be.a('boolean');
	});
});

/**
 * The repo protocol serializes failures as plain JSON (db-p2p's repo service does
 * `JSON.parse`/`JSON.stringify` on the wire), so `staleAt` needs no codec and no version
 * negotiation — it survives a round trip as a nested object, and a peer that predates the field
 * simply omits it. These pin both halves so a future wire change cannot quietly break either.
 */
describe('StaleFailure.staleAt over the wire', () => {
	const failure: StaleFailure = {
		success: false,
		conflict: true,
		reason: 'stale revision: block b1 at rev 9, requested rev 7',
		staleAt: { blockId: 'b1', rev: 9 }
	};

	it('survives a JSON round trip intact', () => {
		const roundTripped = JSON.parse(JSON.stringify(failure)) as StaleFailure;
		expect(roundTripped.staleAt).to.deep.equal({ blockId: 'b1', rev: 9 });
		expect(isConflictFailure(roundTripped)).to.equal(true);
	});

	it('classifies and retries identically when an older peer strips the field', () => {
		const { staleAt: _dropped, ...olderPeerResponse } = failure;
		const roundTripped = JSON.parse(JSON.stringify(olderPeerResponse)) as StaleFailure;
		expect(roundTripped.staleAt).to.equal(undefined);
		// Same retry decision as the version that carried the number: absence is not a signal.
		expect(isConflictFailure(roundTripped)).to.equal(isConflictFailure(failure));
	});
});
