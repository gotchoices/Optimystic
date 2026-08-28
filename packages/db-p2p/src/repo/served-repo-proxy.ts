import type { IRepo } from "@optimystic/db-core";
import type { ArchiveServingRepo, ProofRetainingRepo } from "../storage/block-archive.js";

/**
 * The repo object a node hands its inbound protocol services (`repoService`, `syncService`) — the
 * seam between "a request arrived from the network" and "which local repo answers it".
 *
 * Extracted from `createLibp2pNodeBase` rather than left as an inline literal there, for the reason
 * `resolveClusterPolicy` was: an object built inside the composition root can only be exercised by
 * booting a whole libp2p node, so nothing asserts on it, and a member silently missing from it is
 * invisible. That is not hypothetical — the proxy served every repair archive without its commit
 * proof for exactly as long as it was inline, because `getBlockProof` was never forwarded and every
 * test read a real `StorageRepo` directly.
 *
 * Two delegation rules, and the difference between them is the whole point of the type:
 *
 *  - The four `IRepo` members go to the COORDINATED repo once one exists, falling back to local
 *    storage before assembly finishes — a client request must get cluster-coordinated semantics.
 *  - {@link ArchiveServingRepo.getBlockProof} goes UNCONDITIONALLY to local storage. A peer
 *    answering a repair fetch reports the proof IT retained, the same reason the read behind it
 *    passes `skipClusterFetch`; one that re-asked its cohort would launder another peer's evidence
 *    as its own.
 *
 * @param local this node's own store. Typed {@link ProofRetainingRepo} — the accessor is REQUIRED
 *   here even though it is optional on `ArchiveServingRepo`, so a composition root cannot hand over
 *   a store that silently serves no proofs.
 * @param coordinated resolves the cluster-coordinated repo, or `undefined` while the node is still
 *   assembling. Read per call, never captured: the coordinated repo is constructed after this proxy.
 */
export function createServedRepoProxy(
	local: ProofRetainingRepo,
	coordinated: () => IRepo | undefined
): ArchiveServingRepo {
	const target = (): IRepo => coordinated() ?? local;
	return {
		async get(blockGets, options) {
			return await target().get(blockGets, options);
		},
		async pend(request, options) {
			return await target().pend(request, options);
		},
		async cancel(trxRef, options) {
			return await target().cancel(trxRef, options);
		},
		async commit(request, options) {
			// `target()` is already the plain `IRepo` seam: `StorageRepo.commit`'s extra optional
			// proof parameter (`ICommitProofPersister`) would otherwise make the union's synthesized
			// call signature reject a plain repo-level request. No proof flows through this member.
			return await target().commit(request, options);
		},
		async getBlockProof(blockId, rev) {
			return await local.getBlockProof(blockId, rev);
		}
	};
}
