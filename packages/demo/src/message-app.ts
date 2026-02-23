import { Tree, Diary, type ITransactor } from '@optimystic/db-core';

export interface Message {
	id: string;
	author: string;
	content: string;
	timestamp: number;
}

export interface Activity {
	action: 'created' | 'updated' | 'deleted';
	messageId: string;
	timestamp: number;
}

/** Simple messages app exercising Tree + Diary collections across the full Optimystic stack. */
export class MessageApp {
	private constructor(
		private readonly messages: Tree<string, Message>,
		private readonly activity: Diary<Activity>,
	) {}

	static async create(transactor: ITransactor): Promise<MessageApp> {
		const messages = await Tree.createOrOpen<string, Message>(
			transactor,
			'demo-messages',
			(entry) => entry.id,
		);
		const activity = await Diary.create<Activity>(transactor, 'demo-activity');
		return new MessageApp(messages, activity);
	}

	async addMessage(author: string, content: string): Promise<Message> {
		const message: Message = {
			id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			author,
			content,
			timestamp: Date.now(),
		};
		await this.messages.replace([[message.id, message]]);
		await this.activity.append({ action: 'created', messageId: message.id, timestamp: Date.now() });
		return message;
	}

	async getMessage(id: string): Promise<Message | undefined> {
		await this.messages.update();
		return await this.messages.get(id);
	}

	async updateMessage(id: string, content: string): Promise<Message> {
		await this.messages.update();
		const existing = await this.messages.get(id);
		if (!existing) {
			throw new Error(`Message not found: ${id}`);
		}
		const updated: Message = { ...existing, content, timestamp: Date.now() };
		await this.messages.replace([[id, updated]]);
		await this.activity.append({ action: 'updated', messageId: id, timestamp: Date.now() });
		return updated;
	}

	async deleteMessage(id: string): Promise<void> {
		await this.messages.update();
		const existing = await this.messages.get(id);
		if (!existing) {
			throw new Error(`Message not found: ${id}`);
		}
		await this.messages.replace([[id, undefined]]);
		await this.activity.append({ action: 'deleted', messageId: id, timestamp: Date.now() });
	}

	async listMessages(): Promise<Message[]> {
		await this.messages.update();
		const result: Message[] = [];
		const path = await this.messages.first();
		for await (const p of this.messages.ascending(path)) {
			const entry = this.messages.at(p);
			if (entry) {
				result.push(entry);
			}
		}
		return result;
	}

	async getActivity(): Promise<Activity[]> {
		await this.activity.update();
		const result: Activity[] = [];
		for await (const entry of this.activity.select()) {
			result.push(entry);
		}
		return result;
	}
}
