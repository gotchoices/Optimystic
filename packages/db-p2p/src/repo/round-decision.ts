import type { ClusterRecord, MemberApplyOutcome, RepoMessage } from "@optimystic/db-core";
import { canonicalJson } from "@optimystic/db-core";

/**
 * When a consensus round may stop waiting for the members it has not heard from. A round asks every
 * member it targets in parallel, and each of the coordinator's three rounds — promise, commit, and the
 * consensus broadcast — stops waiting once the answers in hand decide its outcome, either way, and the
 * members still unanswered have had a short grace ({@link DecisionGrace}). The members still unheard
 * from then are the round's **stragglers**: the coordinator keeps their requests running and owes them
 * the record afterwards (`ClusterCoordinator`'s straggler path). This module is the mechanism and the
 * three rules; it holds no state and never touches the network.
 */

/** One member's answer to a delivery; `response` is absent, and `error` present, when it failed. */
export interface MemberDelivery {
	peerId: string;
	success: boolean;
	response?: ClusterRecord;
	error?: string;
}

/** A round's answers, split at the moment its outcome was decided. */
export interface DecidedRound {
	/** Settled before the decision, in the order they settled. */
	answered: MemberDelivery[];
	/** Still in flight at the decision, by member. Each settles to a {@link MemberDelivery}; never rejects. */
	stragglers: Map<string, Promise<MemberDelivery>>;
}

/**
 * Whether the answers in hand decide a round: true once its outcome is reached, or out of reach whatever
 * the `outstanding` members still answer. False while they could still go either way.
 */
export type RoundDecided = (answered: readonly MemberDelivery[], outstanding: number) => boolean;

/**
 * The least a decided round still waits for its unanswered members ({@link DecisionGrace}): enough for
 * members answering at the same moment as the deciding one, give or take scheduling, to land in hand.
 */
export const STRAGGLER_GRACE_FLOOR_MS = 50;

/**
 * The clock a round's grace runs on. Once a round is decided with members still unanswered, it waits for
 * them a little longer: as long again as the decision took, and at least {@link STRAGGLER_GRACE_FLOOR_MS}.
 * Healthy members answer within moments of each other, so in a healthy cohort every answer lands in that
 * window and nobody is left behind — no member reports late, the write's durability class stays `full`,
 * and no background delivery or under-replication push follows. A member that is connected but silent
 * costs the round about twice its decision time rather than its whole RPC deadline.
 *
 * NOTE: the grace is the one place a round waits on time rather than on answers. If healthy members are
 * routinely left behind (`cluster-tx:stragglers` on writes no member was slow for), lengthen it; if a
 * silent member still costs writes too much, shorten it — down to none, the pure "stop at the decision".
 */
export interface DecisionGrace {
	now: () => number;
	/** A one-shot timer; the returned function cancels it. */
	setTimer: (fn: () => void, delayMs: number) => () => void;
}

/**
 * Resolve once `decided(answered, outstanding)` is true — after the {@link DecisionGrace} for anyone still
 * unanswered, when one is given — or once nothing is outstanding. The rule is asked before any answer
 * arrives and again after each one until it holds, so a round with nobody to ask resolves at once. A
 * decided round stays decided: an answer can neither revive a round out of reach nor undo a reached one,
 * since approvals, commits and holders only grow. A request that rejects counts as a failed delivery — the
 * callers' requests never reject, but a round must not hang or leak an unhandled rejection if one ever does.
 */
export function awaitDecision(requests: ReadonlyMap<string, Promise<MemberDelivery>>, decided: RoundDecided, grace?: DecisionGrace): Promise<DecidedRound> {
	return new Promise<DecidedRound>(resolve => {
		const startedAt = grace?.now();
		const answered: MemberDelivery[] = [];
		const outstanding = new Map<string, Promise<MemberDelivery>>();
		let done = false;
		let cancelGrace: (() => void) | undefined;
		const finish = (): void => {
			if (done) return;
			done = true;
			cancelGrace?.();
			resolve({ answered: [...answered], stragglers: new Map(outstanding) });
		};
		const onAnswer = (): void => {
			if (outstanding.size === 0) return finish();
			if (cancelGrace !== undefined || !decided(answered, outstanding.size)) return;
			if (grace === undefined || startedAt === undefined) return finish();
			cancelGrace = grace.setTimer(finish, Math.max(STRAGGLER_GRACE_FLOOR_MS, grace.now() - startedAt));
		};
		for (const [peerId, request] of requests) {
			const settled = request.then(
				delivery => delivery,
				(err: unknown): MemberDelivery => ({ peerId, success: false, error: err instanceof Error ? err.message : String(err) }));
			outstanding.set(peerId, settled);
			void settled.then(delivery => {
				if (done) return;
				outstanding.delete(peerId);
				answered.push(delivery);
				onAnswer();
			});
		}
		onAnswer();
	});
}

/**
 * Pick each peer's OWN {@link ClusterRecord.applyOutcomes} entry out of the record that peer answered
 * with, and key it under the peer we actually asked.
 *
 * Taking only `response.applyOutcomes[peerId]` — rather than spreading the whole map — is what keeps
 * one member from reporting outcomes on other members' behalf: a peer that echoes back a record full
 * of entries contributes exactly one, its own. The field is unsigned advisory data (see its doc
 * comment for why that is safe), so this is a shaping rule, not a security boundary.
 *
 * Returns `undefined` when no peer reported anything, so the common case adds no empty object to the
 * record.
 */
