import { expect } from 'chai';
import { clusterMember, MEMBERSHIP_NOT_ADMITTED, type ExpectedClusterView, type DeriveExpectedClusterCallback } from '../src/cluster/cluster-repo.js';
import type { IRepo, ClusterRecord, RepoMessage, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, ClusterPeers, ClusterConsensusConfig } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

// ─── Helpers (v1/unbound records — the admission gate reads record.peers + coordinatingBlockIds, not the
// membership-binding version) ───

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const computeMessageHash = async (message: RepoMessage): Promise<string> => {
	const hashBytes = await sha256.digest(new TextEncoder().encode(canonicalJson(message)));
	return base58btc.encode(hashBytes.digest);
};

const makeClusterPeers = (keyPairs: KeyPair[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const { peerId } of keyPairs) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: uint8ArrayToString(peerId.publicKey!.raw, 'base64url')
		};
	}
	return peers;
};

/** A fresh record (no promises/commits) carrying a coordinating block id so the gate can derive a view. */
const makeRecord = async (peers: ClusterPeers, blockId = 'block-1'): Promise<ClusterRecord> => {
	const message: RepoMessage = {
		operations: [{ get: { blockIds: [blockId] } }],
		coordinatingBlockIds: [blockId],
		expiration: Date.now() + 30000
	};
	const messageHash = await computeMessageHash(message);
	return {
		messageHash,
		message,
		peers,
		coordinatingBlockIds: [blockId],
		promises: {},
		commits: {}
	};
};

