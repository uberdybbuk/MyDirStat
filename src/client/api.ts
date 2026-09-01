/**
 * Typed client for the local API.
 *
 * The token arrives in the URL; it is moved into memory and the address bar is
 * scrubbed so it does not end up in history, bookmarks or a screenshot.
 */

import type {
    ActionOp, ActionResponse, AncestorsResponse, ChildrenResponse,
    ExtensionsResponse, NodeDetail, RootsResponse, ScanSummary,
    SizeMetric, TreemapResponse,
} from '../shared/protocol.js';

const TOKEN = new URLSearchParams(location.search).get('t') ?? '';
history.replaceState(null, '', location.pathname);

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
};
