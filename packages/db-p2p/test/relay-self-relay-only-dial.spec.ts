/**
 * Regression guard for gotchoices/Optimystic#14, over real sockets.
 *
 * A relay-only client reserves a circuit on a relay, and the only address it can advertise is
 * `/<relay's transport addr>/p2p/<relay's peer id>/p2p-circuit`. That address is right for every
 * node in the mesh except one: the relay itself, which would have to relay to the client through
 * itself to use it. So the relay ends up holding a NON-empty address book entry that it can never
 * dial, and libp2p reports the resulting failure with the same text as "we were never told an
 * address" — two conditions, one error, and only one of them ever repaired by a retry.
 *
 * The spec builds the topology that produces it: relay `R`, relay-only client `C`, and a control
 * arm `H` — an ordinary peer with real listen addresses. Both `C` and `H` are then STOPPED, so
 * neither can re-dial while its address-book entry at `R` survives. (Stopping matters: a live
 * relay-only client re-dials the relay immediately, and the dial then succeeds over the fresh
 * connection — the bug is only visible once the client is gone.) `H` is what makes the assertion
 * mean anything: without it, an error raised for any reason at all would satisfy the test.
 *
 * **Runtime.** ~5 s (three real libp2p boots over loopback, plus the reservation/identifyPush
 * round trip), so like `relay-inbound-source-address.spec.ts` it is NOT env-gated.
 */
import { expect } from 'chai';
import type { PeerId } from '@libp2p/interface';
import { SelfRelayOnlyAddressesError } from '../src/libp2p-key-network.js';
import { routesThroughRelay } from '../src/peer-address-book.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { spawnRelayNode, spawnCircuitOnlyPeer, spawnTcpServicePeer, pickRelayTcpAddr, pickRelayWsAddr, waitForCircuitListen } from './util/relay-topology.js';

/** Distinct per-spec: the identify protocol ids are network-scoped, so a shared name lets specs cross-talk. */
const NETWORK = 'relay-self-relay-only-dial';

/** Any protocol id will do — no dial in this spec is ever expected to reach protocol negotiation. */
const PROTOCOL = '/optimystic/test/self-relay/1.0.0';

/**
 * Budget for the client's circuit address to reach the relay's peerStore. Two chained debounces
 * sit in that path — libp2p's `AddressManager` coalesces listen-address changes for ~1000 ms
 * before patching the self record, and `@libp2p/identify` debounces the push a further 1000 ms.
 */
const PROPAGATION_TIMEOUT_MS = 20_000;

/**
 * Ceiling for the refused dial. Deliberately far below libp2p's ~30 s default dial timeout: the
 * value of failing fast is that the caller can move to another cohort member, and a check that
 * only asserted "it eventually threw" would pass just as happily on the old, doomed dial.
 */
const FAST_FAILURE_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Multiaddr strings `node` holds for `peerId` — empty when the peerStore has no entry. */
async function heldAddrs(node: OptimysticNode, peerId: PeerId): Promise<string[]> {
	try {
		const peer = await node.peerStore.get(peerId);
		return peer.addresses.map(a => a.multiaddr.toString());
	} catch {
		// `peerStore.get` throws for an unknown peer; indistinguishable from holding nothing.
		return [];
	}
}

/** Poll until `predicate` holds for the addresses `node` has for `peerId`, or time out. */
async function waitForHeldAddrs(
	node: OptimysticNode,
	peerId: PeerId,
	predicate: (addrs: string[]) => boolean,
	what: string,
	timeoutMs: number
): Promise<string[]> {
	const start = Date.now();
	let addrs: string[] = [];
	while (Date.now() - start < timeoutMs) {
		addrs = await heldAddrs(node, peerId);
		if (predicate(addrs)) return addrs;
		await sleep(50);
	}
	throw new Error(`Timed out waiting for ${what}; last held: ${JSON.stringify(addrs)}`);
}

/** Poll until `node` holds no open connection to `peerId`. */
async function waitForNoConnection(node: OptimysticNode, peerId: PeerId, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (node.getConnections(peerId).length === 0) return;
		await sleep(50);
	}
	throw new Error(`Connection to ${peerId.toString()} never closed`);
}

