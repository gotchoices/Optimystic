import type { CommitRequest, CommitResult } from '@optimystic/db-core';
import type { MeshNode } from '../../src/testing/mesh-harness.js';

/**
 * What an interception does with one commit reaching a node's storage: answer it itself, or hand a
 * request on through `through`, the real apply for whichever seam the commit arrived on. The request
 * handed on need not be the one that arrived — a fault that drops part of a commit forwards a
 * narrowed one.
 */
export type CommitIntercept = (
	request: CommitRequest, through: (request: CommitRequest) => Promise<CommitResult>
) => Promise<CommitResult>;

/**
 * Put `intercept` in front of EVERY commit that reaches `node`'s storage, for a fault a spec wants
 * one member of a mesh to suffer.
 *
 * TWO seams reach storage and both have to be covered: the public `StorageRepo.commit`, which is
 * what a coordinator's own solo and fallback applies call, and the write group a consensus record's
 * commits are applied inside (`StorageRepo.applyInOneGroup`), whose handle writes under each
 * request's latches WITHOUT going through `commit` — that is how the record's collections come to
 * share one flush. Patching `commit` alone leaves `ClusterMember` applying the commit for real, so
 * the spec quietly stops reproducing the fault it set up.
 */
export const interceptCommits = (node: MeshNode, intercept: CommitIntercept): void => {
	const storage = node.storageRepo;
	const commit = storage.commit.bind(storage);
	storage.commit = (request, options, apply) => intercept(request, forwarded => commit(forwarded, options, apply));
	const inOneGroup = storage.applyInOneGroup.bind(storage);
	storage.applyInOneGroup = (apply, body) => inOneGroup(apply, group => body({
		pend: group.pend,
		commit: (request, options, proof) => intercept(request, forwarded => group.commit(forwarded, options, proof))
	}));
};
