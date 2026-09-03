/**
 * Typed client for the local API.
 *
 * The token arrives in the URL; it is moved into memory and the address bar is
 * scrubbed so it does not end up in history, bookmarks or a screenshot.
 */

import type {
    ActionOp, ActionResponse, AncestorsResponse, ChildrenResponse,
    ExtensionsResponse, NodeDetail, RootsResponse, ScanSummary,
    SearchResponse, SelectionOp, SelectionSummary,
    DeleteStatus, SizeMetric, TreemapResponse, ZipStatus,
} from '../shared/protocol.js';

import { encodePathParam } from '../shared/paths.js';

const TOKEN_KEY = 'mydirstat.token';

/** Rewrite the address bar to describe what is on screen, minus the token. */
export function setUrlPath(path: string | null): void {
    const query = path ? `?path=${encodePathParam(path)}` : '';
    history.replaceState(null, '', location.pathname + query);
}

export function requestedPath(): string | null {
    return new URLSearchParams(location.search).get('path');
}

/**
 * The token must survive a reload, but keeping it in the address bar would put
 * it in history, bookmarks and any screenshot. sessionStorage is the middle
 * ground: it outlives a reload of this tab and dies with it. The URL keeps only
 * the scanned path, which is what makes the address bar meaningful.
 */
function recoverToken(): string {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('t');
    if (fromUrl) {
        try {
            sessionStorage.setItem(TOKEN_KEY, fromUrl);
        } catch {
            /* blocked storage: this session still works, a reload will not */
        }
        setUrlPath(params.get('path'));
        return fromUrl;
    }
    try {
        return sessionStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
        return '';
    }
}

const TOKEN = recoverToken();

export const token = TOKEN;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
        ...options,
        headers: {
            'x-mydirstat-token': TOKEN,
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
        },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (res.status === 403) {
        throw new Error('This page is no longer authorised — reopen the URL that mydirstat printed.');
    }
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body;
}

const post = <T>(path: string, data: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: JSON.stringify(data) });

export const api = {
    state: () => request<ScanSummary>('/api/state'),
    roots: () => request<RootsResponse>('/api/roots'),
    children: (id: number) => request<ChildrenResponse>(`/api/children?id=${id}`),
    ancestors: (id: number) => request<AncestorsResponse>(`/api/ancestors?id=${id}`),
    node: (id: number) => request<NodeDetail>(`/api/node?id=${id}`),
    extensions: () => request<ExtensionsResponse>('/api/extensions'),
    treemap: (id: number, metric: SizeMetric, area: number, minTile: number) =>
        request<TreemapResponse>(`/api/treemap?id=${id}&metric=${metric}&area=${area}&minTile=${minTile}`),
    scan: (path: string) => post<{ status: string; root: string }>('/api/scan', { path }),
    cancel: () => post<{ ok: true }>('/api/cancel', {}),
    action: (op: ActionOp, id: number) => post<ActionResponse>('/api/action', { op, id }),
    events: () => new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`),

    selectionSummary: () => request<SelectionSummary>('/api/selection'),
    selection: (op: SelectionOp) => post<SelectionSummary>('/api/selection', op),
    search: (text: string, limit: number) =>
        request<SearchResponse>(`/api/search?text=${encodeURIComponent(text)}&limit=${limit}`),

    zip: (format: string) => post<ZipStatus>('/api/zip', { format }),
    zipStatus: (id: string) => request<ZipStatus>(`/api/zip/status?id=${encodeURIComponent(id)}`),
    zipCancel: (id: string) => post<{ ok: true }>('/api/zip/cancel', { id }),

    /** Without `types`, the current selection; with it, every file of those types. */
    deleteSelection: (mode: 'trash' | 'permanent', confirm?: number, types?: string[]) =>
        post<DeleteStatus>('/api/delete', { mode, confirm, types }),
    deleteCancel: () => post<{ ok: true }>('/api/delete/cancel', {}),
    /** Plain navigation, so the browser handles the save dialog itself. */
    zipDownloadUrl: (id: string) =>
        `/api/zip/download?id=${encodeURIComponent(id)}&t=${encodeURIComponent(TOKEN)}`,
};
