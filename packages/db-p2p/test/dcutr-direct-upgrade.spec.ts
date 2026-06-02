/**
 * DCUtR direct-upgrade integration spec.
 *
 * `createLibp2pNodeBase` wires the always-on `@libp2p/dcutr` service (see
 * `libp2p-node-base.ts`). DCUtR's job: when two NAT'd peers first meet through a
 * circuit relay, it coordinates a direct TCP open and upgrades the relayed
 * connection to a direct one — demoting the relay from a permanent data path to a
 * momentary signaling/bootstrap channel.
 *
 * This file has two independent tests with DIFFERENT gates and DIFFERENT
 * guarantees. Read both before changing either — the split is deliberate.
 *
 *  1. Loopback relay smoke (`RUN_LONG_TESTS=1`)
 *     ------------------------------------------
 *     Proves the relay topology functions end-to-end: peer A reaches peer B
 *     through the circuit relay over loopback. It asserts ONLY that a relayed
 *     `/p2p-circuit` connection is established — it does **not** claim a direct
 *     upgrade, because over loopback one is impossible (see below). This is the
 *     honest replacement for the old "asserts strong-if-observed, else warns"
 *     fallback, which would have passed even with DCUtR removed.
 *
 *  2. Direct hole-punch upgrade (`RUN_DCUTR_HOLEPUNCH=1` + `DCUTR_HOST=<ip>`)
 *     ----------------------------------------------------------------------
 *     The real behavioral guarantee: within a timeout, `peerA.getConnections(
 *     peerB.peerId)` contains a connection whose `remoteAddr` is NOT a
 *     `/p2p-circuit` multiaddr. Failure to upgrade FAILS the test — there is no
 *     fallback. It `skip()`s (never silently passes) unless the env is set.
 *
 * WHY LOOPBACK CANNOT HOLE-PUNCH. `@libp2p/dcutr` only ever dials candidate
 * addresses for which `isPublicAndDialable(ma)` holds, and that helper rejects
 * every private/loopback range (`@libp2p/utils` `isPrivate`: `127.0.0.0/8`,
 * `10/8`, `172.16/12`, `192.168/16`, ...). On a single loopback host both peers
 * advertise only `127.0.0.1` addrs, so DCUtR finds zero dialable candidates and
 * never upgrades. This is a library design choice, not a bug — hole-punching is
 * meaningless between peers that already share an interface. Therefore the strong
 * assertion is only runnable where the nodes bind a genuinely non-private,
 * routable address.
 *
 * HOW TO RUN THE STRONG ASSERTION. Set `DCUTR_HOST` to a non-private IPv4 address
 * that is actually bound on the test machine's NIC (a cloud VM's public NIC IP,
 * or a container / network-namespace address in a public range with NAT). All
 * three nodes bind to it; DCUtR then sees each peer's non-private addr and
 * upgrades. A private/loopback `DCUTR_HOST` is rejected fast with guidance rather
 * than producing a misleading non-upgrade. In CI this belongs in an out-of-band,
 * multi-host / container network job — not the agent-runnable suite.
 *
 *   PowerShell: $env:RUN_LONG_TESTS=1; yarn workspace @optimystic/db-p2p test --grep "DCUtR"
 *   bash:        RUN_LONG_TESTS=1 yarn workspace @optimystic/db-p2p test --grep "DCUtR"
 *   strong (bash): RUN_DCUTR_HOLEPUNCH=1 DCUTR_HOST=203.0.113.7 yarn workspace @optimystic/db-p2p test --grep "DCUtR"
 *
 * The always-run `dcutr-autonat-registration.spec.ts` independently guards that
 * `services.dcutr` / `services.autoNAT` are wired, so neither test here re-checks
 * service presence.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import {
	spawnRelayNode,
	spawnTcpServicePeer,
	pickRelayTcpAddr,
	waitForCircuitListen,
	hasDirectConnection,
	waitForDirectConnection
} from './util/relay-topology.js';

const NETWORK = 'dcutr-direct-upgrade-it';

/**
 * Fail fast (with guidance) when `DCUTR_HOST` is an obviously private/loopback
 * address — DCUtR would silently decline to hole-punch it, which previously
 * masqueraded as a non-upgrade. Cheap prefix check, not a substitute for
 * `@libp2p/utils` `isPrivate`; it only catches the common misconfigurations.
 */
