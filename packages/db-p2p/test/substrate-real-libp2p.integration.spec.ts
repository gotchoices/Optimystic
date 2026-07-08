import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { PrivateKey, PeerId } from '@libp2p/interface';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { hashPeerId, type FretService } from 'p2p-fret';
import {
	createTierAddressing,
	createSlotAssigner,
	RingHash,
	reactivityTopicId,
	membershipCertSigningPayload,
	registerSigningPayload,
	renewSigningPayload,
	serializeBootstrapEvidenceEnvelope,
	bootstrapBoundImage,
	subscribeAppPayloadBytes,
	createNotificationVerifier,
	createStickyCohortHintCache,
	encodeQueryV1,
	decodeQueryReplyV1,
	encodeProviderAppPayload,
	providerSigningPayload,
	verifyProviderEntry,
	bytesToB64url,
	b64urlToBytes,
	bytesEqual,
	encodeCohortMessage,
	Tier,
	type RingCoord,
	type MembershipCertV1,
	type RegisterV1,
	type RenewV1,
	type NotificationV1,
	type ResumeV1,
	type ResumeReplyV1,
	type ResumeSignable,
	type CommitCert,
	type CollectionChangeEvent,
	type BlockId,
	type ActionId,
	type QueryV1,
} from '@optimystic/db-core';
import { createLibp2pNode, type NodeOptions } from '../src/libp2p-node.js';
import { peerIdToBytes, bytesToPeerIdString } from '../src/cohort-topic/peer-codec.js';
import { signPeer, verifyPeerSig } from '../src/cohort-topic/peer-sig.js';
import { sendOneWay, requestResponse, DEFAULT_STREAM_MAX_BYTES } from '../src/cohort-topic/stream-util.js';
import { DEFAULT_COHORT_TOPIC_PROTOCOLS } from '../src/cohort-topic/protocols.js';
import { DEFAULT_MATCHMAKING_PROTOCOLS } from '../src/matchmaking/protocols.js';
import { createLibp2pMatchmakingTransport } from '../src/matchmaking/query-transport.js';
import { SeekerWalkClient, type SeekerWalkResult } from '../src/matchmaking/seeker-walk-client.js';
import { waitFor, waitForValue } from '@optimystic/db-core/test';
import { signedWillingness, type Member } from '../src/testing/cohort-topic-mesh-harness.js';
import { createReactivitySelfMembershipGate, reactivityTailBytes } from '../src/cohort-topic/reactivity-membership-gate.js';
import { DEFAULT_REACTIVITY_PROTOCOLS } from '../src/reactivity/protocols.js';
import {
	Libp2pReactivityRecoverTransport,
	createLibp2pRecoverDialer,
	createRecoverRequestSigners,
} from '../src/reactivity/recover-transport.js';
import type { CohortTopicHost, CoordEngine } from '../src/cohort-topic/host.js';

/**
 * **Substrate real-libp2p e2e tier** — the high-fidelity, small-N counterpart to the three mock-tier
 * suites (`cohort-topic/cohort-topic-scale-*.spec.ts`, `reactivity/mesh-*.spec.ts`,
 * `matchmaking/mesh-*.spec.ts`). The mock tier proves behavioral correctness at scale with deterministic
 * in-process routing; this tier proves the substrate behaves over **real TCP/libp2p transport + real FRET
 * stabilization** at small N (3–16 nodes). Scale is explicitly out of scope — that is the mock tier's and
 * the simulator's job.
 *
 * Each node is a production `createLibp2pNode({ cohortTopic: { enabled: true } })` — so the five
 * cohort-topic protocols (`register`, `cohort-gossip`, `promote`, `membership`, `sign`) run over real
 * sockets, FRET two-sided stabilization assembles the cohort for real, and the participant
 * `CohortTopicService` + `MembershipVerifier` are the production wiring. Assertions use bounded polling
 * with generous timeouts (no fixed sleeps); tolerances reflect real network timing, not the simulator's
 * exact bounds.
 *
 * **What is real over the wire here vs. what is honestly deferred.** The piece the mock mesh *stubs* — real
 * FRET cohort assembly + coordinate derivation, the `/sign` threshold-signature collection, the
 * `/membership` cert serve+fetch, and `/cohort-gossip` record replication — is exercised end-to-end over
 * real TCP. Two scenarios in the parent ticket need **production seams that are not yet wired** and are
 * tagged `it.skip` with their tracking tickets rather than faked:
 *   - reactivity notification *socket delivery* (the origination bridge fires `onLocalCommit` and the
 *     verify path is real, but no emit transport / subscriber-delivery protocol is registered in
 *     production — `libp2p-node-base.ts` "installing the origination manager + emit transport is a sibling
 *     ticket"); and
 *   - the matchmaking hang-out walk *converging to a match* (no `QueryV1` RPC handler is registered on a
 *     real node — the seeker walk's `query()` seam is unbound in production).
 * The real, wired pieces of both (the reactivity origination membership gate over real FRET; a matchmaking
 * provider record landing in + replicating across a real cohort) ARE exercised.
 *
 * Gated on `OPTIMYSTIC_INTEGRATION=1` (or `RUN_LONG_TESTS=1`) so the default `yarn test` stays fast. Run:
 *   OPTIMYSTIC_INTEGRATION=1 yarn test:integration   (db-p2p)
 * Windows (PowerShell):
 *   $env:OPTIMYSTIC_INTEGRATION=1; yarn test:integration
 */

const GATED = process.env.OPTIMYSTIC_INTEGRATION === '1' || process.env.RUN_LONG_TESTS === '1';

const NETWORK_NAME = 'substrate-real-libp2p-it';
const GOSSIP_PROTOCOL = DEFAULT_COHORT_TOPIC_PROTOCOLS.gossip;

function clampN(n: number): number {
	if (!Number.isInteger(n) || n < 3) return 3;
	return n > 16 ? 16 : n;
}

// Small N, high fidelity. wantK = N → the tier-0 cohort is the whole mesh, so `assembleCohort(coord, N)`
// converges once FRET has discovered every peer — the live-tier milestone shape, now over real sockets.
// Override N (3–16) via env for a wider real run; the substrate logic is identical, only slower to stabilize.
const N = clampN(Number.parseInt(process.env.OPTIMYSTIC_SUBSTRATE_N ?? '4', 10));
const WANT_K = N;
const MIN_SIGS = N - 1; // (N-1)-of-N quorum (the production minSigs = 14 path is identical, just larger)
// The willingness admission needs a strict-majority quorum (`defaultQuorum(N)`); self counts via live
// willingness, so the gossip view must carry at least `quorum − 1 = floor(N/2)` willing siblings.
const WILLING_SIBLINGS_NEEDED = Math.floor(WANT_K / 2);

// A topic whose tier-0 cohort is the whole mesh; fixed bytes keep coord derivation reproducible.
const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i * 9 + 5) & 0xff);
// A collection tail id used for the reactivity-topic anchor derivation.
const TAIL_ID = 'optimystic/collection/tail-real-libp2p';

const addressing = createTierAddressing(new RingHash());
const slots = createSlotAssigner(new RingHash());

function slotPrimary(participantBytes: Uint8Array, cohortEpoch: Uint8Array, members: readonly Uint8Array[]): Uint8Array {
	return slots.assignSlots(participantBytes, cohortEpoch, members as Uint8Array[]).primary;
}

/** Stable bogus member bytes for the stale-cert priming (a peer-id-shaped, never-a-real-member value). */
function staleMemberBytes(): Uint8Array {
	return Uint8Array.from({ length: 34 }, (_v, i) => (i * 17 + 3) & 0xff);
}

interface SignedRegisterOptions {
	readonly tier?: number;
	readonly treeTier?: number;
	readonly bootstrap?: boolean;
	readonly ttl?: number;
	/**
	 * Attach a self-vouch reputation endorsement: the participant peer-key-signs its own
	 * `bootstrapBoundImage` as the referee, so a *configured* production node admits a T2/T3 `bootstrap`
	 * register via the `PoW || reputation || parent-ref` disjunction (the origin's reputation view scores an
	 * unseen, non-banned peer below the deprioritize threshold). Needed because T2/T3 bootstrap stays gated
	 * (`cohort-topic-bootstrap-coldstart-origination-regression` keeps only T0/T1 permissive).
	 */
	readonly selfVouch?: boolean;
	/**
	 * Opaque app-payload bytes for `RegisterV1.appPayload` (e.g. a matchmaking provider/seeker payload).
	 * `bootstrapBoundImage` binds only (topicId, tier, participantCoord, timestamp), so a self-vouch is
	 * unaffected; `registerSigningPayload` covers it, so it is attached before the final register sign.
	 */
	readonly appPayload?: Uint8Array;
}

