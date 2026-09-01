/**
 * Squarified cushion treemap.
 *
 * Two published algorithms, combined the way WinDirStat combines them:
 *
 *  - Layout: "Squarified Treemaps" (Bruls, Huizing & van Wijk, 2000). Children
 *    are laid into rows across the shorter side of the remaining rectangle,
 *    growing each row only while it improves the worst aspect ratio in it.
 *    Tiles come out near-square, which is what makes small files clickable and
 *    relative areas judgeable.
 *
 *  - Shading: "Cushion Treemaps" (van Wijk & van de Wetering, 1999). Every
 *    nesting level adds a parabolic ridge to a shared quadratic height field;
 *    each pixel is then lit from that surface's normal. The result reads as
 *    nested bumps, so directory structure is visible without drawing a single
 *    border. This is the effect that makes a WinDirStat map legible.
 */

import type { TreemapNode } from '../shared/protocol.js';

export interface TreemapOptions {
    height: number;
    scaleFactor: number;
    ambient: number;
    brightness: number;
    lightX: number;
    lightY: number;
    lightZ: number;
    minTile: number;
}

export const DEFAULTS: TreemapOptions = {
    height: 0.55, // ridge amplitude; surface normals reach +/-4*height at edges
    scaleFactor: 0.8, // ridge flattening per nesting level
    // A high ambient floor is not a stylistic choice: creases that fall to near
    // zero destroy the hue, and hue is the only channel carrying file type.
    ambient: 0.36,
    brightness: 1.0, // overall gain
    lightX: -0.45, // from the upper left
    lightY: -0.45,
    // Deliberately not normalised. Leaving lightZ above 1 and clamping cosa at
    // 1 gives each tile a flat lit plateau across its middle, with darkening
    // confined to the edges where the parabola is steep. That is what reads as
    // a crease between neighbours instead of a global gradient, and it keeps
    // the base colour identifiable, which a normalised [-1,1] range does not.
    lightZ: 1.4,
    minTile: 1, // device pixels below which a tile is not worth emitting
};

export interface Tile {
    node: TreemapNode;
    x: number;
    y: number;
    w: number;
    h: number;
    depth: number;
}

export type Rgb = readonly [number, number, number];
export type ColorOf = (node: TreemapNode) => Rgb;

/** Anything with a numeric value, laid out by area. */
export interface Sized {
    v: number;
}

/* -------------------------------------------------------------- layout ---- */

