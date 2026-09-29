description: When a new machine joins a group shortly after the group last checked its replicas, the group never sends the newcomer copies of the existing data until some unrelated connection happens a minute or more later. The check that should do it is skipped for being too soon and is then forgotten, instead of being postponed.
files:
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`maybeRebalance`'s throttle exit; `handleTopologyChange` and the NOTE in it; `updateRecheckTimer`; `stop`)
  - packages/db-p2p/test/rebalance-monitor.spec.ts (the `debounce behavior` describe — the regression goes here)
  - docs/internals.md (§ Cluster Health Monitors → RebalanceMonitor, "Throttled to one scan per `minRebalanceIntervalMs`")
repro: verified
----
# A throttled rebalance check drops its trigger

## What happens

`RebalanceMonitor` reacts to libp2p `connection:open` / `connection:close` by waiting `debounceMs` (5 s by default) and then calling `maybeRebalance`. That method refuses to run if the last check was less than `minRebalanceIntervalMs` (60 s by default) ago — and simply returns. Nothing remembers that a topology change is waiting: `pendingTopologyChange` was already cleared by the debounce callback, and the growth re-check timer (`updateRecheckTimer`) is armed only while growth work is *already* outstanding, which it is not for a peer the monitor has never reported.

So a machine that joins a block's cohort within 60 s of the founder's previous check is never reported `grown`, and never receives a copy of the blocks committed before it arrived, until some later connection event happens to land outside the throttle window. On relay-only deployments connection events are rare, so "later" can be never for the life of the session.

This is one of the two causes behind the sereus re-attach report (optimystic #22 measurements; see also `a-restarted-node-forgets-which-peers-serve-its-network`): peer B joined a cohort whose blocks A committed before B arrived, read a row through A, and detached a few seconds later holding only part of the collection. Nothing but the growth push would ever have copied those blocks to B (reads served through a remote coordinator are not stored by the reader, by design).

## Reproduction (ran it, fails at HEAD)

With `debounceMs: 20, minRebalanceIntervalMs: 300`: track a block with a self-only cohort, run `checkNow()` (the founder's check), grow the cohort to `[self, peer]`, emit `connection:open`, wait 1 s. No event is ever emitted. The same spec with `minRebalanceIntervalMs: 0` emits `grown: b1 → [peer]` (control, passes). Adapted to the existing spec file's `MockLibp2p` / `MockFret` helpers:

```ts
it('a topology change landing inside the throttle window is deferred, not dropped', async () => {
	mockFret.setCohort('*', [selfId.toString()]);
	const events: RebalanceEvent[] = [];
	const monitor = new RebalanceMonitor(deps, { debounceMs: 20, minRebalanceIntervalMs: 300 });
	monitor.onRebalance(e => events.push(e));
	monitor.trackBlock('block-1');
	await monitor.start();
	await monitor.checkNow();                     // the founder's check, alone
	mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);
	mockLibp2p.emit('connection:open');           // the joiner arrives inside the throttle window
	await waitFor(() => events.some(e => e.grown.has('block-1')), { description: 'the deferred check reported the joiner' });
	expect(events.flatMap(e => [...e.grown.entries()])).to.deep.equal([['block-1', [peerId2.toString()]]]);
	await monitor.stop();
});
```

## Required behaviour

- A trigger that `maybeRebalance` refuses for the throttle is **deferred to the end of the throttle window**, never dropped: arm one timer for `lastRebalanceAt + minRebalanceIntervalMs − now` that runs the check then. The throttle keeps bounding the scan rate; it just stops losing work.
- At most one deferred check is armed at a time; further triggers inside the window fold into it (keep `topologyChangeTimestamp` as the earliest pending trigger, as the debounce already does).
- The timer is `unref`'d like the re-check timer, and `stop()` clears it. It may share the re-check timer's slot if that reads cleaner — the re-check timer already calls `maybeRebalance`, so the same deferral covers a throttled re-check too.
- Keep the throttle's default. Do not shorten it to hide this.

## What this does not fix (tripwire, record at the site)

A joiner that leaves before the debounce plus the rest of the throttle window has elapsed still leaves without a copy. That is not a defect of the push: the re-attaching side must not treat its own partial store as the whole truth, which is `a-restarted-node-forgets-which-peers-serve-its-network`'s business. Update the NOTE in `handleTopologyChange` (it currently says nothing re-checks until the next connection event outside the window — no longer true) and leave a `NOTE:` at the deferral saying that the worst-case delay before a joiner gets its copy is `debounceMs + minRebalanceIntervalMs`, and that if a deployment ever needs it shorter, the answer is a growth-only fast path for newly reported peers rather than a shorter full-scan throttle.

## Questions from the fix ticket, answered here

- *Can a detaching peer finish its pending growth push?* No: the push is owed by the machine that holds the blocks (the founder), not by the peer that is leaving. What was in reach was making the founder's push happen at all; that is this ticket.

## TODO

- Add the regression spec above to `test/rebalance-monitor.spec.ts` (`debounce behavior`); confirm it fails before the change.
- Defer the throttled trigger in `maybeRebalance` as specified; clear the timer in `stop()`.
- Update the NOTE in `handleTopologyChange` and add the tripwire `NOTE:` at the deferral.
- Update `docs/internals.md` § RebalanceMonitor: "Throttled to one scan per `minRebalanceIntervalMs` (default 60s)" gains "— a trigger landing inside that window runs when it ends, it is not dropped".
- Run `yarn test` in `packages/db-p2p` (rebalance specs in particular: `rebalance-monitor`, `rebalance-reaction`, `rebalance-monitor-node-wiring`) and `yarn lint:docs`.
