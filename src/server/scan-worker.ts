/**
 * Filesystem walk. Runs on a worker thread so a scan of a few million files
 * never blocks the HTTP server.
 *
 * The walk is deliberately synchronous: for a metadata-bound traversal the sync
 * fs calls beat the promise machinery comfortably, and `postMessage` still
 * queues fine from synchronous code, so progress keeps flowing.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { readdirSync, lstatSync, type Stats } from 'node:fs';
import { join, sep } from 'node:path';
import { NodeStore } from './store.js';
import { F_DIR, F_LINK, F_ERROR, F_SKIPPED, F_DUP } from '../shared/protocol.js';
import type { WorkerInput, WorkerMessage } from './scan-protocol.js';

const port = parentPort;
if (!port) throw new Error('scan-worker must run as a worker thread');

const { root, options, cancelBuffer } = workerData as WorkerInput;
const cancelFlag = new Int32Array(cancelBuffer);

const CLUSTER = 4096; // assumed allocation unit where st.blocks is unavailable
const PROGRESS_MS = 120;
const CHECK_INTERVAL = 1024; // entries between clock and cancel checks

const excludeNames = new Set(options.excludeNames);
const excludePaths = new Set(options.excludePaths);
const oneFileSystem = options.oneFileSystem;

const store = new NodeStore(1 << 16, 1 << 20);
store.root = root;

// Extension interning. Ids here are creation-ordered; summarise() renumbers
// them by size so colour assignment can key off rank.
const extIds = new Map<string, number>();
const extNames: string[] = [];

function internExt(name: string): number {
    const dot = name.lastIndexOf('.');
    // A leading dot is a hidden file (".bashrc"), not an extension.
    let ext = dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : '';
    if (ext.length > 16) ext = ''; // junk suffix, not a real type
    let id = extIds.get(ext);
    if (id === undefined) {
        id = extNames.length;
        extNames.push(ext);
        extIds.set(ext, id);
    }
    return id;
}

/** Bytes actually occupied on disk, falling back to cluster rounding. */
function allocated(st: Stats): number {
    if (typeof st.blocks === 'number' && st.blocks > 0) return st.blocks * 512;
    if (st.size === 0) return 0;
    return Math.ceil(st.size / CLUSTER) * CLUSTER;
}

// Hardlinked files are counted once, at the first path we reach them by.
const seenLinks: Set<string> | null = options.countHardlinksOnce ? new Set() : null;

let nFiles = 0;
let nDirs = 0;
let nBytes = 0;
let nErrors = 0;
let sinceCheck = 0;
let lastPost = 0;
let cancelled = false;

function post(message: WorkerMessage, transfer?: ArrayBuffer[]): void {
    port!.postMessage(message, transfer ?? []);
}

function maybeReport(path: string): void {
    if (++sinceCheck < CHECK_INTERVAL) return;
    sinceCheck = 0;
    if (Atomics.load(cancelFlag, 0) === 1) {
        cancelled = true;
        return;
    }
    const now = Date.now();
    if (now - lastPost >= PROGRESS_MS) {
        lastPost = now;
        post({ type: 'progress', files: nFiles, dirs: nDirs, bytes: nBytes, errors: nErrors, path });
    }
}

/** Turn an errno into something a person can act on. */
function why(err: unknown, path: string): string {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return `No such directory: ${path}`;
    if (code === 'EACCES' || code === 'EPERM') return `Permission denied: ${path}`;
    if (code === 'ENOTDIR') return `Not a directory: ${path}`;
    if (code === 'ELOOP') return `Too many symbolic links: ${path}`;
    if (code === 'ENAMETOOLONG') return `Path is too long: ${path}`;
    return `Cannot read ${path}${code ? ` (${code})` : ''}`;
}

let rootStat: Stats | undefined;
let rootError: string | null = null;
try {
    rootStat = lstatSync(root);
} catch (err) {
    rootError = why(err, root);
}

if (rootError !== null) {
    post({ type: 'error', message: rootError });
} else if (!rootStat!.isDirectory()) {
    post({ type: 'error', message: `Not a directory: ${root}` });
} else {
    const rootStats = rootStat!;
    const rootDev = rootStats.dev;
    const rootIdx = store.add(-1, root, F_DIR);
    store.alloc[rootIdx] = allocated(rootStats);
    store.mtime[rootIdx] = rootStats.mtimeMs;

    // Explicit stack; recursion would blow up on deep trees and is slower here.
    const stack: [number, string][] = [[rootIdx, root]];
    let fatal: string | null = null;

    while (stack.length > 0) {
        if (cancelled) break;
        const frame = stack.pop()!;
        const [dirIdx, dirPath] = frame;
        nDirs++;

        let entries;
        try {
            entries = readdirSync(dirPath, { withFileTypes: true });
        } catch (err) {
            // An unreadable directory deep in the tree is a fact about that
            // directory. An unreadable *root* is a failed scan: reporting it as
            // a successful walk of nothing tells the user their folder is empty.
            if (dirIdx === rootIdx) {
                fatal = why(err, dirPath);
                break;
            }
            store.flags[dirIdx] |= F_ERROR;
            nErrors++;
            continue;
        }

        for (const entry of entries) {
            const name = entry.name;
            const full = dirPath === sep ? sep + name : join(dirPath, name);

            if (excludeNames.has(name) || excludePaths.has(full)) {
                store.add(dirIdx, name, F_DIR | F_SKIPPED);
                continue;
            }

            // Trust the dirent for the common cases, but sizes, devices and symlink
            // targets still need an lstat.
            const st = lstatSync(full, { throwIfNoEntry: false });
            if (!st) continue; // vanished between readdir and lstat

            if (st.isDirectory()) {
                if (oneFileSystem && st.dev !== rootDev) {
                    const idx = store.add(dirIdx, name, F_DIR | F_SKIPPED);
                    store.mtime[idx] = st.mtimeMs;
                    continue;
                }
                const idx = store.add(dirIdx, name, F_DIR);
                store.alloc[idx] = allocated(st);
                store.mtime[idx] = st.mtimeMs;
                stack.push([idx, full]);
            } else {
                let flags = st.isSymbolicLink() ? F_LINK : 0;
                let size = st.size;
                let alloc = allocated(st);

                if (seenLinks && st.nlink > 1 && !st.isSymbolicLink()) {
                    const key = `${st.dev}:${st.ino}`;
                    if (seenLinks.has(key)) {
                        flags |= F_DUP;
                        size = 0;
                        alloc = 0;
                    } else {
                        seenLinks.add(key);
                    }
                }

                const idx = store.add(dirIdx, name, flags);
                store.size[idx] = size;
                store.alloc[idx] = alloc;
                store.mtime[idx] = st.mtimeMs;
                store.ext[idx] = internExt(name);
                nFiles++;
                // Apparent size, matching what the UI reports everywhere else —
                // reporting allocation here would make the total jump when the
                // scan finishes and the final figure takes over.
                nBytes += size;
            }
            maybeReport(full);
        }
    }

    if (fatal !== null) {
        post({ type: 'error', message: fatal });
    } else {
        store.aggregate();
        store.sortChildren();
        store.summarise(extNames);
        store.computeDominant();

        const { payload, transfer } = store.toTransfer();
        post({ type: 'done', cancelled, files: nFiles, dirs: nDirs, errors: nErrors, store: payload }, transfer);
    }
}
