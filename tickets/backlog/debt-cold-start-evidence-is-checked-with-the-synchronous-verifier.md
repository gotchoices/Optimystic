description: The first machine to register for a topic attaches proof that it is entitled to start it, and checking that proof still uses the slow pure-JavaScript signature routine, even when a machine is checking its own proof. Opening many watches on a phone pays for this on the JavaScript thread.
architecture: docs/cohort-topic.md#anti-dos
files: packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts (`createReputationVerifier`), packages/db-p2p/src/cohort-topic/bootstrap-parent-reference.ts, packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts, packages/db-core/src/cohort-topic/member-engine.ts (`runGuards`), packages/db-p2p/src/cohort-topic/host.ts (`dispatchRegister`, `handleRegisterFrame`)
prereq: cohort-topic-register-and-renew-are-verified-off-the-synchronous-path
tradeoffs: It runs only when a topic starts up, never on an idle group, and it saves nothing per check on a phone with no native Ed25519, so it may not be worth changing the evidence port until a device profile shows this share matters.
----

`cohort-topic-register-and-renew-are-verified-off-the-synchronous-path` moves the participant's register signature to the platform verifier, but leaves the cold-start evidence check where it is: `runGuards` calls the synchronous `bootstrapEvidence.verify`, and at the T2 and T3 tiers that verifies a self-endorsement signature with `verifyPeerSig` (`createReputationVerifier`). That ticket's scope kept this port unless it was on an idle path, and it is not.

**Measured on Node, not Hermes.** Two real nodes, each with a key, both opening watches on the same 6 collections: 18 register signature checks and 6 evidence checks, one evidence check per topic that started cold. Over the following 375 s or so of idle there were none. All 6 evidence checks were a node checking its own frame, in process.

Two separate savings are available, and the first is the cheaper:

- A register this node sent to itself (origin `"self"` in `handleRegisterFrame`, added by the prerequisite ticket) has an endorsement this process just signed, so it needs no signature check. It would still need the referee's ban and score check, which is synchronous and cheap.
- A register from another machine could have its endorsement checked with `verifyPeerSigAsync` in the host before the engine, as the register signature now is. The evidence policy is tier-routed and chooses between proof of work, a parent reference and an endorsement, so the host would need to know which envelope a frame carries without duplicating that policy.

Expected: opening a watch performs no noble verification on a node with a key, except for the kinds of evidence that genuinely cannot be checked asynchronously (name them, if any). An unbacked or forged endorsement is still refused at every tier, and a `followOn` register is still held to the same evidence as a `bootstrap` one.
