/**
 * Shrink: show what would go before anything goes.
 *
 * The server says which development leftovers live under the folder, one row
 * per type with its size and count. Every type starts ticked. Unticking one
 * keeps it. Nothing changes on disk until Shrink is pressed, and the permanent
 * variant still goes through the app's typed-count confirmation.
 *
 * Finding generated proxies means reading the start of every .cs file, which
 * takes a while on a large tree. The dialog opens at once and shows that
 * search's progress, so a slow folder never looks like a click that did nothing.
 */

import { api } from './api.js';
import { el, escapeHtml } from './dom.js';
import { bytes, count, percent } from './format.js';
import type { ShrinkPreview, ShrinkProgress, ShrinkType } from '../shared/protocol.js';

export interface ShrinkHandlers {
    remove(mode: 'trash' | 'permanent', under: number, types: string[], files: number, bytes: number): void;
}

const view = {
    preview: null as ShrinkPreview | null,
    /** The folder being looked at; set while loading too, so progress can be matched to it. */
    loadingId: null as number | null,
    kept: new Set<string>(),
};

let handlers: ShrinkHandlers = { remove: () => undefined };

export function initShrink(hooks: ShrinkHandlers): void {
    handlers = hooks;

    el('shrinkClose').onclick = closeShrink;
    el('shrinkCancel').onclick = closeShrink;
    el('shrinkTrash').onclick = () => remove('trash');
    el('shrinkErase').onclick = () => remove('permanent');

    el('shrinkRows').addEventListener('click', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-ext]');
        if (!row) return;
        const ext = row.dataset.ext!;
        if (view.kept.has(ext)) view.kept.delete(ext);
        else view.kept.add(ext);
        render();
    });
}

export function closeShrink(): void {
    // Closing while the server is still reading files stops it reading.
    if (view.loadingId !== null) void api.shrinkCancel().catch(() => undefined);
    el('shrink').hidden = true;
    view.preview = null;
    view.loadingId = null;
}

export async function openShrink(id: number): Promise<void> {
    view.preview = null;
    view.loadingId = id;
    view.kept = new Set();
    el('shrinkPath').textContent = '';
    void api.node(id).then((node) => {
        if (view.loadingId === id) el('shrinkPath').textContent = node.path;
    }, () => undefined);
    showLoading('Looking for files to shrink…', 0, '');
    el('shrink').hidden = false;
    render();
    el('shrinkCancel').focus();

    let preview: ShrinkPreview;
    try {
        preview = await api.shrink(id);
    } catch (err) {
        // Cancelled or replaced by a newer look: nothing to report.
        if (view.loadingId !== id) return;
        view.loadingId = null;
        closeShrink();
        throw err;
    }
    if (view.loadingId !== id) return;
    view.loadingId = null;
    view.preview = preview;
    el('shrinkPath').textContent = preview.path;
    el('shrinkLoading').hidden = true;
    render();
}

/** Progress of the server's look through the .cs files, from the event stream. */
export function shrinkProgress(p: ShrinkProgress): void {
    if (view.loadingId !== p.id || p.total === 0) return;
    const proxies = p.found === 1 ? '1 generated proxy' : `${count(p.found)} generated proxies`;
    showLoading(
        'Looking for generated web service proxies…',
        p.done / p.total,
        `${count(p.done)} of ${count(p.total)} .cs files read · ${proxies} found`
    );
}

function showLoading(text: string, fraction: number, detail: string): void {
    el('shrinkLoading').hidden = false;
    el('shrinkLoadingText').textContent = text;
    el<HTMLElement>('shrinkLoadingBar').style.width = `${Math.round(fraction * 100)}%`;
    el('shrinkLoadingDetail').textContent = detail;
}

function chosen(): ShrinkType[] {
    return (view.preview?.types ?? []).filter((t) => !view.kept.has(t.ext));
}

function remove(mode: 'trash' | 'permanent'): void {
    const preview = view.preview;
    const picked = chosen();
    if (!preview || picked.length === 0) return;
    closeShrink();
    handlers.remove(
        mode,
        preview.id,
        picked.map((t) => t.ext),
        picked.reduce((a, t) => a + t.count, 0),
        picked.reduce((a, t) => a + t.size, 0)
    );
}

function render(): void {
    const types = view.preview?.types ?? [];
    const total = types.reduce((a, t) => a + t.size, 0) || 1;

    // Grouped the way the server groups them, biggest group first.
    const groups = new Map<string, ShrinkType[]>();
    for (const t of types) {
        const list = groups.get(t.group) ?? [];
        list.push(t);
        groups.set(t.group, list);
    }
    const ordered = [...groups].sort(
        (a, b) => b[1].reduce((s, t) => s + t.size, 0) - a[1].reduce((s, t) => s + t.size, 0)
    );

    const loading = view.preview === null;
    el('shrinkRows').innerHTML = loading
        ? ''
        : types.length === 0
            ? '<div class="empty">Nothing to shrink here.</div>'
            : ordered
                  .map(([group, list]) =>
                      `<div class="group">${escapeHtml(group)}</div>` +
                      list.map((t) => rowHtml(t, t.size / total)).join('')
                  )
                  .join('');

    const picked = chosen();
    const files = picked.reduce((a, t) => a + t.count, 0);
    const size = picked.reduce((a, t) => a + t.size, 0);
    el('shrinkTotals').textContent = loading
        ? ''
        : picked.length === 0 ? 'Nothing chosen' : `${count(files)} files · ${bytes(size)} saved`;
    el('shrinkNote').textContent =
        view.kept.size === 0 ? '' : `${count(view.kept.size)} ${view.kept.size === 1 ? 'type' : 'types'} kept`;

    for (const id of ['shrinkTrash', 'shrinkErase']) {
        el<HTMLButtonElement>(id).disabled = picked.length === 0;
    }
}

function rowHtml(t: ShrinkType, share: number): string {
    const on = !view.kept.has(t.ext);
    return (
        `<div class="erow type-grid${on ? ' sel' : ''}" data-ext="${escapeHtml(t.ext)}">` +
            `<div class="name">` +
                `<span class="cbx" role="checkbox" aria-checked="${on}"></span>` +
                `<span class="swatch" style="background:${t.color}"></span>` +
                `<img class="ficon" src="/icons/${encodeURIComponent(t.icon)}.svg" alt="" loading="lazy" decoding="async">` +
                `<span class="label">${escapeHtml(t.label)}</span>` +
            `</div>` +
            `<div class="num">${bytes(t.size)}</div>` +
            `<div class="pct" style="--f:${share.toFixed(4)}"><i></i><span>${percent(share)}</span></div>` +
            `<div class="num dim">${count(t.count)}</div>` +
        `</div>`
    );
}
