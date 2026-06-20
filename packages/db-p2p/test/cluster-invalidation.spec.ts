import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type {
	IRepo, ClusterRecord, RepoMessage, Signature, ClusterPeers,
	BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	InvalidateRequest, DisputeResolutionProof, CommitCert, ActionId,
} from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import { clusterMember, type ClusterMember } from '../src/cluster/cluster-repo.js';
import { invalidationActionId } from '../src/cluster/commit-cert.js';
import { buildDisputeResolutionProof, computeTargetHash } from '../src/dispute/invalidation.js';
import type { ArbitrationVote, DisputeResolution } from '../src/dispute/types.js';

// ─── Crypto / record helpers (mirrors cluster-repo.spec.ts) ───

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

type KeyPair = { peerId: PeerId; privateKey: PrivateKey };

async function makeKeyPair(): Promise<KeyPair> {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
}

async function computeMessageHash(message: RepoMessage): Promise<string> {
	const hashBytes = await sha256.digest(new TextEncoder().encode(canonicalJson(message)));
	return base58btc.encode(hashBytes.digest);
}

async function computePromiseHash(record: ClusterRecord): Promise<string> {
	const hashBytes = await sha256.digest(new TextEncoder().encode(record.messageHash + canonicalJson(record.message)));
	return uint8ArrayToString(hashBytes.digest, 'base64url');
}

async function computeCommitHash(record: ClusterRecord): Promise<string> {
	const hashBytes = await sha256.digest(new TextEncoder().encode(record.messageHash + canonicalJson(record.message) + canonicalJson(record.promises)));
	return uint8ArrayToString(hashBytes.digest, 'base64url');
}

async function signVote(privateKey: PrivateKey, hash: string, type: 'approve'): Promise<string> {
	const sigBytes = await privateKey.sign(new TextEncoder().encode(`${hash}:${type}`));
	return uint8ArrayToString(sigBytes, 'base64url');
}

function makeClusterPeers(keyPairs: KeyPair[]): ClusterPeers {
	const peers: ClusterPeers = {};
	for (const { peerId } of keyPairs) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: uint8ArrayToString(peerId.publicKey!.raw, 'base64url'),
		};
	}
	return peers;
}

/** Build a single-peer record that is already at consensus for `operations`. */
async function makeConsensusRecord(self: KeyPair, operations: RepoMessage['operations'], expiration: number): Promise<ClusterRecord> {
	const message: RepoMessage = { operations, expiration };
	const messageHash = await computeMessageHash(message);
	const peers = makeClusterPeers([self]);
	const base: ClusterRecord = { messageHash, message, peers, promises: {}, commits: {} };
	const promiseSig: Signature = { type: 'approve', signature: await signVote(self.privateKey, await computePromiseHash(base), 'approve') };
	const withPromise: ClusterRecord = { ...base, promises: { [self.peerId.toString()]: promiseSig } };
	const commitSig: Signature = { type: 'approve', signature: await signVote(self.privateKey, await computeCommitHash(withPromise), 'approve') };
	return { ...withPromise, commits: { [self.peerId.toString()]: commitSig } };
}

// ─── Dispute proof helpers ───

// The invalidation request these tests drive through consensus always reverts action 'a-inv' / block
// 'B' under messageHash 'msg-hash'; the v2 votes are bound to exactly that target so the cluster's
// apply-path verification (against the request's own target) succeeds.
const PROOF_MSG = 'msg-hash';
const PROOF_TARGET = { invalidatedActionId: 'a-inv', blockIds: ['B'] };

async function makeVote(arb: KeyPair, disputeId: string, vote: ArbitrationVote['vote'], targetHash: string): Promise<ArbitrationVote> {
	const computedHash = 'h';
	const sig = await arb.privateKey.sign(new TextEncoder().encode(`v2:${disputeId}:${vote}:${computedHash}:${targetHash}`));
	return {
		version: 'v2', disputeId, arbitratorPeerId: arb.peerId.toString(), vote,
		evidence: { computedHash, engineId: 'e', schemaHash: 's', blockStateHashes: {} },
		signature: uint8ArrayToString(sig, 'base64url'),
	};
}

