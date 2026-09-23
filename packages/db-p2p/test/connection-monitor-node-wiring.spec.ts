/**
 * Node-level wiring for `NodeOptions.connectionMonitor`.
 *
 * Two real nodes over loopback TCP, one connection between them, and one observation window. The
 * dialer is given a ping interval far shorter than libp2p's 10s default; the listener is given no
 * `connectionMonitor` at all. Each node's monitor stamps `Connection.rtt` on its own side of the
 * pair after a ping answers, so within the window the dialer's side must carry an rtt and the
 * listener's must not.
 *
 * NOTE: that reading rests on `ConnectionMonitor` being the only writer of `Connection.rtt` — true
 * of libp2p 3.1.x, where it is the sole assignment in the tree. If a later libp2p stamps rtt from
 * the transport or the upgrader as well, the listener assertion starts failing for a reason that
 * has nothing to do with this option; switch the observation to a distinctive `protocolPrefix`
 * (the monitor dials `/<prefix>/ping/1.0.0`) and a handler counting it on the far side.
 *
 * That pair is the whole claim: the supplied init reached libp2p's monitor, and an omitted one left
 * libp2p's own defaults in place rather than a default of ours. What the monitor does with a
 * `pingTimeout` is libp2p's business and is deliberately not tested here.
 */
import { expect } from 'chai';
import { multiaddr } from '@multiformats/multiaddr';
import type { Connection } from '@libp2p/interface';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { Libp2pConnectionMonitorInit } from '../src/connection-monitor.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'connection-monitor-node-wiring';

/** Short enough to fire several times inside the window, far enough under libp2p's 10s default
 *  that observing a single ping cannot be explained by the default. */
const PING_INTERVAL_MS = 250;

/** How long the pair is left alone before both sides are read. */
const WINDOW_MS = 2_000;

describe('connectionMonitor — node-level wiring', function () {
	// Two real libp2p boots plus the observation window.
	this.timeout(60_000);

	const nodes: OptimysticNode[] = [];
	let outbound: Connection;
	let inbound: readonly Connection[];

	async function spawn(extra: { connectionMonitor?: Libp2pConnectionMonitorInit } = {}): Promise<OptimysticNode> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			...extra
		});
		nodes.push(node);
		return node;
	}

	before(async () => {
		const dialer = await spawn({ connectionMonitor: { pingInterval: PING_INTERVAL_MS } });
		const listener = await spawn();

		outbound = await dialer.dial(multiaddr(pickLocalTcpMultiaddr(listener)));
		await new Promise(resolve => setTimeout(resolve, WINDOW_MS));
		inbound = listener.getConnections(dialer.peerId);
	});

	after(async () => {
		await Promise.allSettled(nodes.splice(0).map(node => node.stop()));
	});

	it('pings on the supplied interval', () => {
		expect(outbound.rtt, `the supplied ${PING_INTERVAL_MS}ms interval did not reach libp2p's monitor`)
			.to.be.a('number');
	});

	it('leaves a node that supplied nothing on libp2p\'s own default interval', () => {
		expect(inbound, 'the listener still holds the dialed connection').to.have.lengthOf(1);
		expect(inbound[0]?.rtt, 'a node given no connectionMonitor pinged inside libp2p\'s default interval')
			.to.equal(undefined);
	});
});
