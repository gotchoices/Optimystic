/**
 * Cohort-topic substrate — bootstrap evidence policy (anti-DoS).
 *
 * Transcribed from `docs/cohort-topic.md` §Anti-DoS bullet 4. A cold root that accepts a
 * `bootstrap: true` registration must demand evidence, so a cold topic cannot be instantiated for
 * free by an attacker. The accepted evidence is **tier-dependent**:
 *
 * - **T0 / T1** — generally no proof-of-work, because these tiers correspond to committed work; a
 *   *signed reference to a committed parent topic that does exist* is sufficient.
 * - **T2 / T3** — a **proof-of-work** OR a **reputation-score signature** (a signature from a peer
 *   with sufficient reputation, see `architecture.md` §Reputation) OR a **signed parent-topic
 *   reference**.
 *
 * This module is the *policy* — which evidence kinds satisfy which tier. The cryptographic checks
 * themselves (verifying a PoW, a reputation signature, a parent-topic reference) are injected, keeping
 * db-core free of any specific PoW/reputation scheme (the same injection discipline as the threshold
 * crypto port). The evidence travels in the registration's dedicated, signature-covered
 * `bootstrapEvidence` field — a versioned `BootstrapEvidenceEnvelopeV1`
 * (`./bootstrap-evidence-envelope.js`), parsed crypto-free here and checked by the injected verifiers;
 * NOT the opaque `appPayload` slot (which the cohort copies verbatim into the registration's appState).
 * A registration that is not a bootstrap needs no evidence and is admitted.
 */

import type { RegisterV1 } from "../wire/types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("cohort-topic:antidos");

/** Tiers at/below this need no proof-of-work — a signed parent reference suffices (T0/T1). */
export const DEFAULT_MAX_NO_POW_TIER = 1;

export interface BootstrapEvidenceDeps {
	/** Verify a proof-of-work attached to `reg` (T2/T3 path). Absent → PoW is never satisfiable. */
	verifyPoW?: (reg: RegisterV1) => boolean;
	/** Verify a sufficient-reputation signature on `reg` (T2/T3 path). Absent → never satisfiable. */
	verifyReputation?: (reg: RegisterV1) => boolean;
	/** Verify a signed reference to an existing committed parent topic (all tiers). Absent → never satisfiable. */
	verifyParentReference?: (reg: RegisterV1) => boolean;
	config?: BootstrapEvidenceConfig;
}

export interface BootstrapEvidenceConfig {
	/** Highest tier exempt from proof-of-work (T0/T1 → 1). Default {@link DEFAULT_MAX_NO_POW_TIER}. */
	maxNoPowTier?: number;
}

/** Tier-dependent bootstrap-evidence gate for cold-root registrations. */
export interface BootstrapEvidence {
	/**
	 * Whether `reg` carries acceptable bootstrap evidence for `tier`. A non-bootstrap registration is
	 * always acceptable (nothing to prove). For a bootstrap: T0/T1 require a signed parent reference;
	 * T2/T3 accept proof-of-work OR a reputation signature OR a signed parent reference.
	 */
	verify(reg: RegisterV1, tier: number): boolean;
}

class TieredBootstrapEvidence implements BootstrapEvidence {
	private readonly maxNoPowTier: number;
	private readonly verifyPoW: (reg: RegisterV1) => boolean;
	private readonly verifyReputation: (reg: RegisterV1) => boolean;
	private readonly verifyParentReference: (reg: RegisterV1) => boolean;

	constructor(deps: BootstrapEvidenceDeps = {}) {
		this.maxNoPowTier = deps.config?.maxNoPowTier ?? DEFAULT_MAX_NO_POW_TIER;
		this.verifyPoW = deps.verifyPoW ?? ((): boolean => false);
		this.verifyReputation = deps.verifyReputation ?? ((): boolean => false);
		this.verifyParentReference = deps.verifyParentReference ?? ((): boolean => false);
	}

	verify(reg: RegisterV1, tier: number): boolean {
		if (reg.bootstrap !== true) {
			return true; // only a cold-root bootstrap must carry evidence
		}
		if (tier <= this.maxNoPowTier) {
			// T0/T1: a signed reference to a committed parent topic is sufficient (no PoW expected).
			const ok = this.verifyParentReference(reg);
			if (!ok) {
				log("bootstrap-evidence reject: tier=%d needs a signed parent reference", tier);
			}
			return ok;
		}
		// T2/T3: any one of PoW, a reputation signature, or a signed parent reference.
		const ok = this.verifyPoW(reg) || this.verifyReputation(reg) || this.verifyParentReference(reg);
		if (!ok) {
			log("bootstrap-evidence reject: tier=%d needs PoW / reputation / parent reference", tier);
		}
		return ok;
	}
}

/** Build a {@link BootstrapEvidence} policy over the injected (db-p2p-supplied) evidence verifiers. */
export function createBootstrapEvidence(deps: BootstrapEvidenceDeps = {}): BootstrapEvidence {
	return new TieredBootstrapEvidence(deps);
}
