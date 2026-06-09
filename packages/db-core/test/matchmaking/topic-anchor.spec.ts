import { expect } from 'chai';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import {
	createMatchTopicAnchor,
	matchTopicId,
	isMatchTopicKind,
	MATCH_TOPIC_KINDS,
	type MatchTopicKind,
} from '../../src/matchmaking/index.js';

const hex = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

describe('matchmaking / topic anchor (topicId)', () => {
	const anchor = createMatchTopicAnchor();

	it('produces a 32-byte topicId (cohort-topic width)', () => {
		expect(anchor.topicId('capability', 'geocode-resolver').length).to.equal(32);
	});

	it('is deterministic for the same (kind, label)', () => {
		const a = anchor.topicId('task', 'pdf-render');
		const b = anchor.topicId('task', 'pdf-render');
		expect(hex(a)).to.equal(hex(b));
	});

	it('matches the standalone matchTopicId convenience', () => {
		expect(hex(anchor.topicId('quorum', 'proposal-0xabc'))).to.equal(hex(matchTopicId('quorum', 'proposal-0xabc')));
	});

	it('is distinct across labels within a kind', () => {
		const a = anchor.topicId('capability', 'geocode-resolver');
		const b = anchor.topicId('capability', 'zk-snark-prover-v2');
		expect(hex(a)).to.not.equal(hex(b));
	});

	it('is distinct across kinds for the same label', () => {
		const seen = new Set<string>();
		for (const kind of MATCH_TOPIC_KINDS) {
			seen.add(hex(anchor.topicId(kind, 'shared-label')));
		}
		expect(seen.size).to.equal(MATCH_TOPIC_KINDS.length);
	});

	it('does not alias across the kind/label concatenation boundary', () => {
		// task‖"Xfoo" vs capability‖... — the closed kind set has no prefix collisions, so distinct
		// (kind,label) pairs whose naive concatenations might look similar still differ.
		const a = anchor.topicId('task', 'foo');
		const b = anchor.topicId('capability', 'foo');
		expect(hex(a)).to.not.equal(hex(b));
	});

	it('uses the injected hash (same instance → same digest)', () => {
		const hash = createRingHash();
		const a = createMatchTopicAnchor(hash).topicId('task', 'x');
		const b = createMatchTopicAnchor(hash).topicId('task', 'x');
		expect(hex(a)).to.equal(hex(b));
	});

	it('rejects an unknown kind at runtime', () => {
		expect(() => anchor.topicId('bogus' as MatchTopicKind, 'x')).to.throw(RangeError, /unknown kind/);
	});

	it('classifies kinds with isMatchTopicKind', () => {
		expect(isMatchTopicKind('quorum')).to.equal(true);
		expect(isMatchTopicKind('nope')).to.equal(false);
	});

	it('handles unicode labels deterministically', () => {
		const a = anchor.topicId('capability', '日本語-label');
		const b = anchor.topicId('capability', '日本語-label');
		expect(hex(a)).to.equal(hex(b));
		expect(a.length).to.equal(32);
	});
});
