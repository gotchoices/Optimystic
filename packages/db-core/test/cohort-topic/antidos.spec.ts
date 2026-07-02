import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	createRegisterRateLimiter,
	DEFAULT_REGISTER_RATE_PER_PEER,
	DEFAULT_RATE_WINDOW_MS,
	DEFAULT_RATE_LIMITER_MAX_KEYS,
	DEFAULT_RATE_LIMITER_IDLE_TTL_MS,
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

		it('exposes the LRU-cap + idle-TTL defaults', () => {
			expect(DEFAULT_RATE_LIMITER_MAX_KEYS).to.equal(100_000);
			expect(DEFAULT_RATE_LIMITER_IDLE_TTL_MS).to.equal(DEFAULT_RATE_WINDOW_MS);
		});

		it('caps tracked keys at maxKeys, evicting the least-recently-checked', () => {
			// ratePerWindow 1 → a single check saturates a key, so "fresh vs retained" is observable as
			// admit-vs-reject on the next same-window check. Here check order == recency order.
			const limiter = createRegisterRateLimiter({ maxKeys: 3, ratePerWindow: 1 });
			const T = [bytes('cap-0'), bytes('cap-1'), bytes('cap-2'), bytes('cap-3')];
			expect(limiter.check(PEER_A, T[0]!, 10).ok).to.be.true; // saturates T0; recency [T0]
			expect(limiter.check(PEER_A, T[1]!, 11).ok).to.be.true; // [T0, T1]
			expect(limiter.check(PEER_A, T[2]!, 12).ok).to.be.true; // [T0, T1, T2]
			expect(limiter.size, 'at cap').to.equal(3);

			// A fourth distinct key evicts the least-recently-checked (T0). Size holds at the cap.
			expect(limiter.check(PEER_A, T[3]!, 13).ok).to.be.true; // evicts T0 → [T1, T2, T3]
			expect(limiter.size, 'still capped after the flood key').to.equal(3);

			// A survivor (T2) is still saturated → rejected; the evicted T0 returns fresh → admitted.
			// (Probe T2 before re-inserting T0, whose fresh insert would evict the next-oldest key.)
			expect(limiter.check(PEER_A, T[2]!, 14).ok, 'a recently-checked key survived with its state').to.be.false;
			expect(limiter.check(PEER_A, T[0]!, 15).ok, 'the evicted key returns fresh').to.be.true;
		});

		it('sweep() evicts keys idle >= idleTtlMs and keeps keys still inside the window', () => {
			const limiter = createRegisterRateLimiter({ idleTtlMs: 1_000 });
			limiter.check(PEER_A, TOPIC_1, 0); // lastSeen 0
			limiter.check(PEER_B, TOPIC_1, 0); // lastSeen 0
			limiter.check(PEER_A, TOPIC_2, 0); // lastSeen 0
			// Refresh one key just inside the TTL so it survives the sweep.
			limiter.check(PEER_B, TOPIC_1, 1); // lastSeen 1
			expect(limiter.size).to.equal(3);

			// At t = 1000: the two keys last seen at 0 are idle exactly idleTtlMs (>= → swept); the
			// refreshed key (age 999 < 1000) is still inside its window and is kept.
			expect(limiter.sweep(1_000), 'two idle keys swept').to.equal(2);
			expect(limiter.size, 'only the refreshed key remains').to.equal(1);
			// The survivor is still tracked: a later sweep well past its TTL drops it too.
			expect(limiter.sweep(2_000)).to.equal(1);
			expect(limiter.size).to.equal(0);
		});

		it('an evicted/idle key returns fresh — full ratePerWindow allowance, strikes reset', () => {
			const limiter = createRegisterRateLimiter({ maxKeys: 1, ratePerWindow: DEFAULT_REGISTER_RATE_PER_PEER });
			// Saturate (A, T1) and drive it over-rate to accumulate a strike.
			for (let i = 0; i < DEFAULT_REGISTER_RATE_PER_PEER; i++) limiter.check(PEER_A, TOPIC_1, i);
			expect(limiter.check(PEER_A, TOPIC_1, 5).ok, 'over rate before eviction').to.be.false;

			// A distinct key floods past the cap (maxKeys 1) → (A, T1) is evicted.
			limiter.check(PEER_B, TOPIC_2, 6);
			expect(limiter.size).to.equal(1);

			// (A, T1) re-appears: fresh key, the full allowance again, no inherited strikes.
			for (let i = 0; i < DEFAULT_REGISTER_RATE_PER_PEER; i++) {
				expect(limiter.check(PEER_A, TOPIC_1, 10 + i).ok, `fresh admit ${i}`).to.be.true;
			}
		});

		it('a sustained attacker survives a distinct-key flood — back-off keeps escalating, not reset', () => {
			const limiter = createRegisterRateLimiter({ maxKeys: 4, ratePerWindow: DEFAULT_REGISTER_RATE_PER_PEER });
			// Saturate (A, T1) within the window.
			for (let i = 0; i < DEFAULT_REGISTER_RATE_PER_PEER; i++) limiter.check(PEER_A, TOPIC_1, i);
			// Drive it over-rate twice to build strikes — back-off climbs (attempt 0 → 1).
			const r1 = limiter.check(PEER_A, TOPIC_1, 5);
			const r2 = limiter.check(PEER_A, TOPIC_1, 6);
			expect(r1.ok).to.be.false;
			expect(r2.ok).to.be.false;
			if (r1.ok === false && r2.ok === false) {
				expect(r1.retryAfterMs).to.equal(backoffRetryMs(0));
				expect(r2.retryAfterMs).to.equal(backoffRetryMs(1));
			}

			// Interleave a flood of distinct (A, Tn) keys far exceeding maxKeys, re-checking (A, T1)
			// between each — that refresh keeps the attacker at the MRU end, never the eviction victim.
			for (let n = 0; n < 20; n++) {
				limiter.check(PEER_A, bytes(`flood-${n}`), 7 + n);
				limiter.check(PEER_A, TOPIC_1, 7 + n);
			}
			expect(limiter.size, 'the cap held during the flood').to.equal(4);

			// (A, T1) is still over-rate AND its back-off has kept escalating — it was NOT evicted/reset.
			const after = limiter.check(PEER_A, TOPIC_1, 100);
			expect(after.ok, 'the sustained attacker is still rejected').to.be.false;
			if (after.ok === false) {
				expect(after.retryAfterMs, 'strikes accumulated through the flood, not reset to the floor').to.be.greaterThan(backoffRetryMs(1));
			}
		});

		it('rejects invalid maxKeys / idleTtlMs at construction', () => {
			expect(() => createRegisterRateLimiter({ maxKeys: 0 })).to.throw(RangeError);
			expect(() => createRegisterRateLimiter({ maxKeys: 2.5 })).to.throw(RangeError);
			expect(() => createRegisterRateLimiter({ maxKeys: -1 })).to.throw(RangeError);
			expect(() => createRegisterRateLimiter({ idleTtlMs: 0 })).to.throw(RangeError);
			expect(() => createRegisterRateLimiter({ idleTtlMs: -1 })).to.throw(RangeError);
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

			// Populate two topics; leave t[1] the only zero-participant (cold) resident.
			budget.touch(t[0]!, 10);
			budget.touch(t[2]!, 5);
			budget.touch(t[1]!, 0);

			// A new topic evicts the cold one (t[1]), not a populated topic — participant count is the
			// primary eviction key, so the only zero-participant resident goes regardless of recency.
			expect(budget.admit(t[3]!)).to.be.true;
			expect(budget.size).to.equal(3);
			expect(budget.has(t[1]!), 'cold topic evicted').to.be.false;
			expect(budget.has(t[0]!)).to.be.true;
			expect(budget.has(t[2]!)).to.be.true;
			expect(budget.has(t[3]!)).to.be.true;
		});

		it('among several zero-participant residents, evicts the least-recently-used (lowest seq)', () => {
			const budget = createTopicBudget({ topicsMax: 3 });
			const t = [bytes('x'), bytes('y'), bytes('z'), bytes('w')];
			budget.admit(t[0]!); // seq 1
			budget.admit(t[1]!); // seq 2
			budget.admit(t[2]!); // seq 3
			// All three are zero-participant. Refresh recency so t[0] becomes the LRU victim:
			// touch t[1] then t[2], leaving t[0] with the lowest seq among the cold residents.
			budget.touch(t[1]!, 0);
			budget.touch(t[2]!, 0);

			expect(budget.admit(t[3]!)).to.be.true;
			expect(budget.has(t[0]!), 'least-recently-used cold topic evicted').to.be.false;
			expect(budget.has(t[1]!)).to.be.true;
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

		it('re-admits a correlationId once its prior record has aged out of the window', () => {
			// A re-used id can only re-appear with a *fresh* timestamp (a captured replay carries the old,
			// now-stale timestamp and is rejected on age). The guard must prune the aged record so the
			// legitimate owner is not penalized forever for a one-time id collision across windows.
			const guard = createCorrelationReplayGuard();
			const cid = bytes('corr-recur', 16);
			const now = 1_000_000;
			expect(guard.accept(cid, PEER_A, now, now)).to.be.true;
			// Same id, fresh timestamp, a full window later → the old record has aged out and is pruned.
			const later = now + DEFAULT_REPLAY_MAX_AGE_MS + 1;
			expect(guard.accept(cid, PEER_A, later, later)).to.be.true;
			// ...but an immediate exact replay at that fresh timestamp is still caught.
			expect(guard.accept(cid, PEER_A, later, later + 1)).to.be.false;
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

		// A follow-on cold-start (`followOn: true`) is gated identically to a root bootstrap: it must carry
		// the same tier-dependent evidence, and a register that is neither flag needs none.
		function followOnReg(tier: number): RegisterV1 {
			return { ...reg(tier, false), treeTier: 1, followOn: true };
		}

		it('gates a followOn registration exactly like a bootstrap (evidence required)', () => {
			// T2 follow-on with PoW → admitted; without any verifier → refused (same truth-table as bootstrap).
			expect(createBootstrapEvidence({ verifyPoW: () => true }).verify(followOnReg(2), 2)).to.be.true;
			expect(createBootstrapEvidence({}).verify(followOnReg(2), 2)).to.be.false;
			// T1 follow-on needs a signed parent reference, not PoW (mirrors the bootstrap T0/T1 policy).
			expect(createBootstrapEvidence({ verifyParentReference: () => true }).verify(followOnReg(1), 1)).to.be.true;
			expect(createBootstrapEvidence({ verifyPoW: () => true }).verify(followOnReg(1), 1)).to.be.false;
		});

		it('admits a register that is neither bootstrap nor followOn without evidence', () => {
			const ev = createBootstrapEvidence({}); // no verifiers → evidence never satisfiable
			expect(ev.verify(reg(3, false), 3), 'a plain register needs no evidence').to.be.true;
		});
	});
});
