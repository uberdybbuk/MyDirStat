/** Three-pane UI: directory tree, extension legend, treemap; all cross-linked. */

import { Treemap, type Rgb, type Tile } from './treemap.js';
import { api, requestedPath, setUrlPath } from './api.js';
import { el, all, escapeHtml, hexToRgb } from './dom.js';
import { bytes, count, percent, when } from './format.js';
import { installColumnResizers, TREE_COLUMNS, EXT_COLUMNS } from './columns.js';
import { initTypes, isTypesOpen, closeTypes } from './type-dialog.js';
import { initPathInput } from './path-input.js';
import { initPicker, openPicker, closePicker, isOpen as isPickerOpen, selectedFormat } from './select-dialog.js';
import { ARCHIVE_FORMATS, F_DIR, F_LINK, F_ERROR, F_SKIPPED, F_DUP } from '../shared/protocol.js';
import type {
    ExtensionRow, NodeDetail, ScanProgress, ScanSummary,
    DeleteStatus, SelectionSummary, SizeMetric, SpecialColors, TreeRow, TreemapNode, ZipStatus,
} from '../shared/protocol.js';

const ROW_H = 22;

/**
 * Sizes are reported as apparent — the sum of file lengths — everywhere.
 *
 * The on-disk figure (block-rounded allocation) is what answers "how much space
 * will I get back", and the server still computes and serves it; only the UI
 * switch is gone. Flip this back to 'alloc' and restore the toolbar control to
 * bring it back.
 */
const METRIC: SizeMetric = 'size';

// Smallest tile worth sending, in device pixels. Small on purpose: a higher
// floor folds most individual files away, and the folded mass then dominates
// the map as one tile.
const MIN_TILE = 4;

type SortKey = 'name' | 'size' | 'pct' | 'items' | 'mtime';
type ExtSortKey = 'type' | 'size' | 'pct' | 'count';

interface VisibleRow {
    id: number;
    depth: number;
}

interface State {
    status: ScanSummary['status'];
    summary: ScanSummary | null;
    zoom: number;
    selected: number | null;
    rows: Map<number, TreeRow>;
    kids: Map<number, number[]>;
    expanded: Set<number>;
    visible: VisibleRow[];
    extensions: ExtensionRow[];
    colorByRank: Map<number, string>;
    rgbByRank: Map<number, Rgb>;
    special: SpecialColors;
    specialRgb: Record<keyof SpecialColors, Rgb>;
    highlight: number | null;
    sort: { key: SortKey; dir: 1 | -1 };
    extSort: { key: ExtSortKey; dir: 1 | -1 };
    menuTarget: number | null;
    selection: SelectionSummary | null;
    zipId: string | null;
}

const state: State = {
    status: 'idle',
    summary: null,
    zoom: 0,
    selected: null,
    rows: new Map(),
    kids: new Map(),
    expanded: new Set(),
    visible: [],
    extensions: [],
    colorByRank: new Map(),
    rgbByRank: new Map(),
    special: { dir: '#6b7280', other: '#8b9096', unreadable: '#54585e' },
    specialRgb: { dir: [107, 114, 128], other: [139, 144, 150], unreadable: [84, 88, 94] },
    highlight: null,
    sort: { key: 'size', dir: -1 },
    extSort: { key: 'size', dir: -1 },
    menuTarget: null,
    selection: null,
    zipId: null,
};

const valueOf = (row: TreeRow | NodeDetail): number => row.size;

/* ------------------------------------------------------------- treemap ---- */

const canvas = el<HTMLCanvasElement>('map');
const map = new Treemap(canvas);

function refreshColors(): void {
    state.specialRgb = {
        dir: hexToRgb(state.special.dir),
        other: hexToRgb(state.special.other),
        unreadable: hexToRgb(state.special.unreadable),
    };
    state.rgbByRank = new Map([...state.colorByRank].map(([rank, hex]) => [rank, hexToRgb(hex)] as const));
}

// Directories and folded aggregates report the type that dominates their bytes,
// so a region too fine to subdivide still reads as "mostly video" than as grey.
map.colorOf = (node: TreemapNode): Rgb => {
    if (node.f & (F_ERROR | F_SKIPPED)) return state.specialRgb.unreadable;
    const byExt = state.rgbByRank.get(node.e);
    if (byExt) return byExt;
    return node.f & F_DIR || node.g ? state.specialRgb.dir : state.specialRgb.other;
};

function mapArea(): number {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return Math.max(1, Math.round(rect.width * dpr * rect.height * dpr));
}

let mapRequest = 0;
async function loadTreemap(): Promise<void> {
    if (state.status !== 'ready') return;
    const seq = ++mapRequest;
    const data = await api.treemap(state.zoom, METRIC, mapArea(), MIN_TILE);
    if (seq !== mapRequest) return; // a newer request already won
    // The server moves the zoom up out of anything that has been deleted, so
    // the map never draws a folder that is no longer there. Follow it.
    if (data.id !== state.zoom) {
        state.zoom = data.id;
        await renderCrumbs();
    }
    map.setData(data.root);
    map.render();
    syncMapSelection();
    const empty = el('mapEmpty');
    empty.hidden = data.root.v > 0;
    if (data.root.v <= 0) empty.textContent = 'Nothing to show here';
}

function syncMapSelection(): void {
    const tile = state.selected === null ? null : map.tileForId(state.selected);
    if (map.setSelected(tile)) map.overlay();
}

/* ----------------------------------------------------------- tree pane ---- */

