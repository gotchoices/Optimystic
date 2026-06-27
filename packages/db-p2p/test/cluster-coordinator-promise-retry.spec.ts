import { expect } from 'chai';
import { ClusterCoordinator } from '../src/repo/cluster-coordinator.js';
import type { ClusterRecord, ClusterPeers, IKeyNetwork, RepoMessage, ClusterConsensusConfig, BlockId, Signature } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';

/**
 * Regression for `multi-coordinator-write-relay-stream-reset`.
 *
 * The inter-coordinator promise stream rides a libp2p stream that a relayed
 * ("limited") connection can reset transiently. The commit broadcast already
 * tolerates that with an in-line per-peer retry; the PROMISE phase did not, so a
 * single reset dropped the peer and sank the super-majority (2-of-2 → 1/2). This
 * locks in the per-peer immediate retry in `collectPromises`: with the default
 * `promiseImmediateRetries` a one-shot reset is recovered and the write reaches
 * 2-of-2; with retries disabled the same reset fails super-majority (the bug).
 *
 * Models the relay reset deterministically — no real libp2p — because the
 * organic relay repro can't converge in-process (FRET's own wire RPCs don't run
 * over limited connections, so two relay-only peers never assemble a cohort) and
 * even when it does, `applyDefaultLimit:false` lifts the data cap so a tiny RPC
 * won't reset on its own. See `multi-coordinator-write-relay.integration.spec.ts`.
 */

const makePeerId = async (): Promise<PeerId> => {
	const pk = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(pk);
};

/** Always approves the promise, then the commit, when asked. */
class ApprovingClusterClient {
	constructor(private readonly peerIdStr: string) { }
	async update(record: ClusterRecord): Promise<ClusterRecord> {
		return addSignature(record, this.peerIdStr);
	}
}

/**
 * Approves like {@link ApprovingClusterClient}, but throws a transport-style
 * StreamResetError on its first `failTimes` `update` calls — mimicking a
 * relayed/limited connection being reset before it recovers.
 */
class FlakyResetClusterClient {
	private updateCalls = 0;
	constructor(private readonly peerIdStr: string, private readonly failTimes: number) { }
	get callCount(): number { return this.updateCalls; }
	async update(record: ClusterRecord): Promise<ClusterRecord> {
		this.updateCalls++;
		if (this.updateCalls <= this.failTimes) {
			const err = new Error('the stream has been reset') as Error & { code?: string };
			err.name = 'StreamResetError';
			err.code = 'ERR_STREAM_RESET';
			throw err;
		}
		return addSignature(record, this.peerIdStr);
	}
}

/** Add this peer's promise (first touch) then commit (second touch) to a copy of the record. */
function addSignature(record: ClusterRecord, peerIdStr: string): ClusterRecord {
	if (!(peerIdStr in record.promises)) {
		return {
			...record,
			promises: {
				...record.promises,
				[peerIdStr]: { type: 'approve', signature: `psig-${peerIdStr.substring(0, 8)}` } as Signature
			}
		};
	}
	return {
		...record,
		commits: {
			...record.commits,
			[peerIdStr]: { type: 'approve', signature: `csig-${peerIdStr.substring(0, 8)}` } as Signature
		}
	};
}

// clusterSize 2, superMajorityThreshold 0.67 → ceil(2 * 0.67) = 2 (2-of-2 required).
const baseCfg: ClusterConsensusConfig & { clusterSize: number } = {
	clusterSize: 2,
	superMajorityThreshold: 0.67,
	simpleMajorityThreshold: 0.51,
	minAbsoluteClusterSize: 2,
	allowClusterDownsize: true,
	clusterSizeTolerance: 0.5,
	partitionDetectionWindow: 60000
};

const makeMessage = (): RepoMessage => ({
	operations: [{ get: { blockIds: ['block-1'] } }],
	expiration: Date.now() + 30000
});