async function challengerWinsProof(disputeId: string): Promise<DisputeResolutionProof> {
	const arbs = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair()]);
	const targetHash = await computeTargetHash(PROOF_MSG, PROOF_TARGET);
	const votes = await Promise.all(arbs.map(a => makeVote(a, disputeId, 'agree-with-challenger', targetHash)));
	const resolution: DisputeResolution = { disputeId, outcome: 'challenger-wins', votes, affectedPeers: [], timestamp: 1 };
	return buildDisputeResolutionProof(resolution, PROOF_MSG);
}

async function majorityWinsProof(disputeId: string): Promise<DisputeResolutionProof> {
	const arbs = await Promise.all([makeKeyPair(), makeKeyPair()]);
	const targetHash = await computeTargetHash(PROOF_MSG, PROOF_TARGET);
	const votes = await Promise.all(arbs.map(a => makeVote(a, disputeId, 'agree-with-majority', targetHash)));
	const resolution: DisputeResolution = { disputeId, outcome: 'majority-wins', votes, affectedPeers: [], timestamp: 1 };
	return buildDisputeResolutionProof(resolution, PROOF_MSG);
}

function invalidateOp(resolution: DisputeResolutionProof, actionId = 'a-inv'): RepoMessage['operations'] {
	const request: InvalidateRequest = {
		invalidatedActionId: actionId, invalidatedRev: 2, blockIds: ['B'], collectionId: 'C', resolution,
	};
	return [{ invalidate: request }];
}

class MockRepo implements IRepo {
	async get(_b: BlockGets): Promise<GetBlockResults> { return {}; }
	async pend(_r: PendRequest): Promise<PendResult> { return { success: true, blockIds: [], pending: [] }; }
	async commit(_r: CommitRequest): Promise<CommitResult> { return { success: true }; }
	async cancel(_a: ActionBlocks): Promise<void> { /* no-op */ }
}

class MockNetwork implements IPeerNetwork {
	async connect(): Promise<any> { return {}; }
}

