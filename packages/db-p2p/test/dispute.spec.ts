import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import type { ClusterRecord, IPeerNetwork, InvalidateRequest } from '@optimystic/db-core';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { DisputeService } from '../src/dispute/dispute-service.js';
import { verifyInvalidationCertificate } from '../src/dispute/invalidation.js';
import { EngineHealthMonitor } from '../src/dispute/engine-health-monitor.js';
import type { ValidationEvidence, ArbitrationVote, DisputeChallenge, DisputeResolution } from '../src/dispute/types.js';
import { PeerReputationService } from '../src/reputation/peer-reputation.js';
import { PenaltyReason } from '../src/reputation/types.js';
import { sampleArbitrators, coordinatePreimage, type NearestResolver } from '../src/dispute/arbitrator-selection.js';
import { sortPeersByDistance, type KnownPeer } from '../src/routing/responsibility.js';
import { hashKey } from 'p2p-fret';

// ─── Canonical JSON for deterministic hashing ───

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

// Helpers

async function makeKeyPair() {
	const privateKey = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(privateKey);
	return { peerId, privateKey };
}

async function computeMessageHash(message: any): Promise<string> {
	const msgBytes = new TextEncoder().encode(canonicalJson(message));
	const hashBytes = await sha256.digest(msgBytes);
	return base58btc.encode(hashBytes.digest);
}

function makeRepoMessage(blockId: string = 'block-1') {
	return {
		operations: [{
			pend: {
				actionId: 'action-1',
				transforms: { [blockId]: { inserts: { 'doc-1': { value: 1 } } } },
			}
		}],
		coordinatingBlockIds: [blockId],
		expiration: Date.now() + 60000,
	};
}

async function makeClusterRecord(
	peers: { peerId: PeerId; privateKey: PrivateKey }[],
	blockId: string = 'block-1',
	options?: { rejectPeers?: Set<string> }
): Promise<ClusterRecord> {
	const message = makeRepoMessage(blockId);
	const messageHash = await computeMessageHash(message);

	const clusterPeers: ClusterRecord['peers'] = {};
	for (const { peerId } of peers) {
		clusterPeers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: uint8ArrayToString(peerId.publicKey!.raw, 'base64url'),
		};
	}

	// Build promises - some approve, some reject
	const promiseHashInput = messageHash + canonicalJson(message);
	const promiseHashBytes = await sha256.digest(new TextEncoder().encode(promiseHashInput));
	const promiseHash = uint8ArrayToString(promiseHashBytes.digest, 'base64url');

	const promises: ClusterRecord['promises'] = {};
	for (const { peerId, privateKey } of peers) {
		const isRejector = options?.rejectPeers?.has(peerId.toString());
		const type = isRejector ? 'reject' : 'approve';
		const rejectReason = isRejector ? 'validation-mismatch' : undefined;
		const payload = promiseHash + ':' + type + (rejectReason ? ':' + rejectReason : '');
		const sigBytes = await privateKey.sign(new TextEncoder().encode(payload));
		promises[peerId.toString()] = {
			type,
			signature: uint8ArrayToString(sigBytes, 'base64url'),
			...(rejectReason ? { rejectReason } : {}),
		};
	}

	// Build commits (from approving peers only)
	const commitHashInput = messageHash + canonicalJson(message) + canonicalJson(promises);
	const commitHashBytes = await sha256.digest(new TextEncoder().encode(commitHashInput));
	const commitHash = uint8ArrayToString(commitHashBytes.digest, 'base64url');

	const commits: ClusterRecord['commits'] = {};
	for (const { peerId, privateKey } of peers) {
		if (options?.rejectPeers?.has(peerId.toString())) continue;
		const payload = commitHash + ':approve';
		const sigBytes = await privateKey.sign(new TextEncoder().encode(payload));
		commits[peerId.toString()] = {
			type: 'approve',
			signature: uint8ArrayToString(sigBytes, 'base64url'),
		};
	}

	return {
		messageHash,
		peers: clusterPeers,
		message: message as any,
		coordinatingBlockIds: [blockId],
		promises,
		commits,
	};
}

function makeEvidence(computedHash: string = 'hash-A'): ValidationEvidence {
	return {
		computedHash,
		engineId: 'test-engine',
		schemaHash: 'schema-abc',
		blockStateHashes: {
			'block-1': { revision: 1, contentHash: 'content-abc' },
		},
	};
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> {
		return {};
	}
}

// Mock DisputeClient that directly calls the target service
function createMockClientFactory(services: Map<string, DisputeService>) {
	return (peerId: PeerId) => ({
		async sendChallenge(challenge: DisputeChallenge, _timeoutMs?: number): Promise<ArbitrationVote> {
			const svc = services.get(peerId.toString());
			if (!svc) throw new Error(`No dispute service for ${peerId.toString()}`);
			return svc.handleChallenge(challenge);
		},
		async sendResolution(resolution: DisputeResolution): Promise<void> {
			const svc = services.get(peerId.toString());
			if (!svc) throw new Error(`No dispute service for ${peerId.toString()}`);
			svc.handleResolution(resolution);
		},
	});
}

