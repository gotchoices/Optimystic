description: When one node tells others "this registration is gone," the receivers delete their copy no matter what — so a slow node's outdated removal, arriving after the member has re-registered, wrongly deletes the fresh registration. Add a freshness stamp so a stale removal is ignored.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts               # GossipRecordRefV1 — add lastPing
  - packages/db-core/src/cohort-topic/wire/validate.ts            # validateGossipRecordRefV1 (~444-451) — validate lastPing
  - packages/db-core/src/cohort-topic/wire/payloads.ts            # gossip signing payload (~121) — cover lastPing
  - packages/db-core/src/cohort-topic/gossip/bus.ts               # mergeRecords eviction loop (~226-235) — freshness guard
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts      # PendingDeltas.evicted (~114-118) — stamp lastPing
  - packages/db-core/test/cohort-topic/gossip.spec.ts             # eviction merge tests (~133-195)
  - packages/db-core/test/cohort-topic/wire.spec.ts               # codec round-trip / validator tests (~383-396)
difficulty: medium
----

# Gossiped evictions delete unconditionally — stale eviction deltas kill fresh records

## The problem

Record *merges* over gossip are last-writer-wins by `lastPing` (`gossip/bus.ts:214-218`). Record
*evictions* are **not**: `GossipRecordRefV1` carries only `(topicId, participantId)`
(`wire/types.ts:280-285`), and `mergeRecords` deletes whatever is held with no freshness check
(`gossip/bus.ts:226-232`).

So a slow member's stale eviction delta, arriving **after** the participant re-registered, deletes the
newer record. It self-heals via the next renew → failover, but it breaks the replication invariant
(evictions are not LWW-ordered like merges are) and causes spurious failovers under message reordering.

## Root cause (traced)

- **Producer** — `cohort-gossip-driver.ts:114-118`, `PendingDeltas.evicted(rec)` gets the full
  `RegistrationRecord` (which has `rec.lastPing`) but stamps only `{ topicId, participantId }` into the
  ref. The freshness data is on hand at the producing site; it is simply dropped.
- **Consumer** — `gossip/bus.ts:226-232`, the eviction loop does `store.delete(...)` unconditionally,
  with no compare against the held record's `lastPing`.

## The fix

Carry the evicted record's `lastPing` on the wire ref, and gate the delete on it.

**Wire shape** (`GossipRecordRefV1`) gains a required `lastPing: number` (unix ms), mirroring
`GossipRecordV1.lastPing`. This changes the wire shape — validator + signing payload + round-trip tests
follow.

**Guard** in `mergeRecords`: delete only when the held record is no newer than the eviction
(`held.lastPing <= ref.lastPing`). A stale eviction (`ref.lastPing < held.lastPing`) is ignored, so a
fresh re-registration survives. When the record is already absent (`held === undefined`), keep today's
behavior: the delete is a harmless no-op and the topic still flows to the `onRecordsEvicted` budget
re-touch — only the genuinely-stale case (`held.lastPing > ref.lastPing`) is newly skipped, and a
skipped topic must **not** be added to `evictedTopics` (nothing drained → no budget re-touch).

### Sending side stamps lastPing (`cohort-gossip-driver.ts:114-118`)

```ts
evicted(rec: RegistrationRecord): void {
	const key = keyOf(rec.topicId, rec.participantId);
	evicted.set(key, {
		topicId: bytesToB64url(rec.topicId),
		participantId: bytesToB64url(rec.participantId),
		lastPing: rec.lastPing,
	});
	records.delete(key);
},
```

### Guard on the receiving side (`gossip/bus.ts:226-232`)

```ts
for (const ref of g.evicted ?? []) {
	const topicId = b64urlToBytes(ref.topicId);
	const participantId = b64urlToBytes(ref.participantId);
	const held = this.deps.store.getByParticipant(topicId, participantId);
	// A stale eviction (older than the held record) must not delete a fresher re-registration.
	// Evictions are otherwise NOT last-writer-wins like merges are, so a reordered/slow delta wins.
	if (held !== undefined && held.lastPing > ref.lastPing) {
		continue;
	}
	this.deps.store.delete(topicId, participantId);
	if (this.deps.onRecordsEvicted !== undefined) {
		(evictedTopics ??= new Map()).set(bytesKey(topicId), topicId);
	}
}
```

