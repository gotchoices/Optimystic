import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	logBucketCount,
	selectShards,
	runMultiCohortSweep,
	providerSigningPayload,
	matchTopicId,
	DEFAULT_SWEEP_MAX_SHARDS,
	type AggregateCountV1,
	type ProviderEntryV1,
	type EntrySigVerifier,
	type MultiCohortSweepPorts,
	type SweepShardQuery,
} from '../../src/matchmaking/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';

/**
 * Multi-cohort sweep — db-core pure orchestration of the hot-topic representative sample
 * (`docs/matchmaking.md` §Multi-cohort sweep). Crypto-free: a deterministic `base64url(sha256(payload))`
 * stands in for the libp2p peer-key signer; the injected verifier recomputes the same image. The root
 * `AggregateCountV1` fetch and per-shard queries are mocked through the {@link MultiCohortSweepPorts} port.
 */
const fakeSign = (payload: Uint8Array): string => bytesToB64url(sha256(payload));
const fakeVerify: EntrySigVerifier = (_signerId, payload, sig) => bytesToB64url(sha256(payload)) === bytesToB64url(sig);

const TOPIC_ID = matchTopicId('capability', 'pdf-render');

function makeEntry(opts: { participantId: string; capabilities?: string[]; capacityBudget?: number; attachedAt?: number; topicId?: Uint8Array }): ProviderEntryV1 {
	const topicId = opts.topicId ?? TOPIC_ID;
	const capabilities = opts.capabilities ?? ['pdf-render'];
	const capacityBudget = opts.capacityBudget ?? 2;
	return {
		participantId: opts.participantId,
		capabilities,
		capacityBudget,
		contactHint: `c-${opts.participantId}`,
		attachedAt: opts.attachedAt ?? 1_000,
		registrationSig: fakeSign(providerSigningPayload(topicId, capabilities, capacityBudget)),
	};
}

/** An entry whose registrationSig is forged (signed, then a field tampered). */
function makeForgedEntry(participantId: string): ProviderEntryV1 {
	const e = makeEntry({ participantId });
	return { ...e, capacityBudget: e.capacityBudget + 99 };
}

const aggregate = (buckets: Array<{ targetTier?: number; prefixSlot: number; count: number }>): AggregateCountV1 => ({
	v: 1,
	topicId: bytesToB64url(TOPIC_ID),
	bucketCounts: buckets.map((b) => ({ targetTier: b.targetTier ?? 1, prefixSlot: b.prefixSlot, count: b.count })),
	signature: bytesToB64url(new Uint8Array(64).fill(1)),
	signers: [bytesToB64url(new Uint8Array(38).fill(2))],
	cohortEpoch: bytesToB64url(new Uint8Array(32).fill(3)),
});

/** A mock sweep port: a fixed (or absent) aggregate plus a per-prefix-slot shard map, counting calls. */
class MockSweepPorts implements MultiCohortSweepPorts {
	queriedShards: SweepShardQuery[] = [];
	constructor(
		private readonly agg: AggregateCountV1 | undefined,
		private readonly shards: Map<number, ProviderEntryV1[]> = new Map(),
		private readonly aggregateOk: boolean | undefined = undefined,
	) {}
	async fetchAggregate(): Promise<AggregateCountV1 | undefined> {
		return this.agg;
	}
	verifyAggregate(_agg: AggregateCountV1): boolean {
		return this.aggregateOk ?? true;
	}
	async queryShard(shard: SweepShardQuery): Promise<readonly ProviderEntryV1[]> {
		this.queriedShards.push(shard);
		return this.shards.get(shard.prefixSlot) ?? [];
	}
}

describe('matchmaking / multi-cohort sweep — logBucketCount', () => {
	it('is the largest power of two <= n (0 for n <= 0)', () => {
		expect(logBucketCount(0)).to.equal(0);
		expect(logBucketCount(-5)).to.equal(0);
		expect(logBucketCount(1)).to.equal(1);
		expect(logBucketCount(2)).to.equal(2);
		expect(logBucketCount(3)).to.equal(2);
		expect(logBucketCount(4)).to.equal(4);
		expect(logBucketCount(6)).to.equal(4);
		expect(logBucketCount(49)).to.equal(32);
		expect(logBucketCount(64)).to.equal(64);
		expect(logBucketCount(100)).to.equal(64);
	});

	it('rounds DOWN, so summing bucketed counts under-estimates (selection over-provisions, never under-selects)', () => {
		// True population 49+49 = 98; bucketed 32+32 = 64 <= 98 → safe direction.
		expect(logBucketCount(49) + logBucketCount(49)).to.be.at.most(98);
	});
});

