/**
 * Node-level wiring for `NodeOptions.connectionMonitor`.
 *
 * Two real nodes over loopback TCP, one connection between them. The dialer is given a ping
 * interval far shorter than libp2p's 10s default; its monitor stamps `Connection.rtt` on its own
 * side of the pair once a ping answers. An rtt appearing well inside that 10s default is therefore
 * the observation, and the whole claim: the supplied init reached libp2p's monitor. What the
 * monitor then does with a `pingTimeout` is libp2p's business and is deliberately not tested here —
 * except for the one part of it a deployment has to configure around, which
 * `connection-monitor-ping-overlap.spec.ts` covers: a ping that overlaps the previous one aborts
 * the connection, so the deadline a peer really gets is capped at `pingInterval`.
 *
 * NOTE: that reading rests on `ConnectionMonitor` being the only writer of `Connection.rtt` — true
 * of libp2p 3.1.x, where it is the sole assignment in the tree. If a later libp2p stamps rtt from
 * the transport or the upgrader as well, this spec starts passing for a reason that has nothing to
 * do with this option; switch the observation to a distinctive `protocolPrefix` (the monitor dials
 * `/<prefix>/ping/1.0.0`) and a handler counting it on the far side.
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

/** Short enough to fire several times inside the wait below, far enough under libp2p's 10s default
 *  that observing a single ping cannot be explained by the default. */
const PING_INTERVAL_MS = 250;

/** Bounded so a slow boot cannot flake the spec, and kept well under libp2p's 10s default so a
 *  dropped pass-through fails here rather than being rescued by the default's first ping. */
const OBSERVE_TIMEOUT_MS = 5_000;

async function waitForRtt(connection: Connection): Promise<number | undefined> {
	const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
	while (connection.rtt === undefined && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	return connection.rtt;
}

describe('connectionMonitor — node-level wiring', function () {
	// Two real libp2p boots dominate.
	this.timeout(60_000);

	const nodes: OptimysticNode[] = [];

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

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map(node => node.stop()));
	});

	it('pings on the supplied interval', async () => {
		const dialer = await spawn({ connectionMonitor: { pingInterval: PING_INTERVAL_MS } });
		const listener = await spawn();

		const connection = await dialer.dial(multiaddr(pickLocalTcpMultiaddr(listener)));

		expect(await waitForRtt(connection), `the supplied ${PING_INTERVAL_MS}ms interval did not reach libp2p's monitor`)
			.to.be.a('number');
	});
});
