/**
 * Turns the in-memory tree into something a canvas can actually draw.
 *
 * A full drive scan is millions of nodes; a 1400x700 canvas at 2x has under
 * three million pixels. Most nodes are therefore sub-pixel and cannot be shown
 * at all, so the tree is pruned before it is ever serialised.
 *
 * The prune is driven by *projected area*, not by a node count. Given the
 * canvas area, a node's value maps directly to the pixels it will occupy, so
 * anything that would land under `minTile` is folded into an aggregate tile and
 * any directory too small to be worth subdividing is left whole. Budgeting by
 * node count instead produces wildly uneven detail: a single flat directory
 * with 50k files eats the entire allowance while its equally-large siblings
 * stay undifferentiated blocks.
 *
 * Names are deliberately absent from the result. Only the hovered tile ever
 * needs one, and the client fetches that on demand.
 */

import type { NodeStore } from './store.js';
import { F_DIR, F_ERROR, F_SKIPPED } from '../shared/protocol.js';
import type { SizeMetric, TreemapNode } from '../shared/protocol.js';

/** Binary max-heap keyed by node value. */
class MaxHeap<T extends { v: number }> {
    private items: T[] = [];

    get size(): number {
        return this.items.length;
    }

    push(item: T): void {
        const a = this.items;
        a.push(item);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].v >= a[i].v) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }

    pop(): T | undefined {
        const a = this.items;
        if (a.length === 0) return undefined;
        const top = a[0];
        const last = a.pop()!;
        if (a.length > 0) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let big = i;
                if (l < a.length && a[l].v > a[big].v) big = l;
                if (r < a.length && a[r].v > a[big].v) big = r;
                if (big === i) break;
                [a[big], a[i]] = [a[i], a[big]];
                i = big;
            }
        }
        return top;
    }
}

// A directory must be worth at least this many minimum tiles before
// subdividing it tells the eye anything.
const EXPAND_RATIO = 3;

export interface TreemapQueryOptions {
    /** Canvas size in device pixels. */
    area?: number;
    /**
     * Smallest tile worth emitting, in device pixels. Keep this near pixel size:
     * raising it folds sets that are individually small but collectively huge
     * (52k subdirectories, say) into one tile that then misreports itself as the
     * largest thing on the map.
     */
    minTile?: number;
    /** Hard safety cap on payload size. */
    maxTiles?: number;
}

export interface TreemapResult {
    root: TreemapNode;
    tiles: number;
    truncated: boolean;
    minValue: number;
}

export function buildTreemap(
    store: NodeStore,
    rootId: number,
    metric: SizeMetric = 'alloc',
    opts: TreemapQueryOptions = {}
): TreemapResult {
    const { area = 1_000_000, minTile = 4, maxTiles = 40000 } = opts;
    const value = metric === 'size' ? store.size : store.alloc;

    // Directories fall back to the dominant extension beneath them, so a tile
    // that cannot be subdivided still carries type information.
    const extOf = (i: number): number => store.colorExt(i);
    const node = (i: number): TreemapNode => ({
        i,
        v: value[i],
        e: extOf(i),
        f: store.flags[i],
        c: null,
    });

    const root = node(rootId);
    const rootValue = value[rootId];
    if (rootValue <= 0) return { root, tiles: 1, truncated: false, minValue: 0 };

    // Value that projects to exactly one minimum tile.
    const minValue = (rootValue * minTile) / Math.max(1, area);
    const expandValue = minValue * EXPAND_RATIO;

    let count = 1;
    const heap = new MaxHeap<TreemapNode>();
    if (store.flags[rootId] & F_DIR) heap.push(root);

    while (count < maxTiles) {
        const parent = heap.pop();
        if (!parent) break;
        // Too small to subdivide: it stays a single tile.
        if (parent !== root && parent.v < expandValue) continue;

        const kids: number[] = [];
        let foldedValue = 0;
        let foldedCount = 0;
        // Bytes folded per extension, so the aggregate can take the colour of
        // whatever actually dominates it. A directory of 200k small photos folds
        // to gigabytes; rendering that as neutral grey would misreport the single
        // biggest thing on the map.
        const foldedByExt = new Map<number, number>();

        // Children are pre-sorted largest-first, so everything past the first
        // sub-threshold child is also sub-threshold.
        for (const c of store.children(parent.i)) {
            const v = value[c];
            if (v >= minValue) {
                kids.push(c);
            } else if (v > 0 || store.flags[c] & (F_ERROR | F_SKIPPED)) {
                foldedValue += v;
                foldedCount += 1;
                const e = extOf(c);
                foldedByExt.set(e, (foldedByExt.get(e) ?? 0) + v);
            }
        }
        if (kids.length === 0 && foldedCount === 0) continue;

        let foldedExt = -1;
        let foldedBest = 0;
        for (const [e, v] of foldedByExt) {
            if (e >= 0 && v > foldedBest) {
                foldedBest = v;
                foldedExt = e;
            }
        }

        const children: TreemapNode[] = [];
        for (const c of kids) {
            if (count >= maxTiles) break;
            const child = node(c);
            children.push(child);
            count++;
            if (store.flags[c] & F_DIR) heap.push(child);
        }
        if (foldedValue > 0 && count < maxTiles) {
            children.push({ i: -1, v: foldedValue, e: foldedExt, f: 0, c: null, g: foldedCount });
            count++;
        }
        parent.c = children.length > 0 ? children : null;
    }

    return { root, tiles: count, truncated: heap.size > 0, minValue };
}
