# @optimystic/fret

FRET: Finger Ring Ensemble Topology — a Chord-style ring overlay for libp2p with JSON RPCs and a Digitree-backed cache.

## Development

- Build

```
yarn workspace @optimystic/fret build
```

- Test (node only for now)

```
yarn workspace @optimystic/fret test
```

## Test harness (local meshes)

A minimal harness will spin up a small libp2p mesh in-process and exercise:
- Join/bootstrap seeding
- Neighbor snapshots and discovery emissions
- Routing (routeAct) hop counts and anchors
- Diagnostics counters (pings, snapshots, announcements)

The harness will live under `test/` and use profile-tuned configs for edge/core.

