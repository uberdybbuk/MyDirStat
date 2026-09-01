/**
 * Draggable column widths for the tree and legend panes.
 *
 * Widths live in CSS custom properties on the pane, and both the header row and
 * the data rows read the same `grid-template-columns`, so a drag moves them
 * together with no re-render. Sizes persist per pane in localStorage.
 *
 * The first column is deliberately not resizable: it is `1fr` and absorbs
 * whatever the fixed columns give up, which is what stops the last column from
 * being clipped when the pane is narrow.
 */

export interface ColumnSpec {
    /** Matches the `data-grip` attribute on the header cell's grip. */
    key: string;
    /** CSS custom property carrying this column's width. */
    cssVar: string;
    /** Default width in pixels, used on first run and on double-click. */
    initial: number;
    min: number;
    max: number;
}

const DRAG_MIN = 2; // px of movement before a drag suppresses the header's sort

export function installColumnResizers(
    pane: HTMLElement,
    specs: readonly ColumnSpec[],
    storageKey: string
): void {
    const widths = new Map<string, number>(specs.map((s) => [s.key, s.initial]));

    // Stored widths are a convenience, not state we depend on: a malformed or
    // stale entry must never leave the pane unusable, so every value is clamped
    // back into the column's own range.
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, unknown>;
        for (const spec of specs) {
            const value = saved[spec.key];
            if (typeof value === 'number' && Number.isFinite(value)) {
                widths.set(spec.key, Math.min(spec.max, Math.max(spec.min, value)));
            }
        }
    } catch {
        /* unreadable storage: fall back to defaults */
    }

    const apply = (spec: ColumnSpec): void => {
        pane.style.setProperty(spec.cssVar, `${widths.get(spec.key)!}px`);
    };
    for (const spec of specs) apply(spec);

    const persist = (): void => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(widths)));
        } catch {
            /* private browsing or blocked storage: sizing still works this session */
        }
    };

    // A grip lives inside its header cell, which is also the sort button. After
    // a drag the browser still delivers a click to that button, so it has to be
    // swallowed or every resize would re-sort the pane.
    let swallowClick = false;
    pane.addEventListener(
        'click',
        (e) => {
            if (!swallowClick) return;
            swallowClick = false;
            e.preventDefault();
            e.stopPropagation();
        },
        true
    );

    for (const spec of specs) {
        const grip = pane.querySelector<HTMLElement>(`[data-grip="${spec.key}"]`);
        if (!grip) continue;

        grip.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startWidth = widths.get(spec.key)!;
            grip.classList.add('dragging');

            const move = (ev: MouseEvent): void => {
                const next = Math.min(spec.max, Math.max(spec.min, startWidth + (ev.clientX - startX)));
                widths.set(spec.key, next);
                apply(spec);
                if (Math.abs(ev.clientX - startX) > DRAG_MIN) swallowClick = true;
            };
            const up = (): void => {
                grip.classList.remove('dragging');
                removeEventListener('mousemove', move);
                removeEventListener('mouseup', up);
                persist();
            };
            addEventListener('mousemove', move);
            addEventListener('mouseup', up);
        });

        grip.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            swallowClick = true;
            widths.set(spec.key, spec.initial);
            apply(spec);
            persist();
        });
    }
}

export const TREE_COLUMNS: readonly ColumnSpec[] = [
    { key: 'size', cssVar: '--w-size', initial: 92, min: 60, max: 200 },
    { key: 'pct', cssVar: '--w-pct', initial: 90, min: 56, max: 220 },
    { key: 'items', cssVar: '--w-items', initial: 78, min: 48, max: 200 },
    // Wide enough for "2026-08-31 00:00" in the body font, which the old fixed
    // 128px was not: the column silently truncated every date.
    { key: 'date', cssVar: '--w-date', initial: 150, min: 90, max: 280 },
];

export const EXT_COLUMNS: readonly ColumnSpec[] = [
    { key: 'esize', cssVar: '--w-esize', initial: 86, min: 60, max: 200 },
    { key: 'epct', cssVar: '--w-epct', initial: 78, min: 52, max: 200 },
    { key: 'ecount', cssVar: '--w-ecount', initial: 62, min: 44, max: 160 },
];
