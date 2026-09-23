/**
 * The connection monitor's deadline is capped by its ping interval.
 *
 * libp2p's `ConnectionMonitor` opens a ping stream every `pingInterval`, whether or not the
 * previous one has answered, on `/ipfs/ping/1.0.0`. Every node built here also registers the
 * `@libp2p/ping` service on that same protocol, and that service registers it with
 * `maxOutboundStreams: 1`. libp2p reads the outbound limit off the *registrar's* handler options,
 * so the monitor's second stream to a peer that has not answered the first is refused locally with
 * `TooManyOutboundProtocolStreamsError`. The monitor's catch cannot tell that from a late reply and
 * aborts the connection, so a peer gets `min(pingTimeout.minTimeout, pingInterval)` to answer, not
 * `minTimeout`.
 *
 * Both arms stall the listener's ping answers — it accepts the stream and never echoes — and watch
 * what aborts the dialer's connection and when. `Connection.abort` is the observation point because
 * the error the monitor gives up on is passed to it and retained nowhere else.
 *
 * The bounds are one-sided in the safe direction: the overlap arm asserts the abort landed INSIDE
 * the deadline it was configured with — it lands at roughly a seventh of it, boot and dial included
 * — and the patient arm that it landed no earlier than that deadline. Neither needs a timer to be
 * punctual.
 *
 * NOTE: this pins a libp2p/@libp2p/ping premise, not our own code — the docs it backs
 * (`NodeOptions.connectionMonitor`, and the readme's React Native section) tell deployments to set
 * `pingInterval` longer than `pingTimeout.minTimeout` precisely because of it. If a libp2p upgrade
 * makes the monitor await its previous ping, or moves it off the ping service's protocol, or the
 * ping service raises `MAX_OUTBOUND_STREAMS`, the first arm fails — and that is the signal to
 * re-check both documents rather than to relax the assertion.
 */
import { expect } from 'chai';
import { multiaddr } from '@multiformats/multiaddr';
import type { Connection } from '@libp2p/interface';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { Libp2pConnectionMonitorInit } from '../src/connection-monitor.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'connection-monitor-ping-overlap';

/** What both the ping service and the monitor resolve to when neither is given a `protocolPrefix`. */
const PING_PROTOCOL = '/ipfs/ping/1.0.0';

/** The error libp2p raises when a second outbound stream would exceed the protocol's limit. */
const OVERLAP_ERROR = 'TooManyOutboundProtocolStreamsError';

/** Longest either arm may wait for the abort before failing on the absence of one. */
const OBSERVE_TIMEOUT_MS = 20_000;

interface AbortCapture {
	error?: Error;
	elapsedMs?: number;
}

/**
 * Record the first error `connection` is aborted with, and how long after `since` it arrived.
 *
 * The monitor calls `conn.abort(err)` on the connection instance the connection manager holds,
 * which is the one `dial` returned, and `Connection.abort` keeps neither the error nor the moment.
 * Shadowing the method on the instance is the only seat from which both are visible.
 */
function captureAbort(connection: Connection, since: number): AbortCapture {
	const captured: AbortCapture = {};
	const inner = connection.abort.bind(connection);
	connection.abort = (err: Error): void => {
		if (captured.error === undefined) {
			captured.error = err;
			captured.elapsedMs = Date.now() - since;
		}
		inner(err);
	};
	return captured;
}

async function waitForAbort(captured: AbortCapture): Promise<AbortCapture> {
	const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
	while (captured.error === undefined && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	return captured;
}

describe('connectionMonitor — a ping that overlaps the previous one', function () {
	// Two real libp2p boots per arm, plus the configured deadline in the patient arm.
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

	/**
	 * Make `node` a peer whose ping answer never comes: accept the stream, echo nothing, hold it
	 * open. Unhandling the protocol instead would be a different case — the monitor reads
	 * `UnsupportedProtocolError` as proof the peer is alive.
	 *
	 * `maxInboundStreams` restates `@libp2p/ping`'s own default, which the `force` re-registration
	 * would otherwise drop back to the registrar's. Two is what the overlap arm needs: multistream
	 * select runs before the dialer counts its outbound streams, so the ping it is about to refuse
	 * has already been negotiated on this side and both are open here at once.
	 */
	async function stallPingAnswers(node: OptimysticNode): Promise<void> {
		await node.handle(PING_PROTOCOL, () => {}, { force: true, runOnLimitedConnection: true, maxInboundStreams: 2 });
	}

	/** A dialer configured as given, connected to a listener that never answers a ping. */
	async function connectToStalledPeer(connectionMonitor: Libp2pConnectionMonitorInit): Promise<AbortCapture> {
		const dialer = await spawn({ connectionMonitor });
		const listener = await spawn();
		await stallPingAnswers(listener);

		// Clocked from before the dial, not after it: the monitor's interval is already running when
		// the connection is registered, so a ping can start fractionally before `dial` returns. Timing
		// from the earliest moment one could have started keeps both arms' bounds conservative.
		const dialedAt = Date.now();
		const connection = await dialer.dial(multiaddr(pickLocalTcpMultiaddr(listener)));
		return await waitForAbort(captureAbort(connection, dialedAt));
	}

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map(node => node.stop()));
	});

	it('aborts the connection at the ping interval, not at the configured deadline', async () => {
		const interval = 300;
		const deadline = 5_000;

		const { error, elapsedMs } = await connectToStalledPeer({
			pingInterval: interval,
			pingTimeout: { minTimeout: deadline, maxTimeout: deadline }
		});

		expect(error?.name, 'the connection was not aborted by an overlapping ping').to.equal(OVERLAP_ERROR);
		expect(elapsedMs, `a peer given ${deadline}ms to answer was cut off after ${elapsedMs}ms`).to.be.lessThan(deadline);
	});

	it('gives the peer the whole deadline once the interval is longer than it', async () => {
		const interval = 2_000;
		const deadline = 700;

		const { error, elapsedMs } = await connectToStalledPeer({
			pingInterval: interval,
			pingTimeout: { minTimeout: deadline, maxTimeout: deadline }
		});

		expect(error?.name, 'the pings still overlapped').to.not.equal(OVERLAP_ERROR);
		expect(elapsedMs, `the peer was cut off after ${elapsedMs}ms, short of its ${deadline}ms deadline`)
			.to.be.at.least(deadline);
	});
});
