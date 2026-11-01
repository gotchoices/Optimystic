import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { ActionRev, BlockId } from '@optimystic/db-core';
import { ConsultRound, type ClusterLatestBatchCallback, type ConsultAsk, type ConsultBatchAnswer } from '../src/repo/consult-round.js';
import type { ClusterLatestAnswer, ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import { MAX_CONSULT_BATCH_BLOCKS } from '../src/protocol-limits.js';
import { createLogger } from '../src/logger.js';

/**
 * The per-read barrier that turns each block's per-peer consult questions into one request per peer.
 * Driven against fake batch and single callbacks, so what is pinned is the routing of questions to
 * requests and the settling of each question — the three-way contract (claim, holds nothing, silence)
 * per (peer, block).
 */

const newPeer = async (): Promise<string> => peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();

const claim = (rev: number): ClusterLatestAnswer => ({ rev, actionId: `action-${rev}` });

interface Harness {
	round: ConsultRound;
	batchCalls: { peer: string; asks: ConsultAsk[] }[];
	singleCalls: { peer: string; blockId: BlockId; held?: ActionRev }[];
}

/** A round whose batch answers from `reply(peer, asks)` and whose single answers every block at rev 1. */
const makeRound = (reply: (peer: string, asks: readonly ConsultAsk[]) => ConsultBatchAnswer | Promise<ConsultBatchAnswer>, selfId?: string, deadlineMs = 1_000): Harness => {
	const batchCalls: Harness['batchCalls'] = [];
	const singleCalls: Harness['singleCalls'] = [];
	const batch: ClusterLatestBatchCallback = async (peerId, asks) => {
		batchCalls.push({ peer: peerId.toString(), asks: [...asks] });
		return await reply(peerId.toString(), asks);
	};
	const single: ClusterLatestCallback = async (peerId, blockId, _context, held) => {
		singleCalls.push({ peer: peerId.toString(), blockId, ...(held ? { held } : {}) });
		return claim(1);
	};
	const round = new ConsultRound({ batch, single, deadlineMs, selfId, log: createLogger('coordinator-repo') });
	return { round, batchCalls, singleCalls };
};

/** Answers every asked block at rev 7. */
const answerAll = (_peer: string, asks: readonly ConsultAsk[]): ConsultBatchAnswer =>
	({ answers: new Map(asks.map(ask => [ask.blockId, claim(7)])) });

describe('ConsultRound', () => {
	it('asks each peer once, about exactly the blocks registered for it', async () => {
		const [p, q] = [await newPeer(), await newPeer()];
		const { round, batchCalls } = makeRound(answerAll);
		const header = round.join();
		const tail = round.join();
		round.close();

		const held: ActionRev = { rev: 3, actionId: 'mine' };
		const asked = [header.ask(p, 'header', held), header.ask(q, 'header', held), tail.ask(p, 'tail')];
		header.ready();
		expect(batchCalls, 'nothing sent while a seat is still registering').to.have.length(0);
		tail.ready();

		expect(await Promise.all(asked)).to.deep.equal([claim(7), claim(7), claim(7)]);
		expect(batchCalls).to.have.deep.members([
			{ peer: p, asks: [{ blockId: 'header', held }, { blockId: 'tail' }] },
			{ peer: q, asks: [{ blockId: 'header', held }] }
		]);
	});

	it('sends for the others when a seat leaves without asking', async () => {
		const p = await newPeer();
		const { round, batchCalls } = makeRound(answerAll);
		const asking = round.join();
		const leaving = round.join();
		round.close();

		const answer = asking.ask(p, 'block-a');
		asking.ready();
		leaving.ready();

		expect(await answer).to.deep.equal(claim(7));
		expect(batchCalls).to.have.length(1);
	});

	it('starts the deadline when the round sends, not when a question was registered', async () => {
		// One block's pass can spend a while in its cohort lookup (the bounded bootstrap-contact wait)
		// while another's questions are registered and waiting; that wait is not the peer's silence.
		const p = await newPeer();
		const { round } = makeRound(answerAll, undefined, 20);
		const early = round.join();
		const late = round.join();
		round.close();

		const answer = early.ask(p, 'block-a');
		early.ready();
		await new Promise(resolve => setTimeout(resolve, 60));
		late.ready();

		expect(await answer).to.deep.equal(claim(7));
	});

	it('reads a peer that does not answer within the deadline as silent', async () => {
		const p = await newPeer();
		const { round } = makeRound(() => new Promise<ConsultBatchAnswer>(() => undefined), undefined, 20);
		const seat = round.join();
		round.close();

		const answer = seat.ask(p, 'block-a');
		seat.ready();

		const [settled] = await Promise.allSettled([answer]);
		expect(settled?.status).to.equal('rejected');
	});

	it('reads every block of a request that failed as silent', async () => {
		const p = await newPeer();
		const { round } = makeRound(() => { throw new Error('dial failed'); });
		const seat = round.join();
		round.close();

		const asked = [seat.ask(p, 'block-a'), seat.ask(p, 'block-b')];
		seat.ready();

		const settled = await Promise.allSettled(asked);
		expect(settled.map(s => s.status)).to.deep.equal(['rejected', 'rejected']);
	});

	it('reads a block the answer left out as silent, and only that block', async () => {
		const p = await newPeer();
		const { round } = makeRound(() => ({ answers: new Map([['block-a', undefined]]) }));
		const seat = round.join();
		round.close();

		const asked = [seat.ask(p, 'block-a'), seat.ask(p, 'block-b')];
		seat.ready();

		const [a, b] = await Promise.allSettled(asked);
		expect(a, 'answered "holds nothing"').to.deep.equal({ status: 'fulfilled', value: undefined });
		expect(b?.status, 'left out').to.equal('rejected');
	});

	it('asks an older peer about the blocks after the first one at a time', async () => {
		const p = await newPeer();
		const { round, batchCalls, singleCalls } = makeRound(() => ({ answers: new Map([['block-a', claim(4)]]), unbatched: true }));
		const seat = round.join();
		round.close();

		const held: ActionRev = { rev: 2, actionId: 'mine' };
		const asked = [seat.ask(p, 'block-a'), seat.ask(p, 'block-b', held), seat.ask(p, 'block-c')];
		seat.ready();

		expect(await Promise.all(asked)).to.deep.equal([claim(4), claim(1), claim(1)]);
		expect(batchCalls).to.have.length(1);
		expect(singleCalls).to.deep.equal([{ peer: p, blockId: 'block-b', held }, { peer: p, blockId: 'block-c' }]);
	});

	it('asks this node itself through the single-block callback', async () => {
		const [self, p] = [await newPeer(), await newPeer()];
		const { round, batchCalls, singleCalls } = makeRound(answerAll, self);
		const seat = round.join();
		round.close();

		const asked = [seat.ask(self, 'block-a'), seat.ask(p, 'block-a')];
		seat.ready();

		expect(await Promise.all(asked)).to.deep.equal([claim(1), claim(7)]);
		expect(singleCalls.map(c => c.peer)).to.deep.equal([self]);
		expect(batchCalls.map(c => c.peer)).to.deep.equal([p]);
	});

	it('splits a peer\'s blocks past the batch cap into several requests', async () => {
		const p = await newPeer();
		const { round, batchCalls } = makeRound(answerAll);
		const seat = round.join();
		round.close();

		const blockIds = Array.from({ length: MAX_CONSULT_BATCH_BLOCKS + 1 }, (_, i) => `block-${i}`);
		const asked = blockIds.map(id => seat.ask(p, id));
		seat.ready();

		await Promise.all(asked);
		expect(batchCalls.map(c => c.asks.length)).to.deep.equal([MAX_CONSULT_BATCH_BLOCKS, 1]);
	});
});
