import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { sha256 } from '@noble/hashes/sha2.js';

use(chaiAsPromised);
import {
	VotingQuorumAssembler,
	eligibilityTag,
	eligibilityProofOf,
	defaultSelect,
	DEFAULT_VOTER_CAPACITY_BUDGET,
	providerSigningPayload,
	decodeProviderAppPayload,
	providerEntryOf,
	matchTopicId,
	type ProviderEntryV1,
	type QuorumDiscovery,
	type QuorumDiscoveryRequest,
	type QuorumDiscoverySlice,
	type EntrySigVerifier,
	type RegisterVoterProviderRequest,
} from '../../src/matchmaking/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';

/**
 * Voting-quorum assembler — discovery-only composition over the matchmaking module.
 *
 * Crypto-free at db-core: a deterministic `base64url(sha256(payload))` stands in for the libp2p
 * peer-key signer (matching `entry-verify.spec.ts` / `registration.spec.ts`), and the injected
 * {@link EntrySigVerifier} recomputes the same image. The discovery I/O (single-cohort walk + the
 * hot-topic multi-cohort sweep, landing with `matchmaking-sweep-adversarial-module`) is injected as a
 * {@link QuorumDiscovery} port and mocked here with a mock-tier cohort fixture — no real libp2p.
 */
const fakeSign = async (payload: Uint8Array): Promise<string> => bytesToB64url(sha256(payload));
const fakeVerify: EntrySigVerifier = (_signerId, payload, sig) => bytesToB64url(sha256(payload)) === bytesToB64url(sig);

const PROPOSAL = 'proposal-hash-abc';
const TOPIC_ID = matchTopicId('quorum', PROPOSAL);
const VALID_PROOF = 'stake-sig-good';
/** Eligibility predicate the voting/stake layer would inject: the proof must be the minted, valid one. */
const verifyEligibility = (entry: ProviderEntryV1): boolean => eligibilityProofOf(entry) === VALID_PROOF;

/** Build a forwarded provider entry whose `registrationSig` verifies (proof bound into capabilities). */
async function makeVoterEntry(opts: {
	participantId: string;
	proof?: string;
	capabilityTags?: string[];
	capacityBudget?: number;
	attachedAt?: number;
	topicId?: Uint8Array;
}): Promise<ProviderEntryV1> {
	const topicId = opts.topicId ?? TOPIC_ID;
	const capacityBudget = opts.capacityBudget ?? DEFAULT_VOTER_CAPACITY_BUDGET;
	const capabilities = [...(opts.capabilityTags ?? []), ...(opts.proof !== undefined ? [eligibilityTag(opts.proof)] : [])];
	const registrationSig = await fakeSign(providerSigningPayload(topicId, capabilities, capacityBudget));
	return {
		participantId: opts.participantId,
		capabilities,
		capacityBudget,
		contactHint: `/ip4/10.0.0.1/tcp/4001/p2p/${opts.participantId}`,
		attachedAt: opts.attachedAt ?? 1_000,
		registrationSig,
	};
}

/** Build an entry with a valid eligibility proof but a `registrationSig` forged (signed, then tampered). */
async function makeForgedEntry(participantId: string): Promise<ProviderEntryV1> {
	const entry = await makeVoterEntry({ participantId, proof: VALID_PROOF });
	// Tamper after signing: the reconstructed image no longer matches the forwarded signature.
	return { ...entry, capacityBudget: entry.capacityBudget + 99 };
}

/** A mock-tier discovery fixture: returns a fixed walk slice and (optionally) a sweep slice, counting calls. */
class MockQuorumDiscovery implements QuorumDiscovery {
	walkCalls = 0;
	sweepCalls = 0;
	lastWalkPatienceMs = -1;
	lastSweepPatienceMs = -1;
	constructor(
		private readonly walkSlice: QuorumDiscoverySlice,
		private readonly sweepSlice: QuorumDiscoverySlice = { entries: [], childCohortCount: 0 },
	) {}
	async walk(req: QuorumDiscoveryRequest): Promise<QuorumDiscoverySlice> {
		this.walkCalls++;
		this.lastWalkPatienceMs = req.patienceMs;
		return this.walkSlice;
	}
	async sweep(req: QuorumDiscoveryRequest): Promise<QuorumDiscoverySlice> {
		this.sweepCalls++;
		this.lastSweepPatienceMs = req.patienceMs;
		return this.sweepSlice;
	}
}

