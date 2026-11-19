/**
 * Shrink: show what would go before anything goes.
 *
 * The server says which development leftovers live under the folder, one row
 * per type with its size and count. Every type starts ticked. Unticking one
 * keeps it. Nothing is removed until one of the two delete buttons is pressed,
 * and the permanent one still goes through the app's typed-count confirmation.
 */

import { api } from './api.js';
import { el, escapeHtml } from './dom.js';
import { bytes, count, percent } from './format.js';
import type { ShrinkPreview, ShrinkType } from '../shared/protocol.js';

export interface ShrinkHandlers {
    remove(mode: 'trash' | 'permanent', under: number, types: string[], files: number, bytes: number): void;
}

const view = {
    preview: null as ShrinkPreview | null,
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
    el('shrink').hidden = true;
    view.preview = null;
}

export async function openShrink(id: number): Promise<void> {
    const preview = await api.shrink(id);
    view.preview = preview;
    view.kept = new Set();
    el('shrinkPath').textContent = preview.path;
    el('shrink').hidden = false;
    render();
    el('shrinkCancel').focus();
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

    el('shrinkRows').innerHTML =
        types.length === 0
            ? '<div class="empty">Nothing to remove here.</div>'
            : ordered
                  .map(([group, list]) =>
                      `<div class="group">${escapeHtml(group)}</div>` +
                      list.map((t) => rowHtml(t, t.size / total)).join('')
                  )
                  .join('');

    const picked = chosen();
    const files = picked.reduce((a, t) => a + t.count, 0);
    const size = picked.reduce((a, t) => a + t.size, 0);
    el('shrinkTotals').textContent =
        picked.length === 0 ? 'Nothing chosen' : `${count(files)} files · ${bytes(size)}`;
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
