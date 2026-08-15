/**
 * The cluster service's node-backed resolvers must survive being called on a live node.
 *
 * `createLibp2pNode` builds the cluster service inside a service factory whose only argument is
 * libp2p's `components` Proxy. That Proxy's getter THROWS `MissingServiceError('<key> not set')`
 * for any key it does not hold, and `libp2p` is NOT one of its keys — so a resolver written as
 * `const libp2p = components.libp2p; if (!libp2p) return` threw on the *property read*, before the
 * guard could run. Neither `?.` nor a null check defends against that.
 *
 * The blast radius was every inbound cluster update: `processOperation` calls `learnPeerAddresses`
 * (→ the `recordPeerAddresses` resolver) FIRST, so each cohort member answered the coordinator with
 * a `MissingServiceError` envelope, consensus never reached super-majority, and every distributed
 * CREATE TABLE failed with `1/3 approvals (needed 2)`.
 *
 * These specs drive the real service on a real node rather than reconstructing the resolvers, since
 * the defect lived precisely in how the wiring reached the node — a hand-built components object
 * would not reproduce it.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { ClusterRecord, ClusterPeers, RepoMessage } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { RedirectPayload } from '../src/repo/redirect.js';

const LISTEN_ADDR = '/ip4/127.0.0.1/tcp/0';

async function makePeerIdString(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/** Minimal record shaped only for the ingress path under test (redirect, not consensus). */
function recordWithPeers(peers: ClusterPeers): ClusterRecord {
	return {
		messageHash: 'test-message-hash',
		peers,
		message: { operations: [] } as unknown as RepoMessage,
		promises: {},
		commits: {},
	};
}

describe('cluster service node resolvers', function () {
	this.timeout(40_000);

	let node: Libp2p | undefined;

	afterEach(async () => {
		const toStop = node;
		node = undefined;
		await toStop?.stop();
	});

	it('processes an inbound update whose record carries cohort addresses, without a MissingServiceError', async () => {
		node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-cluster-resolvers',
			listenAddrs: [LISTEN_ADDR],
			arachnode: { enableRingZulu: false }
		});

		// Two foreign members, neither of them us: `checkRedirect` returns a redirect, so this
		// exercises the two node-backed resolvers (address learning, then redirect-addr lookup)
		// and stops short of local consensus. `withAddrs` drives `recordPeerAddresses`;
		// `withoutAddrs` has no embedded multiaddrs, so the redirect falls back to
		// `getConnectionAddrs` for it.
		const withAddrs = await makePeerIdString();
		const withoutAddrs = await makePeerIdString();
		const record = recordWithPeers({
			[withAddrs]: { multiaddrs: [`/ip4/127.0.0.1/tcp/45001/p2p/${withAddrs}`], publicKey: '' },
			[withoutAddrs]: { multiaddrs: [], publicKey: '' },
		});

		const cluster = (node as any).services.cluster;
		// Before the fix this rejected with MissingServiceError('libp2p not set') out of
		// learnPeerAddresses, long before any redirect decision was made.
		const response = await cluster.processOperation({ operation: 'update', record }) as RedirectPayload;

		expect(response?.redirect?.reason, 'expected a redirect for a cohort we are not a member of').to.equal('not_in_cluster');
		expect(response.redirect.peers.map(p => p.id).sort()).to.deep.equal([withAddrs, withoutAddrs].sort());
	});

	it('keeps the address a record carried for a peer it has never connected to', async () => {
		node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-cluster-resolvers-merge',
			listenAddrs: [LISTEN_ADDR],
			arachnode: { enableRingZulu: false }
		});

		const sibling = await makePeerIdString();
		const addr = `/ip4/127.0.0.1/tcp/45002/p2p/${sibling}`;
		const record = recordWithPeers({ [sibling]: { multiaddrs: [addr], publicKey: '' } });

		const cluster = (node as any).services.cluster;
		await cluster.processOperation({ operation: 'update', record });

		// The point of learning the address at all: it must land in the peer store, so a later
		// dial of this never-met sibling has somewhere to go. `mergePeerAddresses` deliberately
		// does not await the write (nothing downstream does), so poll for it.
		let learned: string[] = [];
		for (let attempt = 0; attempt < 50 && learned.length === 0; attempt++) {
			const entry = (await node.peerStore.all()).find(p => p.id.toString() === sibling);
			learned = entry?.addresses.map(a => a.multiaddr.toString()) ?? [];
			if (learned.length === 0) await new Promise(resolve => setTimeout(resolve, 20));
		}
		// libp2p may normalize away the `/p2p/<id>` suffix, so match on the transport prefix.
		expect(
			learned.some(a => a.startsWith('/ip4/127.0.0.1/tcp/45002')),
			`expected the record's address for ${sibling} in the peer store, got: ${learned.join(', ') || '(none)'}`
		).to.equal(true);
	});
});
