/**
 * The plugin-level `storage_allotment` the node a `network` transactor builds is given as its
 * `NodeOptions.storageAllotment` (README § Plugin-Level Configuration): how many bytes of this
 * machine the operator gave the network, and what the node does as it fills.
 *
 * `declaredStorageAllotment` is where the setting's SHAPE is checked, and the numbers are the node's
 * to refuse — so these cases cover the shapes, including an unknown key, which must be refused
 * rather than dropped: a dropped key reaches the node as "no allotment" and leaves its storage
 * un-measured, which is the thing the setting exists to end. One case per branch.
 */

import { expect } from 'chai';
import { declaredStorageAllotment } from '../src/optimystic-module.js';

describe('declaredStorageAllotment: the allotment the plugin hands its node', () => {
	it('declares nothing when the setting is unset', () => {
		expect(declaredStorageAllotment({})).to.equal(undefined);
	});

	it('passes a well-shaped allotment through unchanged', () => {
		const declared = { bytes: 2147483648, thresholds: { shedAbove: 0.8 } };
		expect(declaredStorageAllotment({ storage_allotment: declared })).to.deep.equal(declared);
	});

	it('accepts an empty object, which asks for the defaults', () => {
		expect(declaredStorageAllotment({ storage_allotment: {} })).to.deep.equal({});
	});

	it('refuses a value that is not an object', () => {
		expect(() => declaredStorageAllotment({ storage_allotment: '20gb' }))
			.to.throw(/storage_allotment must be an object/);
	});

	it('refuses a key that is not a setting, naming it', () => {
		expect(() => declaredStorageAllotment({ storage_allotment: { byte: 20 } }))
			.to.throw(/storage_allotment has no 'byte' setting/);
	});

	it('refuses a bytes that is not a number', () => {
		expect(() => declaredStorageAllotment({ storage_allotment: { bytes: '20gb' } }))
			.to.throw(/storage_allotment\.bytes must be a number/);
	});

	it('refuses a threshold key that is not a threshold, naming it', () => {
		expect(() => declaredStorageAllotment({ storage_allotment: { thresholds: { shedabove: 0.8 } } }))
			.to.throw(/storage_allotment\.thresholds has no 'shedabove' setting/);
	});
});
