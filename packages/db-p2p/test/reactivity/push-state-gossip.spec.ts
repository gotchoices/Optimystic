import { expect } from 'chai';
import {
	PushState,
	serveBackfill,
	encodePushStateGossipV1,
	bytesToB64url,
	type BackfillV1,
	type NotificationV1,
	type PushStateGossipV1,
	type PushStateInit,
	type RingCoord,
} from '@optimystic/db-core';
import {
	ReactivityPushStateGossipDriver,
	type PushStateGossipTruncation,
	type ReactivityGossipCollection,
} from '../../src/reactivity/push-state-gossip.js';
import { PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP } from '../../src/reactivity/protocols.js';

// --- fixtures ---------------------------------------------------------------

const COLLECTION = bytesToB64url(new Uint8Array([1, 2, 3, 4]));
const TOPIC = bytesToB64url(new Uint8Array([5, 6, 7, 8]));
const TAIL = bytesToB64url(new Uint8Array([9, 9, 9, 9]));
const OTHER_COLLECTION = bytesToB64url(new Uint8Array([0xde, 0xad]));
const COORD: RingCoord = new Uint8Array([0xc0, 0x0d]);
const SIG = bytesToB64url(new Uint8Array([0x55]));
const MEMBER = 'member-peer';
const STRANGER = 'stranger-peer';
const NOW = 1_700_000_000_000;

/** A full, codec-valid notification on the fixed (COLLECTION, TAIL). `digest`/`sig` vary by revision. */
function note(revision: number): NotificationV1 {
	return {
		v: 1,
		collectionId: COLLECTION,
		tailId: TAIL,
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff, (revision >> 8) & 0xff])),
		timestamp: NOW + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff, (revision >> 8) & 0xff])),
		signers: [bytesToB64url(new Uint8Array([8]))],
	};
}

/** Build an empty {@link PushState} for the fixed collection/topic (overridable for the foreign-topic cases). */
function makePushState(over: Partial<PushStateInit> = {}): PushState {
	return new PushState({
		collectionId: over.collectionId ?? COLLECTION,
		topicId: over.topicId ?? TOPIC,
		tailIdAtJoin: over.tailIdAtJoin ?? TAIL,
		w: over.w ?? 256,
	});
}

/** Append a revision to a push-state's replay ring + advance its dedupe/lastRevision — what an origin ingest does. */
function ingest(state: PushState, revision: number): NotificationV1 {
	const n = note(revision);
	state.replayBuffer.append({ revision, payload: n, receivedAt: NOW + revision });
	state.dedupe.observe(revision, n.sig);
	if (revision > state.lastRevision) {
		state.lastRevision = revision;
	}
	return n;
}

/** A fake `broadcastOver` that records every (protocol, coord, frame) it is handed. */
class FakeGossipTransport {
	readonly broadcasts: Array<{ protocol: string; coord: RingCoord; frame: Uint8Array }> = [];

	broadcastOver(protocol: string, coord: RingCoord, frame: Uint8Array): void {
		this.broadcasts.push({ protocol, coord, frame });
	}

	frames(): Uint8Array[] {
		return this.broadcasts.map((b) => b.frame);
	}
}

/** The full set of revisions a push-state can serve from its replay ring (via the real `serveBackfill`). */
function served(state: PushState, collectionId = COLLECTION): number[] {
	const req: BackfillV1 = { v: 1, collectionId, fromRevision: 0, toRevision: 1_000_000, signature: SIG };
	return serveBackfill(state.replayBuffer, req, collectionId).entries.map((e) => e.revision);
}

interface DriverOpts {
	live?: ReactivityGossipCollection[];
	resolve?: (g: PushStateGossipV1) => PushState | undefined;
	isCohortMember?: (from: string, g: PushStateGossipV1) => boolean;
	maxBytes?: number;
	intervalMs?: number;
	onTruncate?: (info: PushStateGossipTruncation) => void;
}

