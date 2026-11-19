/**
 * Announcements answered between two real machines (docs/blobs.md §Placement, copying and
 * durability): the writer announces a committed reference, the other node reads committed state for
 * itself, takes the `responsible` hold before it answers `fetching`, pulls the blob and then answers
 * `whole`; and a responsible node that merely reads a referenced blob keeps it ("Readers repair").
 */
import { expect } from 'chai';
import { multiaddr } from '@multiformats/multiaddr';
import { BlobReferenceTree, BlobScopeRegistry, routingKeyForBlob, type BlobRef, type BlobScope, type ITransactor } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { BlobProtocolClient } from '../src/blob/blob-protocol-client.js';
import { buildBlobProtocol } from '../src/blob/blob-protocol.js';
import { createNodeNetworkTransactor } from '../src/node-network-transactor.js';
import { concat, localTcpAddr, streamOf, until } from './support/blob-mesh.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'blob-announce';
const PREFIX = `/optimystic/${NETWORK}`;
const SCOPE: BlobScope = 'app/photos/blobrefs';

/** Bytes that differ by `seed`, so two blobs in one spec never share a piece id. */
function bytesOf(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let state = seed * 2654435761 >>> 0;
	for (let index = 0; index < length; index++) {
		state = (state * 1103515245 + 12345) >>> 0;
		bytes[index] = state >>> 24;
	}
	return bytes;
}

describe('blob announcements answered over the network', function () {
	// Two real libp2p boots and real commits through the cohort dominate.
	this.timeout(120_000);

	let nodes: OptimysticNode[] = [];

	afterEach(async () => {
		const toStop = nodes;
		nodes = [];
		await Promise.allSettled(toStop.map(node => node.stop()));
	});

	/** Two serving nodes, each in every cohort (`clusterSize: 2`), that know the other serves the blob protocol. */
	async function startPair(): Promise<{ a: OptimysticNode; b: OptimysticNode }> {
		const spawn = (): Promise<OptimysticNode> => createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 2,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
		});
		const a = await spawn();
		nodes.push(a);
		const b = await spawn();
		nodes.push(b);
		await b.dial(multiaddr(localTcpAddr(a)));
		const protocol = buildBlobProtocol(PREFIX);
		await until(async () => (await b.keyNetwork.peersServing(protocol, [a.peerId.toString()])).length === 1, 'B knows A serves the blob protocol');
		await until(async () => (await a.keyNetwork.peersServing(protocol, [b.peerId.toString()])).length === 1, 'A knows B serves the blob protocol');
		return { a, b };
	}

	/** The transactor a host over `node` would build: the one construction the node reads committed state through. */
	function transactorOver(node: OptimysticNode): ITransactor {
		return createNodeNetworkTransactor({
			peerId: node.peerId,
			keyNetwork: node.keyNetwork,
			coordinatedRepo: node.coordinatedRepo,
			storageRepo: node.storageRepo,
			protocolPrefix: PREFIX,
			linkDeadlines: node.linkDeadlines,
			clock: node.hlcClock,
		});
	}

	/** A blob put and pinned on `a`, with its reference committed in {@link SCOPE} through `net`. */
	async function referencedBlob(a: OptimysticNode, net: ITransactor, seed: number, referrer: string): Promise<BlobRef> {
		const { ref } = await a.blobs.put(streamOf(bytesOf(4 * 1024, seed)));
		const references = await BlobReferenceTree.createOrOpen(net, SCOPE);
		await references.stageAdd(ref, referrer);
		await references.tree.sync();
		return ref;
	}

	async function untilBothInCohort(node: OptimysticNode, ref: BlobRef): Promise<void> {
		await until(async () => Object.keys(await node.keyNetwork.findCluster(routingKeyForBlob(ref))).length === 2,
			"the blob's cohort holds both nodes");
	}

	it('pulls an announced blob after reading the reference for itself, and answers whole once it has it', async () => {
		const { a, b } = await startPair();
		const net = transactorOver(a);
		await BlobScopeRegistry.register(net, SCOPE);
		const ref = await referencedBlob(a, net, 1, 'row-1');
		await untilBothInCohort(a, ref);

		const client = new BlobProtocolClient({ peerNetwork: a.keyNetwork, protocolPrefix: PREFIX, deadlines: a.linkDeadlines });
		expect(await client.announce(b.peerId, ref, SCOPE), 'the first answer').to.equal('fetching');
		// Flushed before the answer, so a restart after `fetching` resumes the pull.
		expect(await b.blobs.local.responsibleScope(ref), 'the hold B took before answering').to.equal(SCOPE);

		await until(async () => (await b.blobs.local.stat(ref)).locality === 'here', 'B has pulled the whole blob');
		expect(await client.announce(b.peerId, ref, SCOPE), 'the answer once B holds it').to.equal('whole');
	});

	it('keeps a referenced blob it fetched for a read, with no announcement at all', async () => {
		const { a, b } = await startPair();
		const net = transactorOver(a);
		await BlobScopeRegistry.register(net, SCOPE);
		const ref = await referencedBlob(a, net, 2, 'row-2');
		await untilBothInCohort(b, ref);

		const read = await concat(b.blobs.read(ref));
		expect(read.byteLength, 'the bytes B read').to.equal(4 * 1024);
		// Reader repair runs after the read's fetch has settled, so it is reached by polling.
		await until(async () => await b.blobs.local.responsibleScope(ref) === SCOPE, 'B keeps what it read under the scope');
	});
});
