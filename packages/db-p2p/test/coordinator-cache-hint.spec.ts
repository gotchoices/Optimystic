import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { pipe } from 'it-pipe';
import { encode as lpEncode } from 'it-length-prefixed';
import type { PeerId } from '@libp2p/interface';
import type {
	IPeerNetwork, PeerId as CorePeerId, ClusterRecord, RepoMessage,
	CommitRequest, PendRequest, IBlock, BlockGets, ActionBlocks
} from '@optimystic/db-core';
import { routingKeyForBlock } from '@optimystic/db-core';
import { RepoClient } from '../src/repo/client.js';
import { ClusterClient } from '../src/cluster/client.js';

async function makePeerId(): Promise<PeerId> {
	const pk = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(pk);
}

/** Minimal valid IBlock for a pend transforms fixture. */
const makeBlock = (id: string): IBlock => ({ header: { id, type: 'test', collectionId: 'c1' } });

/** Compare two byte arrays as plain number arrays so chai's deep-equal works. */
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

/** Length-prefix encode a JSON value into the byte chunks a libp2p stream yields. */
async function encodeJson(value: unknown): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of pipe([new TextEncoder().encode(JSON.stringify(value))], lpEncode)) {
		chunks.push(chunk.subarray());
	}
	return chunks;
}

/** A fake libp2p stream that simply replays `chunks` to the response reader. */
function streamReplaying(chunks: Uint8Array[]) {
	return {
		send: () => {},
		close: async () => {},
		abort: () => {},
		async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
	};
}

/**
 * Fake IPeerNetwork whose FIRST dial replies with a `redirect` to `redirectTo`
 * (so the client's coordinator-cache-hint path runs exactly once) and whose
 * SECOND dial replies with `terminal` (so the redirect retry stops). Every
 * recordCoordinator(keyBytes, peerId) the client makes is captured in `recorded`.
 */
function makeRedirectNetwork(redirectTo: PeerId, terminal: unknown) {
	const recorded: Array<{ key: Uint8Array, peerId: PeerId }> = [];
	let dials = 0;
	const network = {
		async connect(_p: CorePeerId, _proto: string) {
			const isFirst = dials === 0;
			dials += 1;
			const payload = isFirst
				? { redirect: { peers: [{ id: redirectTo.toString() }] } }
				: terminal;
			return streamReplaying(await encodeJson(payload)) as unknown;
		},
		recordCoordinator(key: Uint8Array, peerId: PeerId) {
			recorded.push({ key, peerId });
		},
	} as unknown as IPeerNetwork;
	return { network, recorded, dialCount: () => dials };
}

// A near-future expiration keeps RepoClient's internal timeout timer from
// lingering ~30s after the (instant) stub responds, while leaving ample headroom.
const soonExpiring = () => ({ expiration: Date.now() + 2000 });

