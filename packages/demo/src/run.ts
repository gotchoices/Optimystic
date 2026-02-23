import { TestTransactor } from '@optimystic/db-core/test';
import { MessageApp } from './message-app.js';

async function main() {
	console.log('=== Optimystic Demo: Messages App ===\n');

	const transactor = new TestTransactor();
	const app = await MessageApp.create(transactor);
	console.log('App initialized with TestTransactor.\n');

	// Add messages
	const msg1 = await app.addMessage('Alice', 'Hello from Alice!');
	console.log(`Added: [${msg1.id}] ${msg1.author}: ${msg1.content}`);

	const msg2 = await app.addMessage('Bob', 'Hey Alice, how are you?');
	console.log(`Added: [${msg2.id}] ${msg2.author}: ${msg2.content}`);

	const msg3 = await app.addMessage('Alice', 'Doing great, thanks!');
	console.log(`Added: [${msg3.id}] ${msg3.author}: ${msg3.content}`);

	// List all messages
	console.log('\n--- All Messages ---');
	const messages = await app.listMessages();
	for (const msg of messages) {
		console.log(`  [${msg.id}] ${msg.author}: ${msg.content}`);
	}

	// Update a message
	const updated = await app.updateMessage(msg2.id, 'Hey Alice, how are you doing today?');
	console.log(`\nUpdated: [${updated.id}] ${updated.author}: ${updated.content}`);

	// Delete a message
	await app.deleteMessage(msg3.id);
	console.log(`Deleted: ${msg3.id}`);

	// List messages after changes
	console.log('\n--- Messages After Changes ---');
	const remaining = await app.listMessages();
	for (const msg of remaining) {
		console.log(`  [${msg.id}] ${msg.author}: ${msg.content}`);
	}

	// Show activity log
	console.log('\n--- Activity Log ---');
	const activities = await app.getActivity();
	for (const activity of activities) {
		console.log(`  ${activity.action} ${activity.messageId} at ${new Date(activity.timestamp).toISOString()}`);
	}

	console.log(`\nTotal messages: ${remaining.length}`);
	console.log(`Total activities: ${activities.length}`);
	console.log('\n=== Demo Complete ===');
}

main().catch((err) => {
	console.error('Demo failed:', err);
	process.exit(1);
});
