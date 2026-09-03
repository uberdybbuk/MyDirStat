/**
 * The selection dialog: a checkbox tree over the scan, plus a name filter.
 *
 * All picking happens here. The main tree pane stays a read-only view of disk
 * usage, so browsing never risks changing what is about to be archived.
 *
 * Two modes share one list:
 *   - no filter: a lazily-expanded tree, tri-state checkboxes, folders first
 *   - filter set: the flat set of matching files anywhere in the scan, with a
 *     button to take or drop the whole match in one go
 *
 * Rows are rendered from a flattened array rather than nested DOM, so a folder
 * with fifty thousand children costs the same as one with five.
 */

import { api } from './api.js';
import { el, escapeHtml } from './dom.js';
import { bytes, count } from './format.js';
import { openTypes } from './type-dialog.js';
import { ARCHIVE_FORMATS, F_DIR } from '../shared/protocol.js';
import type { ArchiveFormat, SearchHit, SelectionSummary, TreeRow } from '../shared/protocol.js';

const ROW_H = 24;
const SIZE_KEY = 'mydirstat.picker.size';
const FORMAT_KEY = 'mydirstat.picker.format';
const SEARCH_LIMIT = 300;

interface Row {
    id: number;
    depth: number;
    row: TreeRow;
}

const view = {
    rows: new Map<number, TreeRow>(),
    kids: new Map<number, number[]>(),
    expanded: new Set<number>(),
    visible: [] as Row[],
    filter: '',
    hits: [] as SearchHit[],
    hitTotal: 0,
    generation: 0,
    /** Extension ranks currently selected, so the type dialog opens on them. */
    rules: [] as number[],
};

let onChanged: (summary: SelectionSummary) => void = () => undefined;

export function isOpen(): boolean {
    return !el('picker').hidden;
}

export function initPicker(changed: (summary: SelectionSummary) => void): void {
    onChanged = changed;
    watchSize();

    const formats = el<HTMLSelectElement>('pickerFormat');
    formats.innerHTML = ARCHIVE_FORMATS
        .map((f) => `<option value="${f.id}">${f.label} — ${f.detail}</option>`)
        .join('');
    try {
        const saved = localStorage.getItem(FORMAT_KEY);
        if (saved && ARCHIVE_FORMATS.some((f) => f.id === saved)) formats.value = saved;
    } catch {
        /* unreadable storage: the first option applies */
    }
    formats.onchange = () => {
        try {
            localStorage.setItem(FORMAT_KEY, formats.value);
        } catch {
            /* private browsing: the choice still applies this session */
        }
    };

    el('pickerClose').onclick = closePicker;
    el('pickerDone').onclick = closePicker;
    el('pickerClear').onclick = () => void mutate({ op: 'clear' });

    // Types are picked in their own dialog and land here as rules over the whole
    // scan, so the tree comes back reflecting them wherever those files are.
    el('pickerTypes').onclick = () => void chooseTypes();

    let debounce: ReturnType<typeof setTimeout> | null = null;
    el<HTMLInputElement>('pickerFilter').oninput = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void applyFilter(el<HTMLInputElement>('pickerFilter').value.trim()), 180);
    };

    el('pickerTakeAll').onclick = () => void mutate({ op: 'matching', text: view.filter, on: true });
    el('pickerDropAll').onclick = () => void mutate({ op: 'matching', text: view.filter, on: false });
    // Scoped to the matches while filtering, to the whole scan from the footer.
    el('pickerFlipAll').onclick = () => void mutate({ op: 'invert', text: view.filter });
    el('pickerInvert').onclick = () => void mutate({ op: 'invert' });

    el('pickerScroll').addEventListener('scroll', render, { passive: true });

    el('pickerRows').addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const box = target.closest<HTMLElement>('[data-pick]');
        if (box) {
            void mutate({ op: 'toggle', ids: [Number(box.dataset.pick)] });
            return;
        }
        const twisty = target.closest<HTMLElement>('[data-pexp]');
        if (twisty) {
            void toggleExpand(Number(twisty.dataset.pexp));
            return;
        }
        // Clicking anywhere on a folder row expands it; on a file row, picks it.
        const row = target.closest<HTMLElement>('.prow');
        if (!row) return;
        const id = Number(row.dataset.id);
        const record = view.rows.get(id);
        if (record && record.flags & F_DIR) void toggleExpand(id);
        else void mutate({ op: 'toggle', ids: [id] });
    });
}

export async function openPicker(): Promise<void> {
    el('picker').hidden = false;
    restoreSize();
    el<HTMLInputElement>('pickerFilter').value = '';
    view.filter = '';
    view.rows.clear();
    view.kids.clear();
    view.expanded.clear();

    const root = await api.children(0);
    view.rows.set(0, root.self);
    for (const row of root.rows) view.rows.set(row.i, row);
    view.kids.set(0, root.rows.map((r) => r.i));
    view.expanded.add(0);

    await refreshSummary();
    rebuild();
    el<HTMLInputElement>('pickerFilter').focus();
}

