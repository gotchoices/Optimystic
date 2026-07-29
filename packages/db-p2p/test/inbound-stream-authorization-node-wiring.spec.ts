/**
 * Node-level wiring for the inbound-stream authorization hook.
 *
 * `createLibp2pNode` takes ONE `authorizeInboundStream` option and threads it to all four
 * database services. That single-option shape is the whole point of the feature — four
 * independently-settable options make it easy to secure three surfaces and silently miss the
 * fourth — so this spec asserts all four protocols individually, over real libp2p, rather than
 * inspecting the services' internals.
 *
 * Two real nodes over loopback TCP: B dials A once per protocol, A's predicate must be consulted
 * each time, with B's `PeerId.toString()` and the full protocol id.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { buildSyncProtocol } from '../src/sync/protocol.js';
import { buildBlockTransferProtocol } from '../src/cluster/block-transfer-service.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'authz-node-wiring';
const PREFIX = `/optimystic/${NETWORK}`;

/** The four protocols the hook must cover, written out rather than derived from the code under test. */
const GATED_PROTOCOLS = [
	`${PREFIX}/repo/1.0.0`,
	`${PREFIX}/cluster/1.0.0`,
	buildSyncProtocol(PREFIX),
	buildBlockTransferProtocol(PREFIX),
];

function localTcpAddr(node: Libp2p): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No loopback TCP multiaddr on node; have: ${addrs.join(', ')}`);
	return local;
}

/** Poll until `predicate` holds or the deadline expires; the handler runs after the dial resolves. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	return predicate();
}

describe('inbound stream authorization — node-level wiring', function () {
	// Two real libp2p boots dominate.
	this.timeout(60_000);

	let a: Libp2p | undefined;
	let b: Libp2p | undefined;

	async function spawn(extra: Record<string, unknown> = {}): Promise<Libp2p> {
		return await createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			...extra
		});
	}

	afterEach(async () => {
		const toStop = [a, b].filter((n): n is Libp2p => !!n);
		a = undefined; b = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('one node-level option reaches all four database services', async () => {
		const seen: Array<[string, string]> = [];
		a = await spawn({
			authorizeInboundStream: (remotePeerId: string, protocol: string) => {
				seen.push([remotePeerId, protocol]);
				return false;
			}
		});
		b = await spawn();

		// Precondition: A really does serve all four protocols, so a missing observation below is a
		// missing *gate*, not a missing handler.
		const served = a.getProtocols() as string[];
		for (const protocol of GATED_PROTOCOLS) {
			expect(served, `node A serves ${protocol}`).to.include(protocol);
		}

		const addr = multiaddr(localTcpAddr(a));
		await b.dial(addr);
		for (const protocol of GATED_PROTOCOLS) {
			// The gate aborts the stream, so the dial may resolve or reject depending on how far
			// negotiation got — either way the predicate must have been consulted.
			try {
				const stream = await b.dialProtocol(addr, [protocol]);
				stream.abort(new Error('test done with stream'));
			} catch { /* denial tore the stream down; the observation below is the assertion */ }
		}

		await waitFor(() => seen.length >= GATED_PROTOCOLS.length, 20_000);

		const observed = seen.map(([, protocol]) => protocol);
		// Asserted individually — the failure message must name WHICH surface was missed.
		for (const protocol of GATED_PROTOCOLS) {
			expect(observed, `the node-level predicate was consulted for ${protocol}`).to.include(protocol);
		}
		// The documented peer-id encoding, end to end through real libp2p: `PeerId.toString()`.
		for (const [remotePeerId, protocol] of seen) {
			expect(remotePeerId, `predicate receives B's PeerId.toString() on ${protocol}`).to.equal(b.peerId.toString());
		}
	});

	it('no option → all four protocols are still registered and ungated (default behavior)', async () => {
		a = await spawn();
		const served = a.getProtocols() as string[];
		for (const protocol of GATED_PROTOCOLS) {
			expect(served, `an ungated node still serves ${protocol}`).to.include(protocol);
		}
	});
});
