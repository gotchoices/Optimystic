import type { PendRequest, PendValidationResult, UnvalidatablePendPolicy } from "@optimystic/db-core";

/**
 * Stable, greppable prefix on the failure reason a validating receiver emits when it refuses a pend
 * that carries no `validation` payload (nothing to re-execute — the single-collection
 * `Collection.sync` shape) under the fail-closed `unvalidatablePendPolicy: 'reject'`.
 */
export const PEND_NOT_VALIDATABLE = 'pend-not-validatable';

/**
 * Stable, greppable prefix on the failure reason a validating receiver emits when the checker
 * itself THREW (engine fault, missing table, parse error) rather than returning a verdict. Distinct
 * from a content verdict on purpose: an operator reading a reject reason can tell "this transaction
 * is wrong" from "this node could not tell".
 */
export const VALIDATOR_FAULT = 'validator-fault';

/**
 * One re-check attempt: hand the pend's `validation` pair to whatever checker this tier holds
 * (a `ClusterMember`'s `ITransactionValidator`, a `StorageRepo`'s `validatePend` hook) and
 * return its verdict. Throwing is allowed — {@link checkPendValidation} converts a throw into a
 * {@link VALIDATOR_FAULT} rejection.
 */
export type PendChecker = (validation: NonNullable<PendRequest['validation']>) => Promise<PendValidationResult>;

/** Structured trace of the decision this helper took, rendered by whichever tier called it. */
export type PendValidationEvent =
	| { kind: 'unvalidatable'; policy: UnvalidatablePendPolicy }
	| { kind: 'validator-fault'; error: string };

/**
 * The fail-closed pend re-check, shared by BOTH tiers that hold a checker — `ClusterMember`
 * (voting on a cluster record) and `StorageRepo` (applying a pend locally). One implementation
 * rather than two mirrored copies, because the two tiers refusing with *different* prefixes or
 * *different* policy semantics is a silent inconsistency nothing would catch: they are read by the
 * same operator, and a member that votes approve while its own storage refuses at apply burns a
 * consensus round for nothing.
 *
 * Two decisions live here:
 *
 * - **No `validation` pair** (the single-collection `Collection.sync` shape — bare transforms, so
 *   there is nothing to re-execute): an explicit, LOGGED policy branch on both arms, never a silent
 *   fall-through. `'accept'` admits it unchecked, preserving the historical behaviour; `'reject'`
 *   refuses with {@link PEND_NOT_VALIDATABLE}. The presence test is on the whole pair, so a sender
 *   cannot talk a receiver out of validating by omitting half of it.
 * - **A checker that throws**: caught and turned into a {@link VALIDATOR_FAULT} rejection, never an
 *   escaping error. At the cluster tier an escaping throw costs the member its vote entirely —
 *   indistinguishable from an unreachable peer, and with no signed reason for the dispute path.
 *
 * NOTE: a TRANSIENT checker fault (database busy, momentary connection loss) therefore produces a
 * terminal reject where a redelivery might have produced an approve. `CoordinatorRepo`'s two
 * rejection classifiers confirm retryability against LOCAL storage state and never read this prose,
 * so a validator-fault reject is returned as retryable only when local state independently shows a
 * stale revision or a rival pending — otherwise it reaches the writer as a throw. If transient
 * validator faults ever show up in practice, give the classifier an arm keyed on this prefix rather
 * than reverting to a silent pass or a lost vote.
 *
 * @param request the pend under consideration
 * @param check the tier's checker, or undefined when this node re-validates nothing (then every
 *   pend passes and the policy is irrelevant — a storage-only node)
 * @param policy what to do with a pend that carries no `validation` pair
 * @param onEvent trace sink; called on every decision this helper takes, so the two tiers log the
 *   same facts in their own formats
 */
export async function checkPendValidation(
	request: PendRequest,
	check: PendChecker | undefined,
	policy: UnvalidatablePendPolicy,
	onEvent: (event: PendValidationEvent) => void
): Promise<PendValidationResult> {
	if (!check) {
		return { valid: true };
	}
	if (!request.validation) {
		onEvent({ kind: 'unvalidatable', policy });
		return policy === 'reject'
			// Plain prose after the stable prefix: at the cluster tier this reason is fed to
			// computeSigningPayload and carried as Signature.rejectReason, so it must stay a string.
			? { valid: false, reason: `${PEND_NOT_VALIDATABLE}: pend carries no transaction to re-execute` }
			: { valid: true };
	}
	try {
		return await check(request.validation);
	} catch (err) {
		const error = (err as Error).message;
		onEvent({ kind: 'validator-fault', error });
		return { valid: false, reason: `${VALIDATOR_FAULT}: ${error}` };
	}
}