const coordinator = (discovery: QuorumDiscovery): VotingQuorumAssembler =>
	new VotingQuorumAssembler({ discovery, verifyEntrySig: fakeVerify });

describe('matchmaking / voting-quorum — topic anchor', () => {
	it('derives the quorum topic kind=quorum, label=proposalHash', () => {
		expect(VotingQuorumAssembler.quorumTopic(PROPOSAL)).to.deep.equal({ kind: 'quorum', label: PROPOSAL });
	});

	it('topicIdFor matches H("quorum" ‖ proposalHash ‖ "match")', () => {
		const assembler = new VotingQuorumAssembler();
		expect(bytesToB64url(assembler.topicIdFor(PROPOSAL))).to.equal(bytesToB64url(matchTopicId('quorum', PROPOSAL)));
	});
});

describe('matchmaking / voting-quorum — eligibility verified per entry', () => {
	it('admits only entries passing BOTH registrationSig and verifyEligibility', async () => {
		const ok1 = await makeVoterEntry({ participantId: 'voter-1', proof: VALID_PROOF });
		const ok2 = await makeVoterEntry({ participantId: 'voter-2', proof: VALID_PROOF });
		const ineligible = await makeVoterEntry({ participantId: 'voter-3', proof: 'stake-sig-bad' }); // valid sig, wrong proof
		const forged = await makeForgedEntry('voter-4'); // valid proof tag, forged sig
		const discovery = new MockQuorumDiscovery({ entries: [ok1, ok2, ineligible, forged], childCohortCount: 0 });

		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 2, patienceMs: 30_000, verifyEligibility });

		expect(result.quorum.map((e) => e.participantId)).to.deep.equal(['voter-1', 'voter-2']);
		expect(result.candidates).to.equal(4);
		expect(result.eligible).to.equal(2);
		expect(result.metTarget).to.equal(true);
		expect(result.swept).to.equal(false);
	});

	it('excludes a forged registrationSig before verifyEligibility even runs', async () => {
		const forged = await makeForgedEntry('voter-X');
		let eligibilityChecked = 0;
		const discovery = new MockQuorumDiscovery({ entries: [forged], childCohortCount: 0 });
		const result = await coordinator(discovery).assembleQuorum({
			proposalHash: PROPOSAL,
			targetSize: 1,
			patienceMs: 30_000,
			verifyEligibility: (e) => {
				eligibilityChecked++;
				return verifyEligibility(e);
			},
		});
		expect(result.eligible).to.equal(0);
		expect(result.quorum).to.have.length(0);
		expect(result.metTarget).to.equal(false);
		// && short-circuits: a failed sig means verifyEligibility is never consulted for that entry.
		expect(eligibilityChecked).to.equal(0);
	});
});

