import { expect } from 'chai';
import { reactivityTopicId, createReactivityTopicAnchor } from '../../src/reactivity/index.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';

function seededBytes(len: number, seed: number): Uint8Array {
	const out = new Uint8Array(len);
	let s = (seed * 2654435761) >>> 0;
	for (let i = 0; i < len; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		out[i] = (s >>> 24) & 0xff;
	}
	return out;
}

describe('reactivity topic anchor', () => {
	it('is deterministic for identical tail ids', () => {
		const tailId = seededBytes(32, 1);
		expect([...reactivityTopicId(tailId)]).to.deep.equal([...reactivityTopicId(tailId)]);
	});

	it('rotates the topic id when the tail id changes', () => {
		const a = reactivityTopicId(seededBytes(32, 1));
		const b = reactivityTopicId(seededBytes(32, 2));
		expect([...a]).to.not.deep.equal([...b]);
	});

	it('produces a ring-width (32-byte) topic id at the default ring bits', () => {
		expect(reactivityTopicId(seededBytes(32, 3)).length).to.equal(32);
	});

	it('domain-separates from a bare hash of the tail id (suffix is mixed in)', () => {
		const hash = createRingHash();
		const tailId = seededBytes(32, 4);
		const anchored = reactivityTopicId(tailId, hash);
		const bare = hash.H(tailId);
		expect([...anchored]).to.not.deep.equal([...bare]);
	});

	it('the anchor object agrees with the free function', () => {
		const anchor = createReactivityTopicAnchor();
		const tailId = seededBytes(32, 5);
		expect([...anchor.topicId(tailId)]).to.deep.equal([...reactivityTopicId(tailId)]);
	});
});
