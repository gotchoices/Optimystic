/**
 * Interoperability guard: the one peer in this suite that our own factory did not build.
 *
 * Every other node in every other spec — unit and integration alike — comes out of
 * `createLibp2pNodeBase`. That makes a whole class of defect invisible: if the factory produces a
 * wrong-but-self-consistent convention, every test peer produces the *same* wrong convention,
 * negotiation succeeds between them, and the suite is green. The system only fails against a peer
 * somebody else built.
 *
 * That is not hypothetical. `@libp2p/identify` was registered at `//optimystic/<net>/id/1.0.0` (a
 * stray doubled slash) for several releases — gotchoices/Optimystic#6. Reverting the fix and
 * re-running the whole integration tier produced a byte-identical pass. It was found by an outside
 * consumer whose own peer, built to the documented convention, could not negotiate.
 *
 * So this spec assembles a peer the way an outside project would: plain `createLibp2p(...)`, real
 * TCP, `noise()`, `yamux()`, and `identify()` configured from the documented protocol-id convention
 * (see `packages/db-p2p/docs/repo.md` § Protocol id conventions). Nothing here is imported from
 * `src/` except the node factory under test. Every expected protocol id below is written out as a
 * LITERAL — not imported from a constants module, not recomputed by calling a builder. Deriving the
 * expectation from the code under test is precisely the tautology this fixture exists to break.
 *
 * **When a deliberate wire-format change makes this fail, that failure is the feature.** Hand-edit
 * the literals; do not reach for a shared constant. The edit is the review checkpoint that somebody
 * intended to change the wire.
 *
 * **Scope guard.** This is deliberately NOT a second implementation of Optimystic. It validates the
 * negotiation surface — where this defect class lives — plus one repo round trip. When a future
 * convention needs covering, add one assertion, not one more subsystem.
 *
 * Gated on OPTIMYSTIC_INTEGRATION=1 like its neighbours (it spawns real sockets). Run via:
 *   PowerShell: $env:OPTIMYSTIC_INTEGRATION=1; yarn workspace @optimystic/db-p2p test:integration
 *   bash:        yarn workspace @optimystic/db-p2p test:integration
 */
import { expect } from 'chai';
import { createLibp2p, type Libp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { tcp } from '@libp2p/tcp';
import { identify } from '@libp2p/identify';
import { UnsupportedProtocolError, type Stream } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import type { BlockId, IBlock, IRepo, Transforms } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { waitForPeerStoreProtocols } from './util/peer-store-wait.js';
import { expectWellFormedProtocolIds } from './util/protocol-ids.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';

/** Distinct per-spec: protocol ids are network-scoped, so a shared name lets concurrent specs cross-talk. */
const NETWORK = 'foreign-peer-interop-it';

/**
 * The identify prefix, spelled SLASH-LESS — the asymmetry that produced #6, reproduced here from the
 * documentation rather than copied from our call site. `@libp2p/identify` builds its own id as
 * `/${protocolPrefix}/id/1.0.0`, always prepending the leading slash (its own default is the bare
 * `'ipfs'`). Every Optimystic service that concatenates its own template literal takes the
 * slash-PREFIXED form instead. An outside integrator reading the docs has to get both right; so does
 * this fixture. Getting it wrong HERE produces a failing test that looks like a production bug —
 * if this spec ever fails, check this line before suspecting `src/`.
 */
const FOREIGN_IDENTIFY_PREFIX = `optimystic/${NETWORK}`;

/**
 * The ids an outside peer expects an Optimystic node to advertise. Literals — see the header.
 *
 * This is the negotiation surface an integrator actually needs: `identify` (+ its push companion) to
 * exchange lists at all, and `cluster`/`repo` because those two are exactly what
 * `Libp2pKeyPeerNetwork.membershipOf` keys peer classification on. The node advertises more than
 * this — `sync` and `block-transfer` (which carry a surprising `/db-p2p/` infix), the five FRET
 * routing ids, and the stock libp2p ids (`/ipfs/ping/1.0.0`, …). All of those are covered by the
 * whole-list well-formedness assertion below rather than named here, per this spec's scope guard;
 * the full inventory is in `packages/db-p2p/docs/repo.md` § Protocol id conventions.
 */
const IDENTIFY_PROTOCOL = `/optimystic/${NETWORK}/id/1.0.0`;
const IDENTIFY_PUSH_PROTOCOL = `/optimystic/${NETWORK}/id/push/1.0.0`;
const CLUSTER_PROTOCOL = `/optimystic/${NETWORK}/cluster/1.0.0`;
const REPO_PROTOCOL = `/optimystic/${NETWORK}/repo/1.0.0`;

/** The #6 shape: what the id becomes when the slash-less/slash-prefixed asymmetry is missed. */
const MALFORMED_REPO_PROTOCOL = `//optimystic/${NETWORK}/repo/1.0.0`;

/**
 * Ceiling on a single length-prefixed response frame. Written out rather than imported from
 * `src/protocol-limits.ts` for the same reason the protocol ids are: an outside peer picks its own
 * cap. Generous — the probe response is a few hundred bytes.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Bounded budget for the repo dial + single round trip. A regression must report an error, not hang. */
const REPO_ROUND_TRIP_TIMEOUT_MS = 15_000;

/**
 * Budget for the Optimystic node's peerStore view of the foreign peer to settle. Covers connection
 * setup plus the identify exchange; `membershipOf` reads `unknown` until identify completes, so this
 * has to poll rather than read once after connect (see `util/peer-store-wait.ts`).
 */
const IDENTIFY_TIMEOUT_MS = 20_000;

/** How `Libp2pKeyPeerNetwork` classifies a peer from its advertised protocol list. */
type NetworkMembership = 'serves' | 'foreign' | 'unknown';

/**
 * `membershipOf` is `private` on `Libp2pKeyPeerNetwork`, and the key network itself is attached to
 * the node as an untyped diagnostic surface. Reach both through this narrow structural type so the
 * shape we depend on is stated rather than erased by `any`.
 */
type OptimysticNodeInternals = {
	readonly keyNetwork: { membershipOf(idStr: string, protocols: string[] | undefined): NetworkMembership };
	readonly coordinatedRepo: IRepo;
};

const internalsOf = (node: Libp2p): OptimysticNodeInternals =>
	node as unknown as OptimysticNodeInternals;

const makeBlock = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'foreign-interop-collection' as BlockId }
});