function sortRows(ids: readonly number[]): number[] {
    const { key, dir } = state.sort;
    const get = (id: number): string | number => {
        const row = state.rows.get(id)!;
        switch (key) {
            case 'name': return row.n.toLowerCase();
            case 'items': return row.files + row.dirs;
            case 'mtime': return row.mtime;
            default: return valueOf(row);
        }
    };
    return [...ids].sort((a, b) => {
        const x = get(a);
        const y = get(b);
        if (x < y) return -dir;
        if (x > y) return dir;
        return state.rows.get(a)!.n.localeCompare(state.rows.get(b)!.n);
    });
}

/** Depth-first flatten of the expanded portion of the tree. */
function rebuildVisible(): void {
    const out: VisibleRow[] = [];
    const walk = (id: number, depth: number): void => {
        out.push({ id, depth });
        if (!state.expanded.has(id)) return;
        const kids = state.kids.get(id);
        if (!kids) return;
        for (const k of sortRows(kids)) walk(k, depth + 1);
    };
    if (state.rows.has(0)) walk(0, 0);
    state.visible = out;
    el('treeSizer').style.height = `${out.length * ROW_H}px`;
    renderTreeWindow();
}

function renderTreeWindow(): void {
    const scroll = el('treeScroll');
    const total = state.visible.length;
    const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_H) - 2);
    const shown = Math.min(total - first, Math.ceil(scroll.clientHeight / ROW_H) + 4);
    const rootRow = state.rows.get(0);
    const rootValue = rootRow ? valueOf(rootRow) || 1 : 1;

    const html: string[] = [];
    for (let k = 0; k < shown; k++) {
        const { id, depth } = state.visible[first + k];
        const row = state.rows.get(id);
        // Rendering must never throw: rows can be dropped underneath a pending
        // repaint, and a missing one is simply not drawn.
        if (!row) continue;
        const value = valueOf(row);
        const share = value / rootValue;
        const isDir = (row.flags & F_DIR) !== 0;
        const open = state.expanded.has(id);

        const faded = row.flags & (F_SKIPPED | F_ERROR) ? ' faded' : '';
        const suffix =
            row.flags & F_SKIPPED ? ' (not scanned)'
            : row.flags & F_ERROR ? ' (unreadable)'
            : row.flags & F_DUP ? ' (hardlink)'
            : row.flags & F_LINK ? ' →'
            : '';

        html.push(
            `<div class="trow tree-grid${id === state.selected ? ' sel' : ''}" data-id="${id}">` +
                `<div class="name" style="padding-left:${4 + depth * 13}px">` +
                    `<button class="twisty${isDir && row.kids ? '' : ' leaf'}" data-twisty="${id}" tabindex="-1">${open ? '▼' : '▶'}</button>` +
                    `<img class="ficon" src="/icons/${encodeURIComponent(row.icon)}.svg" alt="" loading="lazy" decoding="async">` +
                    `<span class="label${faded}" title="${escapeHtml(row.n)}">${escapeHtml(row.n)}${suffix}</span>` +
                `</div>` +
                `<div class="num">${bytes(value)}</div>` +
                `<div class="pct" style="--f:${share.toFixed(4)}"><i></i><span>${percent(share)}</span></div>` +
                `<div class="num dim">${isDir ? count(row.files + row.dirs) : ''}</div>` +
                `<div class="date">${when(row.mtime)}</div>` +
            `</div>`
        );
    }

    const rows = el('treeRows');
    rows.style.transform = `translateY(${first * ROW_H}px)`;
    rows.innerHTML = html.join('');
}

async function loadChildren(id: number): Promise<number[]> {
    const cached = state.kids.get(id);
    if (cached) return cached;
    const data = await api.children(id);
    for (const row of data.rows) state.rows.set(row.i, row);
    const ids = data.rows.map((r) => r.i);
    state.kids.set(id, ids);
    return ids;
}

async function toggle(id: number, force?: boolean): Promise<void> {
    const row = state.rows.get(id);
    if (!row || !(row.flags & F_DIR) || !row.kids) return;
    const open = force ?? !state.expanded.has(id);
    if (open) {
        await loadChildren(id);
        state.expanded.add(id);
    } else {
        state.expanded.delete(id);
    }
    rebuildVisible();
}

/** Expand the path down to `id` and scroll it into view. */
async function revealInTree(id: number): Promise<void> {
    const { chain } = await api.ancestors(id);
    for (const link of chain) {
        if (link.i === id) break;
        await loadChildren(link.i);
        state.expanded.add(link.i);
    }
    rebuildVisible();
    // Arriving from the treemap, the row could be anywhere; centring it gives
    // the surrounding context that a minimal scroll would not.
    scrollRowIntoView(state.visible.findIndex((v) => v.id === id), true);
}

/**
 * Bring a row into view, moving as little as possible. Stepping through a tree
 * with the arrow keys must not make the list jump under the cursor, so this
 * scrolls by exactly the row that fell off the edge.
 */
function scrollRowIntoView(index: number, centre = false): void {
    if (index < 0) return;
    const scroll = el('treeScroll');
    const top = index * ROW_H;
    const bottom = top + ROW_H;
    if (top >= scroll.scrollTop && bottom <= scroll.scrollTop + scroll.clientHeight) return;

    scroll.scrollTop = centre
        ? top - scroll.clientHeight / 2
        : top < scroll.scrollTop ? top
        : bottom - scroll.clientHeight;
    renderTreeWindow();
}

/* --------------------------------------------------------- tree keyboard -- */

