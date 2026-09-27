/**
 * Node-level wiring for `NodeOptions.connectionManager`.
 *
 * Two real nodes over loopback TCP. Each case gives one side a 1ms deadline — far below what a
 * Noise + yamux upgrade takes even on loopback, and four orders of magnitude under libp2p's 10s
 * defaults — so a failed dial is only explained by the supplied value reaching libp2p's
 * connection manager. The control dial with nothing declared shows the pair connects otherwise.
 */
import { expect } from 'chai';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { Libp2pConnectionTimeouts } from '../src/connection-monitor.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'connection-timeouts-node-wiring';

const TOO_SHORT_MS = 1;

describe('connectionManager timeouts — node-level wiring', function () {
	// Two real libp2p boots dominate.
	this.timeout(60_000);

	const nodes: OptimysticNode[] = [];

	async function spawn(connectionManager?: Libp2pConnectionTimeouts): Promise<OptimysticNode> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			...(connectionManager ? { connectionManager } : {})
		});
		nodes.push(node);
		return node;
	}

	async function dialFails(dialer: OptimysticNode, listener: OptimysticNode): Promise<boolean> {
		try {
			await dialer.dial(multiaddr(pickLocalTcpMultiaddr(listener)));
			return false;
		} catch {
			return true;
		}
	}

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map(node => node.stop()));
	});

	it('connects with nothing declared', async () => {
		const dialer = await spawn();
		const listener = await spawn();
		expect(await dialFails(dialer, listener)).to.equal(false);
	});

	it("applies the dialer's dialTimeout", async () => {
		const dialer = await spawn({ dialTimeout: TOO_SHORT_MS });
		const listener = await spawn();
		expect(await dialFails(dialer, listener), 'the supplied dialTimeout did not reach libp2p').to.equal(true);
	});

	it("applies the listener's inboundUpgradeTimeout", async () => {
		const dialer = await spawn();
		const listener = await spawn({ inboundUpgradeTimeout: TOO_SHORT_MS });
		expect(await dialFails(dialer, listener), 'the supplied inboundUpgradeTimeout did not reach libp2p').to.equal(true);
	});
});
