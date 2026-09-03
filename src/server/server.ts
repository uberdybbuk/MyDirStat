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
import { promises as fs, existsSync, opendirSync, readdirSync, statSync } from 'node:fs';
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
import { Selection, isPrecompressed } from './selection.js';
import { ArchiveManager, type ArchiveEntry } from './archive.js';
import { DeleteJob } from './delete-job.js';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { F_DIR } from '../shared/protocol.js';
import { ARCHIVE_FORMATS } from '../shared/protocol.js';
import type {
    ActionRequest, ArchiveFormat, BrowseResponse, DeleteMode, DeleteRequest, DeleteTarget, ExtensionRow, RootsResponse,
    ScanProgress, ScanStatus, ScanSummary, SearchHit, SearchResponse,
    SelectionOp, SelectionSummary, SizeMetric, TreeRow,
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
    let selection: Selection | null = null;
    const listeners = new Set<ServerResponse>();

    const zips = new ArchiveManager((job) => broadcast('zip', job.status()));
    let deletion: DeleteJob | null = null;

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

        broadcast('start', { root: toDisplayPath(root), scanId: state.scanId, startedAt: state.startedAt });

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
                // Node ids only mean anything within one scan.
                selection = new Selection(store);
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
                startedAt: state.startedAt,
                root: state.root === null ? null : toDisplayPath(state.root),
                error: state.error,
                progress: { ...state.progress, path: toDisplayPath(state.progress.path) },
            };
        }
        return {
            status: state.status,
            scanId: state.scanId,
            startedAt: state.startedAt,
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
            sel: selection ? selection.state(i) : 0,
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
     * Cut a node out of its parent's child chain after it has been removed from
     * disk, so the UI stays honest without forcing a rescan.
     *
     * Only the link is touched. Every total is rebuilt afterwards by
     * `store.recompute()`, once per batch rather than once per node: patching
     * ancestor totals node by node is what let a single miscount leave a
     * directory reporting more bytes than the root above it.
     */
    function unlink(store: NodeStore, id: number): void {
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
        store.sib[id] = -1;
    }

    /** Re-derive every total, and drop the selection totals computed from them. */
    function settle(store: NodeStore): void {
        store.recompute();
        selection?.invalidate();
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
                const volumes = listRoots();
                // The picker only earns its place where a volume is not
                // guessable: a Windows drive letter, or a second real device.
                // On a single-disk Mac it would just offer "/" and "~", which
                // are two keystrokes to type.
                const showPicker = process.platform === 'win32' || volumes.length > 1;
                if (showPicker) volumes.push({ label: 'Home', path: toDisplayPath(homedir()) });

                const body: RootsResponse = {
                    roots: volumes,
                    showPicker,
                    home: toDisplayPath(homedir()),
                    cwd: toDisplayPath(process.cwd()),
                };
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
                if (!body.path) return send(res, 400, { error: 'Enter a directory to scan' });
                const wanted = toNativePath(body.path);
                const problem = unreadable(wanted, body.path);
                if (problem) return send(res, 400, { error: problem });
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

            case '/api/selection': {
                if (!store || !selection) return send(res, 409, { error: 'No completed scan' });

                if (req.method === 'POST') {
                    const body = await readJson<SelectionOp>(req);
                    switch (body.op) {
                        case 'include': selection.include(body.ids); break;
                        case 'exclude': selection.exclude(body.ids); break;
                        case 'toggle': selection.toggle(body.ids); break;
                        case 'extension': selection.setExtension(body.ext, body.on); break;
                        case 'extensions': selection.setExtensions(body.ranks); break;
                        case 'matching': {
                            const { ids } = selection.searchAll(body.text, Number.MAX_SAFE_INTEGER);
                            if (body.on) selection.include(ids);
                            else selection.exclude(ids);
                            break;
                        }
                        case 'clear': selection.clear(); break;
                        default: return send(res, 400, { error: 'Unknown selection op' });
                    }
                }

                const resolved = selection.resolve();
                const available = selection.available();
                const body: SelectionSummary = {
                    files: resolved.totalFiles,
                    bytes: resolved.totalBytes,
                    availableFiles: available.files,
                    availableBytes: available.bytes,
                    estimatedZipBytes: resolved.estimatedBytes,
                    baseId: resolved.baseId,
                    basePath: displayPathOf(store, resolved.baseId),
                    rules: selection.ruleCounts,
                };
                return send(res, 200, body);
            }

            case '/api/selection/states': {
                // Selection state for arbitrary nodes. Lets a client assert that
                // what it renders matches what the server actually thinks.
                if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
                if (!store || !selection) return send(res, 409, { error: 'No completed scan' });
                const { ids } = await readJson<{ ids: number[] }>(req);
                const states = ids.map((n) =>
                    Number.isInteger(n) && n >= 0 && n < store.count ? selection!.state(n) : 0
                );
                return send(res, 200, { states }, {}, accept);
            }

            case '/api/search': {
                if (!store || !selection) return send(res, 409, { error: 'No completed scan' });
                const text = (url.searchParams.get('text') ?? '').trim();
                const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
                if (text.length === 0) return send(res, 200, { total: 0, hits: [] });

                const { ids, total } = selection.searchAll(text, limit);
                const hits: SearchHit[] = ids.map((id) => ({
                    i: id,
                    n: store.name(id),
                    rel: store.segments(id).join('/'),
                    size: store.size[id],
                    icon: iconForFile(store.name(id)),
                    sel: selection!.state(id),
                }));
                return send(res, 200, { total, hits } satisfies SearchResponse, {}, accept);
            }

            case '/api/zip': {
                if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
                if (!store || !selection) return send(res, 409, { error: 'No completed scan' });
                const resolved = selection.resolve();
                if (resolved.totalFiles === 0) return send(res, 400, { error: 'Nothing selected' });

                const base = resolved.baseId;
                const entries: ArchiveEntry[] = Array.from(resolved.ids, (id) => {
                    const name = store.name(id);
                    return {
                        path: pathOf(store, id),
                        entry: selection!.entryName(id, base),
                        size: store.size[id],
                        mtime: store.mtime[id],
                        stored: isPrecompressed(name),
                    };
                });

                const requested = (await readJson<{ format?: ArchiveFormat }>(req)).format;
                const format: ArchiveFormat = requested === 'zip' ? 'zip' : '7z';
                const info = ARCHIVE_FORMATS.find((f) => f.id === format)!;

                const stamp = new Date().toISOString().slice(0, 10);
                const label = basename(pathOf(store, base)) || 'archive';
                const job = zips.start({
                    entries,
                    // Entry paths are relative to the selection's common base,
                    // so that is where 7-Zip has to run.
                    baseDir: pathOf(store, base),
                    name: `${label}-${stamp}${info.extension}`,
                    format,
                });
                return send(res, 202, job.status());
            }

            case '/api/delete': {
                if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
                if (!store || !selection) return send(res, 409, { error: 'No completed scan' });
                if (deletion && deletion.state === 'running') {
                    return send(res, 409, { error: 'A deletion is already running' });
                }

                const body = await readJson<DeleteRequest>(req);
                const mode: DeleteMode = body.mode === 'permanent' ? 'permanent' : 'trash';

                // Two scopes: whatever is selected, or every file of the named
                // types. The type dialog uses the second so that deleting a file
                // type never depends on, or disturbs, the current selection.
                const types = Array.isArray(body.types) ? body.types.filter((t) => typeof t === 'string') : null;
                const picked = selection.resolve();
                const scope = types
                    ? selection.filesOfTypes(types)
                    : { ids: Array.from(picked.ids), files: picked.totalFiles };
                if (scope.files === 0) {
                    return send(res, 400, { error: types ? 'No files of those types' : 'Nothing selected' });
                }

                // Permanent removal has no undo, so the client has to echo the
                // exact count back. A stale dialog therefore cannot delete a
                // set the user never saw.
                if (mode === 'permanent' && body.confirm !== scope.files) {
                    return send(res, 409, {
                        error: `Confirmation does not match what would be deleted (${scope.files} files)`,
                    });
                }

                const targets: DeleteTarget[] = Array.from(scope.ids, (id) => ({
                    id,
                    path: pathOf(store, id),
                    label: store.segments(id).join('/'),
                    size: store.size[id],
                }));
                // Never act outside the tree that was actually scanned.
                for (const target of targets) {
                    if (!actions.isInside(store.root, target.path)) {
                        return send(res, 403, { error: 'Target is outside the scan root' });
                    }
                }

                // Own totals have to be recorded while the tree still adds up.
                store.captureOwn();
                deletion = new DeleteJob(
                    targets,
                    mode,
                    (id) => unlink(store, id),
                    (job) => broadcast('delete', job.status())
                );
                void deletion.done.then(() => {
                    settle(store);
                    // Deleting the selection consumes it — the rules now point at
                    // nothing. Deleting a file type has nothing to do with what
                    // the user had picked, so that is left alone.
                    if (!types) selection?.clear();
                    broadcast('done', summary());
                });
                return send(res, 202, deletion.status());
            }

            case '/api/delete/status': {
                if (!deletion) return send(res, 404, { error: 'No deletion' });
                return send(res, 200, deletion.status());
            }

            case '/api/delete/cancel': {
                if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
                deletion?.cancel();
                return send(res, 200, { ok: true });
            }

            case '/api/zip/cancel': {
                if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
                const { id } = await readJson<{ id: string }>(req);
                zips.get(id)?.cancel();
                return send(res, 200, { ok: true });
            }

            case '/api/zip/status': {
                const job = zips.get(url.searchParams.get('id') ?? '');
                if (!job) return send(res, 404, { error: 'No such job' });
                return send(res, 200, job.status());
            }

            case '/api/zip/download': {
                const job = zips.get(url.searchParams.get('id') ?? '');
                if (!job) return send(res, 404, { error: 'No such job' });
                if (job.state !== 'done') return send(res, 409, { error: `Archive is ${job.state}` });

                res.writeHead(200, {
                    'content-type': 'application/zip',
                    'content-length': String(job.size ?? 0),
                    // The filename is derived from a scanned directory name, so
                    // quotes and newlines are stripped rather than trusted.
                    'content-disposition': `attachment; filename="${job.name.replace(/["\r\n]/g, '')}"`,
                    'cache-control': 'no-store',
                });
                const body = createReadStream(job.file);
                body.pipe(res);
                // The archive is disposable once it has been handed over.
                res.on('close', () => void zips.remove(job.id));
                return;
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
                        store.captureOwn();
                        unlink(store, id);
                        settle(store);
                        break;
                    case 'delete':
                        if (id === 0) return send(res, 400, { error: 'Refusing to delete the scan root' });
                        await actions.remove(target);
                        store.captureOwn();
                        unlink(store, id);
                        settle(store);
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

/**
 * Why a directory cannot be scanned, or null if it can.
 *
 * Checked before the worker starts so the answer comes back on the request the
 * user made, rather than as an event they may not be watching. A directory that
 * exists but cannot be listed is the case worth spending an `opendir` on: a
 * plain existence check passes it, and the scan then completes "successfully"
 * over an empty tree, which reads as "this folder is empty" rather than "you
 * are not allowed to look".
 */
function unreadable(path: string, shown: string): string | null {
    let dir;
    try {
        dir = opendirSync(path);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return `No such directory: ${shown}`;
        if (code === 'ENOTDIR') return `Not a directory: ${shown}`;
        if (code === 'EACCES' || code === 'EPERM') return `Permission denied: ${shown}`;
        if (code === 'ELOOP') return `Too many symbolic links: ${shown}`;
        if (code === 'ENAMETOOLONG') return `Path is too long: ${shown}`;
        return `Cannot open ${shown}${code ? ` (${code})` : ''}`;
    }
    dir.closeSync();
    return null;
}

function parentOf(dir: string): string | null {
    const p = resolve(dir, '..');
    return p === resolve(dir) ? null : p;
}

/** Volumes worth offering in the picker, per platform. */
/**
 * Mounted volumes, one entry per actual device.
 *
 * Deduplication is by device id rather than by path, because macOS presents the
 * startup disk at both `/` and `/Volumes/<name>` through a firmlink — listing
 * both offers the same disk twice under different names. The home directory is
 * almost always on a volume already listed, so it is only added as a
 * convenience once the picker has a reason to exist at all.
 */
function listRoots(): { label: string; path: string }[] {
    const seen = new Set<number>();
    const roots: { label: string; path: string }[] = [];

    const push = (label: string, path: string): void => {
        let device: number;
        try {
            device = statSync(path).dev;
        } catch {
            return; // gone, or not readable
        }
        if (seen.has(device)) return;
        seen.add(device);
        roots.push({ label, path: toDisplayPath(path) });
    };

    if (process.platform === 'win32') {
        for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
            push(`${String.fromCharCode(c)}:${sep}`, `${String.fromCharCode(c)}:${sep}`);
        }
    } else {
        // "/" first, so the startup disk is named "/" rather than by whichever
        // mount point happens to be read first.
        push('/', '/');
        for (const dir of ['/Volumes', '/media', '/mnt']) {
            if (!existsSync(dir)) continue;
            try {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isDirectory() || entry.isSymbolicLink()) {
                        push(entry.name, join(dir, entry.name));
                    }
                }
            } catch {
                /* unreadable mount point */
            }
        }
    }
    return roots;
}
