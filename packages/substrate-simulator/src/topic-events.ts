import type { VTime } from './types.js';

/**
 * The simulator metrics stream emitted by the cohort-topic tree, consumed downstream by
 * `simulator-metrics-and-scenarios` (ticket 6). That ticket's richer `MetricsSink`
 * (counter/histogram/timeline) aggregates these typed events; here we define only the event
 * vocabulary and a minimal in-memory sink so the tree can emit and tests can assert.
 *
 * The tree emits `Promoted`, `NoState`, `UnwillingMember`, `UnwillingCohort`, `TopicTraffic`
 * (cohort-topic.md), plus `Demoted` for the convergence tracer.
 */

/** Per-(topic, cohort) flow signal, surfaced on `accepted`/`promoted` replies (cohort-topic.md §Topic traffic). */
export interface TopicTrafficV1 {
	readonly windowSeconds: number;
	readonly arrivalsPerMin: number;
	readonly queriesPerMin: number;
	readonly directParticipants: number;
	readonly childCohortCount: number;
}

export type SimEvent =
	| { readonly kind: 'Promoted'; readonly topicId: string; readonly fromTier: number; readonly toTier: number; readonly at: VTime }
	| { readonly kind: 'Demoted'; readonly topicId: string; readonly tier: number; readonly at: VTime }
	| { readonly kind: 'NoState'; readonly topicId: string; readonly tier: number; readonly at: VTime }
	| { readonly kind: 'UnwillingMember'; readonly topicId: string; readonly tier: number; readonly at: VTime }
	| { readonly kind: 'UnwillingCohort'; readonly topicId: string; readonly tier: number; readonly at: VTime }
	| { readonly kind: 'TopicTraffic'; readonly topicId: string; readonly tier: number; readonly traffic: TopicTrafficV1; readonly at: VTime };

export type SimEventKind = SimEvent['kind'];

/** Sink the tree emits onto; ticket 6's metrics engine implements a richer version. */
export interface EventSink {
	record(event: SimEvent): void;
}

/** In-memory sink for tests and small scenarios — keeps every event in emission order. */
export class CollectingEventSink implements EventSink {
	readonly events: SimEvent[] = [];

	record(event: SimEvent): void {
		this.events.push(event);
	}

	countOf(kind: SimEventKind): number {
		return this.events.reduce((n, e) => (e.kind === kind ? n + 1 : n), 0);
	}

	byKind<K extends SimEventKind>(kind: K): Extract<SimEvent, { kind: K }>[] {
		return this.events.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === kind);
	}
}

/** A sink that drops every event — the default when a tree runs without metrics collection. */
export const NULL_EVENT_SINK: EventSink = { record: () => {} };