export function closePicker(): void {
    el('picker').hidden = true;
}

/* -------------------------------------------------------------- geometry -- */

/**
 * The dialog is resizable, and its size is worth keeping: people who enlarge it
 * once want it enlarged next time. A size saved on a larger display is clamped
 * to the current viewport, so a laptop never inherits an off-screen dialog from
 * an external monitor.
 */
function restoreSize(): void {
    const sheet = el('pickerSheet');
    try {
        const raw = localStorage.getItem(SIZE_KEY);
        if (!raw) return;
        const { w, h } = JSON.parse(raw) as { w?: number; h?: number };
        if (!Number.isFinite(w) || !Number.isFinite(h)) return;
        sheet.style.width = `${Math.min(w!, Math.round(innerWidth * 0.96))}px`;
        sheet.style.height = `${Math.min(h!, Math.round(innerHeight * 0.92))}px`;
    } catch {
        /* unreadable storage: the CSS default applies */
    }
}

function watchSize(): void {
    const sheet = el('pickerSheet');
    let save: ReturnType<typeof setTimeout> | null = null;

    new ResizeObserver(() => {
        if (el('picker').hidden) return;
        // A taller dialog shows more rows, and the list is virtualised — without
        // re-rendering, the space gained by dragging stays empty.
        render();
        if (save) clearTimeout(save);
        save = setTimeout(() => {
            const box = sheet.getBoundingClientRect();
            try {
                localStorage.setItem(SIZE_KEY, JSON.stringify({
                    w: Math.round(box.width),
                    h: Math.round(box.height),
                }));
            } catch {
                /* private browsing: resizing still works for this session */
            }
        }, 200);
    }).observe(sheet);
}

/* ------------------------------------------------------------------ data -- */

async function loadChildren(id: number): Promise<number[]> {
    const cached = view.kids.get(id);
    if (cached) return cached;
    const data = await api.children(id);
    for (const row of data.rows) view.rows.set(row.i, row);
    const ids = data.rows.map((r) => r.i);
    view.kids.set(id, ids);
    return ids;
}

async function toggleExpand(id: number): Promise<void> {
    const row = view.rows.get(id);
    if (!row || !(row.flags & F_DIR) || !row.kids) return;
    if (view.expanded.has(id)) {
        view.expanded.delete(id);
    } else {
        await loadChildren(id);
        view.expanded.add(id);
    }
    rebuild();
}

async function applyFilter(text: string): Promise<void> {
    view.filter = text;
    const generation = ++view.generation;

    if (text.length === 0) {
        view.hits = [];
        view.hitTotal = 0;
        rebuild();
        return;
    }

    const data = await api.search(text, SEARCH_LIMIT);
    // A newer keystroke may have overtaken this request.
    if (generation !== view.generation) return;
    view.hits = data.hits;
    view.hitTotal = data.total;
    rebuild();
}

async function chooseTypes(): Promise<void> {
    const chosen = await openTypes(view.rules);
    if (chosen === null) return; // dismissed: leave the selection alone
    await mutate({ op: 'extensions', ranks: chosen });
}

async function mutate(op: Parameters<typeof api.selection>[0]): Promise<void> {
    try {
        const summary = await api.selection(op);
        onChanged(summary);
        setSummary(summary);
        await refreshStates();
        rebuild();
    } catch (err) {
        el('pickerNote').textContent = err instanceof Error ? err.message : String(err);
    }
}

/**
 * Checkbox state is computed server-side, so every cached row is stale after a
 * change.
 *
 * The cache is dropped wholesale rather than patched. Refreshing only the
 * folders that happen to be expanded leaves the rest of the cache stale but
 * still present, and a collapsed folder's rows are shown again the moment it is
 * re-expanded — so ticking a collapsed folder produced children that still
 * looked unticked. Worse, collapsing a folder does not un-expand its
 * descendants, so a *deeper* folder could stay in the refresh set while its own
 * parent went stale, giving an unticked folder full of ticked children.
 *
 * Everything still on screen is refetched; everything else is discarded and
 * reloaded lazily when it is expanded again.
 */
async function refreshStates(): Promise<void> {
    if (view.filter) {
        const data = await api.search(view.filter, SEARCH_LIMIT);
        view.hits = data.hits;
        view.hitTotal = data.total;
    }

    // The tree cache is refreshed even while the filter is active. Clearing the
    // filter returns to the tree without another round trip, so leaving the
    // cache stale here meant a bulk selection made under a filter showed an
    // entirely unticked tree afterwards.
    view.rows.clear();
    view.kids.clear();

    // The root is always visible, but its own state arrives as `self`, so it is
    // fetched even when collapsed.
    const targets = [...new Set<number>([0, ...view.expanded])];
    const pages = await Promise.all(targets.map((id) => api.children(id)));
    pages.forEach((page, k) => {
        const id = targets[k];
        if (id === 0) view.rows.set(0, page.self);
        for (const row of page.rows) view.rows.set(row.i, row);
        view.kids.set(id, page.rows.map((r) => r.i));
    });
}

