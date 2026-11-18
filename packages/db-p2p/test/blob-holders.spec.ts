import { expect } from 'chai';
import { unavailableOutcome, type PieceAnswer } from '../src/blob/blob-holders.js';

function attempts(...answers: PieceAnswer[]): Array<{ peer: string; answer: PieceAnswer }> {
	return answers.map((answer, index) => ({ peer: `peer-${index}`, answer }));
}

describe('unavailableOutcome', () => {
	it('no candidate is cohort-unreachable', () => {
		expect(unavailableOutcome([])).to.deep.equal({ error: 'unavailable', reason: 'cohort-unreachable' });
	});

	it('every candidate silent is cohort-unreachable', () => {
		expect(unavailableOutcome(attempts('no-answer', 'no-answer'))).to.deep.equal({ error: 'unavailable', reason: 'cohort-unreachable' });
	});

	it('bad bytes where every other candidate lacks the piece is corrupt', () => {
		expect(unavailableOutcome(attempts('not-held', 'corrupt', 'not-held'))).to.deep.equal({ error: 'corrupt' });
	});

	it('a silent candidate beside refusals and bad bytes is peers-unreachable', () => {
		expect(unavailableOutcome(attempts('corrupt', 'no-answer', 'not-held'))).to.deep.equal({ error: 'unavailable', reason: 'peers-unreachable' });
	});

	it('every candidate lacking the piece is not-held', () => {
		expect(unavailableOutcome(attempts('not-held', 'not-held'))).to.deep.equal({ error: 'unavailable', reason: 'not-held' });
	});
});