// Tests

describe('EngineHealthMonitor', () => {
	it('should start healthy', () => {
		const monitor = new EngineHealthMonitor();
		expect(monitor.isUnhealthy()).to.be.false;
		expect(monitor.getState().disputesLost).to.equal(0);
	});

	it('should track dispute losses', () => {
		const monitor = new EngineHealthMonitor();
		monitor.recordDisputeLoss();
		expect(monitor.getState().disputesLost).to.equal(1);
		expect(monitor.isUnhealthy()).to.be.false;
	});

	it('should flag unhealthy when threshold exceeded', () => {
		const monitor = new EngineHealthMonitor({
			engineHealthDisputeThreshold: 3,
			engineHealthWindowMs: 60_000,
		});
		monitor.recordDisputeLoss();
		monitor.recordDisputeLoss();
		expect(monitor.isUnhealthy()).to.be.false;
		monitor.recordDisputeLoss();
		expect(monitor.isUnhealthy()).to.be.true;
	});

	it('should auto-recover when losses fall below threshold', () => {
		const monitor = new EngineHealthMonitor({
			engineHealthDisputeThreshold: 3,
			engineHealthWindowMs: 25, // window large enough that 3 synchronous recordDisputeLoss() calls can't outrun it
		});
		monitor.recordDisputeLoss();
		monitor.recordDisputeLoss();
		monitor.recordDisputeLoss();
		expect(monitor.isUnhealthy()).to.be.true;

		// Wait for losses to expire
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(monitor.isUnhealthy()).to.be.false;
				resolve();
			}, 100);
		});
	});

	it('should reset state', () => {
		const monitor = new EngineHealthMonitor({ engineHealthDisputeThreshold: 1 });
		monitor.recordDisputeLoss();
		expect(monitor.isUnhealthy()).to.be.true;
		monitor.reset();
		expect(monitor.isUnhealthy()).to.be.false;
		expect(monitor.getState().disputesLost).to.equal(0);
	});
});

