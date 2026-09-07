import { DEFAULT_SUPER_MAJORITY_THRESHOLD, type ClusterConsensusConfig, type UnvalidatablePendPolicy } from "@optimystic/db-core";
import { createLogger } from "../logger.js";
import { CORROBORATION_FLOOR } from "./quorum-restore.js";

const log = createLogger('cluster-policy');

/**
 * Resolves the operator-facing cluster knobs (`clusterSize`, `clusterPolicy.*`) into the concrete
 * numbers the consensus and block-restoration paths run on.
 *
 * Extracted from `createLibp2pNodeBase` rather than left inline so the composition root's defaults
 * are assertable without booting a libp2p node — the layer a real deployment actually uses, and
 * therefore the layer where a default that relaxed the repair corroboration floor to a single voter
 * survived unnoticed (see `test/cluster-policy.spec.ts`).
 *
 * ## Why two size yardsticks, not one
 *
 * `clusterPolicy.assumedClusterSize` — "the smallest cohort this deployment can genuinely field" —
 * feeds two consumers whose failure modes point in opposite directions, so its *default* cannot
 * serve both:
 *
 * - **Membership admission gate** (`cluster/cluster-repo.ts`, `admitMembership`) reads it only on its
 *   fallback path, when this node has no confident network-size estimate. Too small: a
 *   partition-induced downsize slips past while the node is unconfident. Too large: the node refuses
 *   legitimate writes — unavailability. It wants a *permissive* default, because an unconfigured
 *   two-node mesh must still be able to transact. It gets {@link minAbsoluteClusterSize} (2).
 * - **Repair corroboration floor** (`corroboratorCapacity` in `cluster/quorum-restore.ts`, called by
 *   `CoordinatorRepo.queryClusterForLatest` and `createReconcileBlock`) reads it on *every* repair,
 *   unconditionally — as the *fallback* for its own field, below. Too small: a shrunken — and always
 *   unauthenticated — cohort view buys a lone peer full trust. Too large: a block stays unrepaired,
 *   degraded rather than dead. It wants a *strict* default. It gets
 *   {@link ResolvedClusterPolicy.repairCorroborationClusterSize}, which falls back in turn to
 *   `clusterSize` (the configured replication factor).
 *
 * ## The two operator fields
 *
 * `clusterPolicy.repairCorroborationClusterSize` declares the **repair yardstick alone**, leaving the
 * admission gate at its permissive default. `clusterPolicy.assumedClusterSize` remains the shared
 * field and still sets BOTH — an operator declaring their real cohort size usually means it for both
 * consumers — but it is now the *fallback* for the repair yardstick, not its only declared source.
 * The repair yardstick is therefore fully declarable on its own.
 *
 * The split exists because the two directions cost different things. Raising the repair yardstick is
 * a pure tightening: the worst outcome is a block that stays unrepaired. Raising the admission
 * yardstick trades write availability — a node with no confident network-size estimate demands
 * `ceil(membershipAdmissionFraction x assumedClusterSize)` declared peers and refuses writes below
 * that. A host that knows its real machine count and wants only the strict yardstick raised (so a
 * shrunken, unauthenticated cohort view cannot talk repair down to trusting one peer) declares
 * `repairCorroborationClusterSize` and leaves `assumedClusterSize` alone.
 *
 * So a genuine two-node mesh needs exactly one setting to self-repair: any of
 * `clusterPolicy.repairCorroborationClusterSize: 2`, `clusterPolicy.assumedClusterSize: 2` (neither
 * of which lowers the replication factor), or an honest `clusterSize: 2`. Writes and voting still
 * work with zero configuration.
 *
 * ## Future
 *
 * Deriving the yardstick from observation (the largest peer group this node has ever seen for the
 * key) would remove the trade entirely and subsume both values. Filed as backlog
 * `feat-admission-floor-from-observed-cohort-high-water-mark`; do not build it here.
 */

/**
 * Absolute floor below which no cohort is safe, whatever the size references say. Named rather than
 * inlined because the admission gate's `assumedClusterSize` defaults to exactly this value — the two
 * must not drift.
 */
export const minAbsoluteClusterSize = 2;

