import type { ActionId, BlockId, ClusterRecord, IBlock, RepoMessage, Signature, CommitRequest } from "@optimystic/db-core";
import {
	canonicalBlockHash, clusterVoteSigningPayload, clusterVoteVerificationPayload,
	computeClusterCommitHash, computeClusterMessageHash, computeClusterPromiseHash,
	membershipDigestFromIds
} from "@optimystic/db-core";
import type { PrivateKey } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";

/**
 * A durable, self-contained proof that a cluster cohort agreed on a commit — everything an offline
 * verifier needs to re-derive the consensus hashes and check every vote signature, with NO access to
 * the live cluster. Unlike a `CommitCert` (whose `signedPayload` is an opaque hash preimage, retained
 * only ~60s in memory for reactivity), this artifact carries the commit `RepoMessage` itself, so a
 * receiver can check the claim "block B at revision R holds these bytes" against it.
 *
 * **No public keys are carried.** Every signer's Ed25519 key is recovered from its peer id — the id
 * IS the multihash of the key (the mechanism `peerIdBindsPublicKey` relies on), so carrying keys
 * would add bytes and a second thing to disagree with the id.
 *
 * **Measured size**: 4578 bytes serialized for a 10-peer cohort signing a two-block fully-signed
 * commit (`JSON.stringify(proof).length`, pinned by the "size" test in `test/commit-proof.spec.ts`).
 * It rides inside sync responses bounded by `MAX_CONTROL_MESSAGE_BYTES` (1 MiB), which already carry
 * whole blocks, so proof size is a rounding error there.
 */
export type BlockCommitProof = {
	v: 1;
	messageHash: string;
	/** The commit RepoMessage exactly as hashed - carries the commit op incl. blockDigests. */
	message: RepoMessage;
	/** Promise-round votes, verbatim: the commitHash preimage includes canonicalJson(promises),
	 *  and the approve promises are the votes that actually carry "I checked this". */
	promises: Record<string, Signature>;
	/** Commit-round votes. */
	commits: Record<string, Signature>;
	/** Always 2. A v1 / unversioned record binds no peer set and is never certifiable. */
	membershipVersion: 2;
	membershipDigest: string;
	/** The record's full sorted peer-id list - the threshold denominator, bound by membershipDigest. */
	peerIds: string[];
};

/** The claim a proof is checked against: this block, at this revision, under this committing action. */
export type ProofClaim = { blockId: BlockId; rev: number; actionId: ActionId };

export type ProofThresholds = {
	/** Gates the promise-round approvals: `approves >= ceil(superMajorityThreshold * peerIds.length)`. */
	superMajorityThreshold: number;
	/**
	 * Gates the commit-round approvals: `approves > peerIds.length * simpleMajorityThreshold`. Pass
	 * **0.5** to mirror what members actually enforce — `ClusterMember.hasMajority` hardcodes
	 * `count > total / 2` (cluster-repo.ts), NOT the config's 0.51 default.
	 */
	simpleMajorityThreshold: number;
};

export type ProofFailure =
	| 'legacy-record' | 'membership-mismatch' | 'message-hash-mismatch'
	| 'unknown-signer' | 'duplicate-signer' | 'non-ed25519-signer' | 'malformed-signature'
	| 'promise-threshold' | 'commit-threshold'
	| 'claim-not-in-message' | 'no-digest-declared' | 'digest-mismatch'
	/** Structurally invalid input (wrong types, missing fields, throwing shapes). Not in the original
	 *  spec enum — added deliberately so "pure and total on hostile input" has an honest catch-all
	 *  instead of mislabeling garbage as one of the semantic failures. */
	| 'malformed-proof';

export type ProofVerdict =
	| { ok: true; declaredDigest?: string }
	| { ok: false; reason: ProofFailure };

/**
 * Project a consensus-committed {@link ClusterRecord} into a {@link BlockCommitProof}. A cheap
 * projection — no hashing, no signature work; the record's maps are carried by reference (the
 * storage layer JSON-snapshots on save). Returns `undefined` for a v1 / unversioned record: its
 * hashes bind no peer set, so its signer list is unbound and it can never be certified (the caller
 * logs the skip).
 */
export function buildBlockCommitProof(record: ClusterRecord): BlockCommitProof | undefined {
	if (record.membershipVersion !== 2 || typeof record.membershipDigest !== 'string') {
		return undefined;
	}
	return {
		v: 1,
		messageHash: record.messageHash,
		message: record.message,
		promises: record.promises,
		commits: record.commits,
		membershipVersion: 2,
		membershipDigest: record.membershipDigest,
		peerIds: Object.keys(record.peers).sort()
	};
}

