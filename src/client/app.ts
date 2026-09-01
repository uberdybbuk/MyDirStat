/** Three-pane UI: directory tree, extension legend, treemap; all cross-linked. */

import { Treemap, type Rgb, type Tile } from './treemap.js';
import { api, requestedPath, setUrlPath } from './api.js';
import { el, all, escapeHtml, hexToRgb } from './dom.js';
import { bytes, count, percent, when } from './format.js';
import { installColumnResizers, TREE_COLUMNS, EXT_COLUMNS } from './columns.js';
import { F_DIR, F_LINK, F_ERROR, F_SKIPPED, F_DUP } from '../shared/protocol.js';
import type {
    ExtensionRow, NodeDetail, ScanProgress, ScanSummary,
    SizeMetric, SpecialColors, TreeRow, TreemapNode,
} from '../shared/protocol.js';

const ROW_H = 22;

// Smallest tile worth sending, in device pixels. Small on purpose: a higher
// floor folds most individual files away, and the folded mass then dominates
// the map as one tile.
const MIN_TILE = 4;

type SortKey = 'name' | 'size' | 'pct' | 'items' | 'mtime';

interface VisibleRow {
    id: number;
    depth: number;
}

interface State {
    metric: SizeMetric;
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
    menuTarget: number | null;
}

const state: State = {
    metric: 'alloc',
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
    menuTarget: null,
};

const valueOf = (row: TreeRow | NodeDetail): number => (state.metric === 'size' ? row.size : row.alloc);

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

/**
 * The one place a palette colour is decided, for both the treemap and the
 * tree's colour chips. Directories and folded aggregates report the type that
 * dominates their bytes, so a region too fine to subdivide still reads as
 * "mostly video" rather than as grey — and a folder's chip matches its tile.
 */
function paletteColor(rank: number, flags: number, aggregate = false): string {
    if (flags & (F_ERROR | F_SKIPPED)) return state.special.unreadable;
    return state.colorByRank.get(rank) ?? (flags & F_DIR || aggregate ? state.special.dir : state.special.other);
}

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
    const data = await api.treemap(state.zoom, state.metric, mapArea(), MIN_TILE);
    if (seq !== mapRequest) return; // a newer request already won
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
        const row = state.rows.get(id)!;
        const value = valueOf(row);
        const share = value / rootValue;
        const isDir = (row.flags & F_DIR) !== 0;
        const open = state.expanded.has(id);
        const color = paletteColor(row.colorRank, row.flags);

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
                    `<span class="chip" style="background:${color}"></span>` +
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

    const index = state.visible.findIndex((v) => v.id === id);
    if (index < 0) return;
    const scroll = el('treeScroll');
    const top = index * ROW_H;
    if (top < scroll.scrollTop || top + ROW_H > scroll.scrollTop + scroll.clientHeight) {
        scroll.scrollTop = top - scroll.clientHeight / 2;
    }
    renderTreeWindow();
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