const makeTransforms = (blockId: string): Transforms => ({
	inserts: { [blockId]: makeBlock(blockId) },
	updates: {},
	deletes: []
});

/**
 * A peer assembled the way an outside project would assemble one: nothing from `src/`, the minimum
 * service surface that exercises protocol negotiation, and every id spelled out from the documented
 * convention.
 *
 * It resolves `libp2p`, `@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux` and `@libp2p/tcp` from
 * this package's own `node_modules` — the SAME resolved versions `createLibp2pNodeBase` uses (the
 * workspace pins one copy of each). That keeps library version skew from becoming the variable under
 * test: a negotiation failure here means our protocol ids diverged, not that two noise builds did.
 *
 * The repo handler exists so the peer's advertised protocol list is honest — `membershipOf` reads
 * that list as a promise to serve the protocol, and this spec asserts on that classification. It
 * deliberately implements no repo semantics: closing the stream is the whole body. Teaching this
 * fixture more of the protocol is the scope creep the ticket warns about; if a future convention
 * needs covering, add an assertion, not a subsystem.
 *
 * `registerRepo: false` omits that handler, producing a peer that speaks identify and nothing this
 * network recognizes. That is the negative control for the classification assertion — see the
 * `foreign` case below.
 */
async function spawnForeignPeer({ registerRepo = true }: { registerRepo?: boolean } = {}): Promise<Libp2p> {
	const peer = await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: {
			identify: identify({ protocolPrefix: FOREIGN_IDENTIFY_PREFIX })
		}
	}) as unknown as Libp2p;

	// Registered before any connection, so the initial identify exchange carries it. (The
	// register-AFTER-connect path — which needs identify/push to propagate — is covered separately
	// by `identify-push-propagation.spec.ts` and is not this fixture's job.)
	if (registerRepo) {
		await peer.handle(REPO_PROTOCOL, (stream: Stream) => { void stream.close(); });
	}

	return peer;
}

/**
 * Assert that `dialer` can negotiate `protocol` on `target`, then close the stream.
 *
 * The point is the failure mode. An unregistered or misspelled id is refused by multistream-select in
 * milliseconds with `UnsupportedProtocolError`, so a convention regression reports the protocol it
 * asked for and the error type — never a bare timeout, which is indistinguishable from a slow machine
 * and trains people to re-run instead of investigate.
 */