/**
 * The keys a tree is expected to answer to, near enough to the ARIA tree
 * pattern that nobody has to learn them: up and down walk the rows that are on
 * screen, right opens a folder and then steps into it, left closes it and then
 * steps out to its parent. Enter zooms, matching a double-click.
 */
const TREE_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'Enter',
]);

async function focusRow(index: number): Promise<void> {
    const target = state.visible[index];
    if (!target) return;
    scrollRowIntoView(index);
    await select(target.id, { fromTree: true });
}

/** Row index of the nearest ancestor above `index`, or -1 at the top level. */
function parentRow(index: number): number {
    const depth = state.visible[index].depth;
    for (let k = index - 1; k >= 0; k--) {
        if (state.visible[k].depth < depth) return k;
    }
    return -1;
}

async function navigateTree(key: string): Promise<void> {
    const last = state.visible.length - 1;
    if (last < 0) return;

    // Nothing focused yet, or the focused row is inside a folder that has since
    // been collapsed: the first key press lands on the root.
    const index = state.visible.findIndex((v) => v.id === state.selected);
    if (index < 0) return focusRow(0);

    const page = Math.max(1, Math.floor(el('treeScroll').clientHeight / ROW_H) - 1);
    const { id } = state.visible[index];
    const row = state.rows.get(id);
    const branch = ((row?.flags ?? 0) & F_DIR) !== 0 && (row?.kids ?? false);
    const open = state.expanded.has(id);

    switch (key) {
        case 'ArrowDown': return focusRow(Math.min(index + 1, last));
        case 'ArrowUp': return focusRow(Math.max(index - 1, 0));
        case 'PageDown': return focusRow(Math.min(index + page, last));
        case 'PageUp': return focusRow(Math.max(index - page, 0));
        case 'Home': return focusRow(0);
        case 'End': return focusRow(last);

        case 'ArrowRight':
            if (!branch) return;
            // Open it first; a second press is what steps inside.
            if (!open) {
                await toggle(id, true);
                scrollRowIntoView(state.visible.findIndex((v) => v.id === id));
                return;
            }
            return focusRow(Math.min(index + 1, last));

        case 'ArrowLeft':
            if (branch && open) {
                await toggle(id, false);
                scrollRowIntoView(state.visible.findIndex((v) => v.id === id));
                return;
            }
            return focusRow(parentRow(index));

        case 'Enter':
            if (branch) await zoomTo(id);
            return;
    }
}

/* ------------------------------------------------------ extension pane ---- */

async function loadExtensions(): Promise<void> {
    const data = await api.extensions();
    state.extensions = data.rows;
    state.special = data.special;
    state.colorByRank = new Map(data.rows.map((r) => [r.rank, r.color] as const));
    refreshColors();
    renderExtensions();
}

function sortExtensions(): ExtensionRow[] {
    const { key, dir } = state.extSort;
    // Share is size over a fixed total, so it orders exactly as size does; it
    // gets its own key only so the header shows which column was clicked.
    const get = (r: ExtensionRow): string | number =>
        key === 'type' ? r.label.toLowerCase() : key === 'count' ? r.count : r.size;
    return [...state.extensions].sort((a, b) => {
        const x = get(a);
        const y = get(b);
        if (x < y) return -dir;
        if (x > y) return dir;
        return a.label.localeCompare(b.label);
    });
}

function renderExtensions(): void {
    const total = state.extensions.reduce((a, r) => a + r.size, 0) || 1;
    el('extRows').innerHTML = sortExtensions()
        .map((r) => {
            const value = r.size;
            const share = value / total;
            return (
                `<div class="erow ext-grid${state.highlight === r.rank ? ' sel' : ''}" data-rank="${r.rank}">` +
                    `<div class="name">` +
                    `<span class="swatch" style="background:${r.color}"></span>` +
                    `<img class="ficon" src="/icons/${encodeURIComponent(r.icon)}.svg" alt="" loading="lazy" decoding="async">` +
                    `<span class="label">${escapeHtml(r.label)}</span></div>` +
                    `<div class="num">${bytes(value)}</div>` +
                    `<div class="pct" style="--f:${share.toFixed(4)}"><i></i><span>${percent(share)}</span></div>` +
                    `<div class="num dim">${count(r.count)}</div>` +
                `</div>`
            );
        })
        .join('');
}

/* ----------------------------------------------------------- selection ---- */

/**
 * Selection lives entirely in the select dialog. The main window is a read-only
 * view of disk usage and deliberately shows no trace of what is picked, so
 * browsing and choosing stay separate activities.
 */
function applySelection(summary: SelectionSummary): void {
    state.selection = summary;
}

/* ---------------------------------------------------------- breadcrumbs --- */