describe('ClusterMember invalidation apply path', () => {
	let self: KeyPair;
	let member: ClusterMember | undefined;

	beforeEach(async () => {
		self = await makeKeyPair();
	});

	afterEach(() => {
		member?.dispose();
		member = undefined;
	});

	it('applies a consensus-ordered invalidation through the injected sink', async () => {
		const received: InvalidateRequest[] = [];
		member = clusterMember({
			storageRepo: new MockRepo(), peerNetwork: new MockNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			onInvalidate: async (req) => { received.push(req); },
		});

		const proof = await challengerWinsProof('d1');
		const record = await makeConsensusRecord(self, invalidateOp(proof), Date.now() + 30000);
		await member.update(record);

		expect(received).to.have.lengthOf(1);
		expect(received[0]!.invalidatedActionId).to.equal('a-inv');
		expect(received[0]!.resolution.disputeId).to.equal('d1');
	});

	it('captures the invalidation commit cert (for reactivity reuse) keyed by invalidationActionId', async () => {
		const certs = new Map<ActionId, CommitCert>();
		member = clusterMember({
			storageRepo: new MockRepo(), peerNetwork: new MockNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			onInvalidate: async () => { /* applied */ },
			onCommitCertificate: (actionId, cert) => { certs.set(actionId, cert); },
		});

		const proof = await challengerWinsProof('d1');
		const record = await makeConsensusRecord(self, invalidateOp(proof, 'a-inv'), Date.now() + 30000);
		await member.update(record);

		// The cert is captured under the deterministic invalidation action id (NOT the original action id),
		// so the reactivity bridge's extractor resolves it when the invalidation's change event is emitted.
		const key = invalidationActionId('a-inv', 'd1');
		const cert = certs.get(key);
		expect(cert, 'invalidation commit cert was captured').to.not.be.undefined;
		expect(cert!.signers).to.include(self.peerId.toString());
		expect(cert!.thresholdSig.length).to.be.greaterThan(0);
		expect(cert!.signedPayload.length).to.be.greaterThan(0);
		// It is NOT captured under the original (reversed) action id — that id has its own commit cert.
		expect(certs.get('a-inv' as ActionId)).to.be.undefined;
	});

	it('does not capture an invalidation cert when the certificate is rejected', async () => {
		const certs = new Map<ActionId, CommitCert>();
		member = clusterMember({
			storageRepo: new MockRepo(), peerNetwork: new MockNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			onInvalidate: async () => { /* applied */ },
			onCommitCertificate: (actionId, cert) => { certs.set(actionId, cert); },
		});

		const proof = await majorityWinsProof('d1'); // not a valid invalidation certificate
		const record = await makeConsensusRecord(self, invalidateOp(proof, 'a-inv'), Date.now() + 30000);
		await member.update(record);

		expect(certs.size).to.equal(0);
	});

	it('rejects a sub-threshold/forged certificate without invoking the sink', async () => {
		const received: InvalidateRequest[] = [];
		member = clusterMember({
			storageRepo: new MockRepo(), peerNetwork: new MockNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			onInvalidate: async (req) => { received.push(req); },
		});

		const proof = await majorityWinsProof('d1'); // not a valid invalidation certificate
		const record = await makeConsensusRecord(self, invalidateOp(proof), Date.now() + 30000);
		await member.update(record);

		expect(received).to.have.lengthOf(0);
	});

	it('rejects a genuine proof replayed against a different target without invoking the sink (#2)', async () => {
		const received: InvalidateRequest[] = [];
		member = clusterMember({
			storageRepo: new MockRepo(), peerNetwork: new MockNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			onInvalidate: async (req) => { received.push(req); },
		});

		// A genuine challenger-wins proof bound to action 'a-inv' / block 'B' …
		const proof = await challengerWinsProof('d1');
		// … carried in a request that points at a DIFFERENT (innocent) action 'innocent'. The cluster
		// verifies the proof against the request's own target, which no longer matches the votes' binding.
		const record = await makeConsensusRecord(self, invalidateOp(proof, 'innocent'), Date.now() + 30000);
		await member.update(record);

		expect(received).to.have.lengthOf(0);
	});

	it('dedups the same invalidation arriving under a different message hash', async () => {
		const received: InvalidateRequest[] = [];
		member = clusterMember({
			storageRepo: new MockRepo(), peerNetwork: new MockNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			onInvalidate: async (req) => { received.push(req); },
		});

		const proof = await challengerWinsProof('d1');
		// Two records carrying the same (invalidatedActionId, disputeId) but distinct messageHashes
		// (different expiration) — the second must be deduped by the (actionId, disputeId) marker.
		const r1 = await makeConsensusRecord(self, invalidateOp(proof), Date.now() + 30000);
		const r2 = await makeConsensusRecord(self, invalidateOp(proof), Date.now() + 60000);
		expect(r1.messageHash).to.not.equal(r2.messageHash);

		await member.update(r1);
		await member.update(r2);

		expect(received).to.have.lengthOf(1);
	});

	it('tolerates a missing sink without throwing', async () => {
		member = clusterMember({
			storageRepo: new MockRepo(), peerNetwork: new MockNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			// no onInvalidate wired
		});

		const proof = await challengerWinsProof('d1');
		const record = await makeConsensusRecord(self, invalidateOp(proof), Date.now() + 30000);
		// Should not throw — a node without an invalidation originator simply logs and moves on.
		await member.update(record);
	});

	it('tolerates a throwing sink and rolls back dedup so a retry can re-apply', async () => {
		let calls = 0;
		member = clusterMember({
			storageRepo: new MockRepo(), peerNetwork: new MockNetwork(),
			peerId: self.peerId, privateKey: self.privateKey,
			onInvalidate: async () => { calls++; if (calls === 1) throw new Error('storage fault'); },
		});

		const proof = await challengerWinsProof('d1');
		const r1 = await makeConsensusRecord(self, invalidateOp(proof), Date.now() + 30000);
		const r2 = await makeConsensusRecord(self, invalidateOp(proof), Date.now() + 60000);

		await member.update(r1); // sink throws → tolerated, dedup marker rolled back
		await member.update(r2); // retry under a new messageHash → applies

		expect(calls).to.equal(2);
	});
});
