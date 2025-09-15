/// <reference types="node" />
import { spawn } from 'child_process';
type Child = ReturnType<typeof spawn>;
export interface MeshNodeInfo {
    peerId: string;
    multiaddrs: string[];
    port: number;
    networkName: string;
    timestamp: number;
    pid: number;
}
export interface MeshHandle {
    children: Child[];
    infoFiles: string[];
    info: MeshNodeInfo[];
    stop: () => Promise<void>;
}
export declare function startMesh(n: number, basePort?: number): Promise<MeshHandle>;
export {};
//# sourceMappingURL=mesh.d.ts.map