function makeDriver(transport: FakeGossipTransport, opts: DriverOpts = {}): ReactivityPushStateGossipDriver {
	return new ReactivityPushStateGossipDriver({
		gossipTransport: transport,
		liveCollections: () => opts.live ?? [],
		pushStateForGossip: opts.resolve ?? ((): PushState | undefined => undefined),
		...(opts.isCohortMember === undefined ? {} : { isCohortMember: opts.isCohortMember }),
		...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
		...(opts.intervalMs === undefined ? {} : { intervalMs: opts.intervalMs }),
		...(opts.onTruncate === undefined ? {} : { onTruncate: opts.onTruncate }),
	});
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- tests ------------------------------------------------------------------

describe('reactivity / push-state gossip driver', () => {
	it('replicates an origin entry so any member serves the same backfill (one round A → B)', () => {
		const a = makePushState();
		const b = makePushState();
		const originEntry = ingest(a, 7);

		const transport = new FakeGossipTransport();
		const driverA = makeDriver(transport, { live: [{ pushState: a, cohortCoord: COORD }] });
		const driverB = makeDriver(new FakeGossipTransport(), { resolve: (g): PushState | undefined => (g.collectionId === COLLECTION && g.topicId === TOPIC ? b : undefined) });

		// A gossips one round; the frame rides the dedicated push-state-gossip protocol to A's cohort coord.
		driverA.round();
		expect(transport.broadcasts).to.have.length(1);
		expect(transport.broadcasts[0]!.protocol).to.equal(PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP);
		expect([...transport.broadcasts[0]!.coord]).to.deep.equal([...COORD]);

		// B had nothing; after merging A's frame it serves revision 7 just like A would.
		expect(served(b), 'B starts empty').to.deep.equal([]);
		driverB.deliver(MEMBER, transport.broadcasts[0]!.frame);
		expect(served(b), 'B now serves the replicated origin entry').to.deep.equal([7]);
		expect(b.replayBuffer.get(7)!.payload, 'the full signed notification crosses intact').to.deep.equal(originEntry);
		expect(b.lastRevision).to.equal(7);
	});

	it('clips an oversized replay ring to stay within maxBytes and surfaces the truncation (no silent cap)', () => {
		const a = makePushState();
		for (let rev = 1; rev <= 60; rev++) ingest(a, rev);

		// A bound the full 60-notification ring cannot fit, but that comfortably clears the (always-kept) dedupe
		// window floor so a handful of most-recent replay entries still ride along. (Production's bound is
		// 512 KiB — far above the dedupe floor; this small bound just forces the clip path.)
		const maxBytes = 6_000;
		expect(encodePushStateGossipV1(a.serializeGossip(), Number.MAX_SAFE_INTEGER).length, 'the full ring overruns the bound').to.be.greaterThan(maxBytes);

		const truncations: PushStateGossipTruncation[] = [];
		const transport = new FakeGossipTransport();
		const driver = makeDriver(transport, { live: [{ pushState: a, cohortCoord: COORD }], maxBytes, onTruncate: (t): void => { truncations.push(t); } });

		driver.round();
		expect(transport.broadcasts).to.have.length(1);
		const frame = transport.broadcasts[0]!.frame;
		expect(frame.length, 'the broadcast frame stays within maxBytes').to.be.lessThanOrEqual(maxBytes);

		expect(truncations, 'the clip is surfaced, not silent').to.have.length(1);
		const t = truncations[0]!;
		expect(t.total, 'the ring held all 60 entries').to.equal(60);
		expect(t.kept, 'only the most-recent entries that fit were broadcast').to.be.lessThan(60);
		expect(t.kept, 'but at least one fits in a 2 KiB frame').to.be.greaterThan(0);
		expect(t.frameBytes).to.equal(frame.length);

		// The kept entries are the most-recent (high-revision) ones — what a lagging subscriber backfills first.
		const kept = makePushState();
		makeDriver(new FakeGossipTransport(), { resolve: (): PushState => kept }).deliver(MEMBER, frame);
		const keptRevs = served(kept);
		expect(keptRevs, 'kept slice is contiguous from the high end').to.deep.equal(
			Array.from({ length: t.kept }, (_, i) => 60 - t.kept + 1 + i),
		);
	});

	it('converges to full overlap over rounds while every frame stays within the bound (streaming ingest)', () => {
		// W large, bound small: once the ring grows past the bound, each round ships only the most-recent
		// entries — but because a member is present throughout, every revision is captured while it is recent,
		// so B converges on A's full ring. (Convergence requires the per-round ingest delta to fit one frame;
		// a burst larger than that leaves a gap the checkpoint/backfill path covers — flagged in the handoff.)
		const a = makePushState();
		const b = makePushState();
		const maxBytes = 6_000;

		const transport = new FakeGossipTransport();
		const driverA = makeDriver(transport, { live: [{ pushState: a, cohortCoord: COORD }], maxBytes });
		const driverB = makeDriver(new FakeGossipTransport(), { resolve: (g): PushState | undefined => (g.collectionId === COLLECTION ? b : undefined) });

		const ROUNDS = 40;
		for (let rev = 1; rev <= ROUNDS; rev++) {
			ingest(a, rev);            // one new revision per round (≤ the frame-fitting window)
			driverA.round();
			driverB.deliver(MEMBER, transport.broadcasts.at(-1)!.frame);
		}

		expect(transport.frames().every((f) => f.length <= maxBytes), 'no frame ever exceeded the bound').to.equal(true);
		expect(transport.frames().some((f) => f.length > maxBytes / 2), 'the ring did grow large enough to exercise clipping').to.equal(true);
		expect(served(b), 'B converged on A\'s full ring — any member serves the same range').to.deep.equal(served(a));
		expect(served(a)).to.deep.equal(Array.from({ length: ROUNDS }, (_, i) => i + 1));
	});

	it('ignores gossip for a collection this node does not serve (resolve returns undefined)', () => {
		const a = makePushState();
		ingest(a, 3);
		const frame = encodePushStateGossipV1(a.serializeGossip());

		let resolveCalls = 0;
		const driver = makeDriver(new FakeGossipTransport(), {
			resolve: (g): PushState | undefined => { resolveCalls++; expect(g.collectionId).to.equal(COLLECTION); return undefined; },
		});
		expect(() => driver.deliver(MEMBER, frame)).to.not.throw();
		expect(resolveCalls, 'the resolver was consulted and declined — nothing merged').to.equal(1);
	});

	it('mergeGossip independently rejects a foreign collection even if the resolver mis-routes it', () => {
		// Defense-in-depth: a resolver that hands back the wrong push-state must not corrupt it — mergeGossip
		// guards collectionId/topicId itself.
		const foreign = makePushState({ collectionId: OTHER_COLLECTION });
		const a = makePushState();
		ingest(a, 4);
		const frame = encodePushStateGossipV1(a.serializeGossip());

		makeDriver(new FakeGossipTransport(), { resolve: (): PushState => foreign }).deliver(MEMBER, frame);
		expect(served(foreign, OTHER_COLLECTION), 'the foreign-collection state stays empty').to.deep.equal([]);
	});

	it('drops a frame from a non-member sender before any merge (membership gate)', () => {
		const a = makePushState();
		ingest(a, 5);
		const frame = encodePushStateGossipV1(a.serializeGossip());

		const b = makePushState();
		let resolveCalls = 0;
		const driver = makeDriver(new FakeGossipTransport(), {
			resolve: (): PushState => { resolveCalls++; return b; },
			isCohortMember: (from): boolean => from === MEMBER,
		});

		driver.deliver(STRANGER, frame);
		expect(resolveCalls, 'a non-member is dropped before resolve/merge').to.equal(0);
		expect(served(b), 'the gated frame never merged').to.deep.equal([]);

		// The same frame from a real member is accepted.
		driver.deliver(MEMBER, frame);
		expect(resolveCalls).to.equal(1);
		expect(served(b)).to.deep.equal([5]);
	});

	it('drops an undecodable inbound frame without throwing or merging', () => {
		const b = makePushState();
		const driver = makeDriver(new FakeGossipTransport(), { resolve: (): PushState => b });
		expect(() => driver.deliver(MEMBER, new Uint8Array([0xff, 0x00, 0x01, 0x02]))).to.not.throw();
		expect(served(b)).to.deep.equal([]);
	});

	it('start() begins ticking and stop() halts further rounds', async () => {
		const a = makePushState();
		ingest(a, 1);
		const transport = new FakeGossipTransport();
		const driver = makeDriver(transport, { live: [{ pushState: a, cohortCoord: COORD }], intervalMs: 5 });

		driver.start();
		driver.start(); // idempotent — a second start must not schedule a second timer
		await delay(40);
		const ticked = transport.broadcasts.length;
		expect(ticked, 'the cadence fired at least once').to.be.greaterThan(0);

		driver.stop();
		const afterStop = transport.broadcasts.length;
		await delay(40);
		expect(transport.broadcasts.length, 'no rounds fire after stop()').to.equal(afterStop);

		// A manual round after stop is also a no-op (stopped short-circuit).
		driver.round();
		expect(transport.broadcasts.length).to.equal(afterStop);
	});

	it('an empty live set yields no broadcasts and never throws', () => {
		const transport = new FakeGossipTransport();
		const driver = makeDriver(transport, { live: [] });
		expect(() => driver.round()).to.not.throw();
		expect(transport.broadcasts).to.have.length(0);
	});
});
