import type { CarriedOutcome, ClusterRecord } from "./structs.js";

export type ICluster = {
	update(record: ClusterRecord): Promise<ClusterRecord>;
	/**
	 * {@link update}, with already-decided records the member is still owed carried ahead of `record`.
	 * The member applies them first, in order, then handles `record`; `carried` in the answer reports
	 * each one, in the order sent. A carried record the member could not take — or every one, when the
	 * member predates carried records — comes back not delivered, and stays owed. Throws exactly when
	 * {@link update} would; the caller then treats every carried record as not delivered (a member
	 * that did apply one dedups its re-delivery).
	 *
	 * Optional: a member reached in process has nothing owed to it, and a client without it is sent
	 * owed records only by the coordinator's retry.
	 */
	updateCarrying?(record: ClusterRecord, carried: readonly ClusterRecord[]): Promise<{ answer: ClusterRecord; carried: CarriedOutcome[] }>;
}
