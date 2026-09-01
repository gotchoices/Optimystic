import { expect } from 'chai';
import type { ActionId, PendRequest, Transaction, Transforms } from '@optimystic/db-core';
import {
	checkPendValidation,
	PEND_NOT_VALIDATABLE,
	VALIDATOR_FAULT,
	type PendValidationEvent
} from '../src/pend-validation.js';

/**
 * Unit cover for the ONE fail-closed decision both validating tiers run (`ClusterMember`'s vote and
 * `StorageRepo`'s apply). Each tier has its own end-to-end case proving it is wired to this
 * function; the truth table itself lives here so it is stated once, and so a future tier gets the
 * same semantics by construction rather than by copying a branch.
 */
describe('checkPendValidation', () => {
	const transforms: Transforms = { inserts: {}, updates: {}, deletes: [] };
	const bareRequest = (): PendRequest => ({ actionId: 'a1' as ActionId, transforms, policy: 'c' });
	const validatableRequest = (): PendRequest => ({
		...bareRequest(),
		validation: { transaction: { statements: [], stamp: {} } as unknown as Transaction, operationsHash: 'ops.v1:hash' }
	});
	/** Collects the trace so the "logged on BOTH branches" claim is asserted, not assumed. */
	const recordEvents = () => {
		const events: PendValidationEvent[] = [];
		return { events, sink: (event: PendValidationEvent) => { events.push(event); } };
	};
	const never = async () => expect.fail('the checker must not be consulted');

	describe('no checker configured — the policy is inert', () => {
		for (const policy of ['accept', 'reject'] as const) {
			it(`passes a validation-free pend under '${policy}'`, async () => {
				const { events, sink } = recordEvents();
				const result = await checkPendValidation(bareRequest(), undefined, policy, sink);
				expect(result.valid).to.equal(true);
				expect(events, 'a node that re-checks nothing takes no policy decision to log').to.deep.equal([]);
			});
		}
	});

	describe('a checker, but nothing to re-check', () => {
		it("under 'accept' admits the pend and LOGS that it went unchecked", async () => {
			const { events, sink } = recordEvents();
			const result = await checkPendValidation(bareRequest(), never, 'accept', sink);
			expect(result.valid).to.equal(true);
			expect(events).to.deep.equal([{ kind: 'unvalidatable', policy: 'accept' }]);
		});

		it("under 'reject' refuses with the stable prefix, and logs the same decision", async () => {
			const { events, sink } = recordEvents();
			const result = await checkPendValidation(bareRequest(), never, 'reject', sink);
			expect(result.valid).to.equal(false);
			expect(result.reason).to.match(new RegExp(`^${PEND_NOT_VALIDATABLE}: `));
			expect(events).to.deep.equal([{ kind: 'unvalidatable', policy: 'reject' }]);
		});
	});

	describe('a checker with a payload to re-check', () => {
		it('passes the pair through verbatim and returns the verdict', async () => {
			const seen: Array<[Transaction, string]> = [];
			const { events, sink } = recordEvents();
			const result = await checkPendValidation(
				validatableRequest(),
				async ({ transaction, operationsHash }) => {
					seen.push([transaction, operationsHash]);
					return { valid: true };
				},
				'reject',
				sink
			);
			expect(result.valid).to.equal(true);
			expect(seen).to.have.length(1);
			expect(seen[0]![1]).to.equal('ops.v1:hash');
			expect(events, 'a re-checked pend takes no policy decision').to.deep.equal([]);
		});

		it("relays a content verdict's own reason untouched — a rejection is not relabelled a fault", async () => {
			const { sink } = recordEvents();
			const result = await checkPendValidation(
				validatableRequest(),
				async () => ({ valid: false, reason: 'Operations hash mismatch: local=x, sender=y' }),
				'accept',
				sink
			);
			expect(result.valid).to.equal(false);
			expect(result.reason).to.equal('Operations hash mismatch: local=x, sender=y');
			expect(result.reason).to.not.include(VALIDATOR_FAULT);
		});

		it('converts a THROWING checker into a prefixed rejection carrying the fault text', async () => {
			const { events, sink } = recordEvents();
			const result = await checkPendValidation(
				validatableRequest(),
				async () => { throw new Error('engine exploded: no such table t'); },
				'accept',
				sink
			);
			expect(result.valid).to.equal(false);
			expect(result.reason).to.equal(`${VALIDATOR_FAULT}: engine exploded: no such table t`);
			expect(events).to.deep.equal([{ kind: 'validator-fault', error: 'engine exploded: no such table t' }]);
		});

		it('converts a SYNCHRONOUS throw too — a checker that fails before its first await', async () => {
			// `check()` is called inside the try, so a checker that throws on the way to returning its
			// promise is caught by the same arm. A `return check(...)` outside a try would not be.
			const { sink } = recordEvents();
			const result = await checkPendValidation(
				validatableRequest(),
				(() => { throw new Error('constructor blew up'); }) as never,
				'accept',
				sink
			);
			expect(result.valid).to.equal(false);
			expect(result.reason).to.equal(`${VALIDATOR_FAULT}: constructor blew up`);
		});
	});
});