/** The final segment of a path, e.g. "/a/b/MyDirStat" -> "MyDirStat". */
function leafName(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * The breadcrumb exists to zoom back out, not to label the scan. At the top
 * level there is nothing to navigate back to and the path is already in the
 * toolbar, the tree root and the address bar, so the bar hides itself. When it
 * does appear it shows segments relative to the scan root rather than repeating
 * the absolute path.
 */
async function renderCrumbs(): Promise<void> {
    const crumbs = el('crumbs');
    if (state.status !== 'ready' || state.zoom === 0) {
        crumbs.innerHTML = '';
        crumbs.hidden = true;
        return;
    }
    const { chain } = await api.ancestors(state.zoom);
    crumbs.hidden = false;
    crumbs.innerHTML = chain
        .map((link, i) => {
            const label = i === 0 ? leafName(link.n) : link.n;
            return (i ? '<span class="sep">›</span>' : '') + `<button data-zoom="${link.i}">${escapeHtml(label)}</button>`;
        })
        .join('');
}

async function zoomTo(id: number): Promise<void> {
    state.zoom = id;
    await renderCrumbs();
    await loadTreemap();
}

/* ------------------------------------------------------------ selection --- */

async function select(id: number, { fromTree = false } = {}): Promise<void> {
    state.selected = id;
    renderTreeWindow();
    syncMapSelection();
    await showStatus(id);
    if (!fromTree) await revealInTree(id);
}

let statusRequest = 0;

async function showStatus(id: number): Promise<void> {
    // Holding an arrow key fires one of these per row; without a sequence
    // number a slower reply could land after a newer one and describe a row
    // the cursor has already left.
    const seq = ++statusRequest;
    try {
        const node = await api.node(id);
        if (seq !== statusRequest) return;
        el('statusPath').textContent = node.path;
        const parts = [bytes(valueOf(node))];
        if (node.flags & F_DIR) parts.push(`${count(node.files)} files`, `${count(node.dirs)} folders`);
        if (node.mtime) parts.push(when(node.mtime));
        el('statusMeta').textContent = parts.join('  ·  ');
    } catch {
        /* the node may have just been deleted */
    }
}

/* ------------------------------------------------------------- scanning --- */

/**
 * A scan reports progress a few times a second, but the elapsed time has to
 * move between those reports or the whole line looks frozen. A ticker owns the
 * summary while a scan runs and hands it back when one finishes.
 */
let ticker: ReturnType<typeof setInterval> | null = null;
let scanStartedAt = 0;
let latestProgress: ScanProgress | null = null;

function renderProgress(): void {
    const seconds = ((Date.now() - scanStartedAt) / 1000).toFixed(1);
    const p = latestProgress;
    el('summary').innerHTML = p
        ? `<b>${bytes(p.bytes)}</b> in <b>${count(p.files)}</b> files, ` +
          `<b>${count(p.dirs)}</b> folders <span class="dim">(${seconds}s)</span>`
        : `<span class="dim">Scanning… (${seconds}s)</span>`;
}

function startTicker(startedAt: number): void {
    stopTicker();
    scanStartedAt = startedAt || Date.now();
    latestProgress = null;
    renderProgress();
    // Tenths need a faster tick than they are shown at, or the display drifts
    // visibly behind the clock.
    ticker = setInterval(renderProgress, 60);
}

function stopTicker(): void {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = null;
}

function setStatus(summary: ScanSummary): void {
    state.summary = summary;
    state.status = summary.status;
    const scanning = summary.status === 'scanning';
    el('progress').hidden = !scanning;
    el('cancel').hidden = !scanning;
    el<HTMLButtonElement>('scan').disabled = scanning;

    if (scanning) {
        if (!ticker) startTicker(summary.startedAt ?? Date.now());
    } else {
        stopTicker();
    }

    if (summary.status === 'ready') {
        const total = summary.size ?? 0;
        el('summary').innerHTML =
            `<b>${bytes(total)}</b> in <b>${count(summary.files ?? 0)}</b> files, ` +
            `<b>${count(summary.dirs ?? 0)}</b> folders ` +
            `<span class="dim">(${((summary.elapsedMs ?? 0) / 1000).toFixed(1)}s${summary.cancelled ? ', partial' : ''})</span>`;
    } else if (summary.status === 'error') {
        el('summary').textContent = summary.error ?? 'Scan failed';
        showAlert(summary.error ?? 'Scan failed');
    }
}

async function afterScan(summary: ScanSummary): Promise<void> {
    setStatus(summary);
    state.rows.clear();
    state.kids.clear();
    state.expanded.clear();
    // The visible list indexes into rows, so it has to go at the same moment.
    // A repaint landing between the two — a ResizeObserver during the await
    // below, say — would otherwise look up ids that no longer exist.
    state.visible = [];
    state.selected = null;
    state.highlight = null;
    map.setHighlight(null);
    state.zoom = 0;

    const root = await api.children(0);
    state.rows.set(0, { ...root.self, n: root.path });
    for (const row of root.rows) state.rows.set(row.i, row);
    state.kids.set(0, root.rows.map((r) => r.i));
    state.expanded.add(0);

    await loadExtensions();
    applySelection(await api.selectionSummary());
    rebuildVisible();
    await renderCrumbs();
    await loadTreemap();
    el<HTMLInputElement>('path').value = root.path;
    setUrlPath(root.path);
}

function connect(): void {
    const events = api.events();
    events.addEventListener('state', (e) => {
        const summary = JSON.parse((e as MessageEvent<string>).data) as ScanSummary;
        setStatus(summary);

        const wanted = requestedPath();
        if (wanted && wanted !== summary.root) {
            // A different folder than the server holds: scan it.
            el<HTMLInputElement>('path').value = wanted;
            void api.scan(wanted).catch(reportError);
            return;
        }
        if (summary.status === 'ready') void afterScan(summary);
        else if (summary.root) el<HTMLInputElement>('path').value = summary.root;
    });
    events.addEventListener('start', (e) => {
        const { root, startedAt } = JSON.parse((e as MessageEvent<string>).data) as
            { root: string; startedAt: number };
        el<HTMLInputElement>('path').value = root;
        setUrlPath(root);
        clearAlert();
        startTicker(startedAt);
        setStatus({ status: 'scanning', root, startedAt });
        const empty = el('mapEmpty');
        empty.hidden = false;
        empty.textContent = 'Scanning…';
    });
    events.addEventListener('progress', (e) => {
        latestProgress = JSON.parse((e as MessageEvent<string>).data) as ScanProgress;
        el('progressPath').textContent = latestProgress.path;
        renderProgress();
    });
    events.addEventListener('done', (e) => {
        void afterScan(JSON.parse((e as MessageEvent<string>).data) as ScanSummary);
    });
    events.addEventListener('delete', (e) => {
        renderDelete(JSON.parse((e as MessageEvent<string>).data) as DeleteStatus);
    });
    events.addEventListener('zip', (e) => {
        renderZip(JSON.parse((e as MessageEvent<string>).data) as ZipStatus);
    });
    events.addEventListener('failed', (e) => {
        const { message } = JSON.parse((e as MessageEvent<string>).data) as { message: string };
        setStatus({ status: 'error', root: state.summary?.root ?? null, error: message });
    });
}

/**
 * Anything that went wrong, in a bar the user cannot walk past. Errors used to
 * go to the status line, which the next hover overwrote.
 */
function showAlert(message: string): void {
    el('alertText').textContent = message;
    el('alert').hidden = false;
}

function clearAlert(): void {
    el('alert').hidden = true;
    el('alertText').textContent = '';
}

function reportError(err: unknown): void {
    showAlert(err instanceof Error ? err.message : String(err));
}

/* -------------------------------------------------------------- toolbar --- */

el('alertClose').onclick = clearAlert;

el('scan').onclick = () => {
    clearAlert();
    void api.scan(el<HTMLInputElement>('path').value.trim()).catch(reportError);
};
el('cancel').onclick = () => void api.cancel().catch(reportError);
initPathInput(() => el('scan').click());
el('up').onclick = () => {
    const current = el<HTMLInputElement>('path').value.trim();
    const parent = current.replace(/[\\/][^\\/]*[\\/]?$/, '') || '/';
    if (parent !== current) void api.scan(parent).catch(reportError);
};


for (const button of all<HTMLButtonElement>('.pane-head [data-sort]')) {
    button.onclick = () => {
        const key = button.dataset.sort as SortKey;
        state.sort = { key, dir: state.sort.key === key ? (-state.sort.dir as 1 | -1) : key === 'name' ? 1 : -1 };
        for (const b of all<HTMLButtonElement>('.pane-head [data-sort]')) b.classList.toggle('on', b === button);
        rebuildVisible();
    };
}

for (const button of all<HTMLButtonElement>('.pane-head [data-esort]')) {
    button.onclick = () => {
        const key = button.dataset.esort as ExtSortKey;
        // Names read best ascending; every quantity reads best largest first.
        state.extSort = {
            key,
            dir: state.extSort.key === key ? (-state.extSort.dir as 1 | -1) : key === 'type' ? 1 : -1,
        };
        for (const b of all<HTMLButtonElement>('.pane-head [data-esort]')) b.classList.toggle('on', b === button);
        renderExtensions();
    };
}

/* ------------------------------------------------------------ tree events -- */

el('treeScroll').addEventListener('scroll', renderTreeWindow, { passive: true });

el('treeScroll').addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !TREE_KEYS.has(e.key)) return;
    // Otherwise the browser scrolls the pane as well as moving the row.
    e.preventDefault();
    void navigateTree(e.key);
});

