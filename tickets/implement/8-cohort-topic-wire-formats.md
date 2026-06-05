description: JSON length-prefixed base64url codecs for RegisterV1, RegisterReplyV1, RenewV1, RenewReplyV1, PromotionNoticeV1, DemotionNoticeV1, CohortGossipV1, MembershipCertV1.
prereq: fold-simulator-findings-into-design-docs, cohort-topic-package-layering
files:
  - docs/cohort-topic.md (§Wire formats L463-600, §Configuration L604-629)
  - packages/db-core/src/cohort-topic (new package surface — pure layer per cohort-topic-package-layering)
effort: medium
----

# Cohort-topic wire formats and RPC message codecs

The wire layer is the foundation of the cohort-topic substrate: every other component
in the substrate (addressing, registration storage, gossip, promotion, walk) encodes
and decodes through these codecs, so it lands first. This ticket implements **only** the
message types and their JSON-over-the-wire serialization — no behavior, no FRET wiring,
no state machines.

All messages are JSON, length-prefixed UTF-8, with byte fields encoded as **base64url**
(no padding). All timestamps are **unix milliseconds**. These conventions are mandated by
`docs/cohort-topic.md` §Wire formats (L465) and must hold for every message and every
byte-typed field.

## New package surface

A new directory `packages/db-core/src/cohort-topic` holds the substrate types. This ticket
creates the wire sub-surface:

```
packages/db-core/src/cohort-topic/
  wire/
    types.ts        // the V1 interfaces below (timeless, exported)
    codec.ts        // encode/decode + length-prefix framing + base64url helpers
    validate.ts     // per-message structural validation (used by decode)
    index.ts        // re-exports
  index.ts          // re-exports wire (later tickets add addressing, storage, etc.)
```

`packages/db-core/src/index.ts` re-exports the cohort-topic surface.

## Message types

The interfaces are transcribed from `docs/cohort-topic.md` §Wire formats. Byte fields are
typed `string` on the wire (base64url) and documented as such. `appPayload` is an opaque
base64url string carrying application-defined bytes — reactivity (`SubscribeAppPayloadV1`)
and matchmaking (`ProviderAppPayloadV1`/`SeekerAppPayloadV1`) define their own structures
in their own tickets and serialize them *into* this slot. The wire layer never interprets
`appPayload`.

```ts
export interface RegisterV1 {
	v: 1;
	topicId: string;           // 32 bytes, base64url
	tier: number;              // 0..3
	treeTier: number;          // current walk position d
	participantCoord: string;  // ring coord, 32 bytes, base64url
	ttl: number;               // ms (default 90000; Edge 60000)
	bootstrap?: boolean;       // true on root cold-start request
	appPayload?: string;       // opaque application bytes, base64url
	timestamp: number;         // unix ms
	correlationId: string;     // 16 bytes, base64url
	signature: string;         // participant peer key, base64url
}

export type RegisterResult =
	| "accepted" | "no_state" | "promoted" | "unwilling_member" | "unwilling_cohort";

export interface RegisterReplyV1 {
	v: 1;
	result: RegisterResult;
	// accepted:
	primary?: string;          // PeerId
	backups?: string[];        // PeerIds, 1-2
	cohortEpoch?: string;      // 32 bytes, base64url
	cohortMembers?: string[];  // full cohort PeerIds, for client cache
	topicTraffic?: TopicTrafficV1;  // present on accepted and promoted only
	// promoted:
	targetTier?: number;       // d+1 typically; may leap
	// unwilling_member:
	candidateMembers?: string[];
	// unwilling_cohort:
	retryAfterMs?: number;
	reason?: string;
}

export interface TopicTrafficV1 {
	windowSeconds: number;
	arrivalsPerMin: number;
	queriesPerMin: number;
	directParticipants: number;
	childCohortCount: number;
}

export interface RenewV1 {
	v: 1;
	topicId: string;
	participantId: string;     // PeerId
	correlationId: string;     // matches original RegisterV1
	timestamp: number;
	signature: string;
}

export interface RenewReplyV1 {
	v: 1;
	result: "ok" | "unknown_registration" | "primary_moved";
	newPrimary?: string;       // primary_moved
	newBackups?: string[];
	cohortEpoch?: string;
}

export interface PromotionNoticeV1 {
	v: 1;
	topicId: string;
	fromTier: number;
	toTier: number;            // typically fromTier + 1
	effectiveAt: number;       // unix ms
	thresholdSig: string;      // cohort threshold sig, base64url
	signers: string[];         // PeerIds, >= minSigs
	cohortEpoch: string;
}

export interface DemotionNoticeV1 {
	v: 1;
	topicId: string;
	tier: number;
	parentCohortCoord: string; // 32 bytes, base64url
	effectiveAt: number;
	thresholdSig: string;
	signers: string[];
	cohortEpoch: string;
}

export interface CohortGossipV1 {
	v: 1;
	fromMember: string;        // PeerId
	cohortEpoch: string;
	willingnessBits: string;   // 4 bits T0..T3, hex
	loadBuckets: number[];     // 4 entries, 0..7 per tier
	windowSeconds: number;     // cohort-wide observation window
	topicSummaries: CohortTopicSummary[];
	timestamp: number;
	signature: string;
}

export interface CohortTopicSummary {
	topicId: string;
	tier: number;
	directParticipants: number;  // exact, intra-cohort only
	arrivalsPerMin: number;      // exact, fresh + renewals
	queriesPerMin: number;
	promoted: boolean;
	childCohortCount: number;
}

export interface MembershipCertV1 {
	v: 1;
	cohortCoord: string;       // 32 bytes, base64url
	cohortEpoch: string;
	members: string[];         // PeerIds, sorted ascending, length k
	stabilizedAt: number;      // unix ms
	thresholdSig: string;
	signers: string[];
	fretAttestation?: string;  // optional FRET stabilization proof
}
```

