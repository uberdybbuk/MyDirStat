/**
 * The path box, completing the way an Explorer address bar does.
 *
 * Two things happen at once, and both matter. As soon as what has been typed
 * has a single obvious continuation, the rest of that folder's name is written
 * into the box and left *selected*, so carrying on typing simply replaces it and
 * Enter accepts it — the completion is offered without ever getting in the way.
 * Underneath, the folders that still match are listed, and the arrow keys walk
 * that list.
 *
 * Completion is only ever offered forwards. Nothing is appended while the user
 * is deleting, or the box would refuse to shrink: backspace would remove a
 * character, the completion would put it straight back.
 *
 * Listings are cached per directory, so typing through a path is one request per
 * folder rather than one per keystroke.
 */

import { api } from './api.js';
import { el, escapeHtml } from './dom.js';
import type { BrowseResponse } from '../shared/protocol.js';

type Entry = BrowseResponse['entries'][number];

/** Enough to fill the list several times over; the rest is never scrolled to. */
const MAX_ROWS = 300;

const view = {
    /** Directory whose children are listed, with its trailing separator. */
    dir: '',
    entries: [] as Entry[],
    matches: [] as Entry[],
    active: -1,
    open: false,
    generation: 0,
};

const cache = new Map<string, Entry[]>();

let input: HTMLInputElement;
let list: HTMLElement;
let onAccept: () => void = () => undefined;

export function initPathInput(accept: () => void): void {
    onAccept = accept;
    input = el<HTMLInputElement>('path');
    list = el('pathList');

    input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', (e) => {
        const deleting = (e as InputEvent).inputType?.startsWith('delete') ?? false;
        void refresh({ complete: !deleting });
    });
    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('blur', () => close());

    // mousedown, not click: the default would move focus out of the box first,
    // and blur would close the list before the click ever landed.
    list.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
        if (!row) return;
        void enter(view.matches[Number(row.dataset.index)]);
    });

    addEventListener('resize', () => {
        if (view.open) place();
    });
}

/* ------------------------------------------------------------------ keys -- */

function onKeyDown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
            e.preventDefault();
            if (!view.open) {
                void refresh({ complete: false, force: true });
                return;
            }
            step(e.key === 'ArrowDown' ? 1 : -1);
            return;
        }

        case 'Tab': {
            // Accept the offer and go one level deeper, without leaving the box.
            const entry = view.matches[view.active];
            if (!entry) return;
            e.preventDefault();
            void enter(entry);
            return;
        }

        case 'Enter':
            close();
            onAccept();
            return;

        case 'Escape':
            if (!view.open) return; // let it reach whatever else is listening
            e.stopPropagation();
            close();
            return;

        default:
    }
}

/** Move through the list, writing each candidate into the box as Explorer does. */
function step(by: number): void {
    const n = view.matches.length;
    if (n === 0) return;
    view.active = view.active < 0 ? (by > 0 ? 0 : n - 1) : (view.active + by + n) % n;
    const entry = view.matches[view.active];
    input.value = view.dir + entry.name;
    // Caret at the end: this is a choice made, not an offer to type over.
    input.setSelectionRange(input.value.length, input.value.length);
    render();
}

/** Take an entry and list what is inside it. */
async function enter(entry: Entry | undefined): Promise<void> {
    if (!entry) return;
    input.value = `${view.dir}${entry.name}/`;
    input.setSelectionRange(input.value.length, input.value.length);
    await refresh({ complete: false });
}

/* ------------------------------------------------------------------ data -- */

interface RefreshOptions {
    /** Write the rest of the best match into the box and leave it selected. */
    complete: boolean;
    /** Open the list even when nothing has been typed to filter by. */
    force?: boolean;
}

async function refresh({ complete, force = false }: RefreshOptions): Promise<void> {
    const typed = input.value;
    const cut = typed.lastIndexOf('/');
    if (cut < 0) {
        // No separator yet: a bare drive letter or a fragment of nothing. There
        // is no directory to list, so there is nothing to offer.
        close();
        return;
    }

    const dir = typed.slice(0, cut + 1);
    const fragment = typed.slice(cut + 1);
    const generation = ++view.generation;

    const entries = await listing(dir, fragment.startsWith('.'));
    if (generation !== view.generation) return; // a later keystroke won
    // The box may have moved on while the request was in flight.
    if (input.value !== typed) return;

    const needle = fragment.toLowerCase();
    view.dir = dir;
    view.entries = entries;
    view.matches = needle === ''
        ? entries
        : entries.filter((e) => e.name.toLowerCase().startsWith(needle));
    view.active = view.matches.length > 0 ? 0 : -1;

    if (view.matches.length === 0 && !force) {
        close();
        return;
    }

    if (complete && fragment !== '' && view.active >= 0) {
        const best = view.matches[0].name;
        // Only ever *extend* what was typed, and only where the case matches
        // what the disk says, so the box shows the folder's real name.
        input.value = dir + best;
        input.setSelectionRange(typed.length, input.value.length);
    }

    open();
    render();
}

async function listing(dir: string, hidden: boolean): Promise<Entry[]> {
    const key = `${hidden ? 'h:' : ''}${dir}`;
    const cached = cache.get(key);
    if (cached) return cached;
    try {
        const data = await api.browse(dir, hidden);
        cache.set(key, data.entries);
        return data.entries;
    } catch {
        // An unreadable or missing folder simply has nothing to suggest.
        cache.set(key, []);
        return [];
    }
}

/* ----------------------------------------------------------------- panel -- */

function open(): void {
    view.open = true;
    list.hidden = false;
    place();
}

function close(): void {
    view.open = false;
    list.hidden = true;
}

/**
 * The list is positioned against the box rather than nested inside it: the
 * toolbar is a flex row, and a wrapper would change how the box itself sizes.
 */
function place(): void {
    const box = input.getBoundingClientRect();
    list.style.left = `${Math.round(box.left)}px`;
    list.style.top = `${Math.round(box.bottom + 2)}px`;
    list.style.width = `${Math.round(box.width)}px`;
}

function render(): void {
    list.innerHTML = view.matches
        .slice(0, MAX_ROWS)
        .map((entry, index) =>
            `<div class="path-row${index === view.active ? ' on' : ''}" data-index="${index}" role="option">` +
                `<img class="ficon" src="/icons/${encodeURIComponent(entry.icon)}.svg" alt="" loading="lazy" decoding="async">` +
                `<span>${escapeHtml(entry.name)}</span>` +
            `</div>`
        )
        .join('');

    const row = list.children[view.active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
}
