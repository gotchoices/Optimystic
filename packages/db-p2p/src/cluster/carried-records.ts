import type { CarriedOutcome, ClusterRecord, ICluster, MemberApplyOutcome } from '@optimystic/db-core';
import { MaxCarriedRecords } from '@optimystic/db-core';
import type { RedirectPayload } from '../repo/redirect.js';
import type { Logger } from '../logger.js';

/**
 * Decided records a coordinator still owes a member ride ahead of its next request to that member
 * (`ClusterCoordinator.takeOwedRecords`). This file holds both ends of that exchange that are not the
 * coordinator's: how a member applies what a request carried, and how a client reads the answer.
 */

/** The steps one node takes a cluster record through before its member sees it, as `ClusterService` runs them. */
export interface CarriedRecordIngress {
	/** The member the records are applied to. */
	cluster: ICluster;
	/** This node's peer id: its entry in each answer's `applyOutcomes` is what is reported back. */
	selfId?: string;
	/** Offer the record's cohort addresses to the address book, as for a standalone record. */
	learnPeerAddresses?: (record: ClusterRecord) => void;
	/** A redirect when this node would send the record elsewhere rather than apply it. */
	checkRedirect?: (record: ClusterRecord) => Promise<RedirectPayload | null>;
	log: Logger;
}

/**
 * Apply the decided records a cluster request carried ahead of its own record, strictly in the order
 * sent and before the request's own record, each the way a standalone record is taken: address learning,
 * then the redirect check (a redirect is "not delivered"), then the member's `update` inside its own
 * `try`, so one carried record's throw is that record's `error` and never fails the request.
 *
 * `undefined` when the request carried nothing, or carried something other than a list of at most
 * {@link MaxCarriedRecords} entries — that is ignored rather than failing the request, and the answer
 * then carries no `carried`, which the coordinator reads as every carried record not delivered.
 *
 * Shared by `ClusterService` and the mesh harness's client, so the in-process mesh applies carried
 * records in the order the wire does.
 */
export async function applyCarriedRecords(carried: unknown, ingress: CarriedRecordIngress): Promise<CarriedOutcome[] | undefined> {
	if (carried === undefined) return undefined;
	if (!Array.isArray(carried) || carried.length > MaxCarriedRecords) {
		ingress.log('carried:ignored shape=%s length=%s max=%d',
			Array.isArray(carried) ? 'array' : typeof carried, Array.isArray(carried) ? carried.length : '-', MaxCarriedRecords);
		return undefined;
	}
	const outcomes: CarriedOutcome[] = [];
	for (const record of carried as unknown[]) {
		outcomes.push(await applyCarriedRecord(record, ingress));
	}
	return outcomes;
}

async function applyCarriedRecord(record: unknown, ingress: CarriedRecordIngress): Promise<CarriedOutcome> {
	if (!isRecordShaped(record)) {
		ingress.log('carried:malformed');
		return { messageHash: '', delivered: false, error: 'malformed carried record' };
	}
	const { messageHash } = record;
	try {
		ingress.learnPeerAddresses?.(record);
		if (await ingress.checkRedirect?.(record)) {
			ingress.log('carried:redirected messageHash=%s', messageHash);
			return { messageHash, delivered: false };
		}
		const answer = await ingress.cluster.update(record);
		const outcome = ingress.selfId === undefined ? undefined : answer.applyOutcomes?.[ingress.selfId];
		return { messageHash, delivered: true, ...(outcome === undefined ? {} : { outcome }) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		ingress.log('carried:error messageHash=%s error=%s', messageHash, error);
		return { messageHash, delivered: false, error };
	}
}

/** Enough of a record to report on; `update` validates the rest, as it does for any record. */
function isRecordShaped(value: unknown): value is ClusterRecord {
	return typeof value === 'object' && value !== null && typeof (value as { messageHash?: unknown }).messageHash === 'string';
}

/**
 * The outcome of each record a request carried, read off its answer's `carried` field: exactly one per
 * record sent, in the order sent. A record the answer does not account for is not delivered — the field
 * is absent (an older member, or a list the member ignored), malformed, or names the record nowhere. The
 * answer arrives off the wire, so beyond its shape nothing in it is trusted: `outcome` is unsigned
 * advisory data under the same rules as {@link ClusterRecord.applyOutcomes}.
 */
export function readCarriedOutcomes(sent: readonly ClusterRecord[], answered: unknown): CarriedOutcome[] {
	const byHash = new Map<string, CarriedOutcome>();
	if (Array.isArray(answered)) {
		for (const entry of answered as unknown[]) {
			const outcome = wellFormedOutcome(entry);
			if (outcome !== undefined && !byHash.has(outcome.messageHash)) byHash.set(outcome.messageHash, outcome);
		}
	}
	return sent.map(record => byHash.get(record.messageHash) ?? { messageHash: record.messageHash, delivered: false });
}

function wellFormedOutcome(entry: unknown): CarriedOutcome | undefined {
	if (typeof entry !== 'object' || entry === null) return undefined;
	const { messageHash, delivered, outcome, error } = entry as Record<string, unknown>;
	if (typeof messageHash !== 'string') return undefined;
	return {
		messageHash,
		delivered: delivered === true,
		...(typeof outcome === 'object' && outcome !== null ? { outcome: outcome as MemberApplyOutcome } : {}),
		...(typeof error === 'string' ? { error } : {})
	};
}
