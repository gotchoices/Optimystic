/**
 * Ticket: a-cluster-request-carries-owed-consensus-deliveries.
 *
 * A member the coordinating node still owes the consensus delivery of an earlier commit gets it inside
 * the next request that node sends it, applied ahead of that request's own record, instead of waiting
 * for the commit-retry timer to send it alone.
 */

import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import type { BlockHeader, BlockId, ClusterRecord, IBlock, ICluster, IPeerNetwork, RepoMessage, Transforms } from '@optimystic/db-core';
import { createMesh, type MeshNode } from '../src/testing/mesh-harness.js';
import { ClusterClient } from '../src/cluster/client.js';
import { ClusterService } from '../src/cluster/service.js';
import { makeServiceStream } from './util/protocol-stream.js';

const transformsFor = (block: BlockId): Transforms => ({
	inserts: { [block]: { header: { id: block, type: 'test', collectionId: 'collection-1' as BlockId } as BlockHeader } as IBlock },
	updates: {},
	deletes: []
});

const latestOn = async (node: MeshNode, block: BlockId) =>
	(await node.storageRepo.get({ blockIds: [block] }))[block]?.state?.latest;

const isCommitOf = (record: ClusterRecord, actionId: string): boolean =>
	record.message.operations.some(op => 'commit' in op && op.commit.actionId === actionId);

/** The coordinating node's scheduled commit retry for `messageHash` — internal state; no public seam reports it. */
const retryFor = (node: MeshNode, messageHash: string): { pendingPeers: Set<string> } | undefined =>
	(node.coordinatorRepo as unknown as { coordinator: { transactions: Map<string, { retry?: { pendingPeers: Set<string> } }> } })
		.coordinator.transactions.get(messageHash)?.retry;

/** A peer network whose every dial is answered by `service`, through the real framing at both ends. */
const networkServedBy = (service: ClusterService, remotePeer: PeerId): IPeerNetwork => ({
	async connect() {
		const request: Uint8Array[] = [];
		return {
			send: (chunk: { subarray: () => Uint8Array }) => { request.push(chunk.subarray()); },
			close: async () => { },
			abort: () => { },
			async *[Symbol.asyncIterator]() {
				const { stream, sent, done } = makeServiceStream(request);
				(service as unknown as { handleIncomingStream: (s: unknown, c: unknown) => void }).handleIncomingStream(stream, { remotePeer });
				await done;
				yield* sent;
			}
		};
	}
}) as unknown as IPeerNetwork;

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

describe('a cluster request carries the consensus deliveries its target is still owed', () => {
	it('over the wire, the member applies carried records in order ahead of the record the request is for, and the client reads one outcome per record', async () => {
		const [memberId, coordinatorId] = await Promise.all([makePeerId(), makePeerId()]);
		const applied: string[] = [];
		const member: ICluster = {
			async update(record: ClusterRecord): Promise<ClusterRecord> {
				applied.push(record.messageHash);
				if (record.messageHash === 'refused') throw new Error('Transaction expired');
				return { ...record, applyOutcomes: { [memberId.toString()]: { executed: true, acceptsCarried: true } } };
			}
		};
		const service = new ClusterService({ registrar: { handle: async () => { }, unhandle: async () => { } }, cluster: member, peerId: memberId });
		const client = ClusterClient.create(memberId, networkServedBy(service, coordinatorId), '/carried-test');
		// No peers: the service has no cohort to redirect by, so every record reaches the member.
		const record = (messageHash: string): ClusterRecord =>
			({ messageHash, peers: {}, message: { operations: [] } as unknown as RepoMessage, promises: {}, commits: {} });

		const { answer, carried } = await client.updateCarrying(record('own'), [record('owed'), record('refused')]);

		expect(applied, 'carried records first, in the order sent, then the record the request is for').to.deep.equal(['owed', 'refused', 'own']);
		expect(carried, 'one outcome per carried record; a throw fails only the record that threw').to.deep.equal([
			{ messageHash: 'owed', delivered: true, outcome: { executed: true, acceptsCarried: true } },
			{ messageHash: 'refused', delivered: false, error: 'Transaction expired' }
		]);
		expect(answer.messageHash).to.equal('own');
		expect(answer, 'the outcomes do not ride on into the answer record').to.not.have.property('carried');
	});

	it('a member that missed a commit applies it from the next request it is sent, ahead of that request\'s own record', async () => {
		// A retry interval far beyond the test, so only a carried delivery can reach the member.
		const mesh = await createMesh(3, { responsibilityK: 3, clusterSize: 3, coordinatorConfig: { commitBroadcastRetryInitialMs: 60_000 } });
		const [coordinator, missing] = mesh.nodes as [MeshNode, MeshNode, MeshNode];
		const missingId = missing.peerId.toString();
		const first = { block: 'carried-first' as BlockId, action: 'carried-first-action' };
		const second = { block: 'carried-second' as BlockId, action: 'carried-second-action' };

		// Write 1: the member votes on both operations but misses the commit operation's commit round and
		// its consensus delivery; the other two members still make the commit's majority.
		let owed: string | undefined;
		mesh.failures.onClusterDelivery = (target, record) => {
			if (target === missingId && isCommitOf(record, first.action) && Object.keys(record.commits).length > 0) {
				owed = record.messageHash;
				throw new Error('the member misses write 1\'s commit');
			}
		};
		expect((await coordinator.coordinatorRepo.pend({ actionId: first.action, transforms: transformsFor(first.block), policy: 'c' })).success, 'write 1 pend').to.equal(true);
		expect((await coordinator.coordinatorRepo.commit({ actionId: first.action, tailId: first.block, rev: 1, blockIds: [first.block] })).success, 'write 1 commit').to.equal(true);
		expect(owed, 'the member missed write 1\'s commit').to.not.equal(undefined);
		expect(await latestOn(missing, first.block), 'the member does not hold write 1').to.equal(undefined);
		expect(retryFor(coordinator, owed!)?.pendingPeers.has(missingId), 'write 1\'s delivery is owed to the member').to.equal(true);

		// Write 2: watch what reaches the member, and in what order its member applies it.
		const requests: Array<{ messageHash: string; carried: string[] }> = [];
		mesh.failures.onClusterDelivery = (target, record, carried) => {
			if (target === missingId) requests.push({ messageHash: record.messageHash, carried: carried.map(c => c.messageHash) });
		};
		const applied: string[] = [];
		const update = missing.clusterMember.update.bind(missing.clusterMember);
		missing.clusterMember.update = async (record: ClusterRecord) => {
			applied.push(record.messageHash);
			return await update(record);
		};
		expect((await coordinator.coordinatorRepo.pend({ actionId: second.action, transforms: transformsFor(second.block), policy: 'c' })).success, 'write 2 pend').to.equal(true);

		const firstRequest = requests[0]!;
		expect(firstRequest.carried, 'write 2\'s first request to the member carries write 1\'s commit').to.deep.equal([owed]);
		expect(applied.slice(0, 2), 'the member applies the carried commit ahead of the request\'s own record').to.deep.equal([owed, firstRequest.messageHash]);
		expect(await latestOn(missing, first.block), 'the member holds write 1').to.deep.equal({ actionId: first.action, rev: 1 });
		expect(retryFor(coordinator, owed!), 'write 1\'s retry is cleared').to.equal(undefined);
	});
});