describe('matchmaking / voting-quorum — single-cohort vs. multi-cohort sweep', () => {
	it('a cold/shallow topic uses the single-cohort walk (swept = false, no sweep call)', async () => {
		const e = await makeVoterEntry({ participantId: 'voter-1', proof: VALID_PROOF });
		const discovery = new MockQuorumDiscovery({ entries: [e], childCohortCount: 0 });
		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 1, patienceMs: 30_000, verifyEligibility });
		expect(result.swept).to.equal(false);
		expect(discovery.walkCalls).to.equal(1);
		expect(discovery.sweepCalls).to.equal(0);
	});

	it('a hot topic (childCohortCount > 0) escalates to the sweep (swept = true)', async () => {
		const local = await makeVoterEntry({ participantId: 'voter-1', proof: VALID_PROOF });
		const swept1 = await makeVoterEntry({ participantId: 'voter-2', proof: VALID_PROOF });
		const swept2 = await makeVoterEntry({ participantId: 'voter-3', proof: VALID_PROOF });
		const discovery = new MockQuorumDiscovery(
			{ entries: [local], childCohortCount: 4 },
			{ entries: [swept1, swept2], childCohortCount: 0 },
		);
		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 3, patienceMs: 30_000, verifyEligibility });
		expect(result.swept).to.equal(true);
		expect(discovery.sweepCalls).to.equal(1);
		expect(result.quorum.map((e) => e.participantId)).to.deep.equal(['voter-1', 'voter-2', 'voter-3']);
	});

	it('preferSweep forces the sweep on a cold topic (swept = true)', async () => {
		const local = await makeVoterEntry({ participantId: 'voter-1', proof: VALID_PROOF });
		const remote = await makeVoterEntry({ participantId: 'voter-2', proof: VALID_PROOF });
		const discovery = new MockQuorumDiscovery({ entries: [local], childCohortCount: 0 }, { entries: [remote], childCohortCount: 0 });
		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 2, patienceMs: 30_000, verifyEligibility, preferSweep: true });
		expect(result.swept).to.equal(true);
		expect(discovery.sweepCalls).to.equal(1);
	});
});

describe('matchmaking / voting-quorum — reply-side discard of ineligible entries', () => {
	it('discards ineligible cohort entries without escalating (no extra hop from ineligibility alone)', async () => {
		const ok = await makeVoterEntry({ participantId: 'voter-1', proof: VALID_PROOF });
		const noisy1 = await makeVoterEntry({ participantId: 'noise-1', proof: 'bad' });
		const noisy2 = await makeVoterEntry({ participantId: 'noise-2' }); // no proof tag at all
		const discovery = new MockQuorumDiscovery({ entries: [ok, noisy1, noisy2], childCohortCount: 0 });
		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 1, patienceMs: 30_000, verifyEligibility });

		expect(result.quorum.map((e) => e.participantId)).to.deep.equal(['voter-1']);
		expect(result.candidates).to.equal(3); // ineligible entries surface in the discard count...
		expect(result.eligible).to.equal(1); // ...but are dropped reply-side
		expect(discovery.walkCalls).to.equal(1);
		expect(discovery.sweepCalls).to.equal(0); // ineligibility alone never triggers a sweep
	});
});

describe('matchmaking / voting-quorum — sweep dedup', () => {
	it('counts a voter appearing in two swept slices exactly once', async () => {
		const shared = await makeVoterEntry({ participantId: 'voter-dup', proof: VALID_PROOF });
		const other = await makeVoterEntry({ participantId: 'voter-other', proof: VALID_PROOF });
		// `shared` appears in BOTH the walk slice and the sweep slice (promotion/redirect overlap).
		const discovery = new MockQuorumDiscovery(
			{ entries: [shared], childCohortCount: 2 },
			{ entries: [shared, other], childCohortCount: 0 },
		);
		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 2, patienceMs: 30_000, verifyEligibility });
		expect(result.candidates).to.equal(2); // shared counted once
		expect(result.eligible).to.equal(2);
		expect(result.quorum.map((e) => e.participantId)).to.deep.equal(['voter-dup', 'voter-other']);
	});
});