el('treeRows').addEventListener('click', (e) => {
    // Clicking a row hands the pane the keyboard, so the arrows carry on from
    // where the click landed. preventScroll: the click already put it in view.
    el('treeScroll').focus({ preventScroll: true });
    const target = e.target as HTMLElement;
    const twisty = target.closest<HTMLElement>('[data-twisty]');
    if (twisty) {
        void toggle(Number(twisty.dataset.twisty));
        return;
    }
    const row = target.closest<HTMLElement>('.trow');
    if (row) void select(Number(row.dataset.id), { fromTree: true });
});

el('treeRows').addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.trow');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (((state.rows.get(id)?.flags ?? 0) & F_DIR) !== 0) void zoomTo(id);
});

el('extRows').addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.erow');
    if (!row) return;
    const rank = Number(row.dataset.rank);
    state.highlight = state.highlight === rank ? null : rank;
    map.setHighlight(state.highlight);
    map.overlay();
    renderExtensions();
});

/* -------------------------------------------------------------- tooltip --- */

const pathCache = new Map<number, string>();

async function pathOf(id: number): Promise<string> {
    const cached = pathCache.get(id);
    if (cached !== undefined) return cached;
    const node = await api.node(id);
    pathCache.set(id, node.path);
    return node.path;
}

function placeTip(tip: HTMLElement, clientX: number, clientY: number): void {
    // Flip to stay inside the viewport near the right and bottom edges.
    const box = tip.getBoundingClientRect();
    const x = clientX + 14 + box.width > innerWidth ? clientX - box.width - 14 : clientX + 14;
    const y = clientY + 18 + box.height > innerHeight ? clientY - box.height - 12 : clientY + 18;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
}

/**
 * Treemap tooltips drop the scan root: it is already on screen in the toolbar
 * and the tree, and repeating it pushes the part that identifies the file off
 * the end of the tooltip.
 */