async function expectProtocolNegotiates(dialer: Libp2p, target: Libp2p, protocol: string, label: string): Promise<void> {
	let stream: Stream | undefined;
	let dialError: Error | undefined;
	try {
		stream = await dialer.dialProtocol(target.peerId, protocol, {
			signal: AbortSignal.timeout(REPO_ROUND_TRIP_TIMEOUT_MS)
		});
	} catch (err) {
		dialError = err as Error;
	} finally {
		if (stream) { try { await stream.close(); } catch { /* already torn down */ } }
	}
	expect(dialError === undefined,
		`a foreign peer could not negotiate ${label} at the documented id ${protocol}: `
		+ `${dialError?.name} — ${dialError?.message}. The node advertises: ${JSON.stringify(target.getProtocols())}`)
		.to.equal(true);
}

/**
 * One repo request/response over a stream the foreign peer opens itself: length-prefixed frames
 * carrying JSON, per `packages/db-p2p/docs/repo.md` § Message Format. Both deadlines are bounded and
 * both failure paths throw something nameable — a protocol-id regression must surface as
 * `UnsupportedProtocolError` from the dial, or as an explicit "no response frame" from the read,
 * never as a bare mocha timeout that is indistinguishable from a slow machine.
 */
async function foreignRepoRoundTrip(peer: Libp2p, target: Libp2p, request: unknown): Promise<unknown> {
	let stream: Stream;
	try {
		stream = await peer.dialProtocol(target.peerId, REPO_PROTOCOL, {
			signal: AbortSignal.timeout(REPO_ROUND_TRIP_TIMEOUT_MS)
		});
	} catch (err) {
		const cause = err as Error;
		throw new Error(`could not negotiate the documented repo protocol ${REPO_PROTOCOL}: ${cause.name} — ${cause.message}`);
	}

	let readTimedOut = false;
	const timer = setTimeout(() => {
		readTimedOut = true;
		// A timer alone does not unblock the `for await` below; aborting the stream is what rejects
		// its iterator (same reasoning as `src/protocol-client.ts`).
		try { stream.abort(new Error('foreign repo read deadline')); } catch { /* already torn down */ }
	}, REPO_ROUND_TRIP_TIMEOUT_MS);

	try {
		for await (const chunk of pipe([new TextEncoder().encode(JSON.stringify(request))], lpEncode)) {
			stream.send(chunk);
		}

		const frames = pipe(stream, source => lpDecode(source, { maxDataLength: MAX_RESPONSE_BYTES }));
		for await (const frame of frames) {
			return JSON.parse(new TextDecoder().decode(frame.subarray()));
		}
		throw new Error(`${REPO_PROTOCOL}: stream closed without a response frame`);
	} catch (err) {
		if (readTimedOut) {
			throw new Error(`${REPO_PROTOCOL}: no response frame within ${REPO_ROUND_TRIP_TIMEOUT_MS}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
		try { await stream.close(); } catch { /* already torn down */ }
	}
}

describe('Foreign-peer interop (a peer this repo did not build)', function () {
	// One real Optimystic boot (FRET + arachnode dominate) plus a plain libp2p boot and the
	// identify exchange.
	this.timeout(90_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let node: Libp2p | undefined;
	let foreign: Libp2p | undefined;

	/**
	 * `responsibilityK` is deliberately larger than any cohort this two-peer mesh can produce, so
	 * `RepoService.checkRedirect` takes its small-mesh bypass and answers locally. Without that the
	 * response shape would depend on whether FRET happened to place the block's cohort on this node,
	 * and the round-trip assertion would be racy rather than wrong-or-right.
	 */
	async function spawnOptimysticNode(): Promise<Libp2p> {
		return await createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			responsibilityK: 8,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false }
		});
	}

	afterEach(async () => {
		const toStop = [foreign, node].filter((n): n is Libp2p => !!n);
		node = undefined; foreign = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('completes identify, serves a repo request, and settles to `serves` for a hand-built peer', async function () {
		node = await spawnOptimysticNode();
		const optimystic = node;

		// Seed one committed block BEFORE the foreign peer joins, so the round trip below returns real
		// data rather than the canonical empty state — and so the write runs on a solo mesh, unaffected
		// by the foreign peer's arrival.
		const blockId = 'foreign-peer-probe-block';
		const repo = internalsOf(optimystic).coordinatedRepo;
		const pended = await repo.pend({ actionId: 'foreign-probe-1', transforms: makeTransforms(blockId), policy: 'c' });
		expect(pended.success, 'seed pend').to.equal(true);
		const committed = await repo.commit({
			actionId: 'foreign-probe-1',
			tailId: blockId as BlockId,
			rev: 1,
			blockIds: [blockId as BlockId]
		});
		expect(committed.success, 'seed commit').to.equal(true);

		foreign = await spawnForeignPeer();
		const outsider = foreign;

		// The outsider dials in, as a client would. identify runs in both directions off the new
		// connection, so both peer stores populate from this one dial.
		await outsider.dial(multiaddr(pickLocalTcpMultiaddr(optimystic)));

		// --- 1a. Identify NEGOTIATES under the documented id -----------------------------------------
		//
		// Asserted by an explicit dial before anything is polled, because this is the exact failure #6
		// produced and a poll can only report it as a 20-second silence. multistream-select refuses an
		// unregistered id in milliseconds, so a regression here names the protocol and the error type
		// instead of looking like a slow machine. (The stream is closed immediately — negotiating it is
		// the whole assertion; reading the payload would be re-implementing identify.)
		await expectProtocolNegotiates(outsider, optimystic, IDENTIFY_PROTOCOL, 'identify');

		// --- 2. A repo dial from the outsider returns a well-formed response ------------------------
		//
		// The documented client-facing entry point, spoken by a client that shares no code with the
		// server. Asserted here — before any polling — for the same reason as 1a: a wrong id fails the
		// dial in milliseconds with a named error, where a poll could only report silence. A wrong
		// framing or payload shape fails the assertions below instead.
		const response = await foreignRepoRoundTrip(outsider, optimystic, {
			operations: [{ get: { blockIds: [blockId] } }],
			expiration: Date.now() + REPO_ROUND_TRIP_TIMEOUT_MS
		}) as Record<string, { block?: { header?: { id?: string } }; state?: { latest?: { rev?: number } } }>;

		expect(response, 'the repo response is a keyed result object').to.be.an('object');
		expect(Object.keys(response), 'the response is keyed by the requested block id').to.include(blockId);
		expect(response[blockId]?.block?.header?.id, 'the response carries the committed block').to.equal(blockId);
		expect(response[blockId]?.state?.latest?.rev, 'the response carries the committed revision').to.equal(1);

		// --- 3. …and identify's PAYLOAD carried the ids the docs promised ----------------------------
		//
		// This is the direction no in-process assertion covers. Every existing check of this kind reads
		// `node.getProtocols()` inside our own process; this one reads what actually crossed the wire
		// into a peer that never saw our source, and compares it against literals an integrator would
		// have written from the documentation.
		//
		// The predicate waits for the WHOLE expected set, not any one member. Negotiating a protocol
		// writes that single id into the dialer's peerStore entry, so the explicit dials above leave a
		// partial entry behind; a one-member predicate would settle on that and assert against a list
		// identify had not delivered yet.
		const expectedIds = [IDENTIFY_PROTOCOL, IDENTIFY_PUSH_PROTOCOL, CLUSTER_PROTOCOL, REPO_PROTOCOL];
		const asSeenByOutsider = await waitForPeerStoreProtocols(
			outsider, optimystic.peerId, IDENTIFY_TIMEOUT_MS,
			protocols => expectedIds.every(id => protocols.includes(id))
		);
		// Printing both sides turns a "the list is wrong" failure into a diff a reader can act on: the
		// ids the node registered sit next to the ids the outsider expected.
		expect(asSeenByOutsider.matched,
			`identify's payload never delivered the documented protocol list to the outsider.\n`
			+ `  expected to include:               ${JSON.stringify(expectedIds)}\n`
			+ `  outsider's peerStore for the node: ${JSON.stringify(asSeenByOutsider.protocols)}\n`
			+ `  the node actually advertises:      ${JSON.stringify(optimystic.getProtocols())}`)
			.to.equal(true);
		// The generalization, now made from OUTSIDE: whatever the services map grows next, nothing the
		// node advertises may be malformed. This is the check that catches an id nobody named.
		expectWellFormedProtocolIds(asSeenByOutsider.protocols, 'Optimystic node, as seen by a foreign peer');

		// --- 4. The node's own peer store lists the outsider's protocols ---------------------------
		const asSeenByNode = await waitForPeerStoreProtocols(
			optimystic, outsider.peerId, IDENTIFY_TIMEOUT_MS,
			protocols => protocols.includes(REPO_PROTOCOL) && protocols.includes(IDENTIFY_PROTOCOL)
		);
		expect(asSeenByNode.matched,
			`the node never learned the outsider's protocol list; it holds: ${JSON.stringify(asSeenByNode.protocols)}`)
			.to.equal(true);
		expectWellFormedProtocolIds(asSeenByNode.protocols, 'foreign peer, as seen by the Optimystic node');

		// --- 5. The user-visible consequence: the outsider classifies as `serves` -------------------
		//
		// `Libp2pKeyPeerNetwork.membershipOf` derives `serves` / `foreign` / `unknown` purely from the
		// advertised protocol list, and coordinator and cohort selection refuse to route work to
		// anything not confirmed `serves`. So this classification flipping is what getting the ids
		// right actually buys. It is polled because `membershipOf` reads `unknown` (never selected)
		// until identify completes — a single read after connect races the exchange.
		// The node's OWN key network, not a fresh one built here: its `protocolPrefix` is the value
		// production resolved, so this asserts against the classifier a real coordinator selection uses.
		const keyNetwork = internalsOf(optimystic).keyNetwork;
		const classify = (protocols: string[]): NetworkMembership =>
			keyNetwork.membershipOf(outsider.peerId.toString(), protocols);

		const settled = await waitForPeerStoreProtocols(
			optimystic, outsider.peerId, IDENTIFY_TIMEOUT_MS,
			protocols => classify(protocols) === 'serves'
		);
		expect(settled.matched,
			`the outsider settled to '${classify(settled.protocols)}', not 'serves'; the node's peerStore holds: ${JSON.stringify(settled.protocols)}`)
			.to.equal(true);
		expect(classify(settled.protocols), 'a hand-built peer advertising the documented repo id is routable')
			.to.equal('serves');
	});

	it('control: a hand-built peer WITHOUT the repo id settles to `foreign`, not `serves`', async function () {
		// The negative half of check 5, and the reason that check means anything. `membershipOf`
		// returns `serves` unconditionally when no `protocolPrefix` is configured, so a build that
		// lost network scoping entirely would still satisfy "settles to serves" — the positive
		// assertion alone cannot tell a working classifier from a disabled one. This peer is
		// identical except that it advertises no Optimystic protocol, so only a classifier that
		// actually reads the list can produce a different answer for it.
		node = await spawnOptimysticNode();
		const optimystic = node;
		foreign = await spawnForeignPeer({ registerRepo: false });
		const outsider = foreign;

		await outsider.dial(multiaddr(pickLocalTcpMultiaddr(optimystic)));

		const keyNetwork = internalsOf(optimystic).keyNetwork;
		const classify = (protocols: string[]): NetworkMembership =>
			keyNetwork.membershipOf(outsider.peerId.toString(), protocols);

		// Polled, and for a REACHED state rather than a sustained one: the peer starts `unknown`
		// (empty protocol list) and only becomes `foreign` once identify delivers a non-empty list
		// that contains nothing this network serves. Asserting immediately after the dial would
		// pass on `unknown` — a different failure wearing the same clothes.
		const settled = await waitForPeerStoreProtocols(
			optimystic, outsider.peerId, IDENTIFY_TIMEOUT_MS,
			protocols => classify(protocols) === 'foreign'
		);
		expect(settled.matched,
			`a peer advertising no Optimystic protocol classified as '${classify(settled.protocols)}', not 'foreign'; `
			+ `the node's peerStore holds: ${JSON.stringify(settled.protocols)}`)
			.to.equal(true);
		expect(settled.protocols, 'the control peer must not be advertising the repo id')
			.to.not.include(REPO_PROTOCOL);
	});

	it('control: a dial on the #6-malformed repo id fails as UnsupportedProtocolError, not a timeout', async function () {
		// Proves the fixture's failure mode is diagnosable. If the node had registered the malformed
		// (doubled-slash) id, an outsider dialing the DOCUMENTED one would get exactly this error — so
		// a future protocol-id regression reports a named negotiation failure rather than a hang that
		// trains people to re-run instead of investigate. Fails fast (multistream-select rejects
		// immediately), so unlike a timeout-asserting control this one is not gated.
		node = await spawnOptimysticNode();
		foreign = await spawnForeignPeer();
		await foreign.dial(multiaddr(pickLocalTcpMultiaddr(node)));

		let dialError: Error | undefined;
		try {
			await foreign.dialProtocol(node.peerId, MALFORMED_REPO_PROTOCOL, {
				signal: AbortSignal.timeout(REPO_ROUND_TRIP_TIMEOUT_MS)
			});
		} catch (err) {
			dialError = err as Error;
		}

		expect(dialError, `dialing ${MALFORMED_REPO_PROTOCOL} should be refused`).to.not.equal(undefined);
		expect(dialError?.name, `the refusal is a named negotiation failure, got: ${dialError?.name} — ${dialError?.message}`)
			.to.equal(UnsupportedProtocolError.name);
	});
});
