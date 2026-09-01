/**
 * Lock spec for the COMPLETE set of libp2p services `createLibp2pNodeBase` registers.
 *
 * Supersedes the former `dcutr-autonat-registration.spec.ts`, which asserted
 * `expect(services.dcutr).to.not.equal(undefined)` — one named member at a time. That pattern is
 * structurally incapable of catching a *missing* service: you can only assert over names you
 * already thought of, and `identifyPush` was on nobody's list, which is how gotchoices/Optimystic#7
 * (address changes never reaching already-connected peers) shipped. So this spec asserts the whole
 * key set against a written-out literal: adding, dropping, or renaming a service fails here until
 * the literal is updated deliberately.
 *
 * It covers the same two spawn shapes the old spec did (default TCP node, browser-shaped WS-only
 * custom-transports node), plus the `@optimystic/db-p2p/rn` factory — which shares the same base
 * and therefore inherits the same services — and a `relay: true` node, the one branch of the
 * services map that adds a key.
 *
 * Behavioral coverage lives elsewhere: hole-punching in `dcutr-direct-upgrade.spec.ts`, identify
 * protocol ids in `identify-protocol-id.spec.ts`, and identify/push address propagation in
 * `relay-address-propagation.spec.ts` / `identify-push-propagation.spec.ts`. This one only proves
 * the map is intact.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createLibp2pNode, type Libp2pTransports } from '../src/libp2p-node.js';
import { createLibp2pNode as createLibp2pNodeRn } from '../src/libp2p-node-rn.js';
import { expectWellFormedProtocolIds } from './util/protocol-ids.js';

/**
 * Every service key `createLibp2pNodeBase` registers on a non-relay node, written out as a
 * literal rather than derived from the code under test. Deriving it would restate whatever the
 * services map happens to contain and assert nothing.
 *
 *  - `identify` / `identifyPush` — peer metadata exchange at connection-open time, and the
 *    re-push of later address/protocol changes to already-connected peers (#7).
 *  - `ping` / `dcutr` / `autoNAT` — liveness, hole-punch upgrade of relayed connections, and
 *    public-reachability discovery.
 *  - `cluster` / `repo` / `sync` / `blockTransfer` — the Optimystic protocol handlers.
 *
 * No `pubsub` key: the `gossipsub` registration was removed (gotchoices/Optimystic#9) because it
 * cannot work on this repo's libp2p 3 — gossipsub's newest release (14.1.2) is built against
 * `@libp2p/interface@^2`, whose `Stream` shape `it-pipe` needs no longer exists on libp2p 3's
 * `Stream`, so every outbound gossipsub stream throws and `publish` silently reaches nobody.
 *  - `networkManager` / `fret` — cluster sizing policy and the FRET routing table.
 *
 * `relay` (the circuit-relay *server*) is deliberately absent: it is registered only when
 * `options.relay` is true, and is asserted separately below.
 */
const EXPECTED_SERVICE_KEYS = [
	'autoNAT',
	'blockTransfer',
	'cluster',
	'dcutr',
	'fret',
	'identify',
	'identifyPush',
	'networkManager',
	'ping',
	'repo',
	'sync'
].sort();

function serviceKeysOf(node: Libp2p): string[] {
	const services = (node as Libp2p & { services: Record<string, unknown> }).services;
	return Object.keys(services).sort();
}

describe('node service set (createLibp2pNodeBase)', function () {
	// Real libp2p boot + FRET seeding dominate.
	this.timeout(40_000);

	it('a default (TCP) node registers exactly the expected services', async () => {
		const node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-service-set-default',
			arachnode: { enableRingZulu: false }
		});
		try {
			expect(serviceKeysOf(node), 'complete services key set on a default node')
				.to.deep.equal(EXPECTED_SERVICE_KEYS);
			expectWellFormedProtocolIds(node.getProtocols() as string[], 'default TCP node');
		} finally {
			await node.stop();
		}
	});

	it('a browser-shaped (WS-only custom transports) node registers the same set', async () => {
		const transports: Libp2pTransports = [webSockets(), circuitRelayTransport()];
		const node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-service-set-browser',
			transports,
			listenAddrs: [],
			arachnode: { enableRingZulu: false }
		});
		try {
			expect(serviceKeysOf(node), 'complete services key set on a browser-shaped node')
				.to.deep.equal(EXPECTED_SERVICE_KEYS);
			expectWellFormedProtocolIds(node.getProtocols() as string[], 'browser-shaped node');
		} finally {
			await node.stop();
		}
	});

	it('the /rn factory path registers the same set (it shares createLibp2pNodeBase)', async () => {
		// The RN entrypoint refuses to pick transports for the caller, so it gets the browser shape.
		const transports: Libp2pTransports = [webSockets(), circuitRelayTransport()];
		const node = await createLibp2pNodeRn({
			bootstrapNodes: [],
			networkName: 'test-service-set-rn',
			transports,
			listenAddrs: [],
			arachnode: { enableRingZulu: false }
		});
		try {
			const keys = serviceKeysOf(node);
			expect(keys, 'complete services key set on an RN-factory node').to.deep.equal(EXPECTED_SERVICE_KEYS);
			// Called out explicitly because the RN subpath is a separate published entrypoint that a
			// reader can easily assume is a different node builder: it is not, and #7's fix reaches it.
			expect(keys, 'the RN entrypoint inherits identifyPush (#7)').to.include('identifyPush');
			expectWellFormedProtocolIds(node.getProtocols() as string[], 'RN-factory node');
		} finally {
			await node.stop();
		}
	});

	it('relay: true adds the circuit-relay server service and nothing else', async () => {
		const node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-service-set-relay',
			relay: true,
			arachnode: { enableRingZulu: false }
		});
		try {
			expect(serviceKeysOf(node), 'relay node adds exactly `relay` to the base set')
				.to.deep.equal([...EXPECTED_SERVICE_KEYS, 'relay'].sort());
			expectWellFormedProtocolIds(node.getProtocols() as string[], 'relay node');
		} finally {
			await node.stop();
		}
	});
});