function worstRatio(sum: number, min: number, max: number, side: number): number {
    const s2 = sum * sum;
    const w2 = side * side;
    return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

/**
 * Lay `items` (descending by .v, all > 0) into the rectangle, calling
 * emit(item, x, y, w, h) for each.
 */
export function squarify<T extends Sized>(
    items: readonly T[],
    x: number,
    y: number,
    w: number,
    h: number,
    emit: (item: T, x: number, y: number, w: number, h: number) => void
): void {
    let total = 0;
    for (const it of items) total += it.v;
    if (total <= 0 || w <= 0 || h <= 0) return;

    const scale = (w * h) / total;
    const areas = items.map((it) => it.v * scale);

    let start = 0;
    while (start < areas.length && w > 0 && h > 0) {
        const horizontal = w >= h; // row runs down the left edge
        const side = horizontal ? h : w;

        let sum = 0;
        let min = Infinity;
        let max = 0;
        let best = Infinity;
        let end = start;

        while (end < areas.length) {
            const a = areas[end];
            const nextSum = sum + a;
            const nextMin = Math.min(min, a);
            const nextMax = Math.max(max, a);
            const ratio = worstRatio(nextSum, nextMin, nextMax, side);
            // Stop as soon as one more tile would make the row's worst tile worse.
            if (end > start && ratio > best) break;
            sum = nextSum;
            min = nextMin;
            max = nextMax;
            best = ratio;
            end++;
        }

        // The final row takes whatever is left: otherwise accumulated rounding
        // leaves an unpainted band along the bottom or right edge.
        const remaining = horizontal ? w : h;
        const thickness = end === areas.length ? remaining : Math.min(sum / side, remaining);

        let offset = 0;
        for (let k = start; k < end; k++) {
            const len = k === end - 1 ? side - offset : areas[k] / thickness;
            if (horizontal) emit(items[k], x, y + offset, thickness, len);
            else emit(items[k], x + offset, y, len, thickness);
            offset += len;
        }

        if (horizontal) {
            x += thickness;
            w -= thickness;
        } else {
            y += thickness;
            h -= thickness;
        }
        start = end;
    }
}

/* -------------------------------------------------------------- cushion --- */

type Surface = [number, number, number, number];

/**
 * Add one node's parabolic ridge to a height field of the form
 *   z = s0·x² + s1·y² + s2·x + s3·y
 * Derived so the parabola peaks at the rectangle's centre and falls to zero at
 * its edges, which is what makes adjacent tiles meet in a visible crease.
 */
function addRidge(surface: Surface, x1: number, y1: number, x2: number, y2: number, h: number): void {
    const w = x2 - x1;
    if (w > 0) {
        surface[2] += (4 * h * (x2 + x1)) / w;
        surface[0] -= (4 * h) / w;
    }
    const t = y2 - y1;
    if (t > 0) {
        surface[3] += (4 * h * (y2 + y1)) / t;
        surface[1] -= (4 * h) / t;
    }
}

/* ------------------------------------------------------------- component -- */

export class Treemap {
    readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    readonly opts: TreemapOptions;

    root: TreemapNode | null = null;
    colorOf: ColorOf = () => [128, 128, 128];
    tiles: Tile[] = [];
    selected: Tile | null = null;
    hovered: Tile | null = null;
    highlight: number | null = null; // extension rank to isolate

    /** Last painted base layer, reused for overlay-only repaints. */
    private image: ImageData | null = null;

    width = 0;
    height = 0;
    dpr = 1;

    constructor(canvas: HTMLCanvasElement, options: Partial<TreemapOptions> = {}) {
        this.canvas = canvas;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('2D canvas context unavailable');
        this.ctx = ctx;
        this.opts = { ...DEFAULTS, ...options };
    }

    setData(root: TreemapNode, colorOf?: ColorOf): void {
        this.root = root;
        if (colorOf) this.colorOf = colorOf;
        this.selected = null;
        this.hovered = null;
    }

    resize(): boolean {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (w === this.width && h === this.height && dpr === this.dpr) return false;
        this.canvas.width = w;
        this.canvas.height = h;
        this.width = w;
        this.height = h;
        this.dpr = dpr;
        return true;
    }

    /** Build the tile list. Separated from painting so hit tests survive repaints. */
    layout(): void {
        this.tiles = [];
        if (!this.root || this.width === 0) return;
        const { minTile } = this.opts;

        const walk = (node: TreemapNode, x: number, y: number, w: number, h: number, depth: number): void => {
            if (w < minTile || h < minTile) return;
            const drawable = node.c?.filter((k) => k.v > 0);
            if (!drawable || drawable.length === 0) {
                this.tiles.push({ node, x, y, w, h, depth });
                return;
            }
            squarify(drawable, x, y, w, h, (child, cx, cy, cw, ch) => walk(child, cx, cy, cw, ch, depth + 1));
        };

        walk(this.root, 0, 0, this.width, this.height, 0);
    }

    /**
     * Recompute the height field top-down and shade every pixel. Done in one
     * pass over an ImageData buffer; per-tile canvas fills would be far slower
     * and could not express the cushion at all.
     */
    paint(): void {
        const { ctx, width, height } = this;
        if (!this.root || width === 0) return;

        const image = ctx.createImageData(width, height);
        const data = image.data;
        const { height: h0, scaleFactor, ambient, brightness, lightX: Lx, lightY: Ly, lightZ: Lz, minTile } = this.opts;
        const specular = 1 - ambient;

        const shade = (node: TreemapNode, tx: number, ty: number, tw: number, th: number, surface: Surface): void => {
            const [r, g, b] = this.colorOf(node);
            const x0 = Math.max(0, Math.round(tx));
            const y0 = Math.max(0, Math.round(ty));
            const x1 = Math.min(width, Math.round(tx + tw));
            const y1 = Math.min(height, Math.round(ty + th));
            const [s0, s1, s2, s3] = surface;

            for (let py = y0; py < y1; py++) {
                const ny = -(2 * s1 * (py + 0.5) + s3);
                let idx = (py * width + x0) * 4;
                for (let px = x0; px < x1; px++) {
                    const nx = -(2 * s0 * (px + 0.5) + s2);
                    let cosa = (nx * Lx + ny * Ly + Lz) / Math.sqrt(nx * nx + ny * ny + 1);
                    if (cosa > 1) cosa = 1;
                    else if (cosa < 0) cosa = 0;
                    const intensity = (ambient + specular * cosa) * brightness;
                    let v = r * intensity;
                    data[idx] = v > 255 ? 255 : v;
                    v = g * intensity;
                    data[idx + 1] = v > 255 ? 255 : v;
                    v = b * intensity;
                    data[idx + 2] = v > 255 ? 255 : v;
                    data[idx + 3] = 255;
                    idx += 4;
                }
            }
        };

        // Mirror of layout()'s recursion, carrying the accumulated height field.
        const walk = (
            node: TreemapNode, x: number, y: number, w: number, h: number,
            surface: Surface, amplitude: number, depth: number
        ): void => {
            if (w < minTile || h < minTile) return;
            const next = surface.slice() as Surface;
            if (depth > 0) addRidge(next, x, y, x + w, y + h, amplitude);

            const kids = node.c?.filter((k) => k.v > 0);
            if (!kids || kids.length === 0) {
                shade(node, x, y, w, h, next);
                return;
            }
            squarify(kids, x, y, w, h, (child, cx, cy, cw, ch) =>
                walk(child, cx, cy, cw, ch, next, amplitude * scaleFactor, depth + 1)
            );
        };

        walk(this.root, 0, 0, width, height, [0, 0, 0, 0], h0, 0);
        this.image = image;
        ctx.putImageData(image, 0, 0);
        this.drawOverlays();
    }

    /**
     * Redraw hover, selection and highlight without re-shading. Restoring the
     * cached base layer costs one putImageData, where a full repaint costs a
     * million square roots.
     */
    overlay(): void {
        if (!this.image) {
            this.paint();
            return;
        }
        this.ctx.putImageData(this.image, 0, 0);
        this.drawOverlays();
    }

    private drawOverlays(): void {
        const { ctx, dpr } = this;
        ctx.save();
        ctx.lineJoin = 'miter';

        // Isolating an extension: dim everything that is not of that type, which
        // keeps the matching tiles at their true colour rather than recolouring.
        if (this.highlight !== null) {
            ctx.fillStyle = 'rgba(0,0,0,0.62)';
            for (const tile of this.tiles) {
                if (tile.node.e === this.highlight) continue;
                ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
            }
        }

        const outlines: [Tile | null, string, number][] = [
            [this.hovered, 'rgba(255,255,255,0.85)', 1],
            [this.selected, '#ffffff', 2],
        ];
        for (const [tile, color, lw] of outlines) {
            if (!tile) continue;
            ctx.strokeStyle = color;
            ctx.lineWidth = lw * dpr;
            const inset = (lw * dpr) / 2;
            ctx.strokeRect(tile.x + inset, tile.y + inset, Math.max(0, tile.w - lw * dpr), Math.max(0, tile.h - lw * dpr));
            if (tile === this.selected) {
                // A dark inner line so the white outline reads on pale tiles too.
                ctx.strokeStyle = 'rgba(0,0,0,0.7)';
                ctx.lineWidth = dpr;
                ctx.strokeRect(
                    tile.x + inset + dpr, tile.y + inset + dpr,
                    Math.max(0, tile.w - lw * dpr - 2 * dpr), Math.max(0, tile.h - lw * dpr - 2 * dpr)
                );
            }
        }
        ctx.restore();
    }

    render(): void {
        this.resize();
        this.layout();
        this.paint();
    }

    /** CSS-pixel coordinates in, tile out. */
    tileAt(cssX: number, cssY: number): Tile | null {
        const x = cssX * this.dpr;
        const y = cssY * this.dpr;
        // Later tiles are drawn on top; scan backwards so they win ties.
        for (let i = this.tiles.length - 1; i >= 0; i--) {
            const t = this.tiles[i];
            if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return t;
        }
        return null;
    }

    tileForId(id: number): Tile | null {
        return this.tiles.find((t) => t.node.i === id) ?? null;
    }

    setHovered(tile: Tile | null): boolean {
        if (tile === this.hovered) return false;
        this.hovered = tile;
        return true;
    }

    setSelected(tile: Tile | null): boolean {
        if (tile === this.selected) return false;
        this.selected = tile;
        return true;
    }

    setHighlight(rank: number | null): boolean {
        if (rank === this.highlight) return false;
        this.highlight = rank;
        return true;
    }
}
