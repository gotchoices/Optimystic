import { expect } from 'chai';
import { reactivityCollectionTopicId, reactivityRootCoord } from '../../src/reactivity/index.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';

const utf8 = new TextEncoder();

describe('reactivity topic anchor', () => {
	it('is a function of the collection id alone: the same collection under two tails has one topic', () => {
		const collection = utf8.encode('app/users');
		const a = reactivityCollectionTopicId(collection);
		const b = reactivityCollectionTopicId(utf8.encode('app/users'));
		expect([...a]).to.deep.equal([...b]);
		// Nothing about a tail enters the derivation; the root coordinate is the only thing a rotation moves.
		expect([...reactivityRootCoord(utf8.encode('tail-block-1'))]).to.not.deep.equal([...reactivityRootCoord(utf8.encode('tail-block-2'))]);
	});

	it('produces a ring-width (32-byte) topic id at the default ring bits', () => {
		expect(reactivityCollectionTopicId(utf8.encode('app/users')).length).to.equal(32);
	});

	it('is domain-separated from the root coordinate and from a bare hash of the same bytes', () => {
		const hash = createRingHash();
		const bytes = utf8.encode('shared-bytes');
		const topic = reactivityCollectionTopicId(bytes, hash);
		expect([...topic], 'the suffix keeps a collection topic apart from a root placed at the same bytes').to.not.deep.equal([...reactivityRootCoord(bytes, hash)]);
		expect([...topic]).to.not.deep.equal([...hash.H(bytes)]);
	});
});