describe('matchmaking / voting-quorum — patience / partial quorum', () => {
	it('returns a full quorum with metTarget=true when discovery yields >= targetSize', async () => {
		const entries = await Promise.all([0, 1, 2, 3].map((i) => makeVoterEntry({ participantId: `voter-${i}`, proof: VALID_PROOF })));
		const discovery = new MockQuorumDiscovery({ entries, childCohortCount: 0 });
		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 3, patienceMs: 120_000, verifyEligibility });
		expect(result.metTarget).to.equal(true);
		expect(result.quorum).to.have.length(3);
	});

	it('returns the partial set with metTarget=false when patience drains before targetSize is met', async () => {
		const entries = await Promise.all([0, 1].map((i) => makeVoterEntry({ participantId: `voter-${i}`, proof: VALID_PROOF })));
		const discovery = new MockQuorumDiscovery({ entries, childCohortCount: 0 });
		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 5, patienceMs: 30_000, verifyEligibility });
		expect(result.metTarget).to.equal(false);
		expect(result.quorum.map((e) => e.participantId)).to.deep.equal(['voter-0', 'voter-1']);
	});

	it('passes a positive remaining-patience budget to the walk, then the sweep', async () => {
		// A monotonic clock that advances 1 s per read models patience draining across hops.
		let now = 1_000_000;
		const clock = (): number => (now += 1_000);
		const local = await makeVoterEntry({ participantId: 'voter-1', proof: VALID_PROOF });
		const remote = await makeVoterEntry({ participantId: 'voter-2', proof: VALID_PROOF });
		const discovery = new MockQuorumDiscovery({ entries: [local], childCohortCount: 3 }, { entries: [remote], childCohortCount: 0 });
		const assembler = new VotingQuorumAssembler({ discovery, verifyEntrySig: fakeVerify, clock });
		await assembler.assembleQuorum({ proposalHash: PROPOSAL, targetSize: 2, patienceMs: 60_000, verifyEligibility });
		expect(discovery.lastWalkPatienceMs).to.be.greaterThan(0);
		expect(discovery.lastSweepPatienceMs).to.be.greaterThan(0);
		// The sweep runs after the walk, so its remaining budget is strictly smaller.
		expect(discovery.lastSweepPatienceMs).to.be.lessThan(discovery.lastWalkPatienceMs);
	});
});

describe('matchmaking / voting-quorum — flash vote (200 000 voters)', () => {
	const CAP_PROMOTE = 64;
	const FANOUT = 16;

	/** Tree depth law: `⌈log_F(N / cap)⌉` (`docs/matchmaking.md` §Worked scenario "Voting on a popular proposal"). */
	function treeDepth(voterCount: number, cap: number, fanout: number): number {
		if (voterCount <= cap) {
			return 0;
		}
		return Math.ceil(Math.log(voterCount / cap) / Math.log(fanout));
	}

	it('settles 200 000 voters at depth 3 with no leaf cohort exceeding cap_promote', () => {
		const depth = treeDepth(200_000, CAP_PROMOTE, FANOUT);
		expect(depth).to.equal(3);
		const leafCohorts = FANOUT ** depth; // 4096
		const maxLeafLoad = Math.ceil(200_000 / leafCohorts);
		expect(maxLeafLoad).to.be.at.most(CAP_PROMOTE); // ~49 <= 64: tree promotion absorbs the storm
	});

	it('assembles >= targetSize via the sweep across selected tier-3 shards', async () => {
		// The root sweep only materializes the selected high-population shards (two tier-3 cohorts here),
		// not all 200 000 voters — exactly what AggregateCountV1-driven shard selection does in production.
		const localShard = await Promise.all(
			Array.from({ length: 8 }, (_v, i) => makeVoterEntry({ participantId: `local-${i}`, proof: VALID_PROOF })),
		);
		const sweptShard = await Promise.all(
			Array.from({ length: 100 }, (_v, i) => makeVoterEntry({ participantId: `swept-${i}`, proof: VALID_PROOF })),
		);
		const discovery = new MockQuorumDiscovery(
			{ entries: localShard, childCohortCount: 16 }, // hot: tier promoted, single shard is thin
			{ entries: sweptShard, childCohortCount: 0 },
		);
		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 64, patienceMs: 120_000, verifyEligibility });
		expect(result.swept).to.equal(true);
		expect(result.metTarget).to.equal(true);
		expect(result.quorum).to.have.length(64);
	});
});