/**
 * Mint a fully-signed one-peer {@link BlockCommitProof} — the producing sibling of
 * {@link verifyBlockCommitProofClaim}, kept in this file so the hash recipe the two must agree on
 * lives in one place. Used by the solo-cohort commit path (`CoordinatorRepo.commit`'s
 * `peerCount <= 1` short-circuit), where consensus never runs and there is no {@link ClusterRecord}
 * to project: the lone member IS the whole cohort, so it signs both rounds itself over a one-peer
 * membership. The artifact stays honest — "one peer, which was the whole cohort at the time,
 * committed these bytes at this revision" — and verifies offline from the peer id alone, exactly
 * like a consensus-produced proof: `ceil(0.75 × 1) = 1` approve satisfies the promise round and
 * `1 > 1 × 0.5` the commit round under the production thresholds.
 *
 * The promise round is signed FIRST: the commit hash's preimage includes the promises map
 * (`computeClusterCommitHash`), so the order is load-bearing, not stylistic.
 */
export async function mintSoloCommitProof(
	peerId: string, privateKey: PrivateKey, message: RepoMessage
): Promise<BlockCommitProof> {
	const membershipDigest = await membershipDigestFromIds([peerId]);
	const messageHash = await computeClusterMessageHash(message, membershipDigest);
	const signApprove = async (hash: string): Promise<Signature> => ({
		type: 'approve',
		signature: uint8ArrayToString(await privateKey.sign(clusterVoteSigningPayload(hash, 'approve')), 'base64url')
	});
	const promiseHash = await computeClusterPromiseHash(messageHash, message, membershipDigest);
	const promises: Record<string, Signature> = { [peerId]: await signApprove(promiseHash) };
	const commitHash = await computeClusterCommitHash(messageHash, message, promises, membershipDigest);
	const commits: Record<string, Signature> = { [peerId]: await signApprove(commitHash) };
	return {
		v: 1, messageHash, message, promises, commits,
		membershipVersion: 2, membershipDigest, peerIds: [peerId]
	};
}

/**
 * Verify that `proof` certifies the CLAIM — `claim.blockId` at `claim.rev` under `claim.actionId` —
 * without needing the block bytes. Pure and total on hostile input: never throws; every failure is a
 * distinguishable {@link ProofFailure}.
 *
 * Mirrors the outcome discipline of `ClusterMember.verifySignature`: a malformed or unbound signer is
 * a verification failure that must NEVER be turned into a reputation penalty, because the identity
 * behind it was not proven. Callers deciding attributability must key off the reason values, and
 * treat `unknown-signer` / `non-ed25519-signer` / `malformed-signature` / `malformed-proof` as
 * non-attributable.
 *
 * **Why both thresholds.** The commit-round vote is cast blind — a member signs the commit whenever
 * the approve-promises reach super-majority, regardless of its own promise vote. The promise-round
 * approvals are the votes that carry "I validated this message, including its content digest".
 * Requiring only the commit approvals would count signatures that attest to nothing; requiring only
 * the promises would accept a record the cohort never actually committed. Require both.
 *
 * The claim step (a `{ commit }` op whose `blockIds`/`actionId`/`rev` all match) is what stops
 * replay: a genuine proof for rev 5 presented for rev 9, or for a different block id, dies there.
 *
 * ## What a passing verdict does NOT prove — two caller obligations
 *
 * 1. **The signers are not bound to the block.** A verdict says "the cohort in `proof.peerIds`
 *    agreed", never "that is the cohort responsible for `claim.blockId`". Any attacker who controls
 *    N keys can stand up their own N-peer cohort, sign a commit for any block id at any revision,
 *    and produce a proof that verifies here. Nothing offline can close this: a block's cohort is
 *    chosen by live placement and rotates over history, so `peerIds` cannot be checked against a
 *    fixed expected set. A caller accepting proofs from untrusted peers MUST corroborate the cohort
 *    separately (overlap with the block's currently-derived cohort, or a membership anchor — see
 *    `feat-cluster-membership-threshold-cert-anchoring`). Both repair paths do this via
 *    `cluster/certified-claims.ts`, whose layer 2 logs the overlap and surfaces the unanchored
 *    residual; the anchor itself is still open.
 * 2. **Cost is attacker-chosen.** This performs one Ed25519 verify per approve vote and hashes the
 *    whole message; nothing here caps `peerIds`, the vote maps, or the message. A caller reading a
 *    proof off the wire must bound its size and cohort count BEFORE calling.
 */