/**
 * Default replication factor / target cohort breadth when the operator declares no `clusterSize`.
 *
 * Exported (and re-exported from the package root) rather than left inline because a caller that
 * must construct a `Libp2pKeyPeerNetwork` for a node it did not build has to state a cluster size —
 * the constructor no longer supplies one — and the only defensible answer is "whatever a node built
 * here would have resolved to". Repeating the literal is how the two drifted last time.
 */
export const DEFAULT_CLUSTER_SIZE = 10;

/**
 * The operator-facing cluster knobs. `NodeOptions` (`libp2p-node-base.ts`) intersects this rather
 * than restating it, so a knob added here is one `resolveClusterPolicy` is guaranteed to see — a
 * second declaration would compile fine and be silently dropped.
 */
export interface ClusterPolicyOptions {
	/**
	 * Desired cluster size per key (default 10) — the replication factor / target cohort breadth
	 * the coordinator aims for. NOT a statement about how many peers actually exist, so the
	 * membership admission gate is never measured against it (see `cluster/cluster-repo.ts`).
	 *
	 * The read-repair/reconcile corroboration floor DOES fall back to it — last in the chain
	 * `clusterPolicy.repairCorroborationClusterSize` -> `clusterPolicy.assumedClusterSize` ->
	 * `clusterSize` — the strict direction, so an unconfigured node cannot have its floor talked down
	 * by a shrunken cohort view. A deployment that genuinely runs fewer peers than this should declare
	 * one of those two `clusterPolicy` fields.
	 */
	clusterSize?: number;
	clusterPolicy?: {
		allowDownsize?: boolean;
		/** Acceptable relative difference (e.g. 0.5 = +/-50%). */
		sizeTolerance?: number;
		/** Fraction of peers needed for super-majority (default {@link DEFAULT_SUPER_MAJORITY_THRESHOLD}). */
		superMajorityThreshold?: number;
		/**
		 * Opt in to transacting below the safe cluster-size floor when FRET has no confident
		 * network-size estimate — the membership-admission and coordinator small-cluster gates both
		 * fail closed without it. Default false. Turn on only for single-node / local dev meshes that
		 * knowingly run undersized.
		 */
		allowUnvalidatedSmallCluster?: boolean;
		/**
		 * The smallest cohort this deployment can genuinely field — normally the number of nodes you
		 * actually run, capped at `clusterSize`. Two consumers read it: the membership admission gate,
		 * on its fallback path when the node has no confident network-size estimate; and the
		 * read-repair/reconcile corroboration floor (`corroboratorCapacity`), unconditionally.
		 *
		 * Declaring it sets BOTH. Leaving it unset does NOT — see the module doc for why the two
		 * defaults point in opposite directions. A large deployment should still set this to its real
		 * cohort size, otherwise the admission gate cannot police a partition-induced downsize while
		 * its size estimate is unconfident; a genuine two-node mesh needs it (or an honest
		 * `clusterSize: 2`) to self-repair.
		 */
		assumedClusterSize?: number;
		/**
		 * The cohort size the **repair corroboration floor alone** is measured against
		 * (`corroboratorCapacity` in `cluster/quorum-restore.ts`, read on every read-repair and every
		 * reconcile). Declaring it is a pure tightening: the worst cost of overstating it is a block
		 * that stays unrepaired — degraded, not dead.
		 *
		 * Deliberately does NOT touch {@link assumedClusterSize}, which is the membership admission
		 * gate's low-confidence write floor: raising that one can make a node refuse legitimate writes
		 * while its network-size estimate is unconfident. A host that derives its machine count from
		 * its own authenticated membership records and wants only the strict yardstick raised declares
		 * this field. It also does not touch {@link ClusterPolicyOptions.clusterSize} (the replication
		 * factor).
		 *
		 * Wins over `assumedClusterSize` for the repair yardstick when both are declared; when absent
		 * the chain falls through to `assumedClusterSize`, then to `clusterSize`. A value above
		 * `clusterSize` is accepted and never raises the corroboration requirement (capped at
		 * `CORROBORATION_FLOOR`), but it is not free: it is also the denominator
		 * `CoordinatorRepo.commitQuorumRulesOutRivals` measures a local commit against before arming
		 * the lazy read-repair freshness window, so a yardstick well above the cohort a commit
		 * actually reaches stops that window arming and costs one cohort consult per written block
		 * per window. Declare the machine count you run, not a safety margin.
		 *
		 * Applied at node construction only — there is deliberately no runtime setter. A host that
		 * learns a new machine count applies it by building a new node; see the accepted-tradeoff
		 * `NOTE:` in {@link resolveClusterPolicy}.
		 */
		repairCorroborationClusterSize?: number;
		/**
		 * What a validator-configured member does with a pend that carries no `validation` payload
		 * (nothing to re-execute — the single-collection `Collection.sync` shape). Default 'accept';
		 * see {@link UnvalidatablePendPolicy}.
		 */
		unvalidatablePendPolicy?: UnvalidatablePendPolicy;
	};
}

