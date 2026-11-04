/**
 * A staged-state snapshot shares the staged values with the live tracker instead of copying them, and
 * the tracker copies a value before changing one it does not own (`Tracker.shareTransforms`). Two
 * shapes of value are changed in place or appended to, and each is exercised here: an invented
 * collection's root leaf is a staged insert, and a write over a committed leaf is a staged update list.
 */

import { expect } from 'chai';
import { Tree, type Transforms } from '../src/index.js';
import { TestTransactor, commitRivalTreeWrite } from '../src/testing/test-transactor.js';

interface Entry {
	key: number;
	name: string;
}

const USERS = 'users';
const byKey = (e: Entry) => e.key;
const row = (key: number, name: string): [number, Entry] => [key, { key, name }];

const shapes = [
	{
		shape: 'an inserted block',
		seed: async (_transactor: TestTransactor) => {},
		values: (transforms: Transforms) => transforms.inserts,
	},
	{
		shape: 'an update list',
		seed: (transactor: TestTransactor) => commitRivalTreeWrite<number, Entry>(transactor, USERS, byKey, [row(5, 'seed')]),
		values: (transforms: Transforms) => transforms.updates,
	},
];

describe('a snapshot shares staged values', () => {
	for (const { shape, seed, values } of shapes) {
		describe(`staged as ${shape}`, () => {
			async function openWithOneRowStaged(): Promise<Tree<number, Entry>> {
				const transactor = new TestTransactor();
				await seed(transactor);
				const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
				await tree.stage([row(1, 'captured')]);
				return tree;
			}

			it('stays as captured when later staging changes that value', async () => {
				const tree = await openWithOneRowStaged();
				const collection = tree.getCollection();
				const snapshot = collection.snapshotPending();
				const captured = structuredClone(snapshot.transforms);

				await tree.stage([row(2, 'later')]);

				expect(values(collection.tracker.transforms), 'the later write changed this shape').to.not.deep.equal(values(captured));
				expect(snapshot.transforms).to.deep.equal(captured);
			});

			it('gives the captured state each time it is restored, with staging between', async () => {
				const tree = await openWithOneRowStaged();
				const collection = tree.getCollection();
				const snapshot = collection.snapshotPending();
				const captured = structuredClone(snapshot.transforms);

				for (const key of [2, 3]) {
					await tree.stage([row(key, 'rolled back')]);
					await collection.restorePending(snapshot);

					expect(collection.tracker.transforms).to.deep.equal(captured);
					expect(await tree.get(1)).to.deep.equal({ key: 1, name: 'captured' });
					expect(await tree.get(key), 'the rolled-back row is gone').to.be.undefined;
				}
			});
		});
	}
});
