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
import type { Connection, PeerId } from '@libp2p/interface';
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

/** Poll until `from`'s peerStore holds at least one address `to` advertised through `identify`. */
async function waitForPeerStoreAddrs(from: Libp2p, to: PeerId, timeoutMs = 10_000): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entry = (await from.peerStore.all()).find(p => p.id.toString() === to.toString());
		const addrs = entry?.addresses.map(a => a.multiaddr.toString()) ?? [];
		if (addrs.length > 0) return addrs;
		if (Date.now() >= deadline) throw new Error(`no peerStore addresses for ${to.toString()} after ${timeoutMs}ms`);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

/** Poll until `from` has indexed at least one connection to `to`. */
async function waitForConnections(from: Libp2p, to: PeerId, timeoutMs = 10_000): Promise<Connection[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const conns = from.getConnections(to);
		if (conns.length > 0) return conns;
		if (Date.now() >= deadline) throw new Error(`no connection to ${to.toString()} after ${timeoutMs}ms`);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

describe('cluster service node resolvers', function () {
	this.timeout(40_000);

	let node: Libp2p | undefined;
	let peer: Libp2p | undefined;

	afterEach(async () => {
		const toStop = [peer, node].filter((n): n is Libp2p => !!n);
		node = undefined; peer = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
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

	/**
	 * Ticket: findcluster-publishes-inbound-source-addresses (gotchoices/Optimystic#13).
	 *
	 * The `getConnectionAddrs` resolver that `libp2p-node-base` wires into the cluster service is
	 * the PRODUCTION source of a redirect target's addresses whenever `record.peers` carries none.
	 * A redirect payload reaches a third party and is merged by the same `mergePeerAddresses` a
	 * cluster record is, so it obeys the same rule: only an address we dialed OUTBOUND may be
	 * published; an inbound connection's `remoteAddr` is the far side's ephemeral source socket.
	 * `cluster-service-redirect.spec.ts` stubs this resolver out, so nothing else exercises it.
	 *
	 * Two real nodes give both verdicts from one dial — the dialer holds the outbound half and the
	 * listener the inbound half of the same socket pair.
	 *
	 * Ticket: third-party-address-set-has-two-definitions. The rule has a second half, and the
	 * resolver used to be missing it: after the direction filter drops the inbound half, the peer's
	 * OWN advertised addresses — the ones `identify` delivered into the peerStore — are what is
	 * left, and for a peer reachable only through a relay they are the only real address that ever
	 * exists on this node. The listener therefore publishes the dialer's advertised addresses,
	 * where before this change it published an empty list and the redirect's recipient had nothing
	 * to dial.
	 */
	it("publishes a redirect target from outbound connections unioned with the peer's advertised addresses", async () => {
		const common = {
			bootstrapNodes: [],
			networkName: 'test-cluster-resolvers-direction',
			listenAddrs: [LISTEN_ADDR],
			arachnode: { enableRingZulu: false }
		};
		node = await createLibp2pNode({ ...common });
		peer = await createLibp2pNode({ ...common });
		const listener = node, dialer = peer;

		await dialer.dial(listener.getMultiaddrs()[0]!);

		// `dial` resolves on the dialer's side; the listener indexes its half a tick or two later.
		const inbound = await waitForConnections(listener, dialer.peerId);
		expect(inbound.map(c => c.direction), 'the listener holds only the inbound half of the dial').to.deep.equal(['inbound']);
		const outbound = await waitForConnections(dialer, listener.peerId);
		expect(outbound.map(c => c.direction), 'the dialer holds only the outbound half').to.deep.equal(['outbound']);
		// Named explicitly so the negative assertion below rejects a concrete address rather than
		// merely observing an empty list: this string is exactly what the pre-fix resolver returned.
		const sourceSocket = inbound[0]!.remoteAddr.toString();

		/** Redirect `from` a node for a cohort of only `target`, whose record entry has no addresses. */
		const redirectAddrsFor = async (from: Libp2p, target: Libp2p): Promise<string[]> => {
			const record = recordWithPeers({ [target.peerId.toString()]: { multiaddrs: [], publicKey: '' } });
			const response = await (from as any).services.cluster
				.processOperation({ operation: 'update', record }) as RedirectPayload;
			expect(response?.redirect?.reason, 'expected a redirect for a cohort we are not a member of').to.equal('not_in_cluster');
			return response.redirect.peers[0]!.addrs;
		};

		// The listener holds ONLY the inbound half, so the peerStore is its entire answer.
		const dialerAdvertised = await waitForPeerStoreAddrs(listener, dialer.peerId);
		const fromListener = await redirectAddrsFor(listener, dialer);
		expect(fromListener,
			`the dialer's ephemeral source socket (${sourceSocket}) is reachable by nobody else and must never be published`)
			.to.not.include(sourceSocket);
		expect(fromListener,
			'an inbound-only peer is not addressless: identify already told us where it listens')
			.to.not.be.empty;
		for (const addr of dialerAdvertised) {
			expect(fromListener, `the dialer advertised ${addr}; the redirect must carry it`).to.include(addr);
		}

		const outboundAddr = outbound[0]!.remoteAddr.toString();
		const listenerAdvertised = await waitForPeerStoreAddrs(dialer, listener.peerId);
		const fromDialer = await redirectAddrsFor(dialer, listener);
		expect(fromDialer[0],
			'the address we dialed ourselves is one libp2p has just succeeded with, so it leads')
			.to.equal(outboundAddr);
		for (const addr of listenerAdvertised) {
			expect(fromDialer, `the listener advertised ${addr}; the redirect must carry it too`).to.include(addr);
		}
		expect(fromDialer.length, 'the union must be de-duplicated').to.equal(new Set(fromDialer).size);
	});
});