/** Everything a node's consensus + restoration paths need, with every default already applied. */
export type ResolvedClusterPolicy = ClusterConsensusConfig & {
	/** Replication factor / target cohort breadth. Always concrete after resolution. */
	clusterSize: number;
	/**
	 * Yardstick the repair corroboration floor measures a (possibly shrunken, always unauthenticated)
	 * cohort view against — see `corroboratorCapacity` in `cluster/quorum-restore.ts`.
	 *
	 * Deliberately distinct from {@link ClusterConsensusConfig.assumedClusterSize}, which the
	 * membership admission gate reads: over- and under-stating the two cost opposite things, so they
	 * share neither a default nor — since `clusterPolicy.repairCorroborationClusterSize` — a required
	 * operator field. See the module doc.
	 */
	repairCorroborationClusterSize: number;
};

/**
 * A declared cohort size, or `undefined` if the operator handed over something that is not one.
 *
 * `Number.isInteger` already rejects `NaN`, both infinities and every fractional value, so the extra
 * check is only the sign. Used for both declared size fields in the repair yardstick's fall-through
 * chain — see the `NOTE:` in {@link resolveRepairCorroborationClusterSize} for why a bad value falls
 * through rather than being clamped.
 */
export function asDeclaredSize(value: number | undefined): number | undefined {
	return Number.isInteger(value) && (value as number) > 0 ? value : undefined;
}

/**
 * The repair corroboration floor's yardstick, from the two operator fields and the replication
 * factor: `repairCorroborationClusterSize` -> `assumedClusterSize` -> `clusterSize`, floored at
 * {@link minAbsoluteClusterSize}.
 *
 * Exported because there are TWO composition paths onto this number — {@link resolveClusterPolicy}
 * (what `createLibp2pNodeBase` runs) and the `CoordinatorRepo` constructor (the readme's manual
 * wiring, `repo/coordinator-repo.ts`) — and a node and a hand-wired coordinator given the same
 * operator numbers must land on the same yardstick, or the two disagree about how much trust a lone
 * peer gets. One function rather than two copies of the chain, so they cannot drift.
 *
 * NOTE: a declared size that is not a positive finite integer is treated as NOT DECLARED and falls
 * through to the next term, rather than being clamped. Clamping to {@link minAbsoluteClusterSize}
 * would be the UNSAFE direction: 2 is the one size whose corroboration floor relaxes to a single
 * voter, so a NaN — which today makes every quorum comparison false, and therefore declines repair
 * forever, dead but safe — would become "trust one peer". Falling through treats a nonsense
 * declaration as no declaration and lands on the strict `clusterSize` default instead.
 *
 * NOTE: the result is deliberately NOT floored at {@link minAbsoluteClusterSize}. Such a floor looks
 * free — it cannot change the corroboration requirement, since `quorumSize` takes
 * `max(1, min(CORROBORATION_FLOOR, capacity))` and `corroboratorCapacity`'s own max against visible
 * peers absorbs the difference at every peer count — but this number has a SECOND consumer:
 * `CoordinatorRepo.commitQuorumRulesOutRivals` uses it as the full-cohort denominator a local commit
 * must beat to arm the lazy read-repair freshness window. Flooring a genuine `clusterSize: 1` up to 2
 * makes a solo node's own commit stop clearing that bar, so every written block pays a cohort consult
 * per window — a real cost in a supported topology (one machine is an ordinary deployment size, see
 * `docs/architecture.md`). Pinned by 'a solo commit on a genuine cohort of one DOES arm the window'
 * in `test/coordinator-repo-commit-freshness.spec.ts`.
 */