describe('DisputeService', () => {
	let clusterPeers: { peerId: PeerId; privateKey: PrivateKey }[];
	let arbitratorPeers: { peerId: PeerId; privateKey: PrivateKey }[];
	let allServices: Map<string, DisputeService>;

	beforeEach(async () => {
		// 3 cluster peers + 3 arbitrator peers
		clusterPeers = await Promise.all(Array.from({ length: 3 }, () => makeKeyPair()));
		arbitratorPeers = await Promise.all(Array.from({ length: 3 }, () => makeKeyPair()));
		allServices = new Map();
	});

	function createDisputeService(
		peer: { peerId: PeerId; privateKey: PrivateKey },
		options?: {
			evidenceHash?: string;
			enabled?: boolean;
			onInvalidation?: (request: InvalidateRequest) => Promise<void> | void;
		}
	): DisputeService {
		const clientFactory = createMockClientFactory(allServices);
		const svc = new DisputeService({
			peerId: peer.peerId,
			privateKey: peer.privateKey,
			peerNetwork: new MockPeerNetwork(),
			createDisputeClient: clientFactory as any,
			reputation: new PeerReputationService(),
			onInvalidation: options?.onInvalidation,
			config: {
				disputeEnabled: options?.enabled ?? true,
				disputeArbitrationTimeoutMs: 5000,
				engineHealthDisputeThreshold: 3,
				engineHealthWindowMs: 600_000,
			},
			revalidate: async (_record) => {
				return makeEvidence(options?.evidenceHash ?? 'hash-default');
			},
			selectArbitrators: async (_blockId, _exclude, count, _round, _epoch) => {
				return arbitratorPeers.slice(0, count).map(p => p.peerId);
			},
		});
		allServices.set(peer.peerId.toString(), svc);
		return svc;
	}

	describe('initiateDispute', () => {
		it('should return undefined when disputes are disabled', async () => {
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(challenger, { enabled: false });

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence());
			expect(result).to.be.undefined;
		});

		it('should prevent duplicate disputes for the same transaction', async () => {
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
			// Setup arbitrator services that agree with challenger
			for (const arb of arbitratorPeers) {
				createDisputeService(arb, { evidenceHash: 'hash-A' });
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result1 = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result1).to.not.be.undefined;

			const result2 = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result2).to.be.undefined;
		});

		it('should skip dispute when engine is unhealthy', async () => {
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(challenger);
			// Force unhealthy
			const health = svc.getEngineHealth();
			health.recordDisputeLoss();
			health.recordDisputeLoss();
			health.recordDisputeLoss();

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence());
			expect(result).to.be.undefined;
		});

		it('should resolve challenger-wins when arbitrators agree with challenger', async () => {
			const challenger = clusterPeers[0]!;
			// Challenger and arbitrators agree on the same hash
			const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
			for (const arb of arbitratorPeers) {
				createDisputeService(arb, { evidenceHash: 'hash-A' });
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result).to.not.be.undefined;
			expect(result!.outcome).to.equal('challenger-wins');
			// Majority peers should be in affected list
			expect(result!.affectedPeers.length).to.be.greaterThan(0);
			expect(result!.affectedPeers.every(p => p.reason === 'false-approval')).to.be.true;
		});

		it('should resolve majority-wins when arbitrators agree with majority', async () => {
			const challenger = clusterPeers[0]!;
			// Challenger has hash-A, arbitrators compute hash-B (different)
			const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
			for (const arb of arbitratorPeers) {
				createDisputeService(arb, { evidenceHash: 'hash-B' });
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result).to.not.be.undefined;
			expect(result!.outcome).to.equal('majority-wins');
			expect(result!.affectedPeers.some(p =>
				p.peerId === challenger.peerId.toString() && p.reason === 'dispute-lost'
			)).to.be.true;
		});

		it('should resolve inconclusive when arbitrators cannot re-execute', async () => {
			const challenger = clusterPeers[0]!;
			// Arbitrators have no revalidate capability (returns undefined evidence)
			const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
			for (const arb of arbitratorPeers) {
				const arbSvc = new DisputeService({
					peerId: arb.peerId,
					privateKey: arb.privateKey,
					peerNetwork: new MockPeerNetwork(),
					createDisputeClient: createMockClientFactory(allServices) as any,
					reputation: new PeerReputationService(),
					config: { disputeEnabled: true, disputeArbitrationTimeoutMs: 5000, engineHealthDisputeThreshold: 3, engineHealthWindowMs: 600_000 },
					// No revalidate callback — will return inconclusive
					selectArbitrators: async () => [],
				});
				allServices.set(arb.peerId.toString(), arbSvc);
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result).to.not.be.undefined;
			expect(result!.outcome).to.equal('inconclusive');
			expect(result!.affectedPeers.length).to.equal(0);
		});

		it('threads round 0 and a non-empty agreed-membership epoch to selectArbitrators', async () => {
			const challenger = clusterPeers[0]!;
			let capturedRound: number | undefined;
			let capturedEpoch: Uint8Array | undefined;
			const svc = new DisputeService({
				peerId: challenger.peerId,
				privateKey: challenger.privateKey,
				peerNetwork: new MockPeerNetwork(),
				createDisputeClient: createMockClientFactory(allServices) as any,
				reputation: new PeerReputationService(),
				config: { disputeEnabled: true, disputeArbitrationTimeoutMs: 5000, engineHealthDisputeThreshold: 3, engineHealthWindowMs: 600_000 },
				revalidate: async () => makeEvidence('hash-A'),
				selectArbitrators: async (_blockId, _exclude, count, round, epoch) => {
					capturedRound = round;
					capturedEpoch = epoch;
					return arbitratorPeers.slice(0, count).map(p => p.peerId);
				},
			});
			allServices.set(challenger.peerId.toString(), svc);
			for (const arb of arbitratorPeers) createDisputeService(arb, { evidenceHash: 'hash-A' });

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});
			await svc.initiateDispute(record, makeEvidence('hash-A'));

			// Round 0 today (single-round arbitration); epoch is the interim hash of the agreed responsible set.
			expect(capturedRound).to.equal(0);
			expect(capturedEpoch).to.be.instanceOf(Uint8Array);
			expect(capturedEpoch!.length).to.be.greaterThan(0);
		});
	});

	describe('invalidation origination', () => {
		it('originates an invalidation with a challenger-wins proof when the challenger wins', async () => {
			const challenger = clusterPeers[0]!;
			const originated: InvalidateRequest[] = [];
			const svc = createDisputeService(challenger, {
				evidenceHash: 'hash-A',
				onInvalidation: async (req) => { originated.push(req); },
			});
			for (const arb of arbitratorPeers) {
				createDisputeService(arb, { evidenceHash: 'hash-A' });
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result!.outcome).to.equal('challenger-wins');

			expect(originated).to.have.lengthOf(1);
			const request = originated[0]!;
			expect(request.invalidatedActionId).to.equal('action-1');
			expect(request.resolution.outcome).to.equal('challenger-wins');
			expect(request.resolution.messageHash).to.equal(record.messageHash);
			// The proof carries the signed arbitrator votes for independent re-verification.
			expect(request.resolution.votes.length).to.be.greaterThan(0);

			// End-to-end target binding (#2): the real arbitrator-produced votes (signed over the target the
			// arbitrators derived from the challenge's originalRecord) verify against the target the
			// originator put on THIS request — the same consistency the network apply path relies on.
			expect(await verifyInvalidationCertificate(request.resolution, {
				invalidatedActionId: request.invalidatedActionId,
				blockIds: request.blockIds,
			})).to.equal(true);
			// …and the same genuine proof does NOT verify against an unrelated (innocent) target — so it
			// cannot be replayed to revert a different transaction.
			expect(await verifyInvalidationCertificate(request.resolution, {
				invalidatedActionId: 'innocent-action',
				blockIds: request.blockIds,
			})).to.equal(false);
		});

		it('does not originate an invalidation when the majority wins', async () => {
			const challenger = clusterPeers[0]!;
			const originated: InvalidateRequest[] = [];
			const svc = createDisputeService(challenger, {
				evidenceHash: 'hash-A',
				onInvalidation: async (req) => { originated.push(req); },
			});
			for (const arb of arbitratorPeers) {
				createDisputeService(arb, { evidenceHash: 'hash-B' });
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result!.outcome).to.equal('majority-wins');
			expect(originated).to.have.lengthOf(0);
		});
	});

	describe('handleChallenge', () => {
		it('should return agree-with-challenger when evidence matches', async () => {
			const arb = arbitratorPeers[0]!;
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(arb, { evidenceHash: 'hash-A' });

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			// Sign the dispute
			const disputeId = 'test-dispute-id';
			const sigBytes = await challenger.privateKey.sign(new TextEncoder().encode(disputeId));
			const signature = uint8ArrayToString(sigBytes, 'base64url');

			const challenge: DisputeChallenge = {
				disputeId,
				originalMessageHash: record.messageHash,
				originalRecord: record,
				challengerPeerId: challenger.peerId.toString(),
				challengerEvidence: makeEvidence('hash-A'),
				signature,
				timestamp: Date.now(),
				expiration: Date.now() + 60000,
			};

			const vote = await svc.handleChallenge(challenge);
			expect(vote.vote).to.equal('agree-with-challenger');
			expect(vote.disputeId).to.equal(disputeId);
			expect(vote.arbitratorPeerId).to.equal(arb.peerId.toString());
		});

		it('should return agree-with-majority when evidence differs', async () => {
			const arb = arbitratorPeers[0]!;
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(arb, { evidenceHash: 'hash-B' });

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const disputeId = 'test-dispute-id-2';
			const sigBytes = await challenger.privateKey.sign(new TextEncoder().encode(disputeId));
			const signature = uint8ArrayToString(sigBytes, 'base64url');

			const challenge: DisputeChallenge = {
				disputeId,
				originalMessageHash: record.messageHash,
				originalRecord: record,
				challengerPeerId: challenger.peerId.toString(),
				challengerEvidence: makeEvidence('hash-A'),
				signature,
				timestamp: Date.now(),
				expiration: Date.now() + 60000,
			};

			const vote = await svc.handleChallenge(challenge);
			expect(vote.vote).to.equal('agree-with-majority');
		});

		it('should return inconclusive for invalid challenge signature', async () => {
			const arb = arbitratorPeers[0]!;
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(arb, { evidenceHash: 'hash-A' });

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const challenge: DisputeChallenge = {
				disputeId: 'test-dispute-id-3',
				originalMessageHash: record.messageHash,
				originalRecord: record,
				challengerPeerId: challenger.peerId.toString(),
				challengerEvidence: makeEvidence('hash-A'),
				signature: 'invalid-signature',
				timestamp: Date.now(),
				expiration: Date.now() + 60000,
			};

			const vote = await svc.handleChallenge(challenge);
			expect(vote.vote).to.equal('inconclusive');
		});
	});

	describe('resolveDispute', () => {
		it('should determine challenger-wins with super-majority', async () => {
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(challenger);
			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const challenge: DisputeChallenge = {
				disputeId: 'test-resolve-1',
				originalMessageHash: record.messageHash,
				originalRecord: record,
				challengerPeerId: challenger.peerId.toString(),
				challengerEvidence: makeEvidence('hash-A'),
				signature: 'sig',
				timestamp: Date.now(),
				expiration: Date.now() + 60000,
			};

			const votes: ArbitrationVote[] = [
				{ version: 'v3', disputeId: 'test-resolve-1', arbitratorPeerId: 'arb-1', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's1' },
				{ version: 'v3', disputeId: 'test-resolve-1', arbitratorPeerId: 'arb-2', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's2' },
				{ version: 'v3', disputeId: 'test-resolve-1', arbitratorPeerId: 'arb-3', vote: 'agree-with-majority', evidence: makeEvidence(), signature: 's3' },
			];

			const resolution = await svc.resolveDispute(challenge, votes);
			expect(resolution.outcome).to.equal('challenger-wins');
			// Should penalize the 2 majority peers who approved
			expect(resolution.affectedPeers.length).to.equal(2);
		});

		it('should determine majority-wins with super-majority', async () => {
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(challenger);
			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const challenge: DisputeChallenge = {
				disputeId: 'test-resolve-2',
				originalMessageHash: record.messageHash,
				originalRecord: record,
				challengerPeerId: challenger.peerId.toString(),
				challengerEvidence: makeEvidence('hash-A'),
				signature: 'sig',
				timestamp: Date.now(),
				expiration: Date.now() + 60000,
			};

			const votes: ArbitrationVote[] = [
				{ version: 'v3', disputeId: 'test-resolve-2', arbitratorPeerId: 'arb-1', vote: 'agree-with-majority', evidence: makeEvidence(), signature: 's1' },
				{ version: 'v3', disputeId: 'test-resolve-2', arbitratorPeerId: 'arb-2', vote: 'agree-with-majority', evidence: makeEvidence(), signature: 's2' },
				{ version: 'v3', disputeId: 'test-resolve-2', arbitratorPeerId: 'arb-3', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's3' },
			];

			const resolution = await svc.resolveDispute(challenge, votes);
			expect(resolution.outcome).to.equal('majority-wins');
			expect(resolution.affectedPeers.length).to.equal(1);
			expect(resolution.affectedPeers[0]!.peerId).to.equal(challenger.peerId.toString());
			expect(resolution.affectedPeers[0]!.reason).to.equal('dispute-lost');
		});

		it('should determine inconclusive without super-majority', async () => {
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(challenger);
			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const challenge: DisputeChallenge = {
				disputeId: 'test-resolve-3',
				originalMessageHash: record.messageHash,
				originalRecord: record,
				challengerPeerId: challenger.peerId.toString(),
				challengerEvidence: makeEvidence('hash-A'),
				signature: 'sig',
				timestamp: Date.now(),
				expiration: Date.now() + 60000,
			};

			const votes: ArbitrationVote[] = [
				{ version: 'v3', disputeId: 'test-resolve-3', arbitratorPeerId: 'arb-1', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's1' },
				{ version: 'v3', disputeId: 'test-resolve-3', arbitratorPeerId: 'arb-2', vote: 'agree-with-majority', evidence: makeEvidence(), signature: 's2' },
				{ version: 'v3', disputeId: 'test-resolve-3', arbitratorPeerId: 'arb-3', vote: 'inconclusive', evidence: makeEvidence(), signature: 's3' },
			];

			const resolution = await svc.resolveDispute(challenge, votes);
			expect(resolution.outcome).to.equal('inconclusive');
			expect(resolution.affectedPeers.length).to.equal(0);
		});

		it('should determine inconclusive when all votes are inconclusive', async () => {
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(challenger);
			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const challenge: DisputeChallenge = {
				disputeId: 'test-resolve-4',
				originalMessageHash: record.messageHash,
				originalRecord: record,
				challengerPeerId: challenger.peerId.toString(),
				challengerEvidence: makeEvidence('hash-A'),
				signature: 'sig',
				timestamp: Date.now(),
				expiration: Date.now() + 60000,
			};

			const votes: ArbitrationVote[] = [
				{ version: 'v3', disputeId: 'test-resolve-4', arbitratorPeerId: 'arb-1', vote: 'inconclusive', evidence: makeEvidence(), signature: 's1' },
				{ version: 'v3', disputeId: 'test-resolve-4', arbitratorPeerId: 'arb-2', vote: 'inconclusive', evidence: makeEvidence(), signature: 's2' },
			];

			const resolution = await svc.resolveDispute(challenge, votes);
			expect(resolution.outcome).to.equal('inconclusive');
		});

		it('does not frame a peer whose approval carries a key not bound to its id', async () => {
			// An attacker can craft a challenge whose originalRecord contains a forged approval attributed
			// to an honest victim (the attacker attaches a key it controls under the victim's id and signs
			// with it). Without the binding gate, a challenger-wins resolution would slap a FalseApproval
			// penalty on that honest victim. The gate skips any approval that is not binding-valid.
			const challenger = clusterPeers[0]!;
			const honestA = clusterPeers[1]!;
			const honestB = clusterPeers[2]!;
			const svc = createDisputeService(challenger);

			const record = await makeClusterRecord(
				[challenger, honestA, honestB],
				'block-1',
				{ rejectPeers: new Set([challenger.peerId.toString()]) }
			);

			// Frame the victim: minted key it controls under the victim's id + a matching forged approval.
			const victim = await makeKeyPair();
			const minted = await makeKeyPair();
			const victimId = victim.peerId.toString();
			record.peers[victimId] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: uint8ArrayToString(minted.peerId.publicKey!.raw, 'base64url'),
			};
			const promiseHashBytes = await sha256.digest(
				new TextEncoder().encode(record.messageHash + canonicalJson(record.message))
			);
			const promiseHash = uint8ArrayToString(promiseHashBytes.digest, 'base64url');
			const forgedSigBytes = await minted.privateKey.sign(new TextEncoder().encode(promiseHash + ':approve'));
			record.promises[victimId] = { type: 'approve', signature: uint8ArrayToString(forgedSigBytes, 'base64url') };

			const challenge: DisputeChallenge = {
				disputeId: 'test-framing-1',
				originalMessageHash: record.messageHash,
				originalRecord: record,
				challengerPeerId: challenger.peerId.toString(),
				challengerEvidence: makeEvidence('hash-A'),
				signature: 'sig',
				timestamp: Date.now(),
				expiration: Date.now() + 60000,
			};

			const votes: ArbitrationVote[] = [
				{ version: 'v3', disputeId: 'test-framing-1', arbitratorPeerId: 'arb-1', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's1' },
				{ version: 'v3', disputeId: 'test-framing-1', arbitratorPeerId: 'arb-2', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's2' },
				{ version: 'v3', disputeId: 'test-framing-1', arbitratorPeerId: 'arb-3', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's3' },
			];

			const resolution = await svc.resolveDispute(challenge, votes);
			expect(resolution.outcome).to.equal('challenger-wins');
			// The two honest approvers (binding-valid) are penalized; the framed victim (unbound key) is not.
			const affectedIds = resolution.affectedPeers.map(p => p.peerId);
			expect(affectedIds).to.include(honestA.peerId.toString());
			expect(affectedIds).to.include(honestB.peerId.toString());
			expect(affectedIds).to.not.include(victimId);
			expect(resolution.affectedPeers.length).to.equal(2);
		});
	});

	describe('handleResolution', () => {
		it('should track engine health when penalized with false-approval', async () => {
			const peer = clusterPeers[1]!;
			const svc = createDisputeService(peer);

			const resolution: DisputeResolution = {
				disputeId: 'res-1',
				outcome: 'challenger-wins',
				votes: [],
				affectedPeers: [
					{ peerId: peer.peerId.toString(), reason: 'false-approval' },
				],
				timestamp: Date.now(),
			};

			svc.handleResolution(resolution);
			expect(svc.getEngineHealth().getState().disputesLost).to.equal(1);
		});

		it('should not affect engine health for dispute-lost', async () => {
			const peer = clusterPeers[0]!;
			const svc = createDisputeService(peer);

			const resolution: DisputeResolution = {
				disputeId: 'res-2',
				outcome: 'majority-wins',
				votes: [],
				affectedPeers: [
					{ peerId: peer.peerId.toString(), reason: 'dispute-lost' },
				],
				timestamp: Date.now(),
			};

			svc.handleResolution(resolution);
			expect(svc.getEngineHealth().getState().disputesLost).to.equal(0);
		});
	});

	describe('getDisputeStatus', () => {
		it('should return undefined for unknown transactions', async () => {
			const peer = clusterPeers[0]!;
			const svc = createDisputeService(peer);
			expect(svc.getDisputeStatus('unknown-hash')).to.be.undefined;
		});

		it('should return committed-invalidated after challenger wins', async () => {
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
			for (const arb of arbitratorPeers) {
				createDisputeService(arb, { evidenceHash: 'hash-A' });
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result!.outcome).to.equal('challenger-wins');
			expect(svc.getDisputeStatus(record.messageHash)).to.equal('committed-invalidated');
		});

		it('should return committed-validated after majority wins', async () => {
			const challenger = clusterPeers[0]!;
			const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
			for (const arb of arbitratorPeers) {
				createDisputeService(arb, { evidenceHash: 'hash-B' });
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result!.outcome).to.equal('majority-wins');
			expect(svc.getDisputeStatus(record.messageHash)).to.equal('committed-validated');
		});
	});

	describe('reputation effects', () => {
		it('should apply FalseApproval penalty when challenger wins', async () => {
			const reputation = new PeerReputationService();
			const challenger = clusterPeers[0]!;

			const clientFactory = createMockClientFactory(allServices);
			const svc = new DisputeService({
				peerId: challenger.peerId,
				privateKey: challenger.privateKey,
				peerNetwork: new MockPeerNetwork(),
				createDisputeClient: clientFactory as any,
				reputation,
				config: {
					disputeEnabled: true,
					disputeArbitrationTimeoutMs: 5000,
					engineHealthDisputeThreshold: 3,
					engineHealthWindowMs: 600_000,
				},
				revalidate: async () => makeEvidence('hash-A'),
				selectArbitrators: async (_blockId, _exclude, count, _round, _epoch) =>
					arbitratorPeers.slice(0, count).map(p => p.peerId),
			});
			allServices.set(challenger.peerId.toString(), svc);

			// Arbitrators agree with challenger
			for (const arb of arbitratorPeers) {
				createDisputeService(arb, { evidenceHash: 'hash-A' });
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result!.outcome).to.equal('challenger-wins');

			// Check that majority peers got FalseApproval penalties
			for (const peer of clusterPeers.slice(1)) {
				const score = reputation.getScore(peer.peerId.toString());
				expect(score).to.be.greaterThan(0);
			}
		});

		it('should apply DisputeLost penalty when majority wins', async () => {
			const reputation = new PeerReputationService();
			const challenger = clusterPeers[0]!;

			const clientFactory = createMockClientFactory(allServices);
			const svc = new DisputeService({
				peerId: challenger.peerId,
				privateKey: challenger.privateKey,
				peerNetwork: new MockPeerNetwork(),
				createDisputeClient: clientFactory as any,
				reputation,
				config: {
					disputeEnabled: true,
					disputeArbitrationTimeoutMs: 5000,
					engineHealthDisputeThreshold: 3,
					engineHealthWindowMs: 600_000,
				},
				revalidate: async () => makeEvidence('hash-A'),
				selectArbitrators: async (_blockId, _exclude, count, _round, _epoch) =>
					arbitratorPeers.slice(0, count).map(p => p.peerId),
			});
			allServices.set(challenger.peerId.toString(), svc);

			// Arbitrators disagree with challenger
			for (const arb of arbitratorPeers) {
				createDisputeService(arb, { evidenceHash: 'hash-B' });
			}

			const record = await makeClusterRecord(clusterPeers, 'block-1', {
				rejectPeers: new Set([challenger.peerId.toString()]),
			});

			const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
			expect(result!.outcome).to.equal('majority-wins');

			// Challenger should have a penalty
			const score = reputation.getScore(challenger.peerId.toString());
			expect(score).to.be.greaterThan(0);
		});
	});
});