/** Run `connect` and return the rejection (or `undefined` if it unexpectedly succeeded) with its wall time. */
async function connectFailure(
	node: OptimysticNode,
	peerId: PeerId
): Promise<{ err: unknown, elapsedMs: number }> {
	const t0 = Date.now();
	const err = await node.keyNetwork.connect(peerId, PROTOCOL).then(
		stream => { void stream.close?.(); return undefined; },
		(e: unknown) => e
	);
	return { err, elapsedMs: Date.now() - t0 };
}

describe('a relay cannot dial its own reservation holders', function () {
	this.timeout(120_000);

	let relay: OptimysticNode | undefined;
	let client: OptimysticNode | undefined;
	let control: OptimysticNode | undefined;

	afterEach(async () => {
		const toStop = [client, control, relay].filter((n): n is OptimysticNode => !!n);
		client = undefined; control = undefined; relay = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('fails fast and distinctly when every address it holds routes back through itself', async function () {
		this.timeout(90_000);

		relay = await spawnRelayNode(NETWORK);
		const relayNode = relay;
		const relayWs = pickRelayWsAddr(relay);
		const relayTcp = pickRelayTcpAddr(relay);

		// `C` is browser-shaped: no direct listener, so the ONLY address it can ever advertise is
		// the circuit through `R`. `H` is an ordinary peer with a real TCP listener, so the
		// addresses `R` learns for it are directly dialable.
		client = await spawnCircuitOnlyPeer(NETWORK, relayWs);
		control = await spawnTcpServicePeer(NETWORK, relayTcp);
		const clientId = client.peerId;
		const controlId = control.peerId;

		// The reservation has to land before the address exists to be learned.
		await waitForCircuitListen(client, PROPAGATION_TIMEOUT_MS);

		const clientHeld = await waitForHeldAddrs(
			relayNode, clientId,
			addrs => addrs.some(a => a.includes('/p2p-circuit')),
			`the relay to learn ${clientId.toString().substring(0, 12)}'s circuit address via identifyPush`,
			PROPAGATION_TIMEOUT_MS
		);
		const controlHeld = await waitForHeldAddrs(
			relayNode, controlId,
			addrs => addrs.length > 0,
			`the relay to learn ${controlId.toString().substring(0, 12)}'s listen addresses via identify`,
			PROPAGATION_TIMEOUT_MS
		);

		// The premise, stated as an assertion rather than assumed: everything the relay knows about
		// `C` routes through the relay, and nothing it knows about `H` does.
		const noop = (): void => { };
		const selfId = relayNode.peerId.toString();
		expect(clientHeld.filter(a => !routesThroughRelay(a, selfId, noop)),
			`the relay holds an address for the client that does NOT route through itself, so this spec is not testing the reported condition: ${JSON.stringify(clientHeld)}`)
			.to.deep.equal([]);
		expect(controlHeld.some(a => !routesThroughRelay(a, selfId, noop)),
			`the control arm must be reachable by a route that is not our own relay; held: ${JSON.stringify(controlHeld)}`)
			.to.equal(true);

		// Stop both. A live relay-only client re-dials instantly and the dial then succeeds over
		// the fresh connection, which is precisely why this only bites once the client is gone.
		await Promise.all([client.stop(), control.stop()]);
		client = undefined; control = undefined;
		await waitForNoConnection(relayNode, clientId, 20_000);
		await waitForNoConnection(relayNode, controlId, 20_000);

		// The entries have to survive the disconnect, or there is nothing left to misread.
		expect(await heldAddrs(relayNode, clientId),
			'the client address-book entry did not survive the disconnect').to.not.be.empty;

		const clientDial = await connectFailure(relayNode, clientId);
		expect(clientDial.err, 'dialing a peer we can only reach through ourselves must fail')
			.to.be.instanceOf(SelfRelayOnlyAddressesError);
		expect(clientDial.elapsedMs,
			`the refusal must be immediate, not a burned dial timeout (took ${clientDial.elapsedMs}ms)`)
			.to.be.lessThan(FAST_FAILURE_MS);

		// The control arm: also unreachable (it is stopped), but for an ordinary reason. Without
		// this, the assertion above would be satisfied by an implementation that threw
		// `SelfRelayOnlyAddressesError` at every failed dial and told us nothing about addresses.
		const controlDial = await connectFailure(relayNode, controlId);
		expect(controlDial.err, 'the control arm must also fail — it is stopped').to.not.be.undefined;
		expect(controlDial.err,
			`a stopped peer with real listen addresses must NOT be reported as self-relay-only: ${String(controlDial.err)}`)
			.to.not.be.instanceOf(SelfRelayOnlyAddressesError);
	});
});