async function refreshSummary(): Promise<void> {
    setSummary(await api.selectionSummary());
}

function setSummary(summary: SelectionSummary): void {
    view.rules = summary.rules.extensions;
    // Always show the denominator: "nothing selected" says nothing about how
    // much there is to choose from.
    const pool = `${count(summary.availableFiles)} files · ${bytes(summary.availableBytes)}`;
    el('pickerTotals').textContent =
        summary.files === 0
            ? `Nothing selected of ${pool}`
            : `${count(summary.files)} of ${count(summary.availableFiles)} files · ` +
              `${bytes(summary.bytes)} of ${bytes(summary.availableBytes)} · ` +
              `about ${bytes(summary.estimatedZipBytes)} zipped`;
    // Nothing selected means nothing to archive, clear or delete, so every
    // action that acts on a selection is inert until there is one. Invert is
    // not one of them: with nothing picked it means "take everything".
    const idle = summary.files === 0;
    for (const id of ['pickerZip', 'pickerClear', 'pickerTrash', 'pickerErase']) {
        el<HTMLButtonElement>(id).disabled = idle;
    }
}

/* -------------------------------------------------------------- rendering -- */

function rebuild(): void {
    const out: Row[] = [];
    if (!view.filter) {
        const walk = (id: number, depth: number): void => {
            const row = view.rows.get(id);
            if (!row) return;
            out.push({ id, depth, row });
            if (!view.expanded.has(id)) return;
            for (const child of view.kids.get(id) ?? []) walk(child, depth + 1);
        };
        walk(0, 0);
    }
    view.visible = out;

    const total = view.filter ? view.hits.length : out.length;
    el('pickerSizer').style.height = `${total * ROW_H}px`;

    const filtering = view.filter.length > 0;
    el('pickerBulk').hidden = !filtering;
    el('pickerNote').textContent = filtering
        ? view.hitTotal > view.hits.length
            ? `${count(view.hitTotal)} matches, showing the first ${count(view.hits.length)}`
            : `${count(view.hitTotal)} matches`
        : '';
    el('pickerTakeAll').textContent = `Select all ${count(view.hitTotal)}`;
    el('pickerDropAll').textContent = `Deselect all ${count(view.hitTotal)}`;
    el('pickerFlipAll').textContent = `Invert ${count(view.hitTotal)}`;
    render();
}

const checkbox = (id: number, sel: number): string =>
    `<span class="cbx" data-pick="${id}" role="checkbox" aria-checked="${['false', 'mixed', 'true'][sel] ?? 'false'}"></span>`;

const icon = (name: string): string =>
    `<img class="ficon" src="/icons/${encodeURIComponent(name)}.svg" alt="" loading="lazy" decoding="async">`;

function render(): void {
    const scroll = el('pickerScroll');
    const source = view.filter ? view.hits : view.visible;
    const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_H) - 3);
    const shown = Math.min(source.length - first, Math.ceil(scroll.clientHeight / ROW_H) + 6);

    const html: string[] = [];
    for (let k = 0; k < shown; k++) {
        if (view.filter) {
            const hit = view.hits[first + k];
            html.push(
                `<div class="prow hit" data-id="${hit.i}">` +
                    `<div class="name">${checkbox(hit.i, hit.sel)}${icon(hit.icon)}` +
                        `<span class="label">${escapeHtml(hit.n)}</span>` +
                        `<span class="where">${escapeHtml(hit.rel)}</span>` +
                    `</div>` +
                    `<div class="num">${bytes(hit.size)}</div>` +
                `</div>`
            );
            continue;
        }

        const { id, depth, row } = view.visible[first + k];
        const isDir = (row.flags & F_DIR) !== 0;
        const open = view.expanded.has(id);
        const label = id === 0 ? row.n.split('/').filter(Boolean).pop() ?? row.n : row.n;
        html.push(
            `<div class="prow" data-id="${id}">` +
                `<div class="name" style="padding-left:${4 + depth * 15}px">` +
                    `<button class="twisty${isDir && row.kids ? '' : ' leaf'}" data-pexp="${id}" tabindex="-1">${open ? '▼' : '▶'}</button>` +
                    checkbox(id, row.sel) +
                    icon(row.icon) +
                    `<span class="label">${escapeHtml(label)}</span>` +
                `</div>` +
                // Logical size, matching the header and what the archive holds —
                // not the on-disk size the main tree shows.
                `<div class="num">${bytes(row.size)}</div>` +
            `</div>`
        );
    }

    const rows = el('pickerRows');
    rows.style.transform = `translateY(${first * ROW_H}px)`;
    rows.innerHTML = html.join('');
}


/** The archive format currently chosen in the dialog. */
export function selectedFormat(): ArchiveFormat {
    return el<HTMLSelectElement>('pickerFormat').value as ArchiveFormat;
}
