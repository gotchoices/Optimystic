import {
	buildBlockCommitProof, type BlockCommitProof, type ProofThresholds
} from '../../src/cluster/commit-proof.js';
import {
	clusterVoteSigningPayload, computeClusterCommitHash, computeClusterMessageHash,
	computeClusterPromiseHash, membershipDigest
} from '@optimystic/db-core';
import type { ClusterPeers, ClusterRecord, CommitRequest, RepoMessage, Signature } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

/**
 * Build fully-signed v2 cluster records — and the {@link BlockCommitProof}s projected from them —
 * with the SAME hash and signing recipe the coordinator and members use.
 *
 * Shared rather than copied per spec: a proof is only meaningful if it verifies, and two specs each
 * hand-rolling the recipe is exactly how one of them ends up asserting against a proof no real
 * cohort would produce. `test/commit-proof.spec.ts` (the verifier's own suite) and
 * `test/block-archive-proof.spec.ts` (the serving wire) both build from here.
 *
 * Failure-injection builders stay in the spec that needs them — a proof deliberately signed wrong
 * is a property of one test, not a fixture.
 */

/** 0.75 mirrors DEFAULT_SUPER_MAJORITY_THRESHOLD; 0.5 mirrors ClusterMember.hasMajority (> total/2). */
export const PROOF_THRESHOLDS: ProofThresholds = { superMajorityThreshold: 0.75, simpleMajorityThreshold: 0.5 };

export interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

export const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

export const makeKeyPairs = (n: number): Promise<KeyPair[]> =>
	Promise.all(Array.from({ length: n }, makeKeyPair));

export const makeClusterPeers = (keyPairs: KeyPair[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const { peerId } of keyPairs) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: uint8ArrayToString(peerId.publicKey!.raw, 'base64url')
		};
	}
	return peers;
};

export const signVote = async (
	privateKey: PrivateKey, hash: string, type: 'approve' | 'reject' = 'approve', reason?: string
): Promise<Signature> => {
	const signature = uint8ArrayToString(
		await privateKey.sign(clusterVoteSigningPayload(hash, type, reason)), 'base64url');
	return type === 'approve' ? { type, signature } : { type, signature, rejectReason: reason };
};

export const makeMessage = (commit: CommitRequest): RepoMessage => ({
	operations: [{ commit }],
	coordinatingBlockIds: [commit.blockIds[0] ?? commit.tailId],
	expiration: Date.now() + 30_000
});

/** Fully-signed v2 record: every key pair approves both rounds — the recipe validateRecord accepts. */
export const makeSignedRecord = async (keyPairs: KeyPair[], commit: CommitRequest): Promise<ClusterRecord> => {
	const peers = makeClusterPeers(keyPairs);
	const digest = await membershipDigest(peers);
	const message = makeMessage(commit);
	const messageHash = await computeClusterMessageHash(message, digest);
	const promiseHash = await computeClusterPromiseHash(messageHash, message, digest);
	const promises: Record<string, Signature> = {};
	for (const kp of keyPairs) {
		promises[kp.peerId.toString()] = await signVote(kp.privateKey, promiseHash);
	}
	const commitHash = await computeClusterCommitHash(messageHash, message, promises, digest);
	const commitVotes: Record<string, Signature> = {};
	for (const kp of keyPairs) {
		commitVotes[kp.peerId.toString()] = await signVote(kp.privateKey, commitHash);
	}
	return {
		messageHash, message, peers, promises, commits: commitVotes,
		membershipVersion: 2, membershipDigest: digest
	};
};

/** An `n`-peer cohort's fully-signed record plus the proof projected from it. */
export const makeSignedProof = async (
	n: number, commit: CommitRequest
): Promise<{ keyPairs: KeyPair[]; record: ClusterRecord; proof: BlockCommitProof }> => {
	const keyPairs = await makeKeyPairs(n);
	const record = await makeSignedRecord(keyPairs, commit);
	const proof = buildBlockCommitProof(record);
	if (!proof) {
		throw new Error('a fully-signed v2 record must project to a proof');
	}
	return { keyPairs, record, proof };
};
