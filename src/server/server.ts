/**
 * Local HTTP server. Binds loopback only.
 *
 * Because the API can delete files, it is guarded three ways: a random
 * per-process token that must accompany every /api call, a Host header check
 * (a rebound DNS name will not match 127.0.0.1), and an Origin check on
 * mutating requests. Static assets are unguarded so the page can bootstrap.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs, existsSync, readdirSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';

import { startScan, type ScanHandle, type ScanOptions } from './scanner.js';
import { buildTreemap } from './treemap-query.js';
import { colorForRank, extensionLabel, SPECIAL_COLORS } from './palette.js';
import { NodeStore } from './store.js';
import { iconForExtension, iconForFile, iconForFolder, iconFilePath } from './icons.js';
import { toDisplayPath, toNativePath } from './paths.js';
import { F_DIR } from '../shared/protocol.js';
import type {
    ActionRequest, BrowseResponse, ExtensionRow, RootsResponse,
    ScanProgress, ScanStatus, ScanSummary, SizeMetric, TreeRow,
} from '../shared/protocol.js';
import * as actions from './actions.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

interface ServerState {
    status: ScanStatus;
    root: string | null;
    store: NodeStore | null;
    scanId: number;
    startedAt: number;
    finishedAt: number;
    progress: ScanProgress;
    error: string | null;
}

export interface AppOptions {
    oneFileSystem?: boolean;
}

export interface App {
    server: Server;
    token: string;
    state: ServerState;
    beginScan(path: string, opts?: ScanOptions): ScanHandle;
    summary(): ScanSummary;
}

export function createApp({ oneFileSystem = true }: AppOptions = {}): App {
    const token = randomBytes(24).toString('hex');

    const state: ServerState = {
        status: 'idle',
        root: null,
        store: null,
        scanId: 0,
        startedAt: 0,
        finishedAt: 0,
        progress: { files: 0, dirs: 0, bytes: 0, errors: 0, path: '' },
        error: null,
    };

    let active: ScanHandle | null = null;
    const listeners = new Set<ServerResponse>();

    function broadcast(event: string, data: unknown): void {
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of listeners) res.write(frame);
    }

    // ---------------------------------------------------------------- scanning

    function beginScan(path: string, opts: ScanOptions = {}): ScanHandle {
        if (active) active.cancel();
        const root = resolve(path);
        state.status = 'scanning';
        state.root = root;
        state.store = null;
        state.error = null;
        state.startedAt = Date.now();
        state.scanId += 1;
        state.progress = { files: 0, dirs: 0, bytes: 0, errors: 0, path: root };

        broadcast('start', { root: toDisplayPath(root), scanId: state.scanId });

        const handle = startScan(root, { oneFileSystem, ...opts }, (progress) => {
            state.progress = progress;
            broadcast('progress', { ...progress, path: toDisplayPath(progress.path) });
        });
        active = handle;

        handle.promise.then(
            (store) => {
                if (active !== handle) return; // superseded by a newer scan
                active = null;
                state.store = store;
                state.status = 'ready';
                state.finishedAt = Date.now();
                broadcast('done', summary());
            },
            (err: Error) => {
                if (active !== handle) return;
                active = null;
                state.status = 'error';
                state.error = err.message;
                broadcast('failed', { message: err.message });
            }
        );
        return handle;
    }

    function summary(): ScanSummary {
        const store = state.store;
        if (!store) {
            return {
                status: state.status,
                root: state.root === null ? null : toDisplayPath(state.root),
                error: state.error,
                progress: { ...state.progress, path: toDisplayPath(state.progress.path) },
            };
        }
        return {
            status: state.status,
            scanId: state.scanId,
            root: toDisplayPath(store.root),
            nodes: store.count,
            files: store.files[0],
            dirs: store.dirs[0],
            size: store.size[0],
            alloc: store.alloc[0],
            elapsedMs: state.finishedAt - state.startedAt,
            cancelled: store.cancelled,
        };
    }

    // ------------------------------------------------------------ tree helpers

    /** Native filesystem path; only fs calls should see this form. */
    function pathOf(store: NodeStore, id: number): string {
        return id === 0 ? store.root : join(store.root, ...store.segments(id));
    }

    /** The same path as the client and the URL bar see it. */
    function displayPathOf(store: NodeStore, id: number): string {
        return toDisplayPath(pathOf(store, id));
    }

    function row(store: NodeStore, i: number): TreeRow {
        const isDir = (store.flags[i] & F_DIR) !== 0;
        return {
            i,
            n: store.name(i),
            icon: isDir ? iconForFolder(store.name(i)) : iconForFile(store.name(i)),
            size: store.size[i],
            alloc: store.alloc[i],
            files: store.files[i],
            dirs: store.dirs[i],
            mtime: store.mtime[i],
            ext: store.ext[i],
            flags: store.flags[i],
            kids: store.child0[i] !== -1,
        };
    }

    /**
     * Detach a node after it has been deleted on disk, subtracting its totals
     * from every ancestor and from the extension legend, so the UI stays honest
     * without forcing a rescan.
     */
    function detach(store: NodeStore, id: number): void {
        const parent = store.parent[id];
        if (parent < 0) return;

        let prev = -1;
        for (let c = store.child0[parent]; c !== -1; c = store.sib[c]) {
            if (c === id) break;
            prev = c;
        }
        if (prev === -1) store.child0[parent] = store.sib[id];
        else store.sib[prev] = store.sib[id];
        if (store.last[parent] === id) store.last[parent] = prev;

        const isDir = (store.flags[id] & F_DIR) !== 0;
        const dSize = store.size[id];
        const dAlloc = store.alloc[id];
        const dFiles = store.files[id] + (isDir ? 0 : 1);
        const dDirs = store.dirs[id] + (isDir ? 1 : 0);
        for (let n = parent; n !== -1; n = store.parent[n]) {
            store.size[n] -= dSize;
            store.alloc[n] -= dAlloc;
            store.files[n] -= dFiles;
            store.dirs[n] -= dDirs;
        }

        const stack = [id];
        while (stack.length > 0) {
            const n = stack.pop()!;
            const e = store.ext[n];
            if (e >= 0) {
                store.extSize[e] -= store.size[n];
                store.extAlloc[e] -= store.alloc[n];
                store.extCount[e] -= 1;
            }
            for (const c of store.children(n)) stack.push(c);
        }
    }

    // ----------------------------------------------------------------- routing

    function send(
        res: ServerResponse,
        status: number,
        body: unknown,
        headers: Record<string, string> = {},
        acceptEncoding = ''
    ): void {
        let payload: Buffer;
        const out = { ...headers };
        if (Buffer.isBuffer(body)) {
            payload = body;
        } else {
            payload = Buffer.from(JSON.stringify(body));
            out['content-type'] = 'application/json; charset=utf-8';
        }
        if (payload.length > 4096 && /\bgzip\b/.test(acceptEncoding)) {
            payload = gzipSync(payload);
            out['content-encoding'] = 'gzip';
        }
        out['content-length'] = String(payload.length);
        out['cache-control'] = 'no-store';
        res.writeHead(status, out);
        res.end(payload);
    }

    function tokenOk(provided: unknown): boolean {
        if (typeof provided !== 'string' || provided.length !== token.length) return false;
        return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
    }

    /** Blocks DNS rebinding: a rebound hostname will not be a loopback literal. */
    function hostOk(req: IncomingMessage): boolean {
        const host = (req.headers.host ?? '').split(':')[0].replace(/^\[|\]$/g, '');
        return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    }

    async function readJson<T>(req: IncomingMessage): Promise<T> {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
            bytes += (chunk as Buffer).length;
            if (bytes > 1 << 20) throw new Error('Request body too large');
            chunks.push(chunk as Buffer);
        }
        return (chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as T;
    }

    async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
        const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
        const file = join(PUBLIC_DIR, rel);
        if (!actions.isInside(PUBLIC_DIR, file)) return send(res, 403, { error: 'Forbidden' });
        try {
            const body = await fs.readFile(file);
            send(res, 200, body, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' },
                req.headers['accept-encoding'] as string ?? '');
        } catch {
            send(res, 404, { error: 'Not found' });
        }
    }

    async function serveIcon(res: ServerResponse, pathname: string): Promise<void> {
        const name = decodeURIComponent(pathname.slice('/icons/'.length)).replace(/\.svg$/, '');
        const file = iconFilePath(name);
        if (!file) return send(res, 404, { error: 'Unknown icon' });
        try {
            const body = await fs.readFile(file);
            res.writeHead(200, {
                'content-type': 'image/svg+xml',
                'content-length': String(body.length),
                'cache-control': 'public, max-age=86400',
            });
            res.end(body);
        } catch {
            send(res, 404, { error: 'Unknown icon' });
        }
    }

    const server = createServer((req, res) => {
        void handle(req, res).catch((err: Error) => send(res, 500, { error: err.message }));
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;

        if (!hostOk(req)) return send(res, 421, { error: 'Misdirected request' });
        if (pathname.startsWith('/icons/')) return serveIcon(res, pathname);
        if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

        const provided = url.searchParams.get('t') ?? req.headers['x-mydirstat-token'];
        if (!tokenOk(provided)) return send(res, 403, { error: 'Bad or missing token' });

        if (req.method === 'POST') {
            const origin = req.headers.origin;
            if (origin && new URL(origin).hostname !== (req.headers.host ?? '').split(':')[0]) {
                return send(res, 403, { error: 'Cross-origin request refused' });
            }
        }

        const accept = (req.headers['accept-encoding'] as string) ?? '';
        const store = state.store;

        /** Reject the request unless a completed scan and a valid node id exist. */
        const nodeId = (): number | null => {
            const id = Number(url.searchParams.get('id') ?? 0);
            if (!store || !Number.isInteger(id) || id < 0 || id >= store.count) return null;
            return id;
        };

        switch (pathname) {
            case '/api/state':
                return send(res, 200, summary(), {}, accept);

            case '/api/events': {
                res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-store',
                    connection: 'keep-alive',
                });
                res.write('retry: 2000\n\n');
                res.write(`event: state\ndata: ${JSON.stringify(summary())}\n\n`);
                listeners.add(res);
                const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
                req.on('close', () => {
                    clearInterval(keepAlive);
                    listeners.delete(res);
                });
                return;
            }

            case '/api/roots': {
                const body: RootsResponse = { roots: listRoots(), home: homedir(), cwd: process.cwd() };
                return send(res, 200, body);
            }

            case '/api/browse': {
                const dir = toNativePath(url.searchParams.get('path') ?? homedir());
                const entries = readdirSync(dir, { withFileTypes: true })
                    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
                    .map((e) => ({ name: e.name, path: toDisplayPath(join(dir, e.name)) }))
                    .sort((a, b) => a.name.localeCompare(b.name));
                const parent = parentOf(dir);
                const body: BrowseResponse = {
                    path: toDisplayPath(resolve(dir)),
                    parent: parent === null ? null : toDisplayPath(parent),
                    entries,
                };
                return send(res, 200, body, {}, accept);
            }

            case '/api/scan': {
                if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
                const body = await readJson<{ path?: string; oneFileSystem?: boolean; countHardlinksOnce?: boolean }>(req);
                if (!body.path) return send(res, 400, { error: 'path is required' });
                const wanted = toNativePath(body.path);
                if (!existsSync(wanted)) return send(res, 400, { error: `No such directory: ${body.path}` });
                beginScan(wanted, {
                    oneFileSystem: body.oneFileSystem !== false,
                    countHardlinksOnce: body.countHardlinksOnce !== false,
                });
                return send(res, 202, { status: 'scanning', root: state.root });
            }

            case '/api/cancel': {
                if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
                if (active) active.cancel();
                return send(res, 200, { ok: true });
            }

            case '/api/children': {
                const id = nodeId();
                if (!store) return send(res, 409, { error: 'No completed scan' });
                if (id === null) return send(res, 400, { error: 'Bad node id' });
                const rows: TreeRow[] = [];
                for (const c of store.children(id)) rows.push(row(store, c));
                return send(res, 200, { id, path: displayPathOf(store, id), self: row(store, id), rows }, {}, accept);
            }

            case '/api/ancestors': {
                const id = nodeId();
                if (!store) return send(res, 409, { error: 'No completed scan' });
                if (id === null) return send(res, 400, { error: 'Bad node id' });
                const chain: number[] = [];
                for (let n = id; n !== -1; n = store.parent[n]) chain.push(n);
                chain.reverse();
                return send(res, 200, {
                    chain: chain.map((i) => ({ i, n: i === 0 ? toDisplayPath(store.root) : store.name(i) })),
                });
            }

            case '/api/treemap': {
                const id = nodeId();
                if (!store) return send(res, 409, { error: 'No completed scan' });
                if (id === null) return send(res, 400, { error: 'Bad node id' });
                const metric: SizeMetric = url.searchParams.get('metric') === 'size' ? 'size' : 'alloc';
                const area = Math.min(3e7, Math.max(1e4, Number(url.searchParams.get('area')) || 1e6));
                const minTile = Math.min(4096, Math.max(1, Number(url.searchParams.get('minTile')) || 4));
                // Scale the safety cap with the canvas so a large display gets the
                // detail it can actually resolve.
                const maxTiles = Math.round(Math.min(60000, Math.max(4000, area / 20)));
                const result = buildTreemap(store, id, metric, { area, minTile, maxTiles });
                return send(res, 200, { ...result, metric, id }, {}, accept);
            }

            case '/api/extensions': {
                if (!store) return send(res, 409, { error: 'No completed scan' });
                const total = store.alloc[0] || 1;
                const rows: ExtensionRow[] = store.extNames
                    .map((ext, rank) => ({
                        ext,
                        label: extensionLabel(ext),
                        color: colorForRank(rank),
                        icon: iconForExtension(ext),
                        rank,
                        size: store.extSize[rank],
                        alloc: store.extAlloc[rank],
                        count: store.extCount[rank],
                        share: store.extAlloc[rank] / total,
                    }))
                    .filter((r) => r.count > 0);
                return send(res, 200, { rows, special: SPECIAL_COLORS }, {}, accept);
            }

            case '/api/node': {
                const id = nodeId();
                if (!store) return send(res, 409, { error: 'No completed scan' });
                if (id === null) return send(res, 400, { error: 'Bad node id' });
                return send(res, 200, { ...row(store, id), path: displayPathOf(store, id) });
            }

            case '/api/action': {
                if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
                if (!store) return send(res, 409, { error: 'No completed scan' });
                const { op, id } = await readJson<ActionRequest>(req);
                if (!Number.isInteger(id) || id < 0 || id >= store.count) {
                    return send(res, 400, { error: 'Bad node id' });
                }
                const target = pathOf(store, id);
                // Never act outside the tree the user actually scanned.
                if (!actions.isInside(store.root, target)) {
                    return send(res, 403, { error: 'Target is outside the scan root' });
                }

                switch (op) {
                    case 'reveal': await actions.reveal(target); break;
                    case 'open': await actions.open(target); break;
                    case 'trash':
                        await actions.trash(target);
                        detach(store, id);
                        break;
                    case 'delete':
                        if (id === 0) return send(res, 400, { error: 'Refusing to delete the scan root' });
                        await actions.remove(target);
                        detach(store, id);
                        break;
                    default:
                        return send(res, 400, { error: `Unknown action: ${String(op)}` });
                }
                return send(res, 200, { ok: true, path: toDisplayPath(target), summary: summary() });
            }

            default:
                return send(res, 404, { error: 'Not found' });
        }
    }

    return { server, token, state, beginScan, summary };
}

function parentOf(dir: string): string | null {
    const p = resolve(dir, '..');
    return p === resolve(dir) ? null : p;
}

/** Volumes worth offering in the picker, per platform. */
function listRoots(): { label: string; path: string }[] {
    const roots: { label: string; path: string }[] = [];
    const push = (label: string, path: string): void => {
        const shown = toDisplayPath(path);
        if (existsSync(path) && !roots.some((r) => r.path === shown)) roots.push({ label, path: shown });
    };

    if (process.platform === 'win32') {
        for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
            const drive = `${String.fromCharCode(c)}:${sep}`;
            if (existsSync(drive)) roots.push({ label: drive, path: toDisplayPath(drive) });
        }
    } else {
        push('/', '/');
        for (const dir of ['/Volumes', '/media', '/mnt']) {
            if (!existsSync(dir)) continue;
            try {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isDirectory() || entry.isSymbolicLink()) push(join(dir, entry.name), join(dir, entry.name));
                }
            } catch {
                /* unreadable mount point */
            }
        }
    }
    push('Home', homedir());
    return roots;
}