export function collectApplyOutcomes(
	responses: ReadonlyArray<{ peerId: string; response?: ClusterRecord | null }>
): ClusterRecord['applyOutcomes'] {
	let collected: NonNullable<ClusterRecord['applyOutcomes']> | undefined;
	for (const { peerId, response } of responses) {
		const own = response?.applyOutcomes?.[peerId];
		if (own === undefined) continue;
		collected ??= {};
		collected[peerId] = own;
	}
	return collected;
}

/**
 * Each answering member's OWN commit signature, keyed by the peer asked, when its answer's promise map
 * equals `record.promises` exactly — same peers, same signatures — and the members whose own commit was
 * signed over some other map. A commit signature covers
 * `computeClusterCommitHash(messageHash, message, promises, membershipDigest)`, so one signed over any
 * other map fails every member's check. Pure: `ClusterCoordinator` applies the result, and a round's
 * decision rule counts with it before anything is applied.
 */
export function commitsSignedOverRecordPromises(
	record: ClusterRecord,
	answers: ReadonlyArray<{ peerId: string; response?: ClusterRecord | null }>
): { kept: ClusterRecord['commits']; dropped: string[] } {
	const promiseMap = canonicalJson(record.promises);
	const kept: ClusterRecord['commits'] = {};
	const dropped: string[] = [];
	for (const { peerId, response } of answers) {
		const own = response?.commits?.[peerId];
		if (response == null || own === undefined) continue;
		if (canonicalJson(response.promises ?? {}) === promiseMap) {
			kept[peerId] = own;
		} else {
			dropped.push(peerId);
		}
	}
	return { kept, dropped };
}

/**
 * The durability gate's rule: a STRICT majority of the cohort the commit ran on — the majority a commit
 * reaches consensus by, applied to durable holders instead of approving votes. The consensus broadcast
 * waits by the same function (`broadcastDecided`), so finishing it early never leaves the gate
 * (`CoordinatorRepo.commit`) seeing fewer holders than a majority while one more answer could have
 * made one.
 */
export function isDurableMajority(durableHolders: number, cohortSize: number): boolean {
	return cohortSize > 0 && durableHolders > cohortSize / 2;
}

/**
 * Whether a member's own report says it holds `message`'s record. For a commit record that is the test
 * the durability gate applies, `commit.success === true`. For a pend or cancel record it is having run
 * the consensus apply (`executed`) with no pend refusal reported: a member on an older build never sets
 * `executed`, so a broadcast of such a record waits for it as every broadcast used to.
 */
export function holdsRecord(message: RepoMessage, outcome: MemberApplyOutcome | undefined): boolean {
	if (message.operations.some(op => 'commit' in op)) {
		return outcome?.commit?.success === true;
	}
	return outcome?.executed === true && outcome.pend === undefined;
}

/**
 * The promise round's rule: decided once the approved promises in the merged map reach `needed`
 * (the super-majority), and out of reach once the approvals plus every outstanding member could not.
 * The merged map is `record.promises` — the coordinator's own pre-vote — under each answer's map, as
 * `ClusterCoordinator.collectPromises` merges them.
 */
export function promiseRoundDecided(record: ClusterRecord, needed: number): RoundDecided {
	return (answered, outstanding) => {
		const merged = answered.reduce<ClusterRecord['promises']>(
			(promises, { response }) => response ? { ...promises, ...response.promises } : promises,
			record.promises);
		const approvals = Object.values(merged).filter(sig => sig.type === 'approve').length;
		return approvals >= needed || approvals + outstanding < needed;
	};
}

/**
 * The commit round's rule: decided once the commits the record holds plus those it would keep from the
 * answers ({@link commitsSignedOverRecordPromises}) reach `needed` (the simple majority), and out of reach
 * once those plus every outstanding member could not.
 */
export function commitRoundDecided(record: ClusterRecord, needed: number): RoundDecided {
	return (answered, outstanding) => {
		const commits = Object.keys({ ...record.commits, ...commitsSignedOverRecordPromises(record, answered).kept }).length;
		return commits >= needed || commits + outstanding < needed;
	};
}

/**
 * What the consensus broadcast knows of this node's own member before any remote member answers: it is
 * delivered first, awaited, so its verdict is in hand. `mayYetHold` is a member that applied without
 * holding, which the second reconcile after the broadcast can still make a holder.
 */
export interface LocalHolding {
	holds: boolean;
	mayYetHold: boolean;
}

/**
 * The consensus broadcast's rule, counted with {@link isDurableMajority} over `record.peers`: decided once
 * the holders reach a strict majority, and out of reach once the possible holders could not. A holder is
 * this node's member when `local.holds`, and each remote member whose latest report — its answer to this
 * broadcast, else `record.applyOutcomes` — says it holds the record ({@link holdsRecord}). The possible
 * holders add every outstanding member, and this node's member when `local.mayYetHold`.
 */
export function broadcastDecided(record: ClusterRecord, selfId: string | undefined, local: LocalHolding): RoundDecided {
	const cohort = Object.keys(record.peers);
	return (answered, outstanding) => {
		const latest = { ...record.applyOutcomes, ...collectApplyOutcomes(answered) };
		const remoteHolders = cohort.filter(peerId => peerId !== selfId && holdsRecord(record.message, latest[peerId])).length;
		const holders = remoteHolders + (local.holds ? 1 : 0);
		const possible = holders + outstanding + (local.mayYetHold ? 1 : 0);
		return isDurableMajority(holders, cohort.length) || !isDurableMajority(possible, cohort.length);
	};
}
