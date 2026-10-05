import { expect } from 'chai';
import { ClusterCoordinator, TransactionExpiredError, ValidatorRejectionError } from '../src/repo/cluster-coordinator.js';
import { PenaltyReason, type IPeerReputation } from '../src/reputation/types.js';
import type { ClusterRecord, ClusterPeers, IKeyNetwork, ICluster, RepoMessage, ClusterConsensusConfig, BlockId } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';

/**
 * GitHub issue #24. A cohort member whose clock is more than the transaction's timeout ahead of the
 * writer's sees every record as already expired. It used to throw, and the coordinator turned the
 * throw into silence: no vote, a `ConsensusTimeout` penalty against the honest member, and the
 * "Failed to get super-majority … 0 rejections" error a downstream repository retries as a silent
 * cohort. The member now answers with a signed expiry vote (a `reject` carrying `expiredAt`), and the
 * coordinator names it.
 *
 * Shape: two members, superMajority 2, so one reject is terminal. The coordinator's own member
 * approves in process; the remote member answers with the expiry vote a real member signs.
 */

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

const cfg: ClusterConsensusConfig & { clusterSize: number } = {
	clusterSize: 2,
	superMajorityThreshold: 0.75,
	simpleMajorityThreshold: 0.51,
	minAbsoluteClusterSize: 2,
	allowClusterDownsize: true,
	clusterSizeTolerance: 0.5,
	partitionDetectionWindow: 60000
};

/** A member that approves every promise and commit, standing in for the coordinator's own. */
const approvingMember = (peerId: PeerId) => ({
	peerId,
	async update(record: ClusterRecord): Promise<ClusterRecord> {
		const id = peerId.toString();
		return id in record.promises
			? { ...record, commits: { ...record.commits, [id]: { type: 'approve', signature: 'csig' } } }
			: { ...record, promises: { ...record.promises, [id]: { type: 'approve', signature: 'psig' } } };
	}
});

/** A member whose clock is `aheadMs` past the record's expiration when it votes. */
const expiringMember = (peerId: PeerId, aheadMs: number) => ({
	async update(record: ClusterRecord): Promise<ClusterRecord> {
		const expiredAt = record.message.expiration! + aheadMs;
		return {
			...record,
			promises: {
				...record.promises,
				[peerId.toString()]: { type: 'reject', signature: 'psig', rejectReason: 'transaction-expired: …', expiredAt }
			}
		};
	}
});

const reputationSpy = () => {
	const reports: { peerId: string; reason: PenaltyReason }[] = [];
	const reputation: IPeerReputation = {
		reportPeer(peerId, reason) { reports.push({ peerId, reason }); },
		recordSuccess() { },
		getScore() { return 0; },
		isBanned() { return false; },
		isDeprioritized() { return false; },
		getReputation() { throw new Error('unused'); },
		getAllReputations() { return new Map(); },
		resetPeer() { }
	};
	return { reputation, reports };
};

describe('ClusterCoordinator — a member refusing an expired record is a clock disagreement, not silence', function () {
	this.timeout(10000);

	it('raises TransactionExpiredError carrying the member clock, and penalizes nobody', async () => {
		const [selfId, remoteId] = await Promise.all([makePeerId(), makePeerId()]);
		const peers: ClusterPeers = Object.fromEntries([selfId, remoteId].map(pid => [pid.toString(), {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
		}]));
		const keyNetwork: IKeyNetwork = {
			async findCoordinator() { return selfId; },
			async findCluster() { return { ...peers }; }
		};
		const remote = expiringMember(remoteId, 1000);
		const { reputation, reports } = reputationSpy();
		const coordinator = new ClusterCoordinator(
			keyNetwork,
			(peerId: PeerId): ICluster => {
				if (peerId.toString() !== remoteId.toString()) throw new Error(`no client for ${peerId.toString()}`);
				return remote;
			},
			cfg,
			approvingMember(selfId),
			undefined,
			reputation
		);
		const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'] } }], expiration: Date.now() + 30000 };

		let caught: unknown;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, message);
		} catch (err) {
			caught = err;
		}

		expect(caught).to.be.instanceOf(TransactionExpiredError);
		expect(caught, 'still a validator rejection to everything above the coordinator').to.be.instanceOf(ValidatorRejectionError);
		const error = caught as TransactionExpiredError;
		expect(error.message, 'never the text a downstream repo retries as a silent cohort').to.not.include('super-majority');
		expect(error.expiration).to.equal(message.expiration);
		expect(error.memberClocks).to.deep.equal({ [remoteId.toString()]: message.expiration! + 1000 });
		expect(error.apparentSkewMs).to.be.closeTo(31000, 1000);
		expect(reports.filter(r => r.reason === PenaltyReason.ConsensusTimeout), 'an answered vote is not a timeout').to.deep.equal([]);
	});
});