class MockRepo implements IRepo {
	async get(_blockGets: BlockGets): Promise<GetBlockResults> { return {}; }
	async pend(_request: PendRequest): Promise<PendResult> { return { success: true, blockIds: [], pending: [] }; }
	async commit(_request: CommitRequest): Promise<CommitResult> { return { success: true }; }
	async cancel(_actionRef: ActionBlocks): Promise<void> { /* no-op */ }
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

/** A deriveExpectedCluster capability that always returns the given view. */
const constantDerive = (view: ExpectedClusterView): DeriveExpectedClusterCallback => async () => view;

const baseConfig = (over: Partial<ClusterConsensusConfig> = {}): ClusterConsensusConfig => ({
	superMajorityThreshold: 0.75,
	simpleMajorityThreshold: 0.51,
	minAbsoluteClusterSize: 2,
	allowClusterDownsize: true,
	clusterSizeTolerance: 0.5,
	partitionDetectionWindow: 60000,
	membershipAdmissionFraction: 0.75,
	...over
});

/**
 * Build a member whose declared-set derivation returns `view`, then vote on a record for `declared`.
 * `config` may be omitted entirely, exercising the no-consensusConfig construction many other specs use.
 */
const voteOn = async (
	self: KeyPair,
	declared: KeyPair[],
	view: ExpectedClusterView | undefined,
	config?: ClusterConsensusConfig
): Promise<{ type: string; rejectReason?: string }> => {
	const member = clusterMember({
		storageRepo: new MockRepo(),
		peerNetwork: new MockPeerNetwork(),
		peerId: self.peerId,
		privateKey: self.privateKey,
		consensusConfig: config,
		deriveExpectedCluster: view ? constantDerive(view) : undefined
	});
	try {
		const record = await makeRecord(makeClusterPeers(declared));
		const result = await member.update(record);
		const sig = result.promises[self.peerId.toString()];
		return { type: sig?.type ?? 'none', rejectReason: sig?.rejectReason };
	} finally {
		member.dispose();
	}
};

/** Build an ExpectedClusterView from key pairs + confidence. */
const view = (peers: KeyPair[], confidence: number): ExpectedClusterView => ({
	peers: makeClusterPeers(peers),
	confidence
});

describe('ClusterMember — membership admission gate', () => {
	let self: KeyPair;
	let others: KeyPair[];

	beforeEach(async () => {
		self = await makeKeyPair();
		others = await Promise.all(Array.from({ length: 9 }, () => makeKeyPair()));
	});

	const cluster = (n: number): KeyPair[] => [self, ...others.slice(0, n - 1)];

	describe('fast path (unchanged behavior)', () => {
		it('admits the declared full set in a healthy full cluster (confident, D == E)', async () => {
			const full = cluster(8);
			const vote = await voteOn(self, full, view(full, 0.9), baseConfig({ assumedClusterSize: 8 }));
			expect(vote.type).to.equal('approve');
		});

		it('with no derivation capability AND no asserted cohort size, preserves legacy approve', async () => {
			const full = cluster(8);
			// No deriveExpectedCluster, no assumedClusterSize → the gate cannot judge a downsize → legacy approve.
			const vote = await voteOn(self, full, undefined, baseConfig());
			expect(vote.type).to.equal('approve');
		});

		it('with no consensusConfig at all, preserves legacy approve', async () => {
			// Many other specs construct ClusterMember with no config; that path must stay admitting.
			const shrunk = cluster(3);
			const vote = await voteOn(self, shrunk, undefined, undefined);
			expect(vote.type).to.equal('approve');
		});
	});

	describe('self-membership (predicate 1)', () => {
		it('rejects a record whose peers omit this member', async () => {
			const declaredWithoutSelf = others.slice(0, 5); // self not included
			const vote = await voteOn(self, declaredWithoutSelf, view(cluster(6), 0.9), baseConfig({ assumedClusterSize: 6 }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(`${MEMBERSHIP_NOT_ADMITTED}:self-not-member`);
		});
	});

	describe('self-shrink floor (predicate 2, confident)', () => {
		it('rejects a strict shrink below ceil(admissionFraction * K_est)', async () => {
			const expected = cluster(8);           // K_est = 8, floor = ceil(0.75*8) = 6
			const declared = cluster(3);           // |D| = 3 < 6
			const vote = await voteOn(self, declared, view(expected, 0.9), baseConfig({ assumedClusterSize: 8 }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.match(
				new RegExp(`^${MEMBERSHIP_NOT_ADMITTED}:below-floor \\(declared=3, floor=6, kEst=8\\)$`)
			);
		});

		it('admits exactly at the ceil boundary of the confident floor', async () => {
			const expected = cluster(8);           // K_est = 8, floor = ceil(0.75*8) = 6
			const declared = cluster(6);           // |D| = 6 == floor, symDiff = 2 <= ceil(0.5*8) = 4
			const vote = await voteOn(self, declared, view(expected, 0.9), baseConfig({ assumedClusterSize: 8 }));
			expect(vote.type).to.equal('approve');
		});

		it('admits a genuinely small cluster when the member is confident of the small size', async () => {
			const small = cluster(3);              // K_est = 3, floor = max(2, ceil(0.75*3)) = 3
			const vote = await voteOn(self, small, view(small, 0.9), baseConfig({ assumedClusterSize: 10 }));
			expect(vote.type).to.equal('approve');
		});
	});

	describe('consistency with derived view (predicate 3, confident)', () => {
		it('admits a set differing from E by one peer (within tolerance)', async () => {
			const expected = cluster(6);                        // E
			// D = E with one peer swapped: symDiff = 2 <= ceil(0.5*6) = 3
			const swapped = [...expected.slice(0, 5), others[8]!];
			const vote = await voteOn(self, swapped, view(expected, 0.9), baseConfig({ assumedClusterSize: 6 }));
			expect(vote.type).to.equal('approve');
		});

		it('admits exactly at the tolerance boundary, rejects just beyond it', async () => {
			const expected = cluster(6);                        // maxDiff = ceil(0.5*6) = 3
			// symDiff = 3: drop one from E (p5) and add two fresh → {removed:1, added:2}
			const atBoundary = [...expected.slice(0, 5), others[7]!, others[8]!]; // size 7, symDiff 3
			const atVote = await voteOn(self, atBoundary, view(expected, 0.9), baseConfig({ assumedClusterSize: 6 }));
			expect(atVote.type, 'symDiff == maxDiff should admit').to.equal('approve');

			// symDiff = 4: drop one from E and add three fresh
			const beyond = [...expected.slice(0, 5), others[6]!, others[7]!, others[8]!]; // size 8, symDiff 4
			const beyondVote = await voteOn(self, beyond, view(expected, 0.9), baseConfig({ assumedClusterSize: 6 }));
			expect(beyondVote.type, 'symDiff > maxDiff should reject').to.equal('reject');
			expect(beyondVote.rejectReason).to.equal(`${MEMBERSHIP_NOT_ADMITTED}:inconsistent-with-derived-view`);
		});

		it('rejects a wholesale-disjoint set of the same size (sharing only self)', async () => {
			const expected = [self, ...others.slice(0, 4)];      // E = {self, o0..o3}, floor=ceil(0.75*5)=4
			const disjoint = [self, ...others.slice(4, 8)];      // D = {self, o4..o7}, |D|=5>=floor, symDiff=8
			const vote = await voteOn(self, disjoint, view(expected, 0.9), baseConfig({ assumedClusterSize: 5 }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(`${MEMBERSHIP_NOT_ADMITTED}:inconsistent-with-derived-view`);
		});
	});

	describe('clusterSize is decoupled from the admission gate', () => {
		it('admits a small declared set when only clusterSize (the replication factor) is configured', async () => {
			// The whole point of the split: clusterSize: 10 says "keep 10 copies", NOT "10 peers exist".
			// A two-node deployment that never configured assumedClusterSize must still transact.
			const pair = cluster(2);
			const vote = await voteOn(self, pair, undefined, baseConfig({ clusterSize: 10 }));
			expect(vote.type).to.equal('approve');
		});

		it('admits a two-node declared set under the small-deployment default (assumedClusterSize 2)', async () => {
			// The reported regression, reproduced at the value libp2p-node-base now defaults to.
			const pair = cluster(2);
			const vote = await voteOn(self, pair, undefined, baseConfig({ clusterSize: 10, assumedClusterSize: 2 }));
			expect(vote.type).to.equal('approve');
		});
	});

	describe('fail-closed partition posture (low confidence)', () => {
		it('rejects a below-floor D when FRET confidence is low (Theorem 2 regression)', async () => {
			// The member is on a minority side: its own derived view is a small shrunk set AND confidence is
			// low (a partition induces exactly this). Even though the record is internally valid, a
			// below-floor declared set must be refused against the asserted cohort size.
			const shrunk = cluster(3);          // floor = max(2, ceil(0.75*8)) = 6
			const vote = await voteOn(self, shrunk, view(shrunk, 0.2), baseConfig({ assumedClusterSize: 8 }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.match(
				new RegExp(`^${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize \\(declared=3, floor=6, assumedClusterSize=8\\)$`)
			);
		});

		it('still admits a full-size D under low confidence (nothing to shrink)', async () => {
			const full = cluster(8);
			const vote = await voteOn(self, full, view(cluster(3), 0.2), baseConfig({ assumedClusterSize: 8 }));
			expect(vote.type).to.equal('approve');
		});

		it('admits at the fallback floor — the same slack the confident path gets', async () => {
			// Previously the fallback demanded the FULL asserted size (no fraction), so this rejected: a
			// deployment sitting at its cohort size got intermittent refusals purely from discovery timing.
			const atFloor = cluster(6);         // floor = ceil(0.75*8) = 6
			const vote = await voteOn(self, atFloor, view(cluster(3), 0.2), baseConfig({ assumedClusterSize: 8 }));
			expect(vote.type).to.equal('approve');
		});

		it('rejects one peer below the fallback floor (the boundary the at-floor case admits)', async () => {
			// Twin of the at-floor case above: floor - 1 must reject, so the boundary is pinned from both
			// sides and a future off-by-one in admissionFloor cannot pass silently.
			const belowFloor = cluster(5);      // floor = ceil(0.75*8) = 6
			const vote = await voteOn(self, belowFloor, view(cluster(3), 0.2), baseConfig({ assumedClusterSize: 8 }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.match(
				new RegExp(`^${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize \\(declared=5, floor=6, assumedClusterSize=8\\)$`)
			);
		});

		it('fails closed even with no derivation capability when a cohort size is asserted', async () => {
			const shrunk = cluster(3);
			const vote = await voteOn(self, shrunk, undefined, baseConfig({ assumedClusterSize: 8 }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.match(
				new RegExp(`^${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize \\(declared=3, floor=6, assumedClusterSize=8\\)$`)
			);
		});
	});

	describe('degenerate assumedClusterSize', () => {
		it('clamps a floor of 1 up to minAbsoluteClusterSize (a solo set still needs the opt-in)', async () => {
			// assumedClusterSize: 1 → floor = max(minAbsoluteClusterSize=2, ceil(0.75*1)=1) = 2.
			const solo = [self];
			const vote = await voteOn(self, solo, undefined, baseConfig({ assumedClusterSize: 1 }));
			expect(vote.type, 'solo D below the absolute floor rejects').to.equal('reject');
			expect(vote.rejectReason).to.match(
				new RegExp(`^${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize \\(declared=1, floor=2, assumedClusterSize=1\\)$`)
			);

			const optIn = await voteOn(self, solo, undefined, baseConfig({ assumedClusterSize: 1, allowUnvalidatedSmallCluster: true }));
			expect(optIn.type, 'the explicit opt-in still admits a solo member').to.equal('approve');
		});

		it('does not throw on a zero or negative asserted size', async () => {
			const pair = cluster(2);
			for (const assumedClusterSize of [0, -5]) {
				const vote = await voteOn(self, pair, undefined, baseConfig({ assumedClusterSize }));
				expect(vote.type, `assumedClusterSize=${assumedClusterSize} floors at minAbsoluteClusterSize`).to.equal('approve');
			}
		});

		it('treats a non-finite asserted size as no usable reference rather than rejecting everything', async () => {
			// A NaN (e.g. Number() of a malformed env var) or Infinity would otherwise propagate through the
			// floor, and EVERY comparison against NaN is false — the node would silently refuse every write it
			// could not measure. Both must fall back to minAbsoluteClusterSize instead.
			const pair = cluster(2);
			for (const assumedClusterSize of [Number.NaN, Number.POSITIVE_INFINITY]) {
				const vote = await voteOn(self, pair, undefined, baseConfig({ assumedClusterSize }));
				expect(vote.type, `assumedClusterSize=${assumedClusterSize} floors at minAbsoluteClusterSize`).to.equal('approve');
			}
		});

		it('a non-finite admission fraction cannot make the floor unsatisfiable either', async () => {
			const pair = cluster(2);
			const vote = await voteOn(self, pair, undefined, baseConfig({ assumedClusterSize: 8, membershipAdmissionFraction: Number.NaN }));
			expect(vote.type).to.equal('approve');
		});
	});

	describe('empty derived view (confident but unusable reference)', () => {
		it('treats a confident-but-empty view as not-confident: full-size D admitted, shrunk D fails closed', async () => {
			const emptyView: ExpectedClusterView = { peers: {}, confidence: 0.9 };
			// Full-size D (>= the fallback floor): nothing to shrink → admit (legacy/fail-open direction).
			const full = cluster(8);
			const fullVote = await voteOn(self, full, emptyView, baseConfig({ assumedClusterSize: 8 }));
			expect(fullVote.type, 'full-size D under empty view admits').to.equal('approve');

			// Shrunk D (< the fallback floor): fail closed rather than spuriously reject as inconsistent.
			const shrunk = cluster(3);
			const shrunkVote = await voteOn(self, shrunk, emptyView, baseConfig({ assumedClusterSize: 8 }));
			expect(shrunkVote.type, 'shrunk D under empty view fails closed').to.equal('reject');
			expect(shrunkVote.rejectReason).to.match(
				new RegExp(`^${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize \\(declared=3, floor=6, assumedClusterSize=8\\)$`)
			);
		});
	});

	describe('allowUnvalidatedSmallCluster opt-in', () => {
		it('lets a solo/dev member admit an undersized D', async () => {
			const solo = [self];
			const vote = await voteOn(self, solo, undefined, baseConfig({ assumedClusterSize: 8, allowUnvalidatedSmallCluster: true }));
			expect(vote.type).to.equal('approve');
		});

		it('opt-in does NOT bypass self-membership', async () => {
			const withoutSelf = others.slice(0, 3);
			const vote = await voteOn(self, withoutSelf, undefined, baseConfig({ assumedClusterSize: 8, allowUnvalidatedSmallCluster: true }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(`${MEMBERSHIP_NOT_ADMITTED}:self-not-member`);
		});
	});

	describe('split-brain prevention (partition, end-to-end at the member layer)', () => {
		it('minority-side members refuse admission while majority-side members approve', async () => {
			// Simulate a partition of an 8-node cluster into a 5-node majority and a 3-node minority.
			const majorityMembers = cluster(8).slice(0, 5);     // {self, o0..o3}
			const minoritySelf = others[5]!;
			const minorityMembers = [minoritySelf, others[6]!, others[7]!];

			// Majority coordinator declares the (still large enough) majority set; each majority member
			// derives a confident view of ~the same set → admit.
			const majorityDeclared = majorityMembers;
			const majView = view(majorityMembers, 0.9);
			const majVote = await voteOn(self, majorityDeclared, majView, baseConfig({ assumedClusterSize: 8 }));

			// Minority coordinator re-derives a self-shrunk 3-node cluster; the minority member's own view is
			// that same shrunk set, and FRET confidence collapsed under the partition → refuse.
			const minVote = await voteOn(minoritySelf, minorityMembers, view(minorityMembers, 0.2), baseConfig({ assumedClusterSize: 8 }));

			expect(majVote.type, 'majority side admits and approves').to.equal('approve');
			expect(minVote.type, 'minority side refuses admission').to.equal('reject');
			expect(minVote.rejectReason).to.match(
				new RegExp(`^${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize \\(declared=3, floor=6, assumedClusterSize=8\\)$`)
			);
		});
	});
});