function relativeToRoot(path: string): string {
    const root = state.summary?.root;
    if (!root) return path;
    if (path === root) return leafName(root);
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function tipHtml(node: TreemapNode, label: string): string {
    const kind = node.g ? '' : node.f & F_DIR ? '  ·  folder' : '';
    return `<div class="tip-name">${escapeHtml(label)}</div><div class="tip-meta">${bytes(node.v)}${kind}</div>`;
}

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const tile = map.tileAt(e.clientX - rect.left, e.clientY - rect.top);
    if (map.setHovered(tile)) map.overlay();

    const tip = el('tip');
    if (!tile) {
        tip.hidden = true;
        return;
    }

    const node = tile.node;
    const cached = pathCache.get(node.i);
    const known = node.g
        ? `${node.g.toLocaleString()} smaller items`
        : cached !== undefined
            ? relativeToRoot(cached)
            : state.rows.get(node.i)?.n;

    tip.innerHTML = tipHtml(node, known ?? '…');
    tip.hidden = false;
    placeTip(tip, e.clientX, e.clientY);

    if (known === undefined && node.i >= 0) {
        void pathOf(node.i).then((path) => {
            // Only patch in the name if the pointer is still on the same tile.
            if (map.hovered !== tile || tip.hidden) return;
            tip.innerHTML = tipHtml(node, relativeToRoot(path));
            placeTip(tip, e.clientX, e.clientY);
        }).catch(() => undefined);
    }
});

canvas.addEventListener('mouseleave', () => {
    el('tip').hidden = true;
    if (map.setHovered(null)) map.overlay();
});

function tileFromEvent(e: MouseEvent): Tile | null {
    const rect = canvas.getBoundingClientRect();
    return map.tileAt(e.clientX - rect.left, e.clientY - rect.top);
}

canvas.addEventListener('click', (e) => {
    const tile = tileFromEvent(e);
    if (tile && tile.node.i >= 0) void select(tile.node.i);
});

canvas.addEventListener('dblclick', (e) => {
    const tile = tileFromEvent(e);
    if (tile && tile.node.i >= 0 && tile.node.f & F_DIR) void zoomTo(tile.node.i);
});

el('crumbs').addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]');
    if (button) void zoomTo(Number(button.dataset.zoom));
});

/* --------------------------------------------------------- context menu --- */

const menu = el('menu');