describe('ClusterCoordinator promise-phase immediate retry (multi-coordinator-write-relay-stream-reset)', function () {
	this.timeout(10000);

	let peerIds: PeerId[];
	let clusterPeers: ClusterPeers;

	beforeEach(async () => {
		peerIds = await Promise.all([makePeerId(), makePeerId()]);
		clusterPeers = {};
		for (const pid of peerIds) {
			clusterPeers[pid.toString()] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			};
		}
	});

	function makeCoordinator(promiseImmediateRetries: number, flaky: FlakyResetClusterClient): ClusterCoordinator {
		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!; },
			async findCluster() { return { ...clusterPeers }; }
		};
		const clients = new Map<string, ApprovingClusterClient | FlakyResetClusterClient>();
		clients.set(peerIds[0]!.toString(), new ApprovingClusterClient(peerIds[0]!.toString()));
		clients.set(peerIds[1]!.toString(), flaky);
		const createClient = (peerId: PeerId) => {
			const mock = clients.get(peerId.toString());
			if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
			return mock;
		};
		return new ClusterCoordinator(
			mockKeyNetwork,
			createClient as any,
			{ ...baseCfg, promiseImmediateRetries }
		);
	}

	it('recovers a 2-of-2 write when one peer\'s promise stream resets once (retries=1)', async () => {
		const flaky = new FlakyResetClusterClient(peerIds[1]!.toString(), 1);
		const coordinator = makeCoordinator(1, flaky);

		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		const approvals = Object.values(result.record.promises).filter(s => s.type === 'approve').length;
		expect(approvals, 'both promises collected despite the one-shot reset').to.equal(2);
		expect(Object.keys(result.record.commits).length, 'commit phase ran').to.be.greaterThan(0);
		// The flaky peer was dialed at least twice in the promise phase (fail → retry → approve).
		expect(flaky.callCount).to.be.greaterThan(1);
	});

	it('does NOT retry the LOCAL cluster on a throw — a local fault is fatal, not transient', async () => {
		// peer[0] is the local cluster; its update throws once. If updateMember treated the
		// local member like a remote one it would retry (retries=1) and recover to 2-of-2.
		// The documented contract is the opposite: the local cluster is invoked exactly once
		// because a local throw is a real fault (validation / merge / consensus), not transport
		// churn — so the throw drops peer[0], leaving 1/2 and failing super-majority.
		let localCalls = 0;
		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!; },
			async findCluster() { return { ...clusterPeers }; }
		};
		const remote = new ApprovingClusterClient(peerIds[1]!.toString());
		const createClient = (peerId: PeerId) => {
			if (peerId.toString() === peerIds[1]!.toString()) return remote;
			throw new Error(`unexpected remote dial for ${peerId.toString()} — local member should not be dialed`);
		};
		const localCluster = {
			peerId: peerIds[0]!,
			async update(_record: ClusterRecord): Promise<ClusterRecord> {
				localCalls++;
				throw new Error('local merge failure');
			}
		};
		const coordinator = new ClusterCoordinator(
			mockKeyNetwork,
			createClient as any,
			{ ...baseCfg, promiseImmediateRetries: 1 },
			localCluster
		);

		let caught: Error | null = null;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		} catch (err) {
			caught = err as Error;
		}
		expect(caught, 'expected a super-majority failure').to.be.instanceOf(Error);
		expect(caught!.message).to.match(/super-majority/i);
		// The decisive assertion: the local cluster was invoked exactly ONCE despite retries=1.
		expect(localCalls, 'local cluster must not be retried in the promise phase').to.equal(1);
	});

	it('fails super-majority on the same reset when the immediate retry is disabled (retries=0 — the bug)', async () => {
		const flaky = new FlakyResetClusterClient(peerIds[1]!.toString(), 1);
		const coordinator = makeCoordinator(0, flaky);

		let caught: Error | null = null;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		} catch (err) {
			caught = err as Error;
		}
		expect(caught, 'expected a super-majority failure').to.be.instanceOf(Error);
		expect(caught!.message).to.match(/super-majority/i);
		// Exactly one dial in the promise phase — no retry — so the reset is fatal.
		expect(flaky.callCount).to.equal(1);
	});
});