## Codec contract

```ts
// codec.ts
export function encodeCohortMessage<T extends { v: 1 }>(msg: T): Uint8Array;   // length-prefixed UTF-8 JSON
export function decodeCohortMessage(bytes: Uint8Array): unknown;              // strips length prefix, JSON.parse
// typed decoders run validate.ts and narrow:
export function decodeRegisterV1(bytes: Uint8Array): RegisterV1;
export function decodeRegisterReplyV1(bytes: Uint8Array): RegisterReplyV1;
// ...one per message type

// base64url helpers (shared)
export function bytesToB64url(b: Uint8Array): string;
export function b64urlToBytes(s: string): Uint8Array;
```

- Length prefix: 4-byte big-endian unsigned length of the UTF-8 JSON body, so a framed
  message is self-delimiting on a stream. Reject frames whose declared length exceeds a
  configurable `max_message_bytes` ceiling (default sized from `topics_max`/cohort gossip
  worst case — pull the concrete bound from `docs/cohort-topic.md` §Configuration once the
  fold-back ticket lands; until then use a conservative 1 MiB and leave a TODO comment).
- `validate.ts` enforces per-message structure: required fields present, `v === 1`,
  `result`/discriminant in its enum, byte fields decode cleanly as base64url, numeric
  ranges (`tier` 0..3, `loadBuckets` length 4 each 0..7), timestamps are finite numbers.
  Decode of a malformed or oversized frame throws a typed `CohortWireError`, never returns
  partial data.

## Constraints

ES modules, no inline `import()`, no `any`, tabs, small single-purpose functions,
cross-platform (browser/node/RN — use the shared base64url helpers, not Node `Buffer`).
Do not break existing db-core tests.

## Simulator dependency

This ticket prereqs `fold-simulator-findings-into-design-docs` only so that any wire-level
size/budget constants (`max_message_bytes`, cohort-gossip topicSummaries cap) reflect the
simulator-validated `topics_max`/`F`/`cap_promote` before they are baked into framing
limits. The message *shapes* are design-locked; only the numeric ceilings may shift.

## TODO

### Phase 1 — types and helpers
- Create `packages/db-core/src/cohort-topic/wire/types.ts` with every V1 interface above, transcribed faithfully from `docs/cohort-topic.md` §Wire formats.
- Implement `bytesToB64url`/`b64urlToBytes` (no padding) in `wire/codec.ts`, cross-platform (no `Buffer`).

### Phase 2 — codec + validation
- Implement length-prefixed framing (`encodeCohortMessage`/`decodeCohortMessage`) with the `max_message_bytes` ceiling and `CohortWireError`.
- Implement per-type validators in `wire/validate.ts` and the typed decoders in `codec.ts`.
- Wire up `wire/index.ts`, `cohort-topic/index.ts`, and the `db-core/src/index.ts` re-export.

### Phase 3 — tests + docs
- Add `packages/db-core/test/cohort-topic/wire.spec.ts`: round-trip encode→decode for every message type; reject malformed (missing field, bad enum, non-finite timestamp); reject oversized frames; base64url byte fidelity (random 32-byte and 16-byte values survive round-trip exactly).
- Doc-sync `docs/cohort-topic.md`: confirm §Wire formats matches the implemented interfaces verbatim; add a one-line note under §Wire formats pointing to `packages/db-core/src/cohort-topic/wire` as the canonical codec and stating the 4-byte length-prefix framing + `max_message_bytes` ceiling (the doc currently says "length-prefixed UTF-8" without the framing detail).

## Done when
- `yarn build` is green for `db-core`.
- `yarn test` is green for `db-core`, including the new `wire.spec.ts`.
- `docs/cohort-topic.md` §Wire formats reflects the framing/ceiling detail and references the codec module.
