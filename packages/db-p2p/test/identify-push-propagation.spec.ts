/**
 * Regression guard for gotchoices/Optimystic#7 on the PROTOCOL half of the identify/push payload.
 *
 * `identify()` exchanges a peer's address and protocol lists exactly once, when the connection
 * opens. `identifyPush()` is the companion that subscribes to libp2p's `self:peer:update` event
 * and re-pushes those lists to every already-connected peer. Without it registered, nothing in the
 * tree consumes that event, so anything a node learns or registers after a connection is open is
 * invisible to the peer on the other end of it — forever, for the life of that connection.
 *
 * Why that matters beyond addresses: `Libp2pKeyPeerNetwork.membershipOf` classifies a peer as
 * `serves` / `foreign` / `unknown` purely from the protocol list in the local peerStore, and
 * coordinator and cohort selection drop everything that is not `serves`. A `cluster` or `repo`
 * handler registered after the initial identify exchange therefore never flips an already-connected
 * peer to `serves` unless push delivers it. `libp2p-node-base.ts` asserts exactly that in a comment
 * next to the `identifyPush` registration; this spec is what makes the claim true rather than
 * asserted.
 *
 * Two real nodes over loopback TCP. It is in the DEFAULT suite (not gated): a full pass is a couple
 * of seconds, dominated by the two libp2p debounce windows described in `util/peer-store-wait.ts`.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { waitForPeerStoreProtocols } from './util/peer-store-wait.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'identify-push-propagation';

/**
 * A SECOND network's cluster protocol id, registered late on node A.
 *
 * Using a different network than the one both nodes booted on is what makes the classification
 * flip observable. Both nodes already advertise `/optimystic/identify-push-propagation/cluster/1.0.0`
 * from construction, so under that prefix A is `serves` before the test even starts and there is
 * nothing to observe. Scoping the key network under test to `LATE_NETWORK` instead makes A start
 * out `foreign` — it serves *a* network, just not this one — and flip to `serves` only if the
 * late registration propagates.
 */
const LATE_NETWORK = 'identify-push-late-joined';
const LATE_PREFIX = `/optimystic/${LATE_NETWORK}`;
const LATE_CLUSTER_PROTOCOL = `${LATE_PREFIX}/cluster/1.0.0`;

/** `/optimystic/<net>/id/push/1.0.0` — the id `@libp2p/identify`'s push service registers. */
const PUSH_PROTOCOL = `/optimystic/${NETWORK}/id/push/1.0.0`;

function localTcpAddr(node: Libp2p): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No loopback TCP multiaddr on node; have: ${addrs.join(', ')}`);
	return local;
}

describe('identify/push — late protocol registration reaches already-connected peers', function () {
	// Two real libp2p boots plus the address-manager + push debounce windows.
	this.timeout(60_000);

	let a: Libp2p | undefined;
	let b: Libp2p | undefined;

	async function spawn(): Promise<Libp2p> {
		return await createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false }
		} as any);
	}

	afterEach(async () => {
		const toStop = [a, b].filter((n): n is Libp2p => !!n);
		a = undefined; b = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('a protocol registered AFTER the initial identify exchange propagates, and flips membershipOf to serves', async () => {
		a = await spawn();
		b = await spawn();

		await b.dial(multiaddr(localTcpAddr(a)));

		// Wait for the INITIAL identify exchange to have completed in both directions before
		// registering anything late. If the late handler existed while identify was still in flight
		// it could ride that first exchange, and the test would pass without push ever running.
		const initial = await waitForPeerStoreProtocols(b, a.peerId, 15_000, p => p.length > 0);
		expect(initial.matched, 'B learned A\'s protocol list from the initial identify exchange').to.equal(true);
		const aSeesB = await waitForPeerStoreProtocols(a, b.peerId, 15_000, p => p.includes(PUSH_PROTOCOL));
		// A only pushes to connected peers whose peerStore entry advertises the push protocol, so
		// this is a precondition of the mechanism, not incidental bookkeeping. Both peers come from
		// the same factory, so it holds by construction — assert it so a failure below is not
		// mis-read as a propagation failure when it is really a registration one.
		expect(aSeesB.matched, 'A sees B supporting identify/push (the push target precondition)').to.equal(true);

		const before = initial.protocols;
		expect(before, 'the late protocol is genuinely absent before registration').to.not.include(LATE_CLUSTER_PROTOCOL);

		// The classification B would make of A right now, scoped to the network A has not joined yet.
		const keyNetwork = new Libp2pKeyPeerNetwork(b, 1, undefined, 'forming', undefined, undefined, LATE_PREFIX);
		const membershipOf = (protocols: string[]): string =>
			(keyNetwork as any).membershipOf(a!.peerId.toString(), protocols);
		expect(membershipOf(before), 'A serves some network, but not this one, before the late handler')
			.to.equal('foreign');

		// Register the late handler on A. `registrar.handle` patches A's own peerStore record, which
		// emits `self:peer:update`, which is the event identifyPush subscribes to.
		await a.handle(LATE_CLUSTER_PROTOCOL, () => { /* presence is the whole assertion */ });

		const after = await waitForPeerStoreProtocols(b, a.peerId, 20_000, p => p.includes(LATE_CLUSTER_PROTOCOL));
		expect(after.matched,
			`B never learned A's late protocol; B's peerStore for A holds: ${JSON.stringify(after.protocols)}`)
			.to.equal(true);

		// The user-visible consequence: A is now selectable as a coordinator / cohort member on the
		// late-joined network. Without identifyPush this stays `foreign` for the life of the connection.
		expect(membershipOf(after.protocols), 'the propagated handler flips A to serves')
			.to.equal('serves');
	});
});