export async function verifyBlockCommitProofClaim(
	proof: BlockCommitProof, claim: ProofClaim, thresholds: ProofThresholds
): Promise<ProofVerdict> {
	try {
		if (proof === null || typeof proof !== 'object') {
			return { ok: false, reason: 'malformed-proof' };
		}
		// A version this verifier does not implement is never half-verified. `membershipVersion !== 2`
		// means the signer list is unbound (v1 / unversioned history) — never certifiable.
		if (proof.v !== 1 || proof.membershipVersion !== 2) {
			return { ok: false, reason: 'legacy-record' };
		}
		if (typeof proof.messageHash !== 'string'
			|| typeof proof.membershipDigest !== 'string'
			|| proof.message === null || typeof proof.message !== 'object'
			|| !Array.isArray(proof.message.operations)
			|| !isVoteMap(proof.promises) || !isVoteMap(proof.commits)
			|| !Array.isArray(proof.peerIds) || !proof.peerIds.every(id => typeof id === 'string')) {
			return { ok: false, reason: 'malformed-proof' };
		}

		// A duplicated id in the denominator list would let one signer count twice against the
		// threshold. (A JSON-parsed vote map cannot carry duplicate keys, so the array is the one
		// reachable site for duplication.)
		const peerSet = new Set(proof.peerIds);
		if (peerSet.size !== proof.peerIds.length) {
			return { ok: false, reason: 'duplicate-signer' };
		}

		// The peer list must be the one every signature covers: recompute the membership digest from
		// it, then the message hash over (message + digest). Tampering with peerIds dies here;
		// tampering with the message dies on the next check.
		if (await membershipDigestFromIds(proof.peerIds) !== proof.membershipDigest) {
			return { ok: false, reason: 'membership-mismatch' };
		}
		if (await computeClusterMessageHash(proof.message, proof.membershipDigest) !== proof.messageHash) {
			return { ok: false, reason: 'message-hash-mismatch' };
		}

		const promiseHash = await computeClusterPromiseHash(proof.messageHash, proof.message, proof.membershipDigest);
		const commitHash = await computeClusterCommitHash(proof.messageHash, proof.message, proof.promises, proof.membershipDigest);

		const promiseRound = await countApprovals(proof.promises, promiseHash, peerSet);
		if ('reason' in promiseRound) {
			return { ok: false, reason: promiseRound.reason };
		}
		const commitRound = await countApprovals(proof.commits, commitHash, peerSet);
		if ('reason' in commitRound) {
			return { ok: false, reason: commitRound.reason };
		}

		// Threshold gates. When a threshold fails AND that round skipped a signer outside `peerIds`,
		// report `unknown-signer` rather than the bare threshold reason — the skipped signature is the
		// record of why the count came up short.
		const superMajority = Math.ceil(thresholds.superMajorityThreshold * proof.peerIds.length);
		if (promiseRound.approves < superMajority) {
			return { ok: false, reason: promiseRound.sawUnknownSigner ? 'unknown-signer' : 'promise-threshold' };
		}
		if (!(commitRound.approves > proof.peerIds.length * thresholds.simpleMajorityThreshold)) {
			return { ok: false, reason: commitRound.sawUnknownSigner ? 'unknown-signer' : 'commit-threshold' };
		}

		const op = findClaimedCommitOp(proof.message, claim);
		if (!op) {
			return { ok: false, reason: 'claim-not-in-message' };
		}
		return { ok: true, declaredDigest: op.blockDigests?.[claim.blockId]?.digest };
	} catch {
		return { ok: false, reason: 'malformed-proof' };
	}
}

/**
 * Claim verification ({@link verifyBlockCommitProofClaim}) PLUS: the digest the commit op declared
 * for `claim.blockId` must be present (`no-digest-declared`) and equal `canonicalBlockHash(block)`
 * (`digest-mismatch`). Total like the claim half; a block shape that `canonicalBlockHash` cannot
 * digest reads as `digest-mismatch` — the received bytes provably are not the declared content.
 */
export async function verifyBlockCommitProofContent(
	proof: BlockCommitProof, claim: ProofClaim, block: IBlock, thresholds: ProofThresholds
): Promise<ProofVerdict> {
	const verdict = await verifyBlockCommitProofClaim(proof, claim, thresholds);
	if (!verdict.ok) {
		return verdict;
	}
	if (typeof verdict.declaredDigest !== 'string') {
		return { ok: false, reason: 'no-digest-declared' };
	}
	try {
		if (await canonicalBlockHash(block) !== verdict.declaredDigest) {
			return { ok: false, reason: 'digest-mismatch' };
		}
	} catch {
		return { ok: false, reason: 'digest-mismatch' };
	}
	return verdict;
}

/**
 * The digest `proof.message`'s commit operation declares for the claimed block, or `undefined`
 * when the claim resolves no commit op or the op carries no digest for that block id. This is the
 * SAME op resolution {@link verifyBlockCommitProofClaim}'s claim step uses, so the digest the
 * storage layer's retention rule compares against (persist only when the local materialization
 * matches) can never drift from the digest a later verifier extracts.
 */