## Design decisions (already made — proceed)

- **`lastPing` is required, not optional.** The substrate is pre-production and deploys together, and
  every real eviction has a `lastPing` on hand (it comes off the held `RegistrationRecord`). Making it
  optional would leave the exact stale-delete hole this ticket closes for any ref that omits it. Match
  `GossipRecordV1.lastPing`: `reqFiniteNumber`. (A peer on old code would send a ref without `lastPing`
  and its whole gossip frame fails validation — acceptable pre-release; note it in the review handoff.)
- **Cover `lastPing` in the signing payload** (`payloads.ts:121`) so a MITM cannot strip/alter it to
  turn a stale eviction back into a wild-card delete. Change the mapper to
  `(g.evicted ?? []).map((e) => [e.topicId, e.participantId, e.lastPing])`.

## Repro / test plan

The current `gossip.spec.ts` "applies an eviction delta" test (line 133) already exercises the delete;
its inline eviction refs (lines 138, 164, 189-192) must gain `lastPing`. Add two new cases proving the
guard:

- **stale eviction ignored**: hold R1 `lastPing=t1`; put newer R2 `lastPing=t2 (>t1)`; deliver an
  eviction ref stamped `lastPing=t1`; assert R2 survives.
- **genuine eviction still deletes**: hold R `lastPing=t`; deliver an eviction ref stamped
  `lastPing >= t`; assert R removed (and, with `onRecordsEvicted`, the budget re-touch still fires).
- Confirm the existing "re-touches the topic budget down" / "fires onRecordsEvicted once per distinct
  drained topic" tests stay green once their refs carry a fresh-enough `lastPing`.

Wire tests (`wire.spec.ts`): add an evicted-ref round-trip asserting `lastPing` survives encode/decode,
and a validator rejection when `lastPing` is missing / non-finite (mirror the childLinks cases at
lines 383-396). If a `sampleGossip()` helper builds `evicted`, update it to include `lastPing`.

## Validation

Run the db-core cohort-topic wire + gossip suites and the db-p2p gossip-cadence suite. Stream output:

```
yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/dbcore-test.log
yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/dbp2p-test.log
```

(Confirm the exact test invocation against AGENTS.md / package.json before running.)

## TODO

- [ ] `wire/types.ts`: add required `lastPing: number` to `GossipRecordRefV1` with a doc comment (the
      evicted record's most-recent-ping stamp; the receiver's freshness guard for the delete).
- [ ] `wire/validate.ts`: in `validateGossipRecordRefV1` (~444), add
      `lastPing: reqFiniteNumber(obj, "lastPing", what)`.
- [ ] `wire/payloads.ts` (~121): include `e.lastPing` in the evicted mapper so the signature covers it.
- [ ] `cohort-gossip-driver.ts` (~114): stamp `lastPing: rec.lastPing` into the queued eviction ref.
- [ ] `gossip/bus.ts` (~226): add the `held.lastPing > ref.lastPing` skip; only add to `evictedTopics`
      when a delete actually runs (don't re-touch the budget for a skipped stale eviction).
- [ ] `gossip.spec.ts`: add `lastPing` to existing eviction refs; add the stale-ignored and
      genuine-delete cases above.
- [ ] `wire.spec.ts`: add evicted-ref round-trip + missing/invalid-`lastPing` rejection; update any
      `sampleGossip()`/evicted helper.
- [ ] Grep for any other constructor of `GossipRecordRefV1` / `evicted:` literals in tests
      (`db-core/test`, `db-p2p/test`) and add `lastPing` so the suites compile.
- [ ] Build + typecheck + run the suites above (stream with `tee`); confirm green.