describe('matchmaking / voting-quorum — delegated assembler returns a self-checkable set', () => {
	it('a separate coordinator re-runs verify→select over the handed-back set and reaches the same quorum', async () => {
		const entries = await Promise.all([0, 1, 2, 3].map((i) => makeVoterEntry({ participantId: `voter-${i}`, proof: VALID_PROOF })));

		// Delegated assembler discovers + assembles.
		const delegate = coordinator(new MockQuorumDiscovery({ entries, childCohortCount: 0 }));
		const delegated = await delegate.assembleQuorum({ proposalHash: PROPOSAL, targetSize: 3, patienceMs: 60_000, verifyEligibility });

		// Coordinator re-validates the handed-back set independently (its discovery just returns that set).
		const coord = coordinator(new MockQuorumDiscovery({ entries: delegated.quorum, childCohortCount: 0 }));
		const rechecked = await coord.assembleQuorum({ proposalHash: PROPOSAL, targetSize: 3, patienceMs: 60_000, verifyEligibility });

		expect(rechecked.quorum.map((e) => e.participantId)).to.deep.equal(delegated.quorum.map((e) => e.participantId));
		expect(rechecked.eligible).to.equal(3);
	});

	it('the coordinator independently rejects a tampered entry in the handed-back set', async () => {
		const good = await makeVoterEntry({ participantId: 'voter-good', proof: VALID_PROOF });
		const tampered = await makeForgedEntry('voter-tampered');
		const coord = coordinator(new MockQuorumDiscovery({ entries: [good, tampered], childCohortCount: 0 }));
		const result = await coord.assembleQuorum({ proposalHash: PROPOSAL, targetSize: 2, patienceMs: 60_000, verifyEligibility });
		expect(result.quorum.map((e) => e.participantId)).to.deep.equal(['voter-good']);
		expect(result.metTarget).to.equal(false);
	});
});

describe('matchmaking / voting-quorum — Sybil cost (eligibility gate)', () => {
	it('rejects mass forged registrations lacking a valid eligibility proof, regardless of registrationSig', async () => {
		// 50 Sybil registrations with valid registrationSigs but no valid stake proof.
		const sybils = await Promise.all(
			Array.from({ length: 50 }, (_v, i) => makeVoterEntry({ participantId: `sybil-${i}` })), // no proof tag
		);
		const real = await makeVoterEntry({ participantId: 'real-voter', proof: VALID_PROOF });
		const discovery = new MockQuorumDiscovery({ entries: [...sybils, real], childCohortCount: 0 });
		const result = await coordinator(discovery).assembleQuorum({ proposalHash: PROPOSAL, targetSize: 10, patienceMs: 30_000, verifyEligibility });
		// Only the one stake-proven voter survives; the registrationSig validity of the Sybils is irrelevant.
		expect(result.eligible).to.equal(1);
		expect(result.quorum.map((e) => e.participantId)).to.deep.equal(['real-voter']);
		expect(result.metTarget).to.equal(false);
	});
});

describe('matchmaking / voting-quorum — voter registration', () => {
	it('binds the eligibility proof into capabilities and registers at the quorum topic (default budget 1)', async () => {
		let captured: RegisterVoterProviderRequest | undefined;
		const assembler = new VotingQuorumAssembler({
			sign: fakeSign,
			registerProvider: async (req) => {
				captured = req;
			},
		});
		await assembler.registerEligibleVoter({ proposalHash: PROPOSAL, eligibilityProof: VALID_PROOF, contactHint: '/ip4/10.0.0.9/tcp/4001' });

		expect(captured).to.not.equal(undefined);
		const req = captured as RegisterVoterProviderRequest;
		expect(bytesToB64url(req.topicId)).to.equal(bytesToB64url(TOPIC_ID));
		const payload = decodeProviderAppPayload(req.appPayloadBytes);
		expect(payload.capacityBudget).to.equal(DEFAULT_VOTER_CAPACITY_BUDGET);
		expect(payload.capabilities).to.include(eligibilityTag(VALID_PROOF));

		// The registered payload forwards as a self-checkable entry: registrationSig + proof re-validate.
		const entry = providerEntryOf({ participantId: 'voter-self', attachedAt: 5, payload });
		expect(eligibilityProofOf(entry)).to.equal(VALID_PROOF);
		expect(verifyEligibility(entry)).to.equal(true);
	});

	it('merges extra capability tags and honours an explicit capacityBudget', async () => {
		let captured: RegisterVoterProviderRequest | undefined;
		const assembler = new VotingQuorumAssembler({ sign: fakeSign, registerProvider: async (req) => { captured = req; } });
		await assembler.registerEligibleVoter({
			proposalHash: PROPOSAL,
			eligibilityProof: VALID_PROOF,
			capabilityTags: ['region:eu', 'gpu'],
			capacityBudget: 0, // "listed but full"
			contactHint: '/ip4/10.0.0.9/tcp/4001',
		});
		const payload = decodeProviderAppPayload((captured as RegisterVoterProviderRequest).appPayloadBytes);
		expect(payload.capacityBudget).to.equal(0);
		expect(payload.capabilities).to.deep.equal(['region:eu', 'gpu', eligibilityTag(VALID_PROOF)]);
	});
});

