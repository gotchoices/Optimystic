/**
 * Reactivity — node-level subscriber registry (the socket-delivery → subscription-manager seam).
 *
 * A {@link import("./subscription-manager.js").ReactivitySubscriptionManager} owns the verify/dedupe/deliver
 * path for one subscription but is transport-agnostic: it exposes `onNotification(n)` and never touches a
 * socket. This registry is the routing table that connects a socket-delivered {@link NotificationV1} to the
 * right manager(s): the forwarder host's `deliverLocal(topicId, n)` looks topic up here and invokes every
 * manager registered for it, and a constructed manager registers its `onNotification` keyed by the reactivity
 * `topicId` it subscribed under.
 *
 * Keyed by topicId-base64url. A manager subscribes under `topicId = reactivityTopicId(reactivityTailBytes(
 * tailId))` (the same anchor origination derives), so a notification's topic — derived by the forwarder host
 * from the notification's tail anchor — routes to exactly the managers watching that tail's collection.
 *
 * **Scope.** This delivers socket-routed notifications into a manager that was *already constructed* and
 * registered. Constructing the manager from a Quereus `Database.watch` (the application bridge) stays the
 * backlog item `optimystic-network-reactive-watch-integration-test`; this registry is the plug it will use.
 */

import { bytesToB64url, type NotificationV1 } from "@optimystic/db-core";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-subscribers");

/** A subscriber's inbound seam — a manager's `onNotification` (which returns a delivery outcome promise). */
export type ReactivityNotificationHandler = (n: NotificationV1) => void | Promise<unknown>;

/**
 * The node's `topicId → subscriber handlers` table. Exposed on the node as `reactivitySubscribers` so a
 * subscribe factory can register a {@link import("./subscription-manager.js").ReactivitySubscriptionManager}
 * and have socket-delivered notifications routed to it.
 */
export class ReactivitySubscriberRegistry {
	private readonly byTopic = new Map<string, Set<ReactivityNotificationHandler>>();

	/**
	 * Register `onNotification` to receive every notification the node delivers for `topicId`. Multiple
	 * managers may register for one topic (each gets every notification). Returns an idempotent unregister.
	 */
	register(topicId: Uint8Array, onNotification: ReactivityNotificationHandler): () => void {
		const key = bytesToB64url(topicId);
		let handlers = this.byTopic.get(key);
		if (handlers === undefined) {
			handlers = new Set();
			this.byTopic.set(key, handlers);
		}
		handlers.add(onNotification);
		return (): void => this.unregister(topicId, onNotification);
	}

	/** Drop a previously-registered handler; idempotent (a no-op if it was never registered / already gone). */
	unregister(topicId: Uint8Array, onNotification: ReactivityNotificationHandler): void {
		const key = bytesToB64url(topicId);
		const handlers = this.byTopic.get(key);
		if (handlers === undefined) {
			return;
		}
		handlers.delete(onNotification);
		if (handlers.size === 0) {
			this.byTopic.delete(key);
		}
	}

	/**
	 * Deliver `n` to every handler registered for `topicId` (the forwarder host's `deliverLocal` seam). Each
	 * handler is isolated: a synchronous throw or a rejected delivery promise is logged, never propagated —
	 * one faulty subscriber must not break delivery to the rest or the fan-out loop that called this.
	 */
	deliver(topicId: Uint8Array, n: NotificationV1): void {
		const handlers = this.byTopic.get(bytesToB64url(topicId));
		if (handlers === undefined) {
			return;
		}
		// Snapshot: a handler that unregisters itself on delivery would otherwise mutate the live set.
		for (const handler of [...handlers]) {
			try {
				const result = handler(n);
				if (result instanceof Promise) {
					result.catch((err: unknown) => log("subscriber delivery rejected (isolated) for rev=%d: %o", n.revision, err));
				}
			} catch (err) {
				log("subscriber handler threw (isolated) for rev=%d: %o", n.revision, err);
			}
		}
	}

	/** Number of topics with at least one registered subscriber (diagnostic / test). */
	get topicCount(): number {
		return this.byTopic.size;
	}

	/** Whether any subscriber is registered for `topicId` (diagnostic / test). */
	has(topicId: Uint8Array): boolean {
		return this.byTopic.has(bytesToB64url(topicId));
	}
}