// Signed register/renew builders for real participants (mirror the mock harness's, but kept local so the
// real-transport spec does not pull the whole mock-mesh surface — `buildMesh`, `MockNode`, … — into scope).
async function signedRegister(participant: Member, topic: Uint8Array, now: number, correlationId: string, opts: SignedRegisterOptions = {}): Promise<RegisterV1> {
	const baseBody: Omit<RegisterV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topic),
		tier: opts.tier ?? 0,
		treeTier: opts.treeTier ?? 0,
		participantCoord: bytesToB64url(participant.bytes),
		ttl: opts.ttl ?? 90_000,
		bootstrap: opts.bootstrap ?? true,
		timestamp: now,
		correlationId: bytesToB64url(new TextEncoder().encode(correlationId)),
		...(opts.appPayload !== undefined ? { appPayload: bytesToB64url(opts.appPayload) } : {}),
	};
	// `bootstrapBoundImage` binds only (topicId, tier, participantCoord, timestamp), so the self-vouch
	// endorsement is identical on `baseBody` and the evidence-bearing body; attach it BEFORE the final
	// register sign (registerSigningPayload covers `bootstrapEvidence`).
	const body: Omit<RegisterV1, 'signature'> = opts.selfVouch === true
		? {
			...baseBody,
			bootstrapEvidence: serializeBootstrapEvidenceEnvelope({
				v: 1,
				reputation: { referee: bytesToB64url(participant.bytes), sig: bytesToB64url(await signPeer(participant.key, bootstrapBoundImage(baseBody))) },
			}),
		}
		: baseBody;
	return { ...body, signature: bytesToB64url(await signPeer(participant.key, registerSigningPayload(body))) };
}

async function signedReattach(participant: Member, topic: Uint8Array, now: number, correlationId = 'reattach'): Promise<RenewV1> {
	const body: Omit<RenewV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topic),
		participantId: bytesToB64url(participant.bytes),
		correlationId: bytesToB64url(new TextEncoder().encode(correlationId)),
		timestamp: now,
		reattach: true,
	};
	return { ...body, signature: bytesToB64url(await signPeer(participant.key, renewSigningPayload(body))) };
}

/** One real libp2p substrate node: the running node, its retained key/peer-id, the cohort-topic host, FRET. */
interface RealNode {
	readonly node: Libp2p;
	readonly key: PrivateKey;
	readonly peerId: PeerId;
	readonly idStr: string;
	/** A {@link Member} view so the shared harness's signed-frame builders work against a real node. */
	readonly member: Member;
	readonly host: CohortTopicHost;
	readonly fret: { assembleCohort(coord: Uint8Array, wants: number): string[] };
}

async function memberOf(key: PrivateKey, peerId: PeerId): Promise<Member> {
	return { key, peerId, idStr: peerId.toString(), bytes: peerIdToBytes(peerId), ringPos: await hashPeerId(peerId) };
}