function openMenu(x: number, y: number, id: number): void {
    state.menuTarget = id;
    const row = state.rows.get(id);
    menu.querySelector<HTMLButtonElement>('[data-op="zoom"]')!.disabled = !(row && row.flags & F_DIR);
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - box.width - 6)}px`;
    menu.style.top = `${Math.min(y, innerHeight - box.height - 6)}px`;
}

function closeMenu(): void {
    menu.hidden = true;
    state.menuTarget = null;
}

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const tile = tileFromEvent(e);
    if (!tile || tile.node.i < 0) return;
    void select(tile.node.i).then(() => openMenu(e.clientX, e.clientY, tile.node.i));
});

el('treeRows').addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.trow');
    if (!row) return;
    e.preventDefault();
    const id = Number(row.dataset.id);
    void select(id, { fromTree: true });
    openMenu(e.clientX, e.clientY, id);
});

addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) closeMenu();
});

/**
 * Dismissable layers, topmost first — the same order they stack in, since they
 * share a z-index and are laid out by document order.
 *
 * Escape closes exactly one: the top one. Each dialog owning its own Escape
 * handler is what let a single keypress close two of them — the type dialog
 * dismissed itself, the event carried on to the window, and by then the picker
 * underneath looked like the topmost thing open.
 */
const LAYERS: { open(): boolean; dismiss(): void }[] = [
    { open: () => !el('modal').hidden, dismiss: () => el('modalCancel').click() },
    // A job in progress is not dismissed by Escape; only its finished report is.
    { open: () => !el('zipModal').hidden, dismiss: () => clickIfShown('zipClose') },
    { open: () => !el('delModal').hidden, dismiss: () => clickIfShown('delClose') },
    { open: () => !el('confirmDelete').hidden, dismiss: () => el('confirmCancel').click() },
    { open: isTypesOpen, dismiss: closeTypes },
    { open: isPickerOpen, dismiss: closePicker },
];

function clickIfShown(id: string): void {
    const button = el(id);
    if (!button.hidden) button.click();
}

addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    LAYERS.find((layer) => layer.open())?.dismiss();
});

menu.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-op]');
    if (!button || button.disabled) return;
    const id = state.menuTarget;
    const op = button.dataset.op!;
    closeMenu();
    if (id === null) return;

    if (op === 'zoom') {
        void zoomTo(id);
        return;
    }
    if (op === 'delete') {
        void api.node(id).then((node) => confirmDelete(node, () => void runAction('delete', id)));
        return;
    }
    void runAction(op as 'reveal' | 'open' | 'trash', id);
});

async function runAction(op: 'reveal' | 'open' | 'trash' | 'delete', id: number): Promise<void> {
    try {
        const result = await api.action(op, id);
        if (op === 'trash' || op === 'delete') {
            pathCache.delete(id);
            state.selected = null;
            setStatus(await api.state());
            await refreshLoadedRows();
            await loadExtensions();
            await loadTreemap();
        }
        el('statusPath').textContent = result.path;
    } catch (err) {
        reportError(err);
    }
}

/**
 * Refetch every row on screen after something was removed.
 *
 * Removing one file changes the totals of every folder above it, so refreshing
 * only its immediate parent left the intermediate ones showing pre-delete
 * sizes — a folder could end up reported as larger than the tree containing it.
 * The cache is dropped wholesale and rebuilt from what is actually expanded,
 * which is bounded by what fits on screen.
 */
async function refreshLoadedRows(): Promise<void> {
    const targets = [...new Set<number>([0, ...state.expanded])];
    const pages = await Promise.all(
        // A folder that was itself deleted answers 410; it drops out here and
        // is pruned from the expanded set below.
        targets.map((id) => api.children(id).then((page) => page, () => null))
    );

    state.rows.clear();
    state.kids.clear();
    // Nothing may look up a row between the clear and the rebuild.
    state.visible = [];

    pages.forEach((page, k) => {
        const id = targets[k];
        if (page === null) {
            state.expanded.delete(id);
            return;
        }
        if (id === 0) state.rows.set(0, { ...page.self, n: page.path });
        else state.rows.set(id, page.self);
        for (const row of page.rows) state.rows.set(row.i, row);
        state.kids.set(id, page.rows.map((r) => r.i));
    });

    rebuildVisible();
}

/* ---------------------------------------------------------------- modal --- */

let confirmHandler: (() => void) | null = null;

function confirmDelete(node: NodeDetail, onConfirm: () => void): void {
    el('modalBody').innerHTML =
        `This permanently removes <b>${escapeHtml(node.n)}</b> (${bytes(valueOf(node))}). ` +
        `It does not go to the Trash and cannot be undone.<br><br><code>${escapeHtml(node.path)}</code>`;
    confirmHandler = onConfirm;
    el('modal').hidden = false;
    el('modalCancel').focus();
}

el('modalCancel').onclick = () => {
    el('modal').hidden = true;
    confirmHandler = null;
};
el('modalConfirm').onclick = () => {
    el('modal').hidden = true;
    confirmHandler?.();
    confirmHandler = null;
};

/* ---------------------------------------------------------- selection UI -- */

el('pick').onclick = () => void openPicker();
el('pickerZip').onclick = () => {
    closePicker();
    void startZip();
};

initPicker(applySelection);
initTypes({
    // The type dialog has already closed itself; the picker goes too, since
    // everything it is showing is about to be refetched.
    remove: (mode, types, files, size) => {
        if (mode === 'trash') {
            closePicker();
            void startDelete('trash', undefined, types);
            return;
        }
        askPermanent(files, size, () => {
            closePicker();
            void startDelete('permanent', files, types);
        });
    },
});

/* ------------------------------------------------------------------ zip --- */

function renderZip(status: ZipStatus): void {
    state.zipId = status.id;
    el('zipModal').hidden = false;

    const done = status.state === 'done';
    const running = status.state === 'archiving' || status.state === 'preparing';
    const fraction = status.bytesTotal > 0 ? status.bytesRead / status.bytesTotal : 0;

    el('zipTitle').textContent =
        done ? 'Archive ready'
        : status.state === 'failed' ? 'Archive failed'
        : status.state === 'cancelled' ? 'Archive cancelled'
        : 'Creating archive';

    el<HTMLElement>('zipBar').style.width = `${Math.round((done ? 1 : fraction) * 100)}%`;

    if (done) {
        const ratio = status.bytesRead > 0 ? 1 - (status.size ?? 0) / status.bytesRead : 0;
        el('zipDetail').textContent =
            `${count(status.files)} files · ${bytes(status.size ?? 0)}` +
            ` (${(ratio * 100).toFixed(0)}% smaller than ${bytes(status.bytesRead)})`;
    } else if (status.state === 'failed') {
        el('zipDetail').textContent = status.error ?? 'Unknown error';
    } else {
        el('zipDetail').textContent =
            `${count(status.filesDone)} / ${count(status.files)} files · ` +
            `${bytes(status.bytesRead)} read · ${bytes(status.bytesWritten)} written`;
    }

    if (status.skipped.length > 0) {
        el('zipDetail').textContent += ` · ${count(status.skipped.length)} skipped`;
    }
    el('zipPath').textContent = running ? status.currentPath : '';

    // The app picked the format, so it also says how to unpack it rather than
    // leaving the user to discover that .tar.br has no common desktop tool.
    const howto = el('zipHowto');
    howto.hidden = !done;
    if (done) {
        const info = ARCHIVE_FORMATS.find((f) => f.id === status.format);
        el('zipCommand').textContent = (info?.extract ?? 'unzip %s')
            .replace(/%s/g, status.name)
            .replace(/%t/g, status.name.replace(/\.(br|zst)$/, ''));
    }

    el('zipCancel').hidden = !running;
    el('zipDownload').hidden = !done;
    el('zipClose').hidden = running;
}

async function startZip(): Promise<void> {
    try {
        renderZip(await api.zip(selectedFormat()));
    } catch (err) {
        reportError(err);
    }
}

el('zipCancel').onclick = () => {
    if (state.zipId) void api.zipCancel(state.zipId).catch(reportError);
};
el('zipClose').onclick = () => {
    el('zipModal').hidden = true;
    state.zipId = null;
};
el('zipDownload').onclick = () => {
    if (!state.zipId) return;
    // Plain navigation so the browser owns the save dialog; the response is an
    // attachment, so the page itself is not replaced.
    location.href = api.zipDownloadUrl(state.zipId);
    el('zipModal').hidden = true;
    state.zipId = null;
};

/* --------------------------------------------------------------- delete --- */

function renderDelete(status: DeleteStatus): void {
    el('delModal').hidden = false;
    const running = status.state === 'running';
    const fraction = status.files > 0 ? status.filesDone / status.files : 0;

    el('delTitle').textContent =
        status.state === 'done' ? (status.mode === 'trash' ? 'Moved to Trash' : 'Deleted')
        : status.state === 'failed' ? 'Delete failed'
        : status.state === 'cancelled' ? 'Delete cancelled'
        : status.mode === 'trash' ? 'Moving to Trash' : 'Deleting';

    el<HTMLElement>('delBar').style.width = `${Math.round(fraction * 100)}%`;

    const parts = [`${count(status.filesDone)} / ${count(status.files)} files`, `${bytes(status.bytesFreed)} freed`];
    if (status.failures.length > 0) parts.push(`${count(status.failures.length)} failed`);
    if (status.error) parts.push(status.error);
    el('delDetail').textContent = parts.join(' · ');
    el('delPath').textContent = running ? status.currentPath : '';

    // What survived matters more than the count of it: "moved to Trash" over a
    // file that is still there is exactly the report this dialog must not give.
    const failures = el('delFailures');
    failures.hidden = status.failures.length === 0;
    failures.innerHTML = status.failures
        .slice(0, 12)
        .map((f) => `<li><b>${escapeHtml(f.path)}</b><span>${escapeHtml(f.reason)}</span></li>`)
        .join('') +
        (status.failures.length > 12
            ? `<li class="more">${count(status.failures.length - 12)} more</li>`
            : '');

    el('delCancel').hidden = !running;
    el('delClose').hidden = running;
}

async function startDelete(
    mode: 'trash' | 'permanent',
    confirm?: number,
    types?: string[]
): Promise<void> {
    try {
        renderDelete(await api.deleteSelection(mode, confirm, types));
    } catch (err) {
        reportError(err);
    }
}

/**
 * Make the user type the count before anything is removed for good.
 *
 * Shared by both routes into permanent deletion — a selection, or whole file
 * types — because the guarantee has to be the same either way: the number the
 * user types is the number the server is then required to agree with.
 */
function askPermanent(files: number, size: number, go: () => void): void {
    if (files === 0) return;
    el('confirmBody').textContent =
        `${count(files)} files (${bytes(size)}) will be removed for good. ` +
        `They do not go to the Trash and cannot be recovered.`;
    const input = el<HTMLInputElement>('confirmInput');
    input.value = '';
    const button = el<HTMLButtonElement>('confirmGo');
    button.disabled = true;
    input.oninput = () => {
        const ok = input.value.trim() === String(files);
        button.disabled = !ok;
        input.classList.toggle('match', ok);
    };
    confirmed = go;
    el('confirmDelete').hidden = false;
    input.focus();
}

/** What the confirm dialog runs once the count has been typed correctly. */
let confirmed: () => void = () => undefined;

el('delCancel').onclick = () => void api.deleteCancel().catch(reportError);
el('delClose').onclick = () => {
    el('delModal').hidden = true;
};

el('pickerTrash').onclick = () => {
    closePicker();
    void startDelete('trash');
};

el('pickerErase').onclick = () => {
    const total = state.selection?.files ?? 0;
    askPermanent(total, state.selection?.bytes ?? 0, () => {
        closePicker();
        void startDelete('permanent', total);
    });
};

el('confirmCancel').onclick = () => {
    el('confirmDelete').hidden = true;
};
el('confirmGo').onclick = () => {
    el('confirmDelete').hidden = true;
    confirmed();
};

/* ------------------------------------------------------------ splitters --- */

function draggable(handle: HTMLElement, apply: (e: MouseEvent) => void): void {
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        handle.classList.add('dragging');
        const move = (ev: MouseEvent): void => apply(ev);
        const up = (): void => {
            handle.classList.remove('dragging');
            removeEventListener('mousemove', move);
            removeEventListener('mouseup', up);
            void loadTreemap();
        };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
    });
}

draggable(el('splitV'), (e) => {
    const box = el('topRow').getBoundingClientRect();
    const width = Math.min(Math.max(160, box.right - e.clientX), box.width - 200);
    el('extPane').style.flexBasis = `${width}px`;
});

draggable(el('splitH'), (e) => {
    const main = document.querySelector('main')!.getBoundingClientRect();
    const height = Math.min(Math.max(80, e.clientY - main.top), main.height - 120);
    el('topRow').style.height = `${height}px`;
});

/* --------------------------------------------------------------- resize --- */

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
new ResizeObserver(() => {
    map.resize();
    map.layout();
    map.paint();
    syncMapSelection();
    renderTreeWindow();
    // The tile budget scales with area, so a settled resize warrants a refetch.
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void loadTreemap(), 250);
}).observe(el('mapPane'));

/* ----------------------------------------------------------------- boot --- */

void api.roots().then(({ roots, showPicker, home }) => {
    const select = el<HTMLSelectElement>('roots');

    // On a single-disk machine the picker would only offer "/" and "~", which
    // the path box already accepts, so it stays out of the toolbar entirely.
    select.hidden = !showPicker;
    if (showPicker) {
        select.innerHTML =
            '<option value="">Volumes…</option>' +
            roots.map((r) => `<option value="${escapeHtml(r.path)}">${escapeHtml(r.label)}</option>`).join('');
        select.onchange = () => {
            if (!select.value) return;
            el<HTMLInputElement>('path').value = select.value;
            select.value = '';
            el('scan').click();
        };
    }

    const pathInput = el<HTMLInputElement>('path');
    if (!pathInput.value) pathInput.value = home;
});

installColumnResizers(el('treePane'), TREE_COLUMNS, 'mydirstat.columns.tree');
installColumnResizers(el('extPane'), EXT_COLUMNS, 'mydirstat.columns.ext');

refreshColors();
connect();