describe('sampleArbitrators', () => {
	// A test NearestResolver over a fixed membership: sort by XOR distance to the coordinate, return ids.
	function nearestFromPeers(peers: KnownPeer[]): NearestResolver {
		return (coord, wants) => sortPeersByDistance(peers, coord).slice(0, wants).map(p => p.id.toString());
	}

	async function makePeers(n: number): Promise<KnownPeer[]> {
		const keys = await Promise.all(Array.from({ length: n }, () => makeKeyPair()));
		return keys.map(k => ({ id: k.peerId, addrs: ['/ip4/127.0.0.1/tcp/8000'] }));
	}

	const EPOCH = new TextEncoder().encode('epoch-A');

	it('disperses picks across the keyspace rather than the block neighborhood', async () => {
		const peers = await makePeers(120);
		const blockId = new TextEncoder().encode('disperse-block');
		const nearest = nearestFromPeers(peers);

		// Rank every peer by XOR distance to hash(blockId): the concentric (old) selection drew only the
		// lowest-ranked peers just past the cluster.
		const blockCoord = await hashKey(blockId);
		const rankOrder = sortPeersByDistance(peers, blockCoord).map(p => p.id.toString());
		const rankOf = new Map(rankOrder.map((id, idx) => [id, idx] as const));

		// Exclude the concentric "cluster": the 6 nearest to hash(blockId).
		const clusterSize = 6;
		const exclude = new Set(rankOrder.slice(0, clusterSize));
		const count = 15;

		const picks = await sampleArbitrators({ blockId, round: 0, epoch: EPOCH, count, exclude }, nearest, hashKey);
		expect(picks.length).to.equal(count);
		expect(new Set(picks).size).to.equal(count); // distinct

		// Concentric selection would place every pick at rank < clusterSize + count (~21). Dispersed sampling
		// draws from the whole ring, so the picks span far beyond that. The chance all 15 uniform draws land
		// within the nearest ~50/120 ranks is ~0.42^15 ≈ 1e-6, so this holds deterministically in practice.
		const maxRank = Math.max(...picks.map(p => rankOf.get(p)!));
		expect(maxRank).to.be.greaterThan(50);

		// And the picks are NOT the concentric next-K set the old function returned.
		const concentricNextK = new Set(rankOrder.slice(clusterSize, clusterSize + count));
		const identical = picks.length === concentricNextK.size && picks.every(p => concentricNextK.has(p));
		expect(identical).to.be.false;
	});

	it('is deterministic: identical params yield the identical ordered set', async () => {
		const peers = await makePeers(40);
		const blockId = new TextEncoder().encode('determinism-block');
		const nearest = nearestFromPeers(peers);
		const a = await sampleArbitrators({ blockId, round: 0, epoch: EPOCH, count: 5, exclude: new Set() }, nearest, hashKey);
		const b = await sampleArbitrators({ blockId, round: 0, epoch: EPOCH, count: 5, exclude: new Set() }, nearest, hashKey);
		expect(a).to.deep.equal(b);
		expect(a.length).to.equal(5);
	});

	it('pins the canonical little-endian coordinate encoding (golden vector)', async () => {
		const peers = await makePeers(10);
		const blockId = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const epoch = new Uint8Array([0x01, 0x02, 0x03]);

		// The i-th coordinate preimage is blockId ‖ u32le(round) ‖ epoch ‖ u32le(i).
		const expectedPreimage0 = new Uint8Array([
			0xde, 0xad, 0xbe, 0xef,     // blockId
			0x07, 0x00, 0x00, 0x00,     // u32le(round = 7)
			0x01, 0x02, 0x03,           // epoch
			0x00, 0x00, 0x00, 0x00,     // u32le(i = 0)
		]);
		expect(Array.from(coordinatePreimage(blockId, 7, epoch, 0))).to.deep.equal(Array.from(expectedPreimage0));

		// And sampleArbitrators hashes exactly that preimage for its first coordinate.
		const seenInputs: Uint8Array[] = [];
		const spyHash = async (bytes: Uint8Array) => { seenInputs.push(bytes.slice()); return hashKey(bytes); };
		await sampleArbitrators({ blockId, round: 7, epoch, count: 1, exclude: new Set() }, nearestFromPeers(peers), spyHash);
		expect(Array.from(seenInputs[0]!)).to.deep.equal(Array.from(expectedPreimage0));
	});

	it('samples a distinct population per round; excluding prior picks keeps rounds disjoint', async () => {
		const peers = await makePeers(120);
		const blockId = new TextEncoder().encode('round-block');
		const nearest = nearestFromPeers(peers);

		const round0 = await sampleArbitrators({ blockId, round: 0, epoch: EPOCH, count: 5, exclude: new Set() }, nearest, hashKey);
		// Caller accumulates prior-round picks into exclude → the two rounds are disjoint.
		const round1 = await sampleArbitrators({ blockId, round: 1, epoch: EPOCH, count: 5, exclude: new Set(round0) }, nearest, hashKey);
		expect(round1.filter(p => round0.includes(p))).to.have.lengthOf(0);

		// Changing epoch reshuffles the draw (different coordinates → different picks).
		const otherEpoch = await sampleArbitrators({ blockId, round: 0, epoch: new TextEncoder().encode('epoch-B'), count: 5, exclude: new Set() }, nearest, hashKey);
		expect(otherEpoch).to.not.deep.equal(round0);
	});

	it('small-network fallback: cluster+1 yields exactly 1; all-in-cluster yields []', async () => {
		const peers = await makePeers(6);
		const blockId = new TextEncoder().encode('small-block');
		const nearest = nearestFromPeers(peers);
		const ids = peers.map(p => p.id.toString());

		// cluster = 5 of 6 excluded → exactly 1 arbitrator available, however high count is; no duplicate, no loop.
		const cluster = new Set(ids.slice(0, 5));
		const one = await sampleArbitrators({ blockId, round: 0, epoch: EPOCH, count: 3, exclude: cluster }, nearest, hashKey);
		expect(one).to.have.lengthOf(1);
		expect(cluster.has(one[0]!)).to.be.false;

		// all peers excluded → empty (matches the old all-in-cluster behavior).
		const none = await sampleArbitrators({ blockId, round: 0, epoch: EPOCH, count: 3, exclude: new Set(ids) }, nearest, hashKey);
		expect(none).to.have.lengthOf(0);
	});

	it('liveness replacement: an excluded nearest pick is replaced by the deterministic next-nearest', async () => {
		const peers = await makePeers(40);
		const blockId = new TextEncoder().encode('liveness-block');
		const nearest = nearestFromPeers(peers);

		// The first coordinate's nearest peer (round 0, i 0) is the natural pick.
		const coord0 = await hashKey(coordinatePreimage(blockId, 0, EPOCH, 0));
		const byDist0 = sortPeersByDistance(peers, coord0).map(p => p.id.toString());
		const naturalPick = byDist0[0]!;

		const first = await sampleArbitrators({ blockId, round: 0, epoch: EPOCH, count: 1, exclude: new Set() }, nearest, hashKey);
		expect(first).to.deep.equal([naturalPick]);

		// Mark that peer offline (excluded): the replacement is the deterministic next-nearest to coord0…
		const replacement = byDist0[1]!;
		const withReplacement = await sampleArbitrators({ blockId, round: 0, epoch: EPOCH, count: 1, exclude: new Set([naturalPick]) }, nearest, hashKey);
		expect(withReplacement).to.deep.equal([replacement]);

		// …and it is identical across two independent computations.
		const again = await sampleArbitrators({ blockId, round: 0, epoch: EPOCH, count: 1, exclude: new Set([naturalPick]) }, nearest, hashKey);
		expect(again).to.deep.equal(withReplacement);
	});
});

describe('PenaltyReason dispute values', () => {
	it('should have FalseApproval with weight 40', async () => {
		const { DEFAULT_PENALTY_WEIGHTS } = await import('../src/reputation/types.js');
		expect(DEFAULT_PENALTY_WEIGHTS[PenaltyReason.FalseApproval]).to.equal(40);
	});

	it('should have DisputeLost with weight 30', async () => {
		const { DEFAULT_PENALTY_WEIGHTS } = await import('../src/reputation/types.js');
		expect(DEFAULT_PENALTY_WEIGHTS[PenaltyReason.DisputeLost]).to.equal(30);
	});
});
