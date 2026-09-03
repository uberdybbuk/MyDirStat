/**
 * Pick whole file types.
 *
 * The same table the extension pane shows — what each type is, how much it
 * weighs, how many files — with a checkbox on every row. It answers "select the
 * source files" without anyone having to write out what a source file is: the
 * list is the scan's own extensions, so it is exactly as long as it needs to be
 * and never misses a type this particular tree happens to contain.
 *
 * The dialog is a transaction. Nothing is applied while it is open; closing it
 * with OK reports the complete set of chosen ranks, which the selection then
 * adopts wholesale.
 */

import { api } from './api.js';
import { el, all, escapeHtml } from './dom.js';
import { bytes, count, percent } from './format.js';
import type { ExtensionRow } from '../shared/protocol.js';

type SortKey = 'type' | 'size' | 'pct' | 'count';

const view = {
    rows: [] as ExtensionRow[],
    chosen: new Set<number>(),
    filter: '',
    sort: { key: 'size' as SortKey, dir: -1 as 1 | -1 },
};

/** Resolves with the chosen ranks, or null if the dialog was dismissed. */
let settle: ((ranks: number[] | null) => void) | null = null;

/**
 * Removing a whole file type is a different act from selecting one, so it is
 * handed back to the app rather than folded into what the dialog returns:
 * ticking a type must never be the thing that arms a delete.
 */
export interface TypeHandlers {
    remove(mode: 'trash' | 'permanent', types: string[], files: number, bytes: number): void;
}

let handlers: TypeHandlers = { remove: () => undefined };

export function initTypes(hooks: TypeHandlers): void {
    handlers = hooks;

    el('typesClose').onclick = () => finish(null);
    el('typesCancel').onclick = () => finish(null);
    el('typesOk').onclick = () => finish([...view.chosen]);

    el('typesAll').onclick = () => {
        // "Select all" means everything the list is currently showing, not
        // everything there is — otherwise it quietly overrides the filter.
        for (const row of visible()) view.chosen.add(row.rank);
        render();
    };
    el('typesNone').onclick = () => {
        for (const row of visible()) view.chosen.delete(row.rank);
        render();
    };

    let debounce: ReturnType<typeof setTimeout> | null = null;
    el<HTMLInputElement>('typesFilter').oninput = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
            view.filter = el<HTMLInputElement>('typesFilter').value.trim().toLowerCase();
            render();
        }, 120);
    };

    for (const button of all<HTMLButtonElement>('#types .pane-head [data-tsort]')) {
        button.onclick = () => {
            const key = button.dataset.tsort as SortKey;
            view.sort = {
                key,
                dir: view.sort.key === key ? (-view.sort.dir as 1 | -1) : key === 'type' ? 1 : -1,
            };
            for (const b of all<HTMLButtonElement>('#types .pane-head [data-tsort]')) {
                b.classList.toggle('on', b === button);
            }
            render();
        };
    }

    el('typesTrash').onclick = () => remove('trash');
    el('typesErase').onclick = () => remove('permanent');

    el('typesRows').addEventListener('click', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-rank]');
        if (!row) return;
        const rank = Number(row.dataset.rank);
        if (view.chosen.has(rank)) view.chosen.delete(rank);
        else view.chosen.add(rank);
        render();
    });

    el('types').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(null);
    });
}

export async function openTypes(selected: readonly number[]): Promise<number[] | null> {
    const data = await api.extensions();
    view.rows = data.rows;
    view.chosen = new Set(selected);
    view.filter = '';
    el<HTMLInputElement>('typesFilter').value = '';

    el('types').hidden = false;
    render();
    el<HTMLInputElement>('typesFilter').focus();

    return new Promise((resolve) => {
        settle = resolve;
    });
}

/** Hand the ticked types to the app's delete flow and step out of the way. */
function remove(mode: 'trash' | 'permanent'): void {
    const picked = chosenRows();
    if (picked.length === 0) return;
    finish(null); // the delete is not a selection change
    handlers.remove(
        mode,
        picked.map((r) => r.ext),
        picked.reduce((a, r) => a + r.count, 0),
        picked.reduce((a, r) => a + r.size, 0)
    );
}

function chosenRows(): ExtensionRow[] {
    return view.rows.filter((r) => view.chosen.has(r.rank));
}

function finish(ranks: number[] | null): void {
    el('types').hidden = true;
    const done = settle;
    settle = null;
    done?.(ranks);
}

function visible(): ExtensionRow[] {
    const { key, dir } = view.sort;
    // Share is size over a fixed total, so it orders exactly as size does; it
    // has its own key only so the header can show which column was clicked.
    const get = (r: ExtensionRow): string | number =>
        key === 'type' ? r.label.toLowerCase() : key === 'count' ? r.count : r.size;

    return view.rows
        .filter((r) => view.filter === '' || r.label.toLowerCase().includes(view.filter))
        .sort((a, b) => {
            const x = get(a);
            const y = get(b);
            if (x < y) return -dir;
            if (x > y) return dir;
            return a.label.localeCompare(b.label);
        });
}

function render(): void {
    const rows = visible();
    // Shares are of the whole scan, not of the filtered list: a share that moved
    // when you typed in the filter box would mean nothing.
    const total = view.rows.reduce((a, r) => a + r.size, 0) || 1;

    el('typesRows').innerHTML = rows
        .map((r) => {
            const share = r.size / total;
            const on = view.chosen.has(r.rank);
            return (
                `<div class="erow type-grid${on ? ' sel' : ''}" data-rank="${r.rank}">` +
                    `<div class="name">` +
                        `<span class="cbx" role="checkbox" aria-checked="${on}"></span>` +
                        `<span class="swatch" style="background:${r.color}"></span>` +
                        `<img class="ficon" src="/icons/${encodeURIComponent(r.icon)}.svg" alt="" loading="lazy" decoding="async">` +
                        `<span class="label">${escapeHtml(r.label)}</span>` +
                    `</div>` +
                    `<div class="num">${bytes(r.size)}</div>` +
                    `<div class="pct" style="--f:${share.toFixed(4)}"><i></i><span>${percent(share)}</span></div>` +
                    `<div class="num dim">${count(r.count)}</div>` +
                `</div>`
            );
        })
        .join('');

    const picked = chosenRows();
    const files = picked.reduce((a, r) => a + r.count, 0);
    const size = picked.reduce((a, r) => a + r.size, 0);
    el('typesTotals').textContent =
        picked.length === 0
            ? `No types chosen of ${count(view.rows.length)}`
            : `${count(picked.length)} of ${count(view.rows.length)} types · ` +
              `${count(files)} files · ${bytes(size)}`;
    el('typesNote').textContent =
        view.filter === '' ? '' : `${count(rows.length)} of ${count(view.rows.length)} types shown`;

    // Nothing ticked means nothing to remove.
    for (const id of ['typesTrash', 'typesErase']) {
        el<HTMLButtonElement>(id).disabled = picked.length === 0;
    }
}