function assertRoutableHost(host: string): void {
	const privatePrefixes = ['127.', '10.', '192.168.', '169.254.', '0.', 'localhost', '::1'];
	const isPrivate172 = /^172\.(1[6-9]|2\d|3[01])\./.test(host);
	if (isPrivate172 || privatePrefixes.some(p => host === p || host.startsWith(p))) {
		throw new Error(
			`DCUTR_HOST=${host} is a private/loopback address; @libp2p/dcutr filters these ` +
			`(isPublicAndDialable) and will never hole-punch over them. Bind a non-private, ` +
			`routable IPv4 address (cloud NIC IP, or a public-range container/netns address).`
		);
	}
}

describe('DCUtR hole-punch', function () {
	this.timeout(180_000);

	let relay: Libp2p | undefined;
	let peerB: Libp2p | undefined;
	let peerA: Libp2p | undefined;

	afterEach(async () => {
		const toStop = [peerA, peerB, relay].filter((n): n is Libp2p => !!n);
		peerA = undefined; peerB = undefined; relay = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('establishes a relayed peer↔peer connection through the circuit relay (loopback smoke; no direct upgrade)', async function () {
		if (process.env.RUN_LONG_TESTS !== '1') { this.skip(); return; }
		this.timeout(120_000);

		relay = await spawnRelayNode(NETWORK);
		const relayTcp = pickRelayTcpAddr(relay);

		// Peer B listens through the relay so it is reachable via /p2p-circuit.
		peerB = await spawnTcpServicePeer(NETWORK, relayTcp, { listenOnCircuit: true });
		const circuitAddr = await waitForCircuitListen(peerB, 15_000);

		// Peer A dials B's circuit addr; the connection is relayed.
		peerA = await spawnTcpServicePeer(NETWORK, relayTcp, { listenOnCircuit: false });
		await peerA.dial(circuitAddr, { signal: AbortSignal.timeout(30_000) });

		const conns = peerA.getConnections(peerB.peerId).map(c => c.remoteAddr.toString());
		// End-to-end relay smoke: a connection to B exists and the relay was the
		// meeting point. We assert the circuit path specifically rather than mere
		// presence so the test cannot pass on an unrelated direct dial.
		expect(conns.length, 'expected a connection to peer B').to.be.greaterThan(0);
		expect(
			conns.some(a => a.includes('/p2p-circuit')),
			`expected at least one relayed (/p2p-circuit) connection to peer B; have: ${conns.join(', ')}`
		).to.equal(true);
		// Over loopback DCUtR cannot upgrade (private addrs filtered) — documented,
		// not asserted, because autoDial could in principle form a direct loopback
		// connection independent of DCUtR. The strong upgrade guarantee lives in the
		// `RUN_DCUTR_HOLEPUNCH` test below.
	});

	it('upgrades a relayed peer↔peer connection to a direct one (RUN_DCUTR_HOLEPUNCH=1 + non-private DCUTR_HOST)', async function () {
		const host = process.env.DCUTR_HOST;
		if (process.env.RUN_DCUTR_HOLEPUNCH !== '1' || !host) { this.skip(); return; }
		this.timeout(120_000);
		assertRoutableHost(host);

		relay = await spawnRelayNode(NETWORK, { host });
		const relayTcp = pickRelayTcpAddr(relay);

		// Both peers bind a non-private direct addr (the DCUtR upgrade target) and
		// first meet only through the relay.
		peerB = await spawnTcpServicePeer(NETWORK, relayTcp, { host, listenOnCircuit: true });
		const circuitAddr = await waitForCircuitListen(peerB, 15_000);

		peerA = await spawnTcpServicePeer(NETWORK, relayTcp, { host, listenOnCircuit: false });
		await peerA.dial(circuitAddr, { signal: AbortSignal.timeout(30_000) });

		// Strong, unconditional invariant: DCUtR upgrades the relayed connection to
		// a direct one. No fallback — a non-upgrade is a failure.
		const upgraded = await waitForDirectConnection(peerA, peerB.peerId, 60_000);
		const conns = peerA.getConnections(peerB.peerId).map(c => c.remoteAddr.toString());
		expect(
			upgraded && hasDirectConnection(peerA, peerB.peerId),
			`expected DCUtR to upgrade to a direct (non /p2p-circuit) connection to peer B ` +
			`within 60s on host ${host}; have: ${conns.join(', ')}`
		).to.equal(true);
	});
});