(GATED ? describe : describe.skip)('substrate over real libp2p (cohort-topic / reactivity / matchmaking fidelity)', function () {
	// Boot of N nodes (TCP + noise + FRET + arachnode + cohort-topic host each) plus FRET stabilization
	// dominates; individual substrate ops finish in well under a second once the mesh is up.
	this.timeout(120_000);

	const nodes: RealNode[] = [];
	let coord0: RingCoord;
	// Published ONCE in `before` after stabilization: the membership publisher is stateful per engine
	// (it republishes only when the first k−x members change), so a second `onStabilized` is a no-op. The
	// cert stays SERVED on the primary's `/membership` handler, so every remote fetch below resolves it.
	let coord0Cert: MembershipCertV1;

	async function spawnNode(overrides: Partial<NodeOptions> = {}): Promise<RealNode> {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK_NAME,
			bootstrapNodes: [],
			privateKey: key,
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: true },
			cohortTopic: {
				enabled: true,
				wantK: WANT_K,
				host: {
					minSigs: MIN_SIGS,
					// Park the periodic driver far out: this suite pumps gossip / membership deterministically so a
					// background tick cannot race the bounded-poll assertions (mirrors the mock harness default).
					gossipIntervalMs: 3_600_000,
				},
			},
			...overrides,
		});
		const real: RealNode = {
			node,
			key,
			peerId,
			idStr: peerId.toString(),
			member: await memberOf(key, peerId),
			host: (node as unknown as { cohortTopicHost: CohortTopicHost }).cohortTopicHost,
			fret: (node as unknown as { services: { fret: { assembleCohort(coord: Uint8Array, wants: number): string[] } } }).services.fret,
		};
		nodes.push(real);
		return real;
	}

	function pickLocalTcpMultiaddr(node: Libp2p): string {
		const addrs = node.getMultiaddrs().map((a) => a.toString());
		const local = addrs.find((a) => a.startsWith('/ip4/127.0.0.1/tcp/')) ?? addrs.find((a) => a.includes('/tcp/') && a.includes('/p2p/'));
		if (!local) throw new Error(`No usable TCP multiaddr; have: ${addrs.join(', ')}`);
		return local;
	}

	/** Instantiate every node's tier-0 cohort engine for `coord` (so each has a live `/cohort-gossip` sub). */
	function engines(coord: RingCoord): CoordEngine[] {
		return nodes.map((n) => n.host.registry.forCoord(coord, 0 as Tier, n.member.bytes));
	}

	/** This node's tier-0 cohort engine for `coord`. */
	function engineOf(n: RealNode, coord: RingCoord): CoordEngine {
		return n.host.registry.forCoord(coord, 0 as Tier, n.member.bytes);
	}

	/** The full mesh peer-id set — what the whole-network tier-0 cohort must converge to. */
	function fullIdSet(): Set<string> {
		return new Set(nodes.map((n) => n.idStr));
	}

	/** The FRET-nearest member to `coord` (the routed primary): `assembleCohort(coord, N)[0]`, mapped to its node. */
	function primaryFor(coord: RingCoord): RealNode {
		const primaryId = nodes[0]!.fret.assembleCohort(coord, WANT_K)[0]!;
		return nodes.find((n) => n.idStr === primaryId) ?? nodes[0]!;
	}

	/** Seed the willingness quorum for `coord`: every member signs+sends a willingness frame to every other. */
	async function seedWillingness(coord: RingCoord): Promise<void> {
		const epoch = engineOf(nodes[0]!, coord).cohort().cohortEpoch;
		const now = Date.now();
		const sends: Promise<void>[] = [];
		for (const from of nodes) {
			const frame = await signedWillingness(from.member, coord, epoch, now);
			for (const to of nodes) {
				if (to.idStr === from.idStr) continue;
				sends.push(sendOneWay(from.node, to.peerId, GOSSIP_PROTOCOL, frame).catch(() => { /* best-effort; next round recovers */ }));
			}
		}
		await Promise.allSettled(sends);
		// No fixed settle here: every caller (`quorumOn`) polls the merged view with `waitFor`, so the
		// inbound /cohort-gossip handlers are given time to merge by the poll itself — early-exiting the
		// instant the quorum appears instead of padding a fixed wait.
	}

	/** Seed willingness for `coord` and wait until the primary's view carries the strict-majority quorum. */
	async function quorumOn(primaryEngine: CoordEngine, coord: RingCoord): Promise<boolean> {
		await seedWillingness(coord);
		const pred = (): boolean => primaryEngine.cohortView().all().size >= WILLING_SIBLINGS_NEEDED;
		try {
			await waitFor(pred, { timeoutMs: 20_000, intervalMs: 200 });
			return true;
		} catch {
			// One more seed wave in case some first-round dials lost the race to a not-yet-open stream.
			await seedWillingness(coord);
			try {
				await waitFor(pred, { timeoutMs: 20_000, intervalMs: 200 });
				return true;
			} catch {
				return false;
			}
		}
	}

	/** Publish a coord's membership cert, retrying past transient sub-quorum `/sign` rounds (real RPC settle). */
	async function publishCohortCert(coord: RingCoord): Promise<MembershipCertV1> {
		const primaryEngine = engineOf(primaryFor(coord), coord);
		let lastErr: unknown;
		try {
			// Poll `onStabilized` on the real /sign RPC cadence, returning the first published cert.
			// `undefined` = a `/sign` round gathered < minSigs before all warm connections settled (transient:
			// the publisher threshold-signs before publishing, so nothing leaked); a thrown error is the same
			// transient, captured for the timeout message. Either way keep polling — early-exit on the first cert.
			return await waitForValue(async () => {
				try {
					return await primaryEngine.onStabilized(Date.now());
				} catch (err) {
					lastErr = err;
					return undefined;
				}
			// NOTE: 20s wall-clock bound (the old loop was 40 attempts × ~500ms + RPC, so a longer effective
			// ceiling when each /sign RPC was slow). Healthy runs publish on the first or second poll; if a
			// loaded CI machine makes onStabilized slow enough to time out here, raise timeoutMs.
			}, { timeoutMs: 20_000, intervalMs: 500, description: 'the cohort membership cert reached quorum over real /sign RPC' });
		} catch {
			throw lastErr ?? new Error('membership cert never reached quorum');
		}
	}

	/** A fresh real-keyed participant whose deterministic slot-primary (under `engine`'s epoch) is the routed primary. */
	async function participantPrimaryAt(engine: CoordEngine, coord: RingCoord): Promise<Member> {
		const primary = primaryFor(coord);
		const { members, cohortEpoch } = engine.cohort();
		for (let attempt = 0; attempt < 8192; attempt++) {
			const key = await generateKeyPair('Ed25519');
			const member = await memberOf(key, peerIdFromPrivateKey(key));
			if (bytesEqual(slotPrimary(member.bytes, cohortEpoch, members), primary.member.bytes)) return member;
		}
		throw new Error('could not derive a participant pinned to the routed primary');
	}

	before(async function () {
		// Star topology to bootstrap discovery: nodes[0] is the bootstrap; the rest dial it.
		const seed = await spawnNode();
		const bootstrapAddr = pickLocalTcpMultiaddr(seed.node);
		const dialAddrs = [bootstrapAddr];
		for (let i = 1; i < N; i++) {
			const n = await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core' });
			dialAddrs.push(pickLocalTcpMultiaddr(n.node));
		}

		// Establish an explicit FULL MESH of warm connections: every node dials every other's TCP addr. The
		// cohort-topic RPCs (`/sign` threshold collection, `/membership` fetch, `/cohort-gossip` fan-out) dial
		// arbitrary cohort members, so whichever member FRET routes to as the primary must already have a warm,
		// address-resolved connection to the rest — a star (leaf→bootstrap only) leaves leaf↔leaf `/sign` dials
		// to resolve cold and intermittently fall short of quorum.
		for (const n of nodes) {
			for (let j = 0; j < nodes.length; j++) {
				if (nodes[j]!.idStr === n.idStr) continue;
				try { await n.node.dial(multiaddr(dialAddrs[j]!)); } catch { /* a peer already dialed us covers this edge */ }
			}
		}
		await waitFor(() => nodes.every((n) => n.node.getPeers().length >= N - 1), { timeoutMs: 60_000, intervalMs: 250, description: `the ${N}-node full mesh did not fully connect within the bound` });

		coord0 = addressing.coord0(TOPIC);

		// Instantiate the tier-0 engine on every node up front so each has a live `/cohort-gossip`
		// subscription for coord_0 before any willingness / record gossip is sent.
		engines(coord0);

		// Wait for real FRET two-sided stabilization: every node's tier-0 cohort around coord_0 must be the
		// whole-mesh set. Generous bound — real FRET discovery gossip is non-instant.
		const expected = fullIdSet();
		await waitFor(() => {
			for (const n of nodes) {
				const members = new Set(engineOf(n, coord0).cohort().members.map(bytesToPeerIdString));
				if (members.size !== N) return false;
				for (const id of expected) if (!members.has(id)) return false;
			}
			return true;
		}, { timeoutMs: 90_000, intervalMs: 250, description: `FRET did not stabilize the ${N}-node tier-0 cohort within the bound` });

		// Publish the coord_0 cohort's membership cert once (real (N-1)-of-N multisig collected over `/sign`);
		// it stays served on the routed primary's `/membership` handler for the verify + stale-refetch tests.
		coord0Cert = await publishCohortCert(coord0);
	});

	after(async () => {
		const toStop = nodes.splice(0, nodes.length);
		await Promise.allSettled(toStop.map((n) => n.node.stop()));
	});

	// --- 1. FRET cohort assembly + coordinate derivation (real two-sided stabilization) ---
	it('FRET assembles the tier-0 cohort = the whole mesh, with one identical coord/epoch on every node', () => {
		const expected = fullIdSet();
		const epochs = new Set<string>();
		for (const n of nodes) {
			const snap = engineOf(n, coord0).cohort();
			const members = new Set(snap.members.map(bytesToPeerIdString));
			expect(members, `node ${n.idStr} assembled the whole-mesh cohort around coord_0`).to.deep.equal(expected);
			expect(engineOf(n, coord0).treeTier, 'instantiated at tier 0').to.equal(0);
			epochs.add(bytesToB64url(snap.cohortEpoch));
		}
		// The deterministic coord_0 epoch is what the threshold-signature collection depends on: a fragmented
		// cohort (nodes disagreeing on the member set) could never quorum. Real FRET converges to one epoch.
		expect(epochs.size, 'all N nodes derive one identical cohort epoch for coord_0').to.equal(1);
	});

	// --- 2. MembershipCertV1: real k−x threshold sig over /sign, served over /membership, verified remotely ---
	it('a cohort publishes a real threshold-signed MembershipCertV1 that a remote participant verifies end-to-end', async () => {
		// `coord0Cert` was assembled in `before` by the routed primary collecting a genuine (N-1)-of-N multisig
		// over the real `/sign` RPC; it stays served on that primary's real `/membership` protocol.
		const primary = primaryFor(coord0);
		const cert = coord0Cert;
		expect(cert.signers.length, 'at least minSigs distinct signers').to.be.at.least(MIN_SIGS);
		expect(new Set(cert.signers).size, 'signers are distinct').to.equal(cert.signers.length);
		const certMembers = new Set(cert.members);
		expect(cert.signers.every((s) => certMembers.has(s)), 'every signer is a cohort member').to.equal(true);

		// A *different* node's participant verifier fetches the cert over the real `/membership` protocol and
		// verifies the real collected multisig for real.
		const participant = nodes.find((n) => n.idStr !== primary.idStr)!;
		const certPayload = membershipCertSigningPayload(cert);
		const verdict = await participant.host.service.verifier().verifyMessage(cert.signers.map(b64urlToBytes), coord0, 0, certPayload, b64urlToBytes(cert.thresholdSig));
		expect(verdict, 'a participant verifies the real threshold-signed cert end-to-end over /membership').to.equal('verified');

		// Negative: the interim shape — a single-signer "threshold" sig — is rejected at minSigs = N-1.
		const forgedSig = await signPeer(primary.member.key, certPayload);
		const forged = await participant.host.service.verifier().verifyMessage([primary.member.bytes], coord0, 0, certPayload, forgedSig);
		expect(forged, 'a forged single-signer cert is untrusted').to.equal('untrusted');
	});

	it('a stale cert in the membership source forces one real /membership refetch, then verifies', async () => {
		const primary = primaryFor(coord0);
		const cert = coord0Cert;

		// Use a node that has NOT yet cached coord_0's cert via the verifier (i.e. not the participant from
		// test 1, which already TOFU-cached it). With N ≥ 3 there is always at least one such fresh node.
		const firstNonPrimary = nodes.find((n) => n.idStr !== primary.idStr)!;
		const freshParticipant = nodes.find((n) => n.idStr !== primary.idStr && n.idStr !== firstNonPrimary.idStr)!;

		// Seed the membership SOURCE (not the verifier) with a fabricated stale cert: a non-self-consistent
		// member set, so the verifier's cached-cert check fails and forces exactly one real `/membership`
		// refetch. Because the source feeds TOFU-cached entries (not trusted ones), the refetch's genuine
		// cert is permitted to replace it — the trust gate allows this path (unlike `verifier.cache()`, which
		// marks the cert trusted and blocks silent overwrites by un-anchored refetches).
		const stale = [bytesToB64url(staleMemberBytes())];
		const staleCert: MembershipCertV1 = {
			v: 1,
			cohortCoord: bytesToB64url(coord0),
			cohortEpoch: bytesToB64url(new Uint8Array([9, 9, 9])),
			members: stale,
			stabilizedAt: Date.now() - 1_000_000,
			thresholdSig: bytesToB64url(new Uint8Array([0])),
			signers: stale,
		};
		const staleEncoded = encodeCohortMessage(staleCert);
		freshParticipant.host.membershipSource.cache(coord0, staleEncoded);
		expect(bytesEqual(staleEncoded, (await freshParticipant.host.membershipSource.current(coord0))!), 'the stale cert is the cached view before the verify').to.equal(true);

		const certPayload = membershipCertSigningPayload(cert);
		const verdict = await freshParticipant.host.service.verifier().verifyMessage(cert.signers.map(b64urlToBytes), coord0, 0, certPayload, b64urlToBytes(cert.thresholdSig));
		expect(verdict, 'a stale source cert forces one real /membership refetch, then verifies').to.equal('verified');

		// Prove the refetch actually fired and replaced the unusable cached view: `FretMembershipSource.fetch()`
		// re-caches the genuine `/membership` reply, so the source's `current()` for coord_0 must no longer be the
		// seeded stale bytes. Without the refetch the verdict could not have been `'verified'`, but this also pins
		// the *one-fetch-replaces-stale* behavior at the integration layer (exact fetch-count is unit-covered at
		// db-core membership.spec.ts:77).
		const afterRefetch = await freshParticipant.host.membershipSource.current(coord0);
		expect(afterRefetch !== undefined && !bytesEqual(staleEncoded, afterRefetch), 'the real /membership refetch replaced the stale cached cert').to.equal(true);
	});

	// --- 3. Cohort-gossip record replication + handoff readiness over real /cohort-gossip ---
	it('a record accepted on the routed primary replicates into a sibling store over real /cohort-gossip (no loss across a touch)', async () => {
		const primary = primaryFor(coord0);
		const primaryEngine = engineOf(primary, coord0);
		const sibling = nodes.find((n) => n.idStr !== primary.idStr)!;
		const siblingEngine = engineOf(sibling, coord0);

		// Bootstrap the willingness quorum the cohort admission needs: an idle engine builds no willingness
		// frame, so the first registration needs this seed (exactly as the mock-tier `setupTopic` does).
		expect(await quorumOn(primaryEngine, coord0), 'the willingness quorum converged on the primary over real gossip').to.equal(true);

		// A participant whose deterministic slot-primary is the routed primary, so the served ping/re-attach
		// touches the record into the gossip deltas (an arbitrary participant lands on the primary only ~1/k).
		const participant = await participantPrimaryAt(primaryEngine, coord0);
		const now = Date.now();
		// This is a T0 (`tier: 0`, default) `bootstrap: true` register carrying no evidence. The production node
		// is *configured* (node-base wires `antiDos.reputation`) but has no committed-existence backing
		// (`committedParentTopicReader` unwired, no `parentTopicView` override), so T0/T1 bootstrap stays
		// permissive-but-logged (cohort-topic-bootstrap-coldstart-origination-regression) and this admits.
		const accept = await primaryEngine.engine.handleRegister(await signedRegister(participant, TOPIC, now, 'real-repl'), { followOn: false, treeTier: 0 }, now);
		expect(accept.result, 'the cohort admitted the registration over the real willingness quorum').to.equal('accepted');
		// Stamp the reattach after the register's `lastPing` (= now) so the freshness gate accepts it.
		expect(primaryEngine.engine.handleRenew(await signedReattach(participant, TOPIC, now + 1), now).result, 'reattach touches the record').to.equal('ok');

		// One gossip round broadcasts the touched record to the cohort over real `/cohort-gossip`.
		const g = await primaryEngine.gossipRound(now);
		expect(g?.records?.length, 'the round carries the touched record').to.be.at.least(1);

		await waitFor(() => siblingEngine.holds(TOPIC, participant.bytes), { timeoutMs: 20_000, intervalMs: 150, description: 'the sibling replicated the record over real /cohort-gossip' });
		// Handoff readiness: the sibling now *serves the topic*, so it is a viable warm-failover target for the
		// participant's primary — the cohort-side half of primary handoff. (The full FRET-departure-driven epoch
		// rotation is timing-bound on real churn detection; see the suite header + the review handoff.)
		expect(siblingEngine.servesTopic(TOPIC), 'a sibling now serves the topic (warm-failover target exists)').to.equal(true);
	});

	// --- 4. Reactivity origination membership gate over real FRET + bridge wiring present ---
	it('the production reactivity origination bridge is wired and its membership gate matches the real FRET cohort', () => {
		// The node-base activation replaced the bare change-notifier with the origination-decorating bridge and
		// exposed the host (`libp2p-node-base.ts` §Cohort-topic origination activation).
		for (const n of nodes) {
			expect((n.node as unknown as { cohortTopicHost?: unknown }).cohortTopicHost, 'cohort-topic host exposed').to.exist;
			expect((n.node as unknown as { blockChangeNotifier?: unknown }).blockChangeNotifier, 'change-notifier bridge installed').to.exist;
		}

		// The real `selfIsCohortMember` gate over real FRET agrees with `assembleCohort(coord_0(reactivityTopicId(tail)))`.
		const reactivityCoord = addressing.coord0(reactivityTopicId(reactivityTailBytes(TAIL_ID)));
		const expectedMembers = new Set(nodes[0]!.fret.assembleCohort(reactivityCoord, WANT_K));
		for (const n of nodes) {
			const gate = createReactivitySelfMembershipGate({ fret: n.fret, selfPeerId: n.idStr, wantK: WANT_K });
			const isMember = gate({ collectionId: 'c', blockIds: [], actionId: 'a', rev: 1, tailId: TAIL_ID });
			expect(isMember, `node ${n.idStr} gate agrees with its membership in the reactivity cohort`).to.equal(expectedMembers.has(n.idStr));
		}
		// At wantK = N the whole mesh is the reactivity cohort, so every node originates for this tail.
		expect(expectedMembers.size, 'reactivity tier-0 cohort = whole mesh at wantK = N').to.equal(N);
	});

	// reactivity notification *socket delivery* end-to-end is now LIVE in production (12.33): the node wires
	// ReactivityOriginationManager.emit → forwarder host → the notify protocol, and a node-level subscriber
	// registry receives inbound frames. A committed change on a tail-cohort member fires a NotificationV1 that
	// reaches a remote subscriber over a real socket; the subscriber verifies it with real Ed25519 against the
	// tail cohort's membership. (Rotation-specific redirect is 12.5; the Quereus Database.watch app-bridge that
	// CONSTRUCTS managers stays the backlog optimystic-network-reactive-watch-integration-test — here the
	// subscriber is constructed directly against the remote node's registry.)
	it('a commit on a real cohort member delivers a NotificationV1 to a remote subscriber over a real socket', async () => {
		const tailBytes = reactivityTailBytes(TAIL_ID);
		const topicId = reactivityTopicId(tailBytes);
		const reactivityCoord = addressing.coord0(topicId);

		// Instantiate every node's reactivity cohort engine + converge willingness so the primary can admit the
		// subscriber registration (mirrors the matchmaking provider test's pre-steps).
		engines(reactivityCoord);
		const origin = primaryFor(reactivityCoord);
		const originEngine = engineOf(origin, reactivityCoord);
		expect(await quorumOn(originEngine, reactivityCoord), 'willingness converged for the reactivity topic').to.equal(true);

		// The remote subscriber is a different real node; register it as a direct reactivity subscriber on the
		// origin's cohort engine so origin's `directSubscribers(topicId)` → [remote] and origin dials it.
		const remote = nodes.find((n) => n.idStr !== origin.idStr)!;
		const collectionIdB64 = bytesToB64url(new TextEncoder().encode('rx-socket-collection'));
		const now = Date.now();
		const appPayload = subscribeAppPayloadBytes({
			collectionId: collectionIdB64,
			tailIdAtAttach: bytesToB64url(tailBytes),
			lastKnownRev: 0,
			deltaMaxBytes: 0,
		});
		const regBody: Omit<RegisterV1, 'signature'> = {
			v: 1,
			topicId: bytesToB64url(topicId),
			tier: Tier.T3,
			treeTier: 0,
			participantCoord: bytesToB64url(remote.member.bytes),
			ttl: 90_000,
			bootstrap: true,
			timestamp: now,
			correlationId: bytesToB64url(new TextEncoder().encode('rx-socket-sub')),
			appPayload: bytesToB64url(appPayload),
		};
		// T3 (`tier > maxNoPowTier`) bootstrap is always gated on the production node (cohort-topic-bootstrap-
		// coldstart-origination-regression keeps only T0/T1 permissive). Attach a self-vouch reputation
		// endorsement: the registrant peer-key-signs its own bootstrapBoundImage as the referee, and the origin's
		// reputation view sees an unseen, non-banned peer (score 0 < deprioritize) → admitted via the
		// `PoW || reputation || parent-ref` disjunction. bootstrapBoundImage binds only (topicId, tier,
		// participantCoord, timestamp), so it is identical on regBody and the evidence-bearing body; attach the
		// evidence to the body BEFORE the final register sign (registerSigningPayload covers bootstrapEvidence).
		const repSig = await signPeer(remote.member.key, bootstrapBoundImage(regBody));
		const evidence = serializeBootstrapEvidenceEnvelope({
			v: 1,
			reputation: { referee: bytesToB64url(remote.member.bytes), sig: bytesToB64url(repSig) },
		});
		const regBodyWithEv: Omit<RegisterV1, 'signature'> = { ...regBody, bootstrapEvidence: evidence };
		const reg: RegisterV1 = { ...regBodyWithEv, signature: bytesToB64url(await signPeer(remote.member.key, registerSigningPayload(regBodyWithEv))) };
		const accept = await originEngine.engine.handleRegister(reg, { followOn: false, treeTier: 0 }, now);
		expect(accept.result, 'the reactivity subscriber registration was admitted on the origin cohort engine').to.equal('accepted');
		expect(
			originEngine.records(topicId).some((r) => r.appState !== undefined && bytesEqual(r.participantId, remote.member.bytes)),
			'origin holds the remote reactivity subscriber record (direct-subscriber read)',
		).to.equal(true);

		// Cache the tail cohort's MembershipCertV1 (whole mesh at wantK = N) into every node's verifier, so the
		// origin's own forwarder receive AND the remote subscriber's verify are real Ed25519 against the
		// membership (cache() trusts the membership list; the notification's own threshold sig is verified).
		const members = nodes.map((n) => bytesToB64url(n.member.bytes));
		const cert: MembershipCertV1 = {
			v: 1,
			cohortCoord: bytesToB64url(reactivityCoord),
			cohortEpoch: bytesToB64url(new TextEncoder().encode(`rx:${TAIL_ID}`)),
			members,
			stabilizedAt: now,
			thresholdSig: bytesToB64url(new Uint8Array([0])),
			signers: members,
		};
		for (const n of nodes) {
			n.host.service.verifier().cache(cert);
		}

		// Register the remote subscriber in the remote node's reactivity subscriber registry, verifying each
		// inbound notification with the production notification verifier (real collected-multisig at T3).
		const received: NotificationV1[] = [];
		const verdicts: string[] = [];
		const verifier = createNotificationVerifier({ verifier: remote.host.service.verifier(), tier: Tier.T3 });
		const registry = (remote.node as unknown as { reactivitySubscribers: { register(topicId: Uint8Array, h: (n: NotificationV1) => void): () => void } }).reactivitySubscribers;
		const off = registry.register(topicId, (n) => {
			received.push(n);
			void verifier.verify(n).then((r) => verdicts.push(r));
		});

		try {
			// Build a REAL threshold commit cert over the cohort: every member signs utf8(commitHash+":approve")
			// with its real Ed25519 key. signers are sorted by peer-id string so each aligns with its 64-byte
			// chunk of the concatenated threshold sig (mirrors buildCommitCert / the mesh harness's buildTailCert).
			const commitHash = `${collectionIdB64}:1`;
			const signedPayload = new TextEncoder().encode(`${commitHash}:approve`);
			const sortedSigners = [...nodes].sort((a, b) => (a.idStr < b.idStr ? -1 : a.idStr > b.idStr ? 1 : 0));
			const chunks: Uint8Array[] = [];
			for (const n of sortedSigners) {
				chunks.push(await n.key.sign(signedPayload));
			}
			const thresholdSig = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
			let offset = 0;
			for (const c of chunks) {
				thresholdSig.set(c, offset);
				offset += c.length;
			}
			const commitCert: CommitCert = { thresholdSig, signers: sortedSigners.map((n) => n.idStr), minSigs: MIN_SIGS, signedPayload };

			// Fire origination on the origin: the production onLocalCommit hook builds the NotificationV1 and
			// emits it → forwarder host → notify socket → the remote node's subscriber registry.
			const event: CollectionChangeEvent = {
				collectionId: collectionIdB64 as unknown as BlockId,
				blockIds: [],
				actionId: 'rx-socket-action' as ActionId,
				rev: 1,
				tailId: TAIL_ID as BlockId,
			};
			expect(typeof origin.host.service.onLocalCommit, 'origination hook installed on the origin').to.equal('function');
			origin.host.service.onLocalCommit!(event, commitCert);

			await waitFor(() => received.length >= 1, { timeoutMs: 20_000, intervalMs: 150, description: 'the remote subscriber received a NotificationV1 over the real notify socket' });
			expect(received[0]!.revision, 'the delivered notification carries the committed revision').to.equal(1);
			expect(received[0]!.tailId, 'the delivered notification anchors on the committed tail').to.equal(bytesToB64url(tailBytes));

			await waitFor(() => verdicts.length >= 1, { timeoutMs: 5_000, intervalMs: 50, description: 'the subscriber ran the verify path on the delivered notification' });
			expect(verdicts[0], 'the delivered notification verified end-to-end (real Ed25519 against the tail cohort)').to.equal('verified');
		} finally {
			off();
		}
	});

	// reactivity RECOVER (resume) *socket delivery* — the pull-recovery analogue of the notify socket test
	// above, now LIVE in production (12.42): the node registers the recover request-reply handler against the
	// forwarder host's live PushStates. A remote subscriber that slept past the live tail's last delivered
	// revision sends one ResumeV1 over a real `/optimystic/reactivity/1.0.0/recover` socket to a real tail-cohort
	// member and is brought current (the backfill variant). The subscriber side is constructed directly (the
	// Quereus Database.watch → manager factory stays the backlog optimystic-network-reactive-watch-integration-test,
	// exactly as the notify test notes); the recover transport is pinned to the origin for determinism — the full
	// sticky-primary → cohort-walk target selection is unit-covered by reactivity/recover-transport.spec.ts.
	it('a remote subscriber resumes past the tail over a real recover socket and is brought current (backfill)', async () => {
		const RESUME_TAIL = 'optimystic/collection/tail-resume-real-libp2p';
		const tailBytes = reactivityTailBytes(RESUME_TAIL);
		const topicId = reactivityTopicId(tailBytes);
		const reactivityCoord = addressing.coord0(topicId);

		// Instantiate every node's reactivity cohort engine + converge willingness so the origin admits + serves.
		engines(reactivityCoord);
		const origin = primaryFor(reactivityCoord);
		const originEngine = engineOf(origin, reactivityCoord);
		expect(await quorumOn(originEngine, reactivityCoord), 'willingness converged for the resume topic').to.equal(true);

		const remote = nodes.find((n) => n.idStr !== origin.idStr)!;
		const collectionIdB64 = bytesToB64url(new TextEncoder().encode('rx-resume-collection'));

		// The production recover transport's cohort-walk WOULD reach the origin: at wantK = N it is in the resume
		// topic's FRET cohort (the same coord_0 assembly `resolveReactivityCohort` uses in libp2p-node-base).
		expect(remote.fret.assembleCohort(reactivityCoord, WANT_K), 'origin is a recover-walk target for the remote').to.include(origin.idStr);

		// Cache the tail cohort's MembershipCertV1 (whole mesh at wantK = N) into every node's verifier so the
		// origin's own forwarder receive (which buffers the originated notification into its PushState replay ring)
		// verifies with real Ed25519 against the membership.
		const now = Date.now();
		const members = nodes.map((n) => bytesToB64url(n.member.bytes));
		const cert: MembershipCertV1 = {
			v: 1,
			cohortCoord: bytesToB64url(reactivityCoord),
			cohortEpoch: bytesToB64url(new TextEncoder().encode(`rx-resume:${RESUME_TAIL}`)),
			members,
			stabilizedAt: now,
			thresholdSig: bytesToB64url(new Uint8Array([0])),
			signers: members,
		};
		for (const n of nodes) {
			n.host.service.verifier().cache(cert);
		}

		// Originate rev 1 on the origin: the production onLocalCommit builds a NotificationV1 and ingests it into
		// the origin's forwarder host, filling its PushState replay ring with rev 1 — the live tail's last
		// delivered revision the remote will resume past. Real threshold commit cert (every member signs its
		// approve image; signers sorted by peer-id so each aligns with its 64-byte chunk of the threshold sig).
		const commitHash = `${collectionIdB64}:1`;
		const signedPayload = new TextEncoder().encode(`${commitHash}:approve`);
		const sortedSigners = [...nodes].sort((a, b) => (a.idStr < b.idStr ? -1 : a.idStr > b.idStr ? 1 : 0));
		const chunks: Uint8Array[] = [];
		for (const n of sortedSigners) {
			chunks.push(await n.key.sign(signedPayload));
		}
		const thresholdSig = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
		let offset = 0;
		for (const c of chunks) {
			thresholdSig.set(c, offset);
			offset += c.length;
		}
		const commitCert: CommitCert = { thresholdSig, signers: sortedSigners.map((n) => n.idStr), minSigs: MIN_SIGS, signedPayload };
		const event: CollectionChangeEvent = {
			collectionId: collectionIdB64 as unknown as BlockId,
			blockIds: [],
			actionId: 'rx-resume-action' as ActionId,
			rev: 1,
			tailId: RESUME_TAIL as BlockId,
		};
		expect(typeof origin.host.service.onLocalCommit, 'origination hook installed on the origin').to.equal('function');
		origin.host.service.onLocalCommit!(event, commitCert);

		// The remote's recover transport over the real recover socket, pinned to the origin: the production dialer
		// + the node's real recover request signers. The sticky cohort-hint cache starts empty, so target
		// selection falls straight through to the resolved (origin) target.
		const recover = new Libp2pReactivityRecoverTransport({
			dialer: createLibp2pRecoverDialer(remote.node, DEFAULT_REACTIVITY_PROTOCOLS.recover),
			selfPeerId: remote.idStr,
			cohortHintCache: createStickyCohortHintCache(),
			resolveCohort: () => [origin.idStr],
		});
		const { signResume } = createRecoverRequestSigners(remote.key);
		const resumeTransport = recover.resumeTransport(topicId, collectionIdB64);

		// The remote slept holding nothing past rev 0, so it resumes from rev 1. Poll: origination ingest is async
		// (serialized off the emit seam), so the origin's PushState may not yet hold rev 1 on the first dial — a
		// not-yet-served collection replies with no frame (the dial rejects). Each attempt re-stamps `timestamp`
		// (fresh, re-signed) so the serve-side freshness/replay guard admits the retry rather than rejecting it.
		let reply: ResumeReplyV1 | undefined;
		await waitFor(async () => {
			const unsigned: ResumeSignable = {
				v: 1,
				collectionId: collectionIdB64,
				fromRevision: 1,
				latestKnownTailId: bytesToB64url(tailBytes),
				subscriberCoord: bytesToB64url(remote.member.bytes),
				timestamp: Date.now(),
			};
			const req: ResumeV1 = { ...unsigned, signature: signResume(unsigned) };
			try {
				reply = await resumeTransport(req);
				return reply.result === 'backfill';
			} catch {
				return false; // origin not yet serving the PushState (ingest pending) → dial rejected; retry
			}
		}, { timeoutMs: 20_000, intervalMs: 200, description: 'the remote got a backfill resume reply from the real tail-cohort member over a real socket' });
		expect(reply!.result, 'within the replay ring → backfill').to.equal('backfill');
		expect(reply!.entries!.map((e) => e.revision), 'the backfill brings the remote current to the tail revision').to.deep.equal([1]);
		expect(reply!.currentRevision, 'the reply carries the current tail revision').to.equal(1);
	});

	// reactivity tail-rotation REDIRECT over a real recover socket (`reactivity-rotation-host-wiring-e2e` §D):
	// after a tail-id change the origination manager fires `forwarderHost.markRotated(oldTopicId, …)`, so a recover
	// dialed at the OLD cohort returns a `kind:"rotated"` frame (the outbound transport raises a terminal
	// `RotationRedirectError`). The drain seam + the observe-on-tail-id-change wiring are exercised end-to-end at
	// the mock tier (`reactivity/mesh-tail-rotation.spec.ts`) and unit-pinned (`managers.spec.ts` markRotated
	// encoding, `forwarder-host.spec.ts` rotationRedirectFor). Standing up a *real* two-tail rotation here means
	// driving two genuine tail commits through the cluster commit path on a node whose FRET has stabilized BOTH
	// the old and the new tail's reactivity cohort — beyond an agent-runnable budget for this small-N real tier —
	// so it is tagged pending rather than added as a flaky long-running test (mirrors the matchmaking-query and
	// FRET-routed-walk pending tests below).
	it.skip('[unimplemented:real-tier — tracked by reactivity-rotation-host-wiring-e2e §D] a recover dialed at the old cohort after a tail-id change returns a kind:"rotated" frame over a real socket', () => {
		/* deferred: a real two-tail rotation needs both tails' reactivity cohorts FRET-stabilized + two real tail commits; the markRotated → rotationRedirectFor → kind:"rotated" path is mock-tier + unit covered */
	});

	// --- 5. Matchmaking: a provider record lands in + replicates across a real cohort ---
	it('a matchmaking provider registration lands in the real cohort and replicates over /cohort-gossip', async () => {
		const matchTopic = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 11) & 0xff);
		const matchCoord = addressing.coord0(matchTopic);
		// Instantiate + stabilize willingness for this topic's cohort (whole mesh at wantK = N).
		engines(matchCoord);
		const matchPrimary = primaryFor(matchCoord);
		const matchPrimaryEngine = engineOf(matchPrimary, matchCoord);
		expect(await quorumOn(matchPrimaryEngine, matchCoord), 'willingness converged for the matchmaking topic').to.equal(true);

		const provider = await participantPrimaryAt(matchPrimaryEngine, matchCoord);
		const now = Date.now();
		// A matchmaking provider rides the cohort-topic register at the matchmaking application tier (T2).
		// T2 bootstrap stays gated on the configured production node (cohort-topic-bootstrap-coldstart-
		// origination-regression keeps only T0/T1 permissive), so the provider self-vouches to clear the
		// `PoW || reputation || parent-ref` disjunction (origin scores it as an unseen, non-banned peer).
		const accept = await matchPrimaryEngine.engine.handleRegister(await signedRegister(provider, matchTopic, now, 'mm-provider', { tier: 2, selfVouch: true }), { followOn: false, treeTier: 0 }, now);
		expect(accept.result, 'the cohort admitted the provider registration over real transport').to.equal('accepted');
		expect(matchPrimaryEngine.records(matchTopic).length, 'the primary holds the provider record (the matchmaking QueryV1 read)').to.be.at.least(1);

		// Touch + gossip so a sibling replicates the provider record (the cohort-side read a remote seeker query
		// would serve from). The seeker *walk* over real sockets needs the unwired QueryV1 RPC (next test).
		// Stamp the reattach after the register's `lastPing` (= now) so the freshness gate accepts it.
		expect(matchPrimaryEngine.engine.handleRenew(await signedReattach(provider, matchTopic, now + 1), now).result).to.equal('ok');
		await matchPrimaryEngine.gossipRound(now);
		const sibling = nodes.find((n) => n.idStr !== matchPrimary.idStr)!;
		const siblingEngine = engineOf(sibling, matchCoord);
		await waitFor(() => siblingEngine.records(matchTopic).length >= 1, { timeoutMs: 20_000, intervalMs: 150, description: 'the provider record replicated to a sibling cohort member over real /cohort-gossip' });
	});

	// --- 5b. Matchmaking: a remote seeker reads a cohort's provider set over the real QueryV1 RPC ---
	// The serve half of the seeker query transport is now LIVE in production (this ticket): the node registers
	// `/optimystic/matchmaking/1.0.0/query` over the host's CoordRegistry. A remote node dials the routed primary
	// with an encoded QueryV1 and the decoded QueryReplyV1 carries the provider entry (with a forwardable
	// `registrationSig` the seeker re-validates) and the cohort's topicTraffic snapshot. The OUTBOUND seeker walk
	// (target selection + hang-out loop) driving this serve RPC is exercised end-to-end in §5c below.
	it('a remote node reads a cohort\'s provider set over the real matchmaking QueryV1 RPC', async () => {
		const matchTopic = Uint8Array.from({ length: 32 }, (_v, i) => (i * 3 + 19) & 0xff);
		const matchCoord = addressing.coord0(matchTopic);
		// Instantiate + stabilize willingness for this topic's cohort (whole mesh at wantK = N).
		engines(matchCoord);
		const matchPrimary = primaryFor(matchCoord);
		const matchPrimaryEngine = engineOf(matchPrimary, matchCoord);
		expect(await quorumOn(matchPrimaryEngine, matchCoord), 'willingness converged for the query topic').to.equal(true);

		// A provider whose deterministic slot-primary is the routed primary, registered with a REAL matchmaking
		// provider app payload so the served record classifies as a provider (its `appState` decodes via
		// `decodeMatchAppPayload`). The payload's signature is over `providerSigningPayload(topicId, caps, budget)`
		// — exactly what the forwarded entry's `registrationSig` is, so the seeker can re-validate it.
		const provider = await participantPrimaryAt(matchPrimaryEngine, matchCoord);
		const capabilities = ['transcode', 'gpu'];
		const capacityBudget = 4;
		const contactHint = `/ip4/127.0.0.1/tcp/4001/p2p/${provider.idStr}`;
		const providerSig = bytesToB64url(await signPeer(provider.key, providerSigningPayload(matchTopic, capabilities, capacityBudget)));
		const appPayload = encodeProviderAppPayload({ kind: 'match-provider', capabilities, capacityBudget, contactHint, signature: providerSig });
		const now = Date.now();
		// T2 bootstrap stays gated on the configured production node (only T0/T1 permissive), so the provider
		// self-vouches to clear the `PoW || reputation || parent-ref` disjunction (mirrors §5).
		const reg = await signedRegister(provider, matchTopic, now, 'mm-query-provider', { tier: 2, selfVouch: true, appPayload });
		const accept = await matchPrimaryEngine.engine.handleRegister(reg, { followOn: false, treeTier: 0 }, now);
		expect(accept.result, 'the cohort admitted the matchmaking provider registration').to.equal('accepted');
		expect(
			matchPrimaryEngine.records(matchTopic).some((r) => r.appState !== undefined && bytesEqual(r.participantId, provider.bytes)),
			'the primary holds the provider record with a decodable matchmaking appState',
		).to.equal(true);

		// A *different* real node dials the routed primary's `/query` protocol over a real socket with an encoded
		// QueryV1 (built like the mock harness `queryCohort`: includeProviders, signature 'AA'). The reply is the
		// real cohort serve: real records, real topicTraffic snapshot, real node-key reply signature.
		const remote = nodes.find((n) => n.idStr !== matchPrimary.idStr)!;
		const query: QueryV1 = {
			v: 1,
			topicId: bytesToB64url(matchTopic),
			includeProviders: true,
			includeSeekers: false,
			limit: 256,
			requesterId: remote.idStr,
			timestamp: Date.now(),
			signature: 'AA',
		};
		const replyFrame = await requestResponse(remote.node, matchPrimary.peerId, DEFAULT_MATCHMAKING_PROTOCOLS.query, encodeQueryV1(query), DEFAULT_STREAM_MAX_BYTES);
		const reply = decodeQueryReplyV1(replyFrame, DEFAULT_STREAM_MAX_BYTES);

		expect(reply.providers, 'the reply carries a providers array').to.not.equal(undefined);
		const entry = reply.providers!.find((p) => p.participantId === provider.idStr);
		expect(entry, 'the reply includes the registered provider entry').to.not.equal(undefined);
		expect(entry!.capabilities, 'the entry forwards the provider capabilities').to.deep.equal(capabilities);
		expect(entry!.capacityBudget, 'the entry forwards the capacity budget').to.equal(capacityBudget);
		// The forwarded `registrationSig` re-validates seeker-side (the advisory trust model's hinge): reconstruct
		// the provider signing image from the entry's own fields and verify against its `participantId` peer key.
		expect(
			verifyProviderEntry(matchTopic, entry!, (id, payload, sig) => verifyPeerSig(id, payload, sig)),
			'the forwarded registrationSig re-validates against the provider peer key (forwardable)',
		).to.equal(true);
		// The cohort's gossip-derived traffic barometer is attached and reflects the real store population.
		expect(reply.topicTraffic, 'the reply attaches a topicTraffic snapshot').to.not.equal(undefined);
		expect(reply.topicTraffic.directParticipants, 'topicTraffic reflects the real direct-participant count').to.be.at.least(1);
		// The reply is single-member-signed over the canonical image by the serving node's peer key.
		expect(reply.signature.length, 'the reply carries the cohort primary single-member signature').to.be.greaterThan(0);

		// A query for a topic this node serves no engine for gets NO reply (the handler never instantiates an
		// engine from an inbound query — DoS guard); requestResponse resolves the empty read as a 0-byte frame.
		const unknownTopic = Uint8Array.from({ length: 32 }, (_v, i) => (i * 31 + 7) & 0xff);
		const unknownQuery: QueryV1 = { ...query, topicId: bytesToB64url(unknownTopic) };
		const noReply = await requestResponse(remote.node, matchPrimary.peerId, DEFAULT_MATCHMAKING_PROTOCOLS.query, encodeQueryV1(unknownQuery), DEFAULT_STREAM_MAX_BYTES);
		expect(noReply.length, 'a query for an unserved topic yields no reply frame (no engine instantiated)').to.equal(0);
	});

	// --- 5c. Matchmaking: a remote seeker walk converges to a match over real sockets (this ticket) ---
	// The OUTBOUND seeker walk client is now LIVE in production (matchmaking-query-rpc-seeker-walk): a remote
	// node builds `createLibp2pMatchmakingTransport`, dials the FRET-routed primary's cohort-topic `/register`
	// (a signed, self-vouched seeker frame) and its matchmaking `/query`, then re-validates + dedupes the
	// returned providers. The hang-out *decision* math stays mock-tier-validated (`matchmaking/mesh-walk.spec.ts`);
	// this proves the real-socket walk converges and that the seeker drops a forged forwarded entry the cohort served.
	it('a seeker hang-out walk queries real cohorts over real sockets and converges to a match (forged entries dropped)', async () => {
		const matchTopic = Uint8Array.from({ length: 32 }, (_v, i) => (i * 5 + 23) & 0xff);
		const matchCoord = addressing.coord0(matchTopic);
		// Instantiate + stabilize willingness for this topic's cohort (whole mesh at wantK = N).
		engines(matchCoord);
		const matchPrimary = primaryFor(matchCoord);
		const matchPrimaryEngine = engineOf(matchPrimary, matchCoord);
		expect(await quorumOn(matchPrimaryEngine, matchCoord), 'willingness converged for the walk topic').to.equal(true);

		// A genuine matchmaking provider: a decodable matchmaking appState whose `registrationSig` is over the
		// REAL topic, so it re-validates seeker-side. T2 bootstrap self-vouches to clear the gate (mirrors §5/§5b).
		const provider = await participantPrimaryAt(matchPrimaryEngine, matchCoord);
		const capabilities = ['transcode', 'gpu'];
		const capacityBudget = 4;
		const providerSig = bytesToB64url(await signPeer(provider.key, providerSigningPayload(matchTopic, capabilities, capacityBudget)));
		const providerPayload = encodeProviderAppPayload({ kind: 'match-provider', capabilities, capacityBudget, contactHint: `/ip4/127.0.0.1/tcp/4001/p2p/${provider.idStr}`, signature: providerSig });
		const now = Date.now();
		const providerReg = await signedRegister(provider, matchTopic, now, 'mm-walk-provider', { tier: 2, selfVouch: true, appPayload: providerPayload });
		expect((await matchPrimaryEngine.engine.handleRegister(providerReg, { followOn: false, treeTier: 0 }, now)).result, 'the genuine provider was admitted').to.equal('accepted');

		// A SECOND "provider" whose matchmaking app-payload signature is forged (signed over a DIFFERENT topic).
		// The cohort still admits + serves it (the RegisterV1 envelope sig is valid — the cohort never verifies
		// app-payload authorship), but the seeker's `verifyProviderEntry` re-validation drops it. This is the
		// advisory-trust contract: the cohort vouches only for "what I held", never provider authenticity.
		const forged = await participantPrimaryAt(matchPrimaryEngine, matchCoord);
		const wrongTopic = Uint8Array.from({ length: 32 }, (_v, i) => (i * 5 + 99) & 0xff);
		const forgedSig = bytesToB64url(await signPeer(forged.key, providerSigningPayload(wrongTopic, capabilities, capacityBudget)));
		const forgedPayload = encodeProviderAppPayload({ kind: 'match-provider', capabilities, capacityBudget, contactHint: `/ip4/127.0.0.1/tcp/4002/p2p/${forged.idStr}`, signature: forgedSig });
		const forgedReg = await signedRegister(forged, matchTopic, now, 'mm-walk-forged', { tier: 2, selfVouch: true, appPayload: forgedPayload });
		expect((await matchPrimaryEngine.engine.handleRegister(forgedReg, { followOn: false, treeTier: 0 }, now)).result, 'the forged-payload provider was also admitted (cohort does not verify app-payload authorship)').to.equal('accepted');

		// Touch + gossip so any sibling also holds the records (the routed primary holds them regardless — the walk dials it).
		// Stamp the reattach after the register's `lastPing` (= now) so the freshness gate accepts it.
		expect(matchPrimaryEngine.engine.handleRenew(await signedReattach(provider, matchTopic, now + 1), now).result).to.equal('ok');
		await matchPrimaryEngine.gossipRound(now);

		// A REMOTE seeker node (!= the routed primary, so the tier-0 register/query never self-dials) drives the
		// real walk over real sockets via the production transport.
		const seeker = nodes.find((n) => n.idStr !== matchPrimary.idStr)!;
		const transport = createLibp2pMatchmakingTransport({
			node: seeker.node,
			fret: seeker.fret as unknown as FretService,
			selfPeerId: seeker.idStr,
			key: seeker.key,
			wantK: WANT_K,
		});

		// The small-N FRET size estimate yields a shallow d_max (single-tier-0 milestone — the walk registers +
		// queries at the root). Exercise the estimator, then drive the walk from the root: at this N the remote
		// seeker is deliberately not the tier-0 primary, so register(0)/query(0) dial the remote matchPrimary.
		const dMaxEstimate = await transport.estimateDMax(matchTopic);
		expect(dMaxEstimate, 'small-N FRET estimate yields a shallow d_max').to.be.at.most(3);

		// Assert convergence (not an exact hop count), with bounded polling (replication/admission settle on real
		// sockets). Each attempt is a fresh single-deadline walk; the provider is already on the dialed primary's
		// engine, so the first walk normally converges — the retry just absorbs a transient real-socket hiccup.
		let result: SeekerWalkResult | undefined;
		await waitFor(async () => {
			try {
				const client = new SeekerWalkClient({
					transport: transport.walkTransport(matchTopic),
					topicId: matchTopic,
					wantCount: 1,
					dMax: 0,
					patienceMs: 10_000,
					verifyEntry: transport.verifyEntry,
				});
				result = await client.run();
				return result.metWantCount;
			} catch {
				return false; // transient real-socket failure; retry within the bound
			}
		}, { timeoutMs: 60_000, intervalMs: 500, description: 'the seeker walk converged to a match over real sockets' });
		expect(result!.providers.length, 'at least one provider matched').to.be.at.least(1);
		const matchedIds = result!.providers.map((p) => p.participantId);
		expect(matchedIds, 'the genuine provider is in the matched set').to.include(provider.idStr);
		expect(matchedIds, 'the forged-payload provider was dropped by the seeker re-validation').to.not.include(forged.idStr);

		// Confirm the drop is the SEEKER's re-validation, not the cohort withholding the record: a raw `/query`
		// (like §5b) served by the cohort lists BOTH participants, yet `verifyProviderEntry` rejects the forged one.
		const rawReplyFrame = await requestResponse(
			seeker.node,
			matchPrimary.peerId,
			DEFAULT_MATCHMAKING_PROTOCOLS.query,
			encodeQueryV1({ v: 1, topicId: bytesToB64url(matchTopic), includeProviders: true, includeSeekers: false, limit: 256, requesterId: seeker.idStr, timestamp: Date.now(), signature: 'AA' }),
			DEFAULT_STREAM_MAX_BYTES,
		);
		const rawReply = decodeQueryReplyV1(rawReplyFrame, DEFAULT_STREAM_MAX_BYTES);
		const rawIds = (rawReply.providers ?? []).map((p) => p.participantId);
		expect(rawIds, 'the raw cohort reply served the genuine provider').to.include(provider.idStr);
		expect(rawIds, 'the raw cohort reply ALSO served the forged-payload provider (cohort forwards verbatim)').to.include(forged.idStr);
		const forgedEntry = rawReply.providers!.find((p) => p.participantId === forged.idStr)!;
		expect(
			verifyProviderEntry(matchTopic, forgedEntry, (id, payload, sig) => verifyPeerSig(id, payload, sig)),
			'verifyProviderEntry rejects the forged entry seeker-side',
		).to.equal(false);
	});

	// --- 6. Cluster-formation / same-FRET-ring consistency ---
	it('the cohort-topic cohort and the transaction layer derive from the SAME FRET ring, deterministically agreed across nodes', () => {
		// Both the cohort-topic substrate and the transaction/cluster layer assemble cohorts from the one FRET
		// ring via `fret.assembleCohort(coord, k)`. The consistency invariant is: for any coord, every node's
		// assembly agrees (a single ring, not per-node disagreement) — so a cohort-topic cohort and a
		// transaction cluster keyed at the same coord are byte-identical, and keyed at different coords they are
		// each a deterministic slice of the same ring. (The reactivity topic coord and a block's transaction key
		// hash to *different* coords, so they are different cohorts BY DESIGN; what must hold is same-ring
		// determinism, which is what a real cross-layer read depends on.)
		const probes: RingCoord[] = [
			coord0,
			addressing.coord0(reactivityTopicId(reactivityTailBytes(TAIL_ID))),
			addressing.coord0(Uint8Array.from({ length: 32 }, (_v, i) => (i * 13 + 1) & 0xff)),
		];
		for (const coord of probes) {
			const reference = nodes[0]!.fret.assembleCohort(coord, WANT_K).slice().sort();
			for (const n of nodes) {
				const seen = n.fret.assembleCohort(coord, WANT_K).slice().sort();
				expect(seen, `node ${n.idStr} agrees on the cohort for a coord (single FRET ring)`).to.deep.equal(reference);
			}
		}
	});

	// participant `service.register` full FRET-routed walk over real sockets: exercised at the cohort-admission
	// level above (handleRegister over the real willingness quorum + real /cohort-gossip replication). The full
	// router-driven walk-toward-root is FRET-routing-timing-sensitive over real TCP at small N and is covered
	// deterministically by the mock tier (`live-tier.spec.ts` test 2); see the review handoff for the rationale.
	it.skip('[covered at cohort-admission + replication level here; full FRET-routed participant walk is mock-tier-deterministic] a participant service.register() walk over real sockets resolves an accepted handle', () => {
		/* deferred to avoid FRET-routing flakiness at small N; the cohort-side admission it would drive is asserted above */
	});
});