export function resolveRepairCorroborationClusterSize(
	declaredRepairSize: number | undefined,
	declaredCohortSize: number | undefined,
	clusterSize: number
): number {
	return asDeclaredSize(declaredRepairSize) ?? asDeclaredSize(declaredCohortSize) ?? clusterSize;
}

/**
 * Apply every cluster-policy default a node needs. Same options in, same numbers out, so the
 * composition root's behavior is unit-testable (`test/cluster-policy.spec.ts`). Its one side effect
 * is the `repair-fault-tolerance` advisory below, which lives here because this is the only place
 * that knows the resolution produced a combination with no repair margin — or none at all.
 */
export function resolveClusterPolicy(options: ClusterPolicyOptions): ResolvedClusterPolicy {
	// Nothing usable on EITHER declared field means "the operator said nothing", which is the only
	// case where the two yardsticks below diverge. Why a degenerate declaration counts as nothing
	// rather than being clamped: see the `NOTE:` on `resolveRepairCorroborationClusterSize`.
	//
	// The ADMISSION-gate value below stays an unvalidated pass-through on purpose:
	// `cluster-repo.admissionFloor` already floors a degenerate one itself (see its specs), and
	// changing that here would alter documented behaviour with no bug behind it.
	//
	// NOTE: accepted tradeoff — resolved once, at node construction; there is deliberately no runtime
	// mutation of either size yardstick. A host that learns a new machine count applies it by building
	// a new node (which every embedder already does on restart and on wake from hibernation), not
	// through a setter: a construction-time argument is what keeps the number un-reachable from the
	// network, and every consumer holds it as an immutable snapshot. Weighed against a
	// live-reconfiguration API and kept. Revisit only if a deployment appears where a rebuild is
	// measurably disruptive — for example a server-profile node holding thousands of blocks whose
	// post-rebuild cohort-consult burst shows up in profiles.
	const declaredCohortSize = options.clusterPolicy?.assumedClusterSize;
	const declaredRepairSize = options.clusterPolicy?.repairCorroborationClusterSize;
	const clusterSize = options.clusterSize ?? DEFAULT_CLUSTER_SIZE;
	const repairCorroborationClusterSize =
		resolveRepairCorroborationClusterSize(declaredRepairSize, declaredCohortSize, clusterSize);

	// ## What the advisory actually claims, and why the trigger is what it is
	//
	// The rule it states is measurable, not rhetorical: sweep `corroboratorCapacity` and `quorumSize`
	// over real cohort sizes and every configuration lands on the same requirement — **2 cohort peers
	// BESIDES the reader must answer that reader and agree on the same (rev, actionId)**, relaxed to 1
	// only for a cohort DECLARED smaller than three. Two consequences follow, and both are worth
	// saying out loud because both surprised people in the field:
	//
	//  - Fewer than three machines, undeclared, can never repair at all: the floor of two never
	//    relaxes, because `repairCorroborationClusterSize` falls back to `clusterSize` (default 10).
	//  - Exactly three machines is the MINIMUM that can ever repair, not a size at which repair is
	//    safe. The reader has exactly two peers and needs both, so a single peer unreachable FROM THAT
	//    READER — perfectly healthy and reachable from everybody else — leaves that reader's copy
	//    permanently unrepairable. Four machines is the first size with any margin.
	//
	// Both of those are claims about MACHINES, and the advisory used to stop there — which made it
	// wrong in the operator's favour, because a machine count is only half the requirement. The peers
	// that answer must also HOLD the block, and two of them must. A block only ONE cohort peer holds
	// cannot be repaired at any deployment size whatsoever: the sole holder cannot second itself, and
	// the two mechanisms that would give a second peer a copy (read-repair and reconcile) both consume
	// this same decision. So an operator at four-plus machines reading "the first size with any margin"
	// could believe they were covered while a block written when the deployment was smaller stayed
	// stranded at one copy forever. The advisory now says so; the per-block half is
	// `cluster-fetch:repair-deadlock` with `reason: 'sole-holder'` (`CoordinatorRepo`), and the
	// behavioural fix — replicating owned blocks once the cohort grows — is separate work.
	//
	// So the trigger is a union of two conditions, not one:
	//
	//  - **undeclared** (the original case): the operator has asserted nothing, so a deployment
	//    smaller than three would be silently unrepairable. Conditional wording ("if you run fewer
	//    than N machines"), never a fault — this fires off configuration, not an observed cohort, so a
	//    correctly-provisioned large deployment sees it too.
	//  - **resolved cohort <= CORROBORATION_FLOOR + 1**, whether declared or not. Declaring
	//    `assumedClusterSize: 3` does not conjure a third peer; it has exactly the same zero tolerance
	//    as an undeclared three. The earlier "a declaration is an explicit assertion we cannot
	//    contradict" reasoning holds for whether the NUMBER is honest — it does not hold for the
	//    fragility implied by the number itself, which is arithmetic.
	//
	// Still one line per node construction (`resolveClusterPolicy` runs once), never per repair: a
	// per-attempt warn on a busy node is noise that gets filtered, which defeats the point. The
	// per-repair half of this — naming a decline that is provably permanent — lives at the repair site
	// instead (`CoordinatorRepo.reportRepairDeadlock`, `cluster-fetch:repair-deadlock`), where the
	// actual cohort is known.
	//
	// NOTE: an operator who declares an assumedClusterSize LARGER than the cohort they actually run is
	// equally unable to repair and still gets no fault — this function has no observed cohort to
	// contradict the declaration with, and the undeclared arm's conditional wording is the closest it
	// can honestly get. If `feat-admission-floor-from-observed-cohort-high-water-mark` ever lands
	// (deriving the yardstick from observation), that check becomes cheap and belongs here.
	const minimumSelfHealingDeployment = CORROBORATION_FLOOR + 1;
	// BOTH operator fields must be absent for this arm: declaring only
	// `repairCorroborationClusterSize` is still a declaration, and `undeclaredAdvice` below would
	// otherwise tell a reader who has already declared the repair yardstick directly to go and declare
	// it — the wrong advice, pointed at the wrong field.
	//
	// "Absent" is the SANITIZED notion, the same one the resolution above uses: a declaration the
	// resolution discarded as degenerate (0, NaN, 2.5, …) must not count as a declaration here
	// either. It is the case that most needs the advice — the operator believes they declared a size,
	// the resolution silently used `clusterSize` instead, and without this the advisory's
	// no-margin arm cannot fire either (the strict fallback has margin), so a typo'd declaration
	// would be QUIETER than declaring nothing at all. The raw values still reach the log payload
	// below, so a reader can see what was rejected.
	const cohortUndeclared = asDeclaredSize(declaredCohortSize) === undefined
		&& asDeclaredSize(declaredRepairSize) === undefined
		&& clusterSize > minAbsoluteClusterSize;
	const noRepairMargin = repairCorroborationClusterSize <= minimumSelfHealingDeployment;
	if (cohortUndeclared || noRepairMargin) {
		// How many peers besides the reader must answer and agree, at the resolved size. Two once the
		// cohort is three or larger; one for a cohort declared at two, which is the only size whose
		// floor relaxes. Never below one — a claim nobody made is never accepted.
		const requiredAnsweringPeers = Math.max(1, Math.min(CORROBORATION_FLOOR, repairCorroborationClusterSize - 1));
		// NOTE: a genuine solo node (`clusterSize: 1`, nothing declared) reads "0 cohort peer(s) and
		// needs 1" and is told to run four machines — honest arithmetic, but advice aimed at a
		// deployment that wanted a cohort. A solo node has nothing to repair FROM and nothing to
		// repair against, so the line is noise rather than wrong. Left as is because one machine is a
		// transitional shape (the ordinary next step is adding a backup) and the advisory is one line
		// per construction. If solo becomes a shape deployments sit in, give this a solo-cohort arm
		// that says so — do NOT reach for a floor on `repairCorroborationClusterSize` instead, which
		// would fix the wording and break the commit-freshness window (see
		// `resolveRepairCorroborationClusterSize`).
		const availablePeers = Math.max(0, repairCorroborationClusterSize - 1);
		const rule =
			`Block repair (read-repair and reconcile) converges only when ${CORROBORATION_FLOOR} cohort peers ` +
			`BESIDES the reader answer that reader and agree on the same (rev, actionId); that requirement drops ` +
			`to 1 only for a cohort that DECLARES it is smaller than ${minimumSelfHealingDeployment}. ` +
			`${minimumSelfHealingDeployment} machines is therefore the MINIMUM that can repair at all, not a safe ` +
			`size — at exactly ${minimumSelfHealingDeployment} the reader has two peers and needs both, so one ` +
			`peer unreachable from that reader (healthy and reachable from everyone else) leaves that reader's ` +
			`copy permanently unrepairable. ${minimumSelfHealingDeployment + 1} machines is the first size with ` +
			`any margin.`;
		// Every number above counts MACHINES. Saying only that overstates the guarantee, because repair
		// also needs the answering peers to actually HOLD the block — which is a property of the block,
		// not of the deployment, and which no machine count can supply.
		//
		// NOTE: accepted tradeoff — the caveat rides the EXISTING trigger (cohort size undeclared, or
		// repairCorroborationClusterSize <= 3) rather than firing for every deployment. A correctly-
		// declared large deployment is arguably the operator most likely to believe a machine count
		// covers them, and never sees this paragraph at startup; they learn it from the per-block
		// `cluster-fetch:repair-deadlock` line with reason=sole-holder instead. Weighed and kept: a
		// startup advisory that fires on every correctly-configured node forever is one operators
		// filter, which costs more than it buys. Revisit if the per-block line proves too late to be
		// useful — i.e. if field reports show operators hitting stranded founding data without ever
		// having read a repair-deadlock line.
		const holdersCaveat =
			` All of that counts MACHINES, and machines are only half the requirement: the peers that answer ` +
			`must also HOLD the block, and ${CORROBORATION_FLOOR} of them must. A block that only ONE cohort ` +
			`peer holds can never be repaired at ANY deployment size — the sole holder cannot second itself — ` +
			`so every size claim above is about a block at least ${CORROBORATION_FLOOR} peers already hold. ` +
			`The usual way to fall outside that: data written while the deployment (or that block's cohort) ` +
			`was smaller keeps the number of copies it was written with, and GROWING THE DEPLOYMENT DOES NOT ` +
			`COPY IT — so founding data can stay stranded however many machines you later run. That case is ` +
			`reported once per affected block as cluster-fetch:repair-deadlock with reason=sole-holder, and its ` +
			`remedy is another cohort peer holding it (commit a new revision of the block), never more machines.`;
		// Names the discarded value when the operator DID pass something the resolution rejected —
		// otherwise "no size declared" reads as a contradiction of their own config, and they have no
		// way to tell that the number they computed never took effect.
		const discardedDeclaration = cohortUndeclared && (declaredCohortSize !== undefined || declaredRepairSize !== undefined)
			? ` (a declared value that is not a positive whole number is discarded and counts as no ` +
			`declaration — this node discarded assumedClusterSize=${String(declaredCohortSize)}, ` +
			`repairCorroborationClusterSize=${String(declaredRepairSize)})`
			: '';
		const undeclaredAdvice = cohortUndeclared
			? ` No clusterPolicy.assumedClusterSize declared, and no clusterPolicy.repairCorroborationClusterSize ` +
			`either${discardedDeclaration}, so the floor is measured against ` +
			`repairCorroborationClusterSize=${repairCorroborationClusterSize} and never relaxes: if you actually ` +
			`run fewer than ${minimumSelfHealingDeployment} machines, every proof-less repair declines, ` +
			`permanently. Either field declares your real cohort size and fixes this: ` +
			`clusterPolicy.repairCorroborationClusterSize moves ONLY this repair yardstick, while ` +
			`clusterPolicy.assumedClusterSize moves it AND the membership admission gate's write floor (which ` +
			`refuses writes below ceil(0.75 x the declared size) while this node has no confident network-size ` +
			`estimate) — so declare the repair field alone unless you mean to raise the write floor too. ` +
			`Neither lowers clusterSize=${clusterSize} (the replication factor). Larger deployments can ignore ` +
			`this.`
			: '';
		// The rule and both advices above constrain proof-LESS claims only — without saying so the
		// advisory overstates the emergency: an operator reading "every repair declines, permanently"
		// would not guess that proof-carrying data is exempt, nor that the cohort-too-small decline is
		// now quiet. It must not overshoot in the other direction either: `sole-holder` is equally
		// permanent and deliberately stays loud, so name WHICH decline went quiet, and for which blocks.
		const certifiedCaveat =
			` Two softeners to all of the above. A claim carrying a VERIFIED cohort commit proof repairs at any ` +
			`size with no second voter (the proof's signature set is its corroboration), so every permanent-` +
			`decline warning here applies to PROOF-LESS data only — legacy blocks written before proofs ` +
			`shipped, or a peer that lost its proof store. And the decline this advisory is about — ` +
			`reason=cohort-too-small, a cohort that cannot reach the quorum at any answer rate — no longer ` +
			`consults on every read: it arms the lazy read-repair window, so the steady-state cost is one ` +
			`declined consult per readRepairWindowMs for each block this node HOLDS, with the permanence named ` +
			`once per episode (cluster-fetch:repair-deadlock). Two shapes still consult on every read, by ` +
			`design: reason=sole-holder, where the missing thing is a COPY a later commit or cohort-growth ` +
			`push can deliver, so re-asking can genuinely learn; and a block this node does not hold at all, ` +
			`whose read must attempt an acquisition and therefore bypasses the window.`;
		const noMarginAdvice = noRepairMargin
			? ` This node resolved repairCorroborationClusterSize=${repairCorroborationClusterSize}, which leaves ` +
			`repair with NO fault tolerance: the reader has ${availablePeers} cohort peer(s) and needs ` +
			`${requiredAnsweringPeers} of them to answer, so losing one is not survivable. Run at least ` +
			`${minimumSelfHealingDeployment + 1} machines if repair must survive an unreachable peer.`
			: '';
		log('repair-fault-tolerance', {
			clusterSize,
			repairCorroborationClusterSize,
			corroborationFloor: CORROBORATION_FLOOR,
			declaredCohortSize,
			// Beside declaredCohortSize so a reader can tell WHICH field produced the resolved number
			// (the repair field wins when both are declared).
			declaredRepairSize,
			cohortUndeclared,
			noRepairMargin,
			requiredAnsweringPeers,
			minimumSelfHealingDeployment,
			message: rule + undeclaredAdvice + noMarginAdvice + certifiedCaveat + holdersCaveat
		});
	}

	return {
		superMajorityThreshold: options.clusterPolicy?.superMajorityThreshold ?? DEFAULT_SUPER_MAJORITY_THRESHOLD,
		simpleMajorityThreshold: 0.51,
		minAbsoluteClusterSize,
		allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
		clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5,
		// Fail closed by default (an undersized cluster with no confident network-size estimate is
		// rejected); embedders running knowingly-small meshes opt in through clusterPolicy.
		allowUnvalidatedSmallCluster: options.clusterPolicy?.allowUnvalidatedSmallCluster ?? false,
		// Pass through undefined (ClusterMember defaults it to 'accept') so an operator who said
		// nothing gets the historical behaviour.
		unvalidatablePendPolicy: options.clusterPolicy?.unvalidatablePendPolicy,
		partitionDetectionWindow: 60000,
		// Replication factor / target cohort breadth — what the coordinator aims for when selecting a
		// cohort. Deliberately NOT the membership admission gate's yardstick: it says nothing about how
		// many peers actually exist, so an unconfigured small mesh would refuse every write.
		clusterSize,
		// Membership admission gate, fallback path only (no confident network-size estimate). Defaults
		// permissive so a two- or three-node mesh transacts unconfigured; the cost of that default is
		// bounded to the gate, since the repair floor no longer reads this field.
		assumedClusterSize: declaredCohortSize ?? minAbsoluteClusterSize,
		// Repair corroboration floor, every repair. Declared by `repairCorroborationClusterSize`, else
		// `assumedClusterSize`, else strict — the replication factor — so an unconfigured node cannot
		// have its floor talked down to a single voter by a shrunken cohort view. A genuinely small
		// mesh declares its size (any of the three) to regain self-repair.
		repairCorroborationClusterSize
	};
}
