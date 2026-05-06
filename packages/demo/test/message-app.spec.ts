import { expect } from 'chai';
import { TestTransactor } from '@optimystic/db-core/test';
import { MessageApp } from '../src/index.js';

describe('MessageApp', () => {
	let transactor: TestTransactor;
	let app: MessageApp;

	beforeEach(async () => {
		transactor = new TestTransactor();
		app = await MessageApp.create(transactor);
	});

	it('should create an app instance', () => {
		expect(app).to.be.instanceOf(MessageApp);
	});

	it('should add and retrieve a message', async () => {
		const msg = await app.addMessage('Alice', 'Hello, world!');
		expect(msg.author).to.equal('Alice');
		expect(msg.content).to.equal('Hello, world!');
		expect(msg.id).to.be.a('string');
		expect(msg.timestamp).to.be.a('number');

		const retrieved = await app.getMessage(msg.id);
		expect(retrieved).to.deep.equal(msg);
	});

	it('should return undefined for non-existent message', async () => {
		const result = await app.getMessage('does-not-exist');
		expect(result).to.be.undefined;
	});

	it('should list multiple messages', async () => {
		const msg1 = await app.addMessage('Alice', 'First');
		const msg2 = await app.addMessage('Bob', 'Second');
		const msg3 = await app.addMessage('Charlie', 'Third');

		const messages = await app.listMessages();
		expect(messages).to.have.lengthOf(3);

		// Messages are sorted by id (string comparison)
		const ids = messages.map(m => m.id);
		expect(ids).to.include(msg1.id);
		expect(ids).to.include(msg2.id);
		expect(ids).to.include(msg3.id);
	});

	it('should update a message', async () => {
		const msg = await app.addMessage('Alice', 'Original');
		const updated = await app.updateMessage(msg.id, 'Updated');

		expect(updated.content).to.equal('Updated');
		expect(updated.author).to.equal('Alice');
		expect(updated.id).to.equal(msg.id);

		const retrieved = await app.getMessage(msg.id);
		expect(retrieved?.content).to.equal('Updated');
	});

	it('should throw when updating non-existent message', async () => {
		try {
			await app.updateMessage('does-not-exist', 'content');
			expect.fail('should have thrown');
		} catch (e) {
			expect((e as Error).message).to.include('Message not found');
		}
	});

	it('should delete a message', async () => {
		const msg = await app.addMessage('Alice', 'To be deleted');
		await app.deleteMessage(msg.id);

		const retrieved = await app.getMessage(msg.id);
		expect(retrieved).to.be.undefined;
	});

	it('should throw when deleting non-existent message', async () => {
		try {
			await app.deleteMessage('does-not-exist');
			expect.fail('should have thrown');
		} catch (e) {
			expect((e as Error).message).to.include('Message not found');
		}
	});

	it('should record activity for all operations', async () => {
		const msg = await app.addMessage('Alice', 'Hello');
		await app.updateMessage(msg.id, 'Updated');
		await app.deleteMessage(msg.id);

		const activities = await app.getActivity();
		expect(activities).to.have.lengthOf(3);
		expect(activities[0]!.action).to.equal('created');
		expect(activities[0]!.messageId).to.equal(msg.id);
		expect(activities[1]!.action).to.equal('updated');
		expect(activities[1]!.messageId).to.equal(msg.id);
		expect(activities[2]!.action).to.equal('deleted');
		expect(activities[2]!.messageId).to.equal(msg.id);
	});

	it('should handle multiple app instances on the same transactor', async () => {
		const app2 = await MessageApp.create(transactor);

		const msg1 = await app.addMessage('Alice', 'From app 1');
		const msg2 = await app2.addMessage('Bob', 'From app 2');

		// Both apps share the same collections, so both messages are visible
		const messages = await app.listMessages();
		expect(messages).to.have.lengthOf(2);

		const retrieved1 = await app2.getMessage(msg1.id);
		expect(retrieved1?.content).to.equal('From app 1');

		const retrieved2 = await app.getMessage(msg2.id);
		expect(retrieved2?.content).to.equal('From app 2');
	});

	it('should handle empty message list', async () => {
		const messages = await app.listMessages();
		expect(messages).to.be.empty;
	});

	it('should handle empty activity list', async () => {
		const activities = await app.getActivity();
		expect(activities).to.be.empty;
	});
});
