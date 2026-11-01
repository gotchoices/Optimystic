import { expect } from 'chai';
import type { ActionId } from '@optimystic/db-core';
import { bytesValueCodec, textValueCodec } from '../src/storage/raw-store-codec.js';

describe('textValueCodec', () => {
	// A text composition's overlay and cache serve the encoded value itself, so it must already be
	// what a read from disk returns: TextEncoder replaces a lone surrogate on the way there.
	it('encodes an ill-formed action id as it reads back from disk', () => {
		const actionId = 'a\uD800b\uDC00c😀' as ActionId;
		const fromDisk = bytesValueCodec.decodeActionId(bytesValueCodec.encodeActionId(actionId));
		expect(textValueCodec.decodeActionId(textValueCodec.encodeActionId(actionId))).to.equal(fromDisk);
		expect(fromDisk).to.equal('a�b�c😀');
	});
});
