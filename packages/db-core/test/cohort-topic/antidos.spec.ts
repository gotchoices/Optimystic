import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	createRegisterRateLimiter,
	DEFAULT_REGISTER_RATE_PER_PEER,
	DEFAULT_RATE_WINDOW_MS,
	createTopicBudget,
	DEFAULT_TOPICS_MAX,
	createCorrelationReplayGuard,
	DEFAULT_REPLAY_MAX_AGE_MS,
	createBootstrapEvidence,
} from '../../src/cohort-topic/antidos/index.js';
import { backoffRetryMs } from '../../src/cohort-topic/willingness.js';
import type { RegisterV1 } from '../../src/cohort-topic/wire/types.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';

function bytes(label: string, len = 32): Uint8Array {
	return sha256(new TextEncoder().encode(label)).slice(0, len);
}

const PEER_A = bytes('peer-a', 16);
const PEER_B = bytes('peer-b', 16);
const TOPIC_1 = bytes('topic-1');
const TOPIC_2 = bytes('topic-2');

describe('cohort-topic / anti-DoS', () => {
	describe('per-peer register rate limiter', () => {
		it('exposes the simulator-confirmed defaults', () => {
			expect(DEFAULT_REGISTER_RATE_PER_PEER).to.equal(4);
			expect(DEFAULT_RATE_WINDOW_MS).to.equal(60_000);
		});

		it('admits up to register_rate_per_peer then rejects with exponential retryAfter', () => {
			const limiter = createRegisterRateLimiter();
			// Four registers in the same minute are admitted.
			for (let i = 0; i < DEFAULT_REGISTER_RATE_PER_PEER; i++) {
				const r = limiter.check(PEER_A, TOPIC_1, i * 100);
				expect(r.ok, `register ${i} admitted`).to.be.true;
			}
			// The fifth and sixth exceed the rate → rejected, retryAfter doubles.
			const fifth = limiter.check(PEER_A, TOPIC_1, 500);
			expect(fifth.ok).to.be.false;
			const sixth = limiter.check(PEER_A, TOPIC_1, 600);
			expect(sixth.ok).to.be.false;
			if (fifth.ok === false && sixth.ok === false) {
				expect(fifth.retryAfterMs).to.equal(backoffRetryMs(0));
				expect(sixth.retryAfterMs).to.equal(backoffRetryMs(1));
				expect(sixth.retryAfterMs).to.be.greaterThan(fifth.retryAfterMs);
			}
		});

		it('isolates the limit per peer and per topic', () => {
			const limiter = createRegisterRateLimiter();
			for (let i = 0; i < DEFAULT_REGISTER_RATE_PER_PEER; i++) {
				limiter.check(PEER_A, TOPIC_1, i);
			}
			// A different peer at the same topic is unaffected.
			expect(limiter.check(PEER_B, TOPIC_1, 10).ok).to.be.true;
			// The same peer at a different topic is unaffected.
			expect(limiter.check(PEER_A, TOPIC_2, 10).ok).to.be.true;
			// But the saturated (peer, topic) is still over rate.
			expect(limiter.check(PEER_A, TOPIC_1, 10).ok).to.be.false;
		});

		it('forgives the source once it has been quiet for a full window', () => {
			const limiter = createRegisterRateLimiter();
			for (let i = 0; i < DEFAULT_REGISTER_RATE_PER_PEER; i++) {
				limiter.check(PEER_A, TOPIC_1, i);
			}
			expect(limiter.check(PEER_A, TOPIC_1, 100).ok).to.be.false;
			// After a full window of silence the window empties and the strikes reset.
			const later = DEFAULT_RATE_WINDOW_MS + 1;
			const r = limiter.check(PEER_A, TOPIC_1, later);
			expect(r.ok).to.be.true;
		});
	});

	describe('per-cohort topic budget (LRU by participant count)', () => {
		it('exposes the simulator-confirmed default', () => {
			expect(DEFAULT_TOPICS_MAX).to.equal(2048);
		});

		it('admits up to topics_max, then evicts the coldest zero-participant topic for a new one', () => {
			const budget = createTopicBudget({ topicsMax: 3 });
			const t = [bytes('a'), bytes('b'), bytes('c'), bytes('d')];
			expect(budget.admit(t[0]!)).to.be.true;
			expect(budget.admit(t[1]!)).to.be.true;
			expect(budget.admit(t[2]!)).to.be.true;
			expect(budget.size).to.equal(3);

			// Populate two topics; leave t[1] cold (zero participants) and least-recently used.
			budget.touch(t[0]!, 10);
			budget.touch(t[2]!, 5);
			budget.touch(t[1]!, 0);

			// A new topic evicts the cold one (t[1]), not a populated topic.
			expect(budget.admit(t[3]!)).to.be.true;
			expect(budget.size).to.equal(3);
			expect(budget.has(t[1]!), 'cold topic evicted').to.be.false;
			expect(budget.has(t[0]!)).to.be.true;
			expect(budget.has(t[2]!)).to.be.true;
			expect(budget.has(t[3]!)).to.be.true;
		});

		it('refuses a new topic when the budget is full of populated topics; existing continue', () => {
			const budget = createTopicBudget({ topicsMax: 2 });
			const t = [bytes('p'), bytes('q'), bytes('r')];
			budget.admit(t[0]!);
			budget.admit(t[1]!);
			budget.touch(t[0]!, 3);
			budget.touch(t[1]!, 7);

			// No zero-participant resident to evict → new instantiation refused.
			expect(budget.admit(t[2]!)).to.be.false;
			expect(budget.has(t[2]!)).to.be.false;
			// Existing topics are untouched and re-admit is always allowed.
			expect(budget.admit(t[0]!)).to.be.true;
			expect(budget.has(t[1]!)).to.be.true;
		});
	});

	describe('correlation-id replay guard', () => {
		it('accepts a fresh registration and rejects an exact replay', () => {
			const guard = createCorrelationReplayGuard();
			const cid = bytes('corr-1', 16);
			const now = 1_000_000;
			expect(guard.accept(cid, PEER_A, now, now)).to.be.true;
			// Same correlationId again, still inside the window → replay.
			expect(guard.accept(cid, PEER_A, now, now + 100)).to.be.false;
			// A different correlationId is accepted.
			expect(guard.accept(bytes('corr-2', 16), PEER_A, now + 100, now + 100)).to.be.true;
		});

		it('rejects a stale timestamp', () => {
			const guard = createCorrelationReplayGuard();
			const now = 1_000_000;
			const stale = now - DEFAULT_REPLAY_MAX_AGE_MS - 1;
			expect(guard.accept(bytes('corr-stale', 16), PEER_A, stale, now)).to.be.false;
		});

		it('rejects an implausibly future timestamp', () => {
			const guard = createCorrelationReplayGuard({ maxFutureSkewMs: 5_000 });
			const now = 1_000_000;
			expect(guard.accept(bytes('corr-future', 16), PEER_A, now + 5_001, now)).to.be.false;
		});
	});

	describe('bootstrap evidence policy', () => {
		function reg(tier: number, bootstrap: boolean): RegisterV1 {
			return {
				v: 1,
				topicId: bytesToB64url(TOPIC_1),
				tier,
				treeTier: 0,
				participantCoord: bytesToB64url(bytes('coord', 32)),
				ttl: 90_000,
				bootstrap,
				timestamp: 0,
				correlationId: bytesToB64url(bytes('cid', 16)),
				signature: bytesToB64url(bytes('sig', 16)),
			};
		}

		it('admits any non-bootstrap registration without evidence', () => {
			const ev = createBootstrapEvidence({});
			expect(ev.verify(reg(3, false), 3)).to.be.true;
		});

		it('T0/T1: requires a signed parent reference, no PoW', () => {
			const ev = createBootstrapEvidence({ verifyParentReference: () => true });
			expect(ev.verify(reg(0, true), 0)).to.be.true;
			expect(ev.verify(reg(1, true), 1)).to.be.true;

			const noParent = createBootstrapEvidence({ verifyPoW: () => true, verifyReputation: () => true });
			// Even with PoW + reputation, T0/T1 without a parent reference is refused.
			expect(noParent.verify(reg(1, true), 1)).to.be.false;
		});

		it('T2/T3: accepts PoW OR reputation OR parent reference, rejects when none hold', () => {
			expect(createBootstrapEvidence({ verifyPoW: () => true }).verify(reg(2, true), 2)).to.be.true;
			expect(createBootstrapEvidence({ verifyReputation: () => true }).verify(reg(3, true), 3)).to.be.true;
			expect(createBootstrapEvidence({ verifyParentReference: () => true }).verify(reg(3, true), 3)).to.be.true;
			// No verifier injected → no evidence satisfiable → refused.
			expect(createBootstrapEvidence({}).verify(reg(3, true), 3)).to.be.false;
		});
	});
});