export function proofDeclaredDigest(proof: BlockCommitProof, claim: ProofClaim): string | undefined {
	return findClaimedCommitOp(proof.message, claim)?.blockDigests?.[claim.blockId]?.digest;
}

/**
 * Does `proof`'s message actually carry a commit operation for this exact
 * `(blockId, rev, actionId)`? The claim step of {@link verifyBlockCommitProofClaim} with NO
 * cryptography — the same {@link findClaimedCommitOp} resolution, so the cheap structural check and
 * the full verification can never disagree about which op a claim names.
 *
 * This is the pairing guard a SERVER uses: a proof is looked up by revision, so attaching one whose
 * message names a different revision (or block, or action) would be publishing a mis-paired
 * artifact. It says nothing about signatures or thresholds — a receiver must still verify. Total on
 * hostile input like its verifying sibling: never throws, `false` on any malformed shape.
 */
export function proofClaimsCommit(proof: BlockCommitProof, claim: ProofClaim): boolean {
	try {
		return findClaimedCommitOp(proof.message, claim) !== undefined;
	} catch {
		return false;
	}
}

/** A plain-object (non-array) map of votes — the shape `promises` / `commits` must have. */
function isVoteMap(value: unknown): value is Record<string, Signature> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Count distinct `approve` votes over `hash` from signers inside `peerSet`, verifying each signature
 * against the Ed25519 key its peer id names. Per-entry rules (the spec's step 5/6):
 *
 * - a non-`approve` vote is ignored silently (rejects/conflicts are part of the signed record but
 *   never count toward approval);
 * - a signer outside `peerSet` is skipped and noted (`sawUnknownSigner`) — the caller downgrades a
 *   failed threshold to `unknown-signer`;
 * - a signer inside `peerSet` whose id is not a valid Ed25519 peer id → immediate
 *   `non-ed25519-signer` (its key cannot be recovered, so the proof as a whole is unverifiable);
 * - a signature that is not a string, fails base64url decode, or fails cryptographic verify →
 *   immediate `malformed-signature`;
 * - each signer id is counted at most once.
 */
async function countApprovals(
	votes: Record<string, Signature>,
	hash: string,
	peerSet: ReadonlySet<string>
): Promise<{ approves: number; sawUnknownSigner: boolean } | { reason: ProofFailure }> {
	let approves = 0;
	let sawUnknownSigner = false;
	const counted = new Set<string>();
	for (const [signerId, vote] of Object.entries(votes)) {
		if (vote === null || typeof vote !== 'object' || vote.type !== 'approve') {
			continue;
		}
		if (!peerSet.has(signerId)) {
			sawUnknownSigner = true;
			continue;
		}
		if (counted.has(signerId)) {
			continue;
		}
		let rawKey: Uint8Array;
		try {
			const peerId = peerIdFromString(signerId);
			if (peerId.type !== 'Ed25519' || peerId.publicKey === undefined) {
				return { reason: 'non-ed25519-signer' };
			}
			rawKey = peerId.publicKey.raw;
		} catch {
			// An id that does not even parse as a peer id certainly names no Ed25519 key.
			return { reason: 'non-ed25519-signer' };
		}
		try {
			if (typeof vote.signature !== 'string') {
				return { reason: 'malformed-signature' };
			}
			const sigBytes = uint8ArrayFromString(vote.signature, 'base64url');
			const payload = clusterVoteVerificationPayload(hash, vote);
			if (!await publicKeyFromRaw(rawKey).verify(payload, sigBytes)) {
				return { reason: 'malformed-signature' };
			}
		} catch {
			return { reason: 'malformed-signature' };
		}
		counted.add(signerId);
		approves++;
	}
	return { approves, sawUnknownSigner };
}

/**
 * The `{ commit }` operation the claim points at: `blockIds` contains the claimed block and the
 * op's `actionId` / `rev` equal the claim's. Absent → `claim-not-in-message` (the replay stop).
 */
function findClaimedCommitOp(message: RepoMessage, claim: ProofClaim): CommitRequest | undefined {
	for (const operation of message.operations) {
		if (operation === null || typeof operation !== 'object' || !('commit' in operation)) {
			continue;
		}
		const commit = operation.commit;
		if (commit !== null && typeof commit === 'object'
			&& Array.isArray(commit.blockIds)
			&& commit.blockIds.includes(claim.blockId)
			&& commit.actionId === claim.actionId
			&& commit.rev === claim.rev) {
			return commit;
		}
	}
	return undefined;
}
