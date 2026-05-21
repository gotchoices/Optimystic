# Circuit-relay trusted-limits + dial-log changes — follow-up review

description: code review pass over the libp2p / reference-peer changes that landed in commit c78f85a alongside the cohort-topic-traffic-signal doc edits. Those changes were not part of that ticket's scope (which was explicitly "doc-only — no source files touched") and so received no targeted review. They appear legitimate but need confirmation that the relay-limit lift is safe, the dial-log enhancement doesn't leak secrets, and there are no consumer-side regressions.
files:
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/protocol-client.ts
  - packages/reference-peer/src/cli.ts
  - packages/db-p2p/test/circuit-relay-long-lived.spec.ts  (untracked at HEAD — the implement agent wrote it but never `git add`'d it; review-stage chose not to add it under the cohort-topic slug; this ticket should review the spec and commit it under its proper ticket)
----

## What landed unreviewed

Commit `c78f85a` ("ticket(implement): cohort-topic-traffic-signal") was supposed to be doc-only — the implement ticket said: *"No code changes anywhere"* and *"No source files, schemas, or tests were touched (the cohort-topic layer has no implementation code yet)"*. The commit nonetheless includes three source edits unrelated to the cohort-topic-traffic-signal design:

### 1. `packages/db-p2p/src/libp2p-node-base.ts`

Adds an optional `relayServerInit?: CircuitRelayServerInit` to `NodeOptions` and threads it through to `circuitRelayServer(...)` in the libp2p services map. JSDoc explains that `@libp2p/circuit-relay-v2` defaults to `applyDefaultLimit: true`, stamping every reservation with `Limit { data: 128 KiB, duration: 2 min }` and silently killing long-lived service↔browser circuits. The hook lets trusted cluster nodes pass `{ reservations: { applyDefaultLimit: false } }` to lift the cap.

### 2. `packages/db-p2p/src/protocol-client.ts`

Enhances the `dial:fail` debug log to include the error `code` and a truncated `message` (200 chars). Previously logged only `peer`, `protocol`, `ms`, `cid`.

### 3. `packages/reference-peer/src/cli.ts`

Passes `{ reservations: { applyDefaultLimit: false } }` as `relayServerInit` when `effectiveRelay` is enabled, and prints `🔁 Circuit-relay limits: disabled (reference-peer trusted)`. Justifies the lift as "reference-peer trusted local-cluster relays" and says it's needed so "service↔browser circuits survive a full e2e run."

## Why this needs a follow-up pass

The changes look reasonable on their face, but they bypassed the normal `plan → implement → review` flow:

- **Scope discipline.** The cohort-topic-traffic-signal ticket explicitly disclaimed code changes. Anyone reading the implement-stage commit message would not expect to find libp2p service config or protocol-client log changes. Future blame / bisect / changelog work will be misled by the slug.
- **No design ticket.** There is no `plan/`, `implement/`, or even `backlog/` entry that introduces these changes; `git log --all --oneline --grep="circuit-relay|relay limits|relayServerInit"` returns empty.
- **No tests added.** A change that toggles reservation limits on every reference-peer cluster relay should at least be smoke-tested against the web-e2e scenarios that motivated it.
- **Trust model.** "Reference-peer trusted" is a strong claim. Confirm reference-peer is never run in a context where untrusted clients can request reservations against it; otherwise lifting per-reservation data/duration caps is a DoS vector.

## What to verify

1. **Relay-limit lift safety.**
   - Confirm `reference-peer` is always deployed inside a trusted boundary (sibling docs or AGENTS.md may already state this; cite the source).
   - Check whether any other call site of `createLibp2pNode` should also pass `relayServerInit` and currently doesn't (e.g. browser-peer, service-peer).
   - Run the web-e2e suite that motivated the change and confirm the long-lived circuits actually survive past 2 min / 128 KiB now.

2. **Dial-log enhancement.**
   - Confirm `err.message` cannot contain secrets, peer keys, or PII. Libp2p errors are generally safe, but check known error shapes from the dial path.
   - 200-char truncation is fine; verify the truncation marker `…` is not interpreted by any log aggregator as structured data.

3. **API surface.**
   - `CircuitRelayServerInit` is now a re-exported type from `@libp2p/circuit-relay-v2`. Confirm no downstream package was implicitly relying on `relayServerInit` *not* existing on `NodeOptions`.

## Suggested actions

- Run targeted tests: `yarn workspace @optimystic/db-p2p test`, plus whatever web-e2e command exercises browser↔service relayed circuits.
- If safety/regressions check out, the change can stay as-is and this ticket closes to `complete/` with a `## Review findings` confirming the unsupervised landing was harmless.
- If anything is off (especially the trust assumption), either roll back to a per-deployment override or add the missing tests / docs before signing off.
