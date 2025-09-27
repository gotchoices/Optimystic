# @optimystic/fret

FRET (Finger Ring Ensemble Topology) is a libp2p overlay that maintains a 256-bit consistent-hash ring over PeerIds with symmetric successor/predecessor neighbor sets and a Digitree-backed routing cache. It provides fast, deterministic neighbor discovery and primitives used by Optimystic for coordinator selection and cohort assembly.

## Status
Work-in-progress. JSON-encoded protocols; TypeScript-first interfaces.

## API (preview)

```ts
export type FretMode = 'active' | 'passive'
export interface FretConfig { k: number; m: number; capacity: number; profile: 'edge'|'core' }
export interface FretService {
  start(): Promise<void>
  stop(): Promise<void>
  setMode(mode: FretMode): void
  ready(): Promise<void>
  neighborDistance(selfId: string, key: Uint8Array, k: number): number
  getNeighbors(key: Uint8Array, direction: 'left'|'right'|'both', wants: number): string[]
  assembleCohort(key: Uint8Array, wants: number, exclude?: Set<string>): string[]
  expandCohort(current: string[], key: Uint8Array, step: number, exclude?: Set<string>): string[]
  routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }>
  report(evt: ReportEvent): void
}
```

See `docs/fret.md` for the full design.

