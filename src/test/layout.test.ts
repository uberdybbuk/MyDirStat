import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squarify } from '../client/treemap.js';

interface Item {
    v: number;
    i: number;
}

interface Placed extends Item {
    x: number;
    y: number;
    w: number;
    h: number;
}

function layout(values: number[], w: number, h: number): Placed[] {
    const items: Item[] = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const out: Placed[] = [];
    squarify(items, 0, 0, w, h, (item, x, y, tw, th) => out.push({ ...item, x, y, w: tw, h: th }));
    return out;
}

test('every item gets exactly one tile', () => {
    const tiles = layout([6, 6, 4, 3, 2, 2, 1], 600, 400);
    assert.equal(tiles.length, 7);
    assert.equal(new Set(tiles.map((t) => t.i)).size, 7);
});

test('tiles tile the rectangle without gaps or overlap', () => {
    const values = Array.from({ length: 60 }, (_, i) => (i + 1) ** 1.7);
    const W = 800;
    const H = 500;
    const tiles = layout(values, W, H);

    const area = tiles.reduce((a, t) => a + t.w * t.h, 0);
    assert.ok(Math.abs(area - W * H) / (W * H) < 1e-9, `covered ${area} of ${W * H}`);

    for (const t of tiles) {
        assert.ok(t.x >= -1e-9 && t.y >= -1e-9, 'tile starts inside the rect');
        assert.ok(t.x + t.w <= W + 1e-9 && t.y + t.h <= H + 1e-9, 'tile ends inside the rect');
        assert.ok(t.w > 0 && t.h > 0, 'tile has positive extent');
    }

    for (let a = 0; a < tiles.length; a++) {
        for (let b = a + 1; b < tiles.length; b++) {
            const p = tiles[a];
            const q = tiles[b];
            const overlap =
                Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) *
                Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));
            assert.ok(overlap < 1e-6, `tiles ${a} and ${b} overlap by ${overlap}`);
        }
    }
});

test('tile area is proportional to value', () => {
    const values = [100, 50, 25, 12, 6, 3, 2, 1, 1];
    const W = 900;
    const H = 600;
    const tiles = layout(values, W, H);
    const total = values.reduce((a, b) => a + b, 0);
    for (const t of tiles) {
        const expected = (t.v / total) * W * H;
        assert.ok(Math.abs(t.w * t.h - expected) / expected < 1e-6, `${t.v}: got ${t.w * t.h}, want ${expected}`);
    }
});

test('aspect ratios stay reasonable, which is the point of squarifying', () => {
    const values = Array.from({ length: 200 }, () => 1 + Math.random() * 40);
    const tiles = layout(values, 1000, 700);
    const ratios = tiles.map((t) => Math.max(t.w / t.h, t.h / t.w)).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    assert.ok(median < 2.2, `median aspect ratio ${median.toFixed(2)} is too elongated`);
});

test('a single item fills the whole rectangle', () => {
    const [tile] = layout([42], 300, 200);
    assert.deepEqual([tile.x, tile.y, tile.w, tile.h], [0, 0, 300, 200]);
});

test('degenerate inputs do not throw', () => {
    assert.doesNotThrow(() => layout([], 100, 100));
    assert.doesNotThrow(() => layout([1, 2], 0, 100));
    assert.doesNotThrow(() => layout([1, 2], 100, 0));
});