function renderExtensions(): void {
    const total = state.extensions.reduce((a, r) => a + (state.metric === 'size' ? r.size : r.alloc), 0) || 1;
    el('extRows').innerHTML = state.extensions
        .map((r) => {
            const value = state.metric === 'size' ? r.size : r.alloc;
            const share = value / total;
            return (
                `<div class="erow ext-grid${state.highlight === r.rank ? ' sel' : ''}" data-rank="${r.rank}">` +
                    `<div class="name"><span class="swatch" style="background:${r.color}"></span>` +
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

/* ---------------------------------------------------------- breadcrumbs --- */

async function renderCrumbs(): Promise<void> {
    if (state.status !== 'ready') {
        el('crumbs').innerHTML = '';
        return;
    }
    const { chain } = await api.ancestors(state.zoom);
    el('crumbs').innerHTML = chain
        .map((link, i) => (i ? '<span class="sep">›</span>' : '') + `<button data-zoom="${link.i}">${escapeHtml(link.n)}</button>`)
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

async function showStatus(id: number): Promise<void> {
    try {
        const node = await api.node(id);
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

function setStatus(summary: ScanSummary): void {
    state.summary = summary;
    state.status = summary.status;
    const scanning = summary.status === 'scanning';
    el('progress').hidden = !scanning;
    el('cancel').hidden = !scanning;
    el<HTMLButtonElement>('scan').disabled = scanning;

    if (summary.status === 'ready') {
        const total = state.metric === 'size' ? summary.size ?? 0 : summary.alloc ?? 0;
        el('summary').innerHTML =
            `<b>${bytes(total)}</b> in <b>${count(summary.files ?? 0)}</b> files, ` +
            `<b>${count(summary.dirs ?? 0)}</b> folders ` +
            `<span class="dim">(${((summary.elapsedMs ?? 0) / 1000).toFixed(1)}s${summary.cancelled ? ', partial' : ''})</span>`;
    } else if (summary.status === 'error') {
        el('summary').textContent = summary.error ?? 'Scan failed';
    }
}

async function afterScan(summary: ScanSummary): Promise<void> {
    setStatus(summary);
    state.rows.clear();
    state.kids.clear();
    state.expanded.clear();
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
        const { root } = JSON.parse((e as MessageEvent<string>).data) as { root: string };
        el<HTMLInputElement>('path').value = root;
        setUrlPath(root);
        setStatus({ status: 'scanning', root });
        const empty = el('mapEmpty');
        empty.hidden = false;
        empty.textContent = 'Scanning…';
    });
    events.addEventListener('progress', (e) => {
        const p = JSON.parse((e as MessageEvent<string>).data) as ScanProgress;
        el('progressCount').textContent = `${count(p.files)} files  ${bytes(p.bytes)}`;
        el('progressPath').textContent = p.path;
    });
    events.addEventListener('done', (e) => {
        void afterScan(JSON.parse((e as MessageEvent<string>).data) as ScanSummary);
    });
    events.addEventListener('failed', (e) => {
        const { message } = JSON.parse((e as MessageEvent<string>).data) as { message: string };
        setStatus({ status: 'error', root: state.summary?.root ?? null, error: message });
    });
}

function reportError(err: unknown): void {
    el('statusMeta').textContent = '';
    el('statusPath').textContent = err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------- toolbar --- */

el('scan').onclick = () => {
    void api.scan(el<HTMLInputElement>('path').value.trim()).catch(reportError);
};
el('cancel').onclick = () => void api.cancel().catch(reportError);
el<HTMLInputElement>('path').onkeydown = (e) => {
    if (e.key === 'Enter') el('scan').click();
};
el('up').onclick = () => {
    const current = el<HTMLInputElement>('path').value.trim();
    const parent = current.replace(/[\\/][^\\/]*[\\/]?$/, '') || '/';
    if (parent !== current) void api.scan(parent).catch(reportError);
};

for (const button of all<HTMLButtonElement>('.seg button')) {
    button.onclick = async () => {
        for (const b of all<HTMLButtonElement>('.seg button')) b.classList.toggle('on', b === button);
        state.metric = button.dataset.metric === 'size' ? 'size' : 'alloc';
        if (state.summary) setStatus(state.summary);
        renderExtensions();
        rebuildVisible();
        await loadTreemap();
    };
}

for (const button of all<HTMLButtonElement>('.pane-head [data-sort]')) {
    button.onclick = () => {
        const key = button.dataset.sort as SortKey;
        state.sort = { key, dir: state.sort.key === key ? (-state.sort.dir as 1 | -1) : key === 'name' ? 1 : -1 };
        for (const b of all<HTMLButtonElement>('.pane-head [data-sort]')) b.classList.toggle('on', b === button);
        rebuildVisible();
    };
}

/* ------------------------------------------------------------ tree events -- */

el('treeScroll').addEventListener('scroll', renderTreeWindow, { passive: true });

el('treeRows').addEventListener('click', (e) => {
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
    const known = node.g
        ? `${node.g.toLocaleString()} smaller items`
        : pathCache.get(node.i) ?? state.rows.get(node.i)?.n;

    tip.innerHTML = tipHtml(node, known ?? '…');
    tip.hidden = false;
    placeTip(tip, e.clientX, e.clientY);

    if (known === undefined && node.i >= 0) {
        void pathOf(node.i).then((path) => {
            // Only patch in the name if the pointer is still on the same tile.
            if (map.hovered !== tile || tip.hidden) return;
            tip.innerHTML = tipHtml(node, path);
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

addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    if (!el('modal').hidden) el('modalCancel').click();
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
            // The node is gone server-side; drop our caches for it and repaint.
            const parent = findParentOf(id);
            state.rows.delete(id);
            pathCache.delete(id);
            state.selected = null;
            if (parent !== null) {
                state.kids.delete(parent);
                await loadChildren(parent);
            }
            setStatus(await api.state());
            const root = await api.children(0);
            state.rows.set(0, { ...root.self, n: root.path });
            await loadExtensions();
            rebuildVisible();
            await loadTreemap();
        }
        el('statusPath').textContent = result.path;
    } catch (err) {
        reportError(err);
    }
}

function findParentOf(id: number): number | null {
    for (const [parent, kids] of state.kids) if (kids.includes(id)) return parent;
    return null;
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

void api.roots().then(({ roots, home }) => {
    const select = el<HTMLSelectElement>('roots');
    select.innerHTML =
        '<option value="">Volumes…</option>' +
        roots.map((r) => `<option value="${escapeHtml(r.path)}">${escapeHtml(r.label)}</option>`).join('');
    select.onchange = () => {
        if (!select.value) return;
        el<HTMLInputElement>('path').value = select.value;
        select.value = '';
        el('scan').click();
    };
    const pathInput = el<HTMLInputElement>('path');
    if (!pathInput.value) pathInput.value = home;
});

installColumnResizers(el('treePane'), TREE_COLUMNS, 'mydirstat.columns.tree');
installColumnResizers(el('extPane'), EXT_COLUMNS, 'mydirstat.columns.ext');

refreshColors();
connect();
