/** Worker lifecycle: start a scan, stream progress, allow cancellation. */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { NodeStore } from './store.js';
import type { ProgressMessage, WorkerMessage } from './scan-protocol.js';

const WORKER = fileURLToPath(new URL('./scan-worker.js', import.meta.url));

/**
 * Paths that are pseudo-filesystems or self-referential mounts. Matched as
 * exact absolute paths, so scanning one of them directly still works — the
 * exclusion only fires when the path turns up as a child during a walk.
 */
const DEFAULT_EXCLUDES: Record<string, string[]> = {
    linux: ['/proc', '/sys', '/dev', '/run'],
    darwin: ['/dev', '/System/Volumes/Data', '/Volumes'],
    win32: [],
};

export function defaultExcludes(platform: string = process.platform): string[] {
    return DEFAULT_EXCLUDES[platform] ?? [];
}

export interface ScanOptions {
    excludeNames?: string[];
    excludePaths?: string[];
    useDefaultExcludes?: boolean;
    oneFileSystem?: boolean;
    countHardlinksOnce?: boolean;
}

export interface ScanHandle {
    promise: Promise<NodeStore>;
    cancel(): void;
}

export function startScan(
    root: string,
    options: ScanOptions = {},
    onProgress: (progress: ProgressMessage) => void = () => undefined
): ScanHandle {
    const cancelBuffer = new SharedArrayBuffer(4);
    const cancelFlag = new Int32Array(cancelBuffer);

    const workerOptions = {
        excludeNames: options.excludeNames ?? [],
        excludePaths:
            options.useDefaultExcludes === false
                ? options.excludePaths ?? []
                : [...defaultExcludes(), ...(options.excludePaths ?? [])],
        oneFileSystem: options.oneFileSystem !== false,
        countHardlinksOnce: options.countHardlinksOnce !== false,
    };

    let resolve!: (store: NodeStore) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<NodeStore>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    const worker = new Worker(WORKER, {
        workerData: { root, options: workerOptions, cancelBuffer },
    });

    worker.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'progress') {
            onProgress(msg);
        } else if (msg.type === 'done') {
            const store = NodeStore.fromTransfer(msg.store);
            store.cancelled = msg.cancelled;
            resolve(store);
            void worker.terminate();
        } else {
            reject(new Error(msg.message));
            void worker.terminate();
        }
    });

    worker.on('error', (err: Error) => reject(err));
    worker.on('exit', (code: number) => {
        if (code !== 0) reject(new Error(`Scanner exited with code ${code}`));
    });

    return {
        promise,
        cancel(): void {
            Atomics.store(cancelFlag, 0, 1);
        },
    };
}
