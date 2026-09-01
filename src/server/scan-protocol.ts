/** Messages exchanged between the scanner and its worker thread. */

import type { StoreTransfer } from './store.js';

export interface WorkerOptions {
    excludeNames: string[];
    excludePaths: string[];
    oneFileSystem: boolean;
    countHardlinksOnce: boolean;
}

export interface WorkerInput {
    root: string;
    options: WorkerOptions;
    cancelBuffer: SharedArrayBuffer;
}

export interface ProgressMessage {
    type: 'progress';
    files: number;
    dirs: number;
    bytes: number;
    errors: number;
    path: string;
}

export interface DoneMessage {
    type: 'done';
    cancelled: boolean;
    files: number;
    dirs: number;
    errors: number;
    store: StoreTransfer;
}

export interface ErrorMessage {
    type: 'error';
    message: string;
}

export type WorkerMessage = ProgressMessage | DoneMessage | ErrorMessage;