describe('matchmaking / voting-quorum — selection rule + validation', () => {
	it('the default selection rule takes the first targetSize eligible entries', async () => {
		const entries = await Promise.all([0, 1, 2].map((i) => makeVoterEntry({ participantId: `voter-${i}`, proof: VALID_PROOF })));
		expect(defaultSelect(entries, 2).map((e) => e.participantId)).to.deep.equal(['voter-0', 'voter-1']);
	});

	it('honours an injected stake-weighted selection rule', async () => {
		const entries = await Promise.all([0, 1, 2].map((i) => makeVoterEntry({ participantId: `voter-${i}`, proof: VALID_PROOF })));
		const discovery = new MockQuorumDiscovery({ entries, childCohortCount: 0 });
		const result = await coordinator(discovery).assembleQuorum({
			proposalHash: PROPOSAL,
			targetSize: 1,
			patienceMs: 30_000,
			verifyEligibility,
			select: (eligible, n) => [...eligible].reverse().slice(0, n), // pick the last as if highest-stake
		});
		expect(result.quorum.map((e) => e.participantId)).to.deep.equal(['voter-2']);
	});

	it('applies an optional reputation pre-filter before verification', async () => {
		const keep = await makeVoterEntry({ participantId: 'rep-good', proof: VALID_PROOF });
		const drop = await makeVoterEntry({ participantId: 'rep-bad', proof: VALID_PROOF });
		const discovery = new MockQuorumDiscovery({ entries: [keep, drop], childCohortCount: 0 });
		const result = await coordinator(discovery).assembleQuorum({
			proposalHash: PROPOSAL,
			targetSize: 2,
			patienceMs: 30_000,
			verifyEligibility,
			reputationPrefilter: (candidates) => candidates.filter((e) => e.participantId !== 'rep-bad'),
		});
		expect(result.eligible).to.equal(1);
		expect(result.quorum.map((e) => e.participantId)).to.deep.equal(['rep-good']);
	});

	it('rejects an invalid targetSize / patienceMs', async () => {
		const assembler = coordinator(new MockQuorumDiscovery({ entries: [], childCohortCount: 0 }));
		await expect(assembler.assembleQuorum({ proposalHash: PROPOSAL, targetSize: 0, patienceMs: 30_000, verifyEligibility })).to.be.rejectedWith(RangeError);
		await expect(assembler.assembleQuorum({ proposalHash: PROPOSAL, targetSize: 2, patienceMs: 0, verifyEligibility })).to.be.rejectedWith(RangeError);
	});

	it('throws a clear error when a role-specific dependency is missing', async () => {
		const noDeps = new VotingQuorumAssembler();
		await expect(noDeps.assembleQuorum({ proposalHash: PROPOSAL, targetSize: 1, patienceMs: 30_000, verifyEligibility })).to.be.rejectedWith(/discovery/);
		await expect(noDeps.registerEligibleVoter({ proposalHash: PROPOSAL, eligibilityProof: VALID_PROOF, contactHint: 'x' })).to.be.rejectedWith(/sign/);
	});
});