describe('matchmaking / multi-cohort sweep — selectShards', () => {
	it('ranks high-population shards first and accumulates to wantCount', () => {
		const agg = aggregate([
			{ prefixSlot: 0, count: 8 },
			{ prefixSlot: 1, count: 64 },
			{ prefixSlot: 2, count: 16 },
		]);
		const selected = selectShards(agg, { wantCount: 20 });
		// 64 covers 20 immediately → just the top shard.
		expect(selected.map((s) => s.prefixSlot)).to.deep.equal([1]);
	});

	it('takes multiple shards when one does not cover wantCount', () => {
		const agg = aggregate([
			{ prefixSlot: 0, count: 8 },
			{ prefixSlot: 1, count: 16 },
			{ prefixSlot: 2, count: 4 },
		]);
		const selected = selectShards(agg, { wantCount: 20 });
		// 16 (slot 1) then 8 (slot 0) = 24 >= 20.
		expect(selected.map((s) => s.prefixSlot)).to.deep.equal([1, 0]);
	});

	it('skips empty shards and the wrong targetTier', () => {
		const agg = aggregate([
			{ prefixSlot: 0, count: 0 },
			{ prefixSlot: 1, count: 8 },
			{ targetTier: 2, prefixSlot: 2, count: 64 }, // wrong tier
		]);
		const selected = selectShards(agg, { wantCount: 100, targetTier: 1 });
		expect(selected.map((s) => s.prefixSlot)).to.deep.equal([1]);
	});

	it('caps fan-out at maxShards', () => {
		const agg = aggregate(Array.from({ length: 20 }, (_v, i) => ({ prefixSlot: i, count: 1 })));
		const selected = selectShards(agg, { wantCount: 1000, maxShards: 3 });
		expect(selected).to.have.length(3);
		expect(selected).to.have.length.at.most(DEFAULT_SWEEP_MAX_SHARDS);
	});
});

describe('matchmaking / multi-cohort sweep — runMultiCohortSweep', () => {
	it('returns an empty set when the root produced no aggregate (cold / unpromoted)', async () => {
		const ports = new MockSweepPorts(undefined);
		const result = await runMultiCohortSweep(ports, { topicId: TOPIC_ID, wantCount: 5, verifyEntry: fakeVerify });
		expect(result.providers).to.have.length(0);
		expect(result.aggregateAvailable).to.equal(false);
		expect(result.aggregateTrusted).to.equal(false);
		expect(ports.queriedShards).to.have.length(0);
	});

	it('returns an empty set when the aggregate fails threshold verification', async () => {
		const ports = new MockSweepPorts(aggregate([{ prefixSlot: 0, count: 8 }]), new Map(), false);
		const result = await runMultiCohortSweep(ports, { topicId: TOPIC_ID, wantCount: 5, verifyEntry: fakeVerify });
		expect(result.aggregateAvailable).to.equal(true);
		expect(result.aggregateTrusted).to.equal(false);
		expect(result.providers).to.have.length(0);
		expect(ports.queriedShards).to.have.length(0);
	});

	it('unions providers across selected shards, deduped + re-validated', async () => {
		const shared = makeEntry({ participantId: 'shared' });
		const shards = new Map<number, ProviderEntryV1[]>([
			[1, [makeEntry({ participantId: 'a' }), shared]],
			[0, [shared, makeEntry({ participantId: 'b' })]], // `shared` appears in both shards
		]);
		const ports = new MockSweepPorts(aggregate([{ prefixSlot: 0, count: 8 }, { prefixSlot: 1, count: 16 }]), shards);
		const result = await runMultiCohortSweep(ports, { topicId: TOPIC_ID, wantCount: 20, verifyEntry: fakeVerify });
		expect(result.providers.map((p) => p.participantId).sort()).to.deep.equal(['a', 'b', 'shared']);
		expect(result.shardsQueried).to.equal(2);
		expect(result.aggregateTrusted).to.equal(true);
	});

	it('reports aggregateTrusted=false when no verifier is injected, but still unions the providers', async () => {
		// No `verifyAggregate` port ⇒ nothing was verified. The sweep proceeds (each entry is
		// registrationSig-re-validated), but the trust flag must stay honest rather than claim trust.
		const agg = aggregate([{ prefixSlot: 1, count: 16 }]);
		const queried: SweepShardQuery[] = [];
		const ports: MultiCohortSweepPorts = {
			async fetchAggregate(): Promise<AggregateCountV1 | undefined> {
				return agg;
			},
			async queryShard(shard: SweepShardQuery): Promise<readonly ProviderEntryV1[]> {
				queried.push(shard);
				return [makeEntry({ participantId: 'a' })];
			},
		};
		const result = await runMultiCohortSweep(ports, { topicId: TOPIC_ID, wantCount: 5, verifyEntry: fakeVerify });
		expect(result.aggregateAvailable).to.equal(true);
		expect(result.aggregateTrusted).to.equal(false);
		expect(result.providers.map((p) => p.participantId)).to.deep.equal(['a']);
		expect(queried).to.have.length(1);
	});

	it('drops entries whose registrationSig is forged', async () => {
		const shards = new Map<number, ProviderEntryV1[]>([[1, [makeEntry({ participantId: 'good' }), makeForgedEntry('forged')]]]);
		const ports = new MockSweepPorts(aggregate([{ prefixSlot: 1, count: 16 }]), shards);
		const result = await runMultiCohortSweep(ports, { topicId: TOPIC_ID, wantCount: 5, verifyEntry: fakeVerify });
		expect(result.providers.map((p) => p.participantId)).to.deep.equal(['good']);
	});

	it('applies the capability filter per shard', async () => {
		const shards = new Map<number, ProviderEntryV1[]>([
			[1, [
				makeEntry({ participantId: 'gpu', capabilities: ['pdf-render', 'gpu'] }),
				makeEntry({ participantId: 'no-gpu', capabilities: ['pdf-render'] }),
			]],
		]);
		const ports = new MockSweepPorts(aggregate([{ prefixSlot: 1, count: 16 }]), shards);
		const result = await runMultiCohortSweep(ports, {
			topicId: TOPIC_ID,
			wantCount: 5,
			verifyEntry: fakeVerify,
			filter: { must: ['gpu'], mustNot: [] },
		});
		expect(result.providers.map((p) => p.participantId)).to.deep.equal(['gpu']);
	});
});