describe('RepoClient coordinator-cache hint key', () => {
	// Defect 2: commit must key on blockIds[0] (where consensus runs), not tailId.
	// Defect 1: the key must be the block's routing key (routingKeyForBlock) — the exact bytes
	// findCoordinator looks the hint up by, which are the raw utf8 of the id, never a digest of it.
	it('records a non-tail commit under routingKeyForBlock(blockIds[0]) — not tailId', async () => {
		const startPeer = await makePeerId();
		const coordinator = await makePeerId();
		const { network, recorded, dialCount } = makeRedirectNetwork(coordinator, { success: true });
		const client = RepoClient.create(startPeer, network, '/optimystic/test');

		const request: CommitRequest = {
			blockIds: ['block-A', 'block-B'], // blockIds[0] = 'block-A'
			actionId: 'a1',
			tailId: 'tail-Z',                 // deliberately != blockIds[0]
			rev: 1,
		};
		await client.commit(request, soonExpiring());

		expect(dialCount(), 'redirect should have driven exactly two dials').to.equal(2);
		expect(recorded).to.have.length(1);
		expect(recorded[0]!.peerId.toString()).to.equal(coordinator.toString());

		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('block-A')), 'key must be routingKeyForBlock(blockIds[0])').to.equal(true);
		expect(bytesEqual(recorded[0]!.key, new TextEncoder().encode('block-A')), 'the routing key is the raw utf8 of the id').to.equal(true);

		// Prove it is NOT the old (wrong) anchor.
		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('tail-Z')), 'must not key on tailId').to.equal(false);
	});

	// Defect 3: pend must key on a real block id (blockIdsForTransforms), not the
	// structural transforms field name ('inserts'/'updates'/'deletes').
	it('records a pend under routingKeyForBlock(block-A) — not the literal "inserts" field name', async () => {
		const startPeer = await makePeerId();
		const coordinator = await makePeerId();
		const { network, recorded } = makeRedirectNetwork(coordinator, { success: true, pending: [], blockIds: ['block-A'] });
		const client = RepoClient.create(startPeer, network, '/optimystic/test');

		const request: PendRequest = {
			transforms: { inserts: { 'block-A': makeBlock('block-A') }, updates: {}, deletes: [] },
			actionId: 'a1',
			policy: 'c',
		};
		await client.pend(request, soonExpiring());

		expect(recorded).to.have.length(1);
		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('block-A')), 'key must be routingKeyForBlock(block-A)').to.equal(true);
		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('inserts')), 'must not key on the field name').to.equal(false);
	});

	// The get branch keys on routingKeyForBlock(blockIds[0]), matching RepoService.deriveBlockKey('get') → blockIds[0].
	it('records a get under routingKeyForBlock(blockIds[0])', async () => {
		const startPeer = await makePeerId();
		const coordinator = await makePeerId();
		const { network, recorded } = makeRedirectNetwork(coordinator, {});
		const client = RepoClient.create(startPeer, network, '/optimystic/test');

		const gets: BlockGets = { blockIds: ['block-A', 'block-B'] };
		await client.get(gets, soonExpiring());

		expect(recorded).to.have.length(1);
		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('block-A')), 'key must be routingKeyForBlock(blockIds[0])').to.equal(true);
	});

	// The cancel branch keys on routingKeyForBlock(actionRef.blockIds[0]), matching deriveBlockKey('cancel').
	it('records a cancel under routingKeyForBlock(actionRef.blockIds[0])', async () => {
		const startPeer = await makePeerId();
		const coordinator = await makePeerId();
		const { network, recorded } = makeRedirectNetwork(coordinator, {});
		const client = RepoClient.create(startPeer, network, '/optimystic/test');

		const actionRef: ActionBlocks = { actionId: 'a1', blockIds: ['block-A', 'block-B'] };
		await client.cancel(actionRef, soonExpiring());

		expect(recorded).to.have.length(1);
		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('block-A')), 'key must be routingKeyForBlock(actionRef.blockIds[0])').to.equal(true);
	});
});

describe('ClusterClient coordinator-cache hint key', () => {
	// Defect 0: the old code read record.message.commit/.pend, which never exist
	// (the op lives at record.message.operations[0]), so recordCoordinator was
	// NEVER called. These tests prove it is now invoked at all, with the right key.
	it('invokes recordCoordinator with routingKeyForBlock(blockIds[0]) for a non-tail commit', async () => {
		const startPeer = await makePeerId();
		const coordinator = await makePeerId();
		const message: RepoMessage = {
			operations: [{ commit: { blockIds: ['block-A', 'block-B'], actionId: 'a1', tailId: 'tail-Z', rev: 1 } }],
		};
		const record: ClusterRecord = {
			messageHash: 'h-commit',
			peers: {},
			message,
			promises: {},
			commits: {},
		};
		const { network, recorded, dialCount } = makeRedirectNetwork(coordinator, record);
		const client = ClusterClient.create(startPeer, network, '/optimystic/test');

		await client.update(record);

		expect(dialCount(), 'redirect should have driven exactly two dials').to.equal(2);
		expect(recorded, 'recordCoordinator must now be invoked (was dead code)').to.have.length(1);
		expect(recorded[0]!.peerId.toString()).to.equal(coordinator.toString());

		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('block-A')), 'key must be routingKeyForBlock(blockIds[0])').to.equal(true);
		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('tail-Z')), 'must not key on tailId').to.equal(false);
	});

	it('invokes recordCoordinator with routingKeyForBlock(block-A) for a pend', async () => {
		const startPeer = await makePeerId();
		const coordinator = await makePeerId();
		const message: RepoMessage = {
			operations: [{ pend: { transforms: { inserts: { 'block-A': makeBlock('block-A') }, updates: {}, deletes: [] }, actionId: 'a1', policy: 'c' } }],
		};
		const record: ClusterRecord = {
			messageHash: 'h-pend',
			peers: {},
			message,
			promises: {},
			commits: {},
		};
		const { network, recorded } = makeRedirectNetwork(coordinator, record);
		const client = ClusterClient.create(startPeer, network, '/optimystic/test');

		await client.update(record);

		expect(recorded, 'recordCoordinator must now be invoked (was dead code)').to.have.length(1);
		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('block-A')), 'key must be routingKeyForBlock(block-A)').to.equal(true);
		expect(bytesEqual(recorded[0]!.key, routingKeyForBlock('inserts')), 'must not key on the field name').to.equal(false);
	});
});
