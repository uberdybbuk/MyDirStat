/**
 * Columnar node store.
 *
 * A scan of a large volume can easily produce millions of nodes, so the tree is
 * kept as parallel typed arrays instead of one object per file. That costs
 * roughly 45 bytes per node plus the UTF-8 name, and the whole thing moves
 * between the worker and the server as transferable ArrayBuffers with no
 * serialisation pass.
 *
 * Structural invariant relied upon throughout: a child is always allocated
 * after its parent, so `parent[i] < i`. A single reverse loop is therefore a
 * valid post-order traversal, which is what makes `aggregate()` and
 * `computeDominant()` one cheap pass each.
 */

import { F_DIR } from '../shared/protocol.js';

export const F_AGG = 32; // synthetic aggregate node, server-side only
export const F_GONE = 64; // removed from disk; still in the arrays, not in the tree

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Grouped by element type so growth can loop instead of repeating itself.
const I32_COLUMNS = ['parent', 'child0', 'sib', 'last', 'ext', 'domExt'] as const;
const F64_COLUMNS = ['size', 'alloc', 'mtime'] as const;
const U32_COLUMNS = ['files', 'dirs'] as const;
const U8_COLUMNS = ['flags'] as const;

/** Shape handed to `postMessage`; every typed array is transferred, not copied. */
export interface StoreTransfer {
    count: number;
    root: string;
    nameLen: number;
    nameOff: Uint32Array;
    nameBuf: Uint8Array;
    extNames: string[];
    extSize: number[];
    extAlloc: number[];
    extCount: number[];
    columns: Record<string, Int32Array | Float64Array | Uint32Array | Uint8Array>;
}

export class NodeStore {
    count = 0;
    cap: number;

    parent!: Int32Array;
    child0!: Int32Array;
    sib!: Int32Array;
    last!: Int32Array;
    ext!: Int32Array;
    /**
     * Extension of the largest single file anywhere in the subtree. Lets a
     * directory too small to subdivide still show what it is made of instead of
     * rendering as a neutral grey mass.
     */
    domExt!: Int32Array;

    size!: Float64Array;
    alloc!: Float64Array;
    mtime!: Float64Array;

    files!: Uint32Array;
    dirs!: Uint32Array;

    flags!: Uint8Array;

    nameOff!: Uint32Array;
    nameBuf: Uint8Array;
    nameLen = 0;

    extNames: string[] = [];
    extSize: number[] = [];
    extAlloc: number[] = [];
    extCount: number[] = [];

    root = '';
    cancelled = false;

    /**
     * Allocation each node owns by itself, children excluded. Only meaningful
     * for directories — a file's own allocation is simply `alloc[i]` — and only
     * present once something is about to be removed, since it exists purely so
     * `recompute()` can rebuild the totals from scratch. See `captureOwn()`.
     */
    ownAlloc: Float64Array | null = null;

    constructor(capacity = 4096, nameCapacity = 1 << 16) {
        this.cap = capacity;
        for (const name of I32_COLUMNS) this[name] = new Int32Array(capacity);
        for (const name of F64_COLUMNS) this[name] = new Float64Array(capacity);
        for (const name of U32_COLUMNS) this[name] = new Uint32Array(capacity);
        for (const name of U8_COLUMNS) this[name] = new Uint8Array(capacity);
        // One extra slot so nameOff[i + 1] always marks the end of node i's name.
        this.nameOff = new Uint32Array(capacity + 1);
        this.nameBuf = new Uint8Array(nameCapacity);
    }

    private growNodes(need: number): void {
        if (need <= this.cap) return;
        let cap = this.cap;
        while (cap < need) cap *= 2;

        for (const name of I32_COLUMNS) {
            const next = new Int32Array(cap);
            next.set(this[name]);
            this[name] = next;
        }
        for (const name of F64_COLUMNS) {
            const next = new Float64Array(cap);
            next.set(this[name]);
            this[name] = next;
        }
        for (const name of U32_COLUMNS) {
            const next = new Uint32Array(cap);
            next.set(this[name]);
            this[name] = next;
        }
        for (const name of U8_COLUMNS) {
            const next = new Uint8Array(cap);
            next.set(this[name]);
            this[name] = next;
        }
        const off = new Uint32Array(cap + 1);
        off.set(this.nameOff);
        this.nameOff = off;
        this.cap = cap;
    }

    private growNames(extra: number): void {
        const need = this.nameLen + extra;
        if (need <= this.nameBuf.length) return;
        let cap = this.nameBuf.length || 1024;
        while (cap < need) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.nameBuf.subarray(0, this.nameLen));
        this.nameBuf = next;
    }

    /** Append a node and link it as the last child of `parent` (-1 for root). */
    add(parent: number, name: string, flags = 0): number {
        const i = this.count;
        this.growNodes(i + 1);

        const bytes = encoder.encode(name);
        this.growNames(bytes.length);
        this.nameOff[i] = this.nameLen;
        this.nameBuf.set(bytes, this.nameLen);
        this.nameLen += bytes.length;
        this.nameOff[i + 1] = this.nameLen;

        this.parent[i] = parent;
        this.child0[i] = -1;
        this.sib[i] = -1;
        this.last[i] = -1;
        this.size[i] = 0;
        this.alloc[i] = 0;
        this.files[i] = 0;
        this.dirs[i] = 0;
        this.mtime[i] = 0;
        this.flags[i] = flags;
        this.ext[i] = -1;
        this.domExt[i] = -1;
        this.count = i + 1;

        if (parent >= 0) {
            const prev = this.last[parent];
            if (prev === -1) this.child0[parent] = i;
            else this.sib[prev] = i;
            this.last[parent] = i;
        }
        return i;
    }

    name(i: number): string {
        return decoder.decode(this.nameBuf.subarray(this.nameOff[i], this.nameOff[i + 1]));
    }

    /**
     * The extension rank a node is coloured by: its own, or — for a directory,
     * which has none — the dominant type beneath it. The treemap and the tree
     * pane must agree on this, so it lives here rather than being derived
     * separately in each.
     */
    colorExt(i: number): number {
        return this.ext[i] >= 0 ? this.ext[i] : this.domExt[i];
    }

    isDir(i: number): boolean {
        return (this.flags[i] & F_DIR) !== 0;
    }

    *children(i: number): Generator<number> {
        for (let c = this.child0[i]; c !== -1; c = this.sib[c]) yield c;
    }

    /** Names from the root down to `i`, exclusive of the root's own name. */
    segments(i: number): string[] {
        const out: string[] = [];
        for (let n = i; n > 0; n = this.parent[n]) out.push(this.name(n));
        out.reverse();
        return out;
    }

    /**
     * Roll subtree totals up to the root. Safe as a single reverse pass because
     * every child index exceeds its parent's.
     */
    aggregate(): void {
        const { parent, size, alloc, files, dirs, flags } = this;
        for (let i = this.count - 1; i > 0; i--) {
            const p = parent[i];
            size[p] += size[i];
            alloc[p] += alloc[i];
            files[p] += files[i];
            dirs[p] += dirs[i];
            if (flags[i] & F_DIR) dirs[p] += 1;
            else files[p] += 1;
        }
    }

    /**
     * Remember what every node contributes on its own, before anything is
     * removed from the tree.
     *
     * Aggregation is destructive: after it, a directory's `alloc` is its whole
     * subtree and the few kilobytes the directory entry itself occupies can no
     * longer be told apart. Recovering it needs a tree that still adds up, so
     * the snapshot has to be taken before the first removal. Idempotent, and
     * only paid for when the user actually deletes something.
     */
    captureOwn(): void {
        if (this.ownAlloc) return;
        const own = new Float64Array(this.count);
        own.set(this.alloc.subarray(0, this.count));
        for (let i = 1; i < this.count; i++) {
            const p = this.parent[i];
            if (p >= 0) own[p] -= this.alloc[i];
        }
        this.ownAlloc = own;
    }

    /**
     * Rebuild every total from the nodes still attached to the root.
     *
     * Deletion used to patch the totals in place, subtracting each removed node
     * from its ancestors. One miscount there — a node accounted for twice, or a
     * removal that never happened on disk — leaves the tree permanently
     * inconsistent, and the symptom is a directory reporting more bytes than the
     * root that contains it, which is where shares above 100% come from. Summing
     * the survivors instead cannot drift: it is the same arithmetic the scan
     * itself performed.
     *
     * Nodes that have been unlinked keep their `parent` entry, so reachability
     * is established by walking the child chains rather than trusting it.
     */
    recompute(): void {
        const { parent, size, alloc, files, dirs, flags, child0, sib, ext } = this;
        const own = this.ownAlloc;

        const live = new Uint8Array(this.count);
        const stack: number[] = this.count > 0 ? [0] : [];
        while (stack.length > 0) {
            const n = stack.pop()!;
            live[n] = 1;
            for (let c = child0[n]; c !== -1; c = sib[c]) stack.push(c);
        }

        for (let i = 0; i < this.count; i++) {
            if (live[i] === 0) {
                // Everything that walks the arrays directly — the extension
                // legend, the selection, the search — has to know these are no
                // longer there, or a deleted file stays selectable.
                flags[i] |= F_GONE;
                continue;
            }
            files[i] = 0;
            dirs[i] = 0;
            // A file's own size is already in place and is never touched; a
            // directory holds no bytes of its own beyond its allocation.
            if (flags[i] & F_DIR) size[i] = 0;
            alloc[i] = own ? own[i] : (flags[i] & F_DIR ? 0 : alloc[i]);
        }

        // A live node's parent is live by construction, so one reverse pass is
        // again a valid post-order roll-up.
        for (let i = this.count - 1; i > 0; i--) {
            if (live[i] === 0) continue;
            const p = parent[i];
            size[p] += size[i];
            alloc[p] += alloc[i];
            files[p] += files[i];
            dirs[p] += dirs[i];
            if (flags[i] & F_DIR) dirs[p] += 1;
            else files[p] += 1;
        }

        // The legend is a second view of the same bytes and drifts the same way.
        const n = this.extNames.length;
        const bySize = new Float64Array(n);
        const byAlloc = new Float64Array(n);
        const byCount = new Uint32Array(n);
        for (let i = 0; i < this.count; i++) {
            const e = ext[i];
            if (live[i] === 0 || e < 0) continue;
            bySize[e] += size[i];
            byAlloc[e] += alloc[i];
            byCount[e] += 1;
        }
        // Ranks stay put: they decide colours, and a delete must not repaint the
        // whole treemap.
        this.extSize = Array.from(bySize);
        this.extAlloc = Array.from(byAlloc);
        this.extCount = Array.from(byCount);

        // Same roll-up as computeDominant(), restricted to the survivors — a
        // deleted file must not keep colouring the directory it was in.
        const domBytes = new Float64Array(this.count);
        for (let i = 0; i < this.count; i++) {
            if (live[i] === 0) continue;
            const isFile = (flags[i] & F_DIR) === 0;
            domBytes[i] = isFile ? alloc[i] : 0;
            this.domExt[i] = isFile ? ext[i] : -1;
        }
        for (let i = this.count - 1; i > 0; i--) {
            if (live[i] === 0) continue;
            const p = parent[i];
            if (domBytes[i] > domBytes[p]) {
                domBytes[p] = domBytes[i];
                this.domExt[p] = this.domExt[i];
            }
        }
    }

    /** Order every sibling chain by allocated size, largest first. */
    sortChildren(): void {
        const { alloc, size, child0, sib, last } = this;
        const compare = (a: number, b: number): number =>
            alloc[b] - alloc[a] || size[b] - size[a] || (this.name(a) < this.name(b) ? -1 : 1);

        const buf: number[] = [];
        for (let i = 0; i < this.count; i++) {
            if (child0[i] === -1 || sib[child0[i]] === -1) continue; // 0 or 1 child
            buf.length = 0;
            for (let c = child0[i]; c !== -1; c = sib[c]) buf.push(c);
            buf.sort(compare);
            child0[i] = buf[0];
            for (let k = 0; k < buf.length - 1; k++) sib[buf[k]] = buf[k + 1];
            sib[buf[buf.length - 1]] = -1;
            last[i] = buf[buf.length - 1];
        }
    }

    /** Total per extension, sorted by allocated size. Call after aggregate(). */
    summarise(extNames: string[]): void {
        const n = extNames.length;
        const bySize = new Float64Array(n);
        const byAlloc = new Float64Array(n);
        const byCount = new Uint32Array(n);

        for (let i = 0; i < this.count; i++) {
            const e = this.ext[i];
            if (e < 0) continue;
            bySize[e] += this.size[i];
            byAlloc[e] += this.alloc[i];
            byCount[e] += 1;
        }

        const order = Array.from({ length: n }, (_, i) => i)
            .sort((a, b) => byAlloc[b] - byAlloc[a] || byCount[b] - byCount[a]);

        // Renumber so extension id 0 is the largest; colour assignment is by rank.
        const remap = new Int32Array(n);
        order.forEach((old, rank) => (remap[old] = rank));
        for (let i = 0; i < this.count; i++) {
            if (this.ext[i] >= 0) this.ext[i] = remap[this.ext[i]];
        }

        this.extNames = order.map((o) => extNames[o]);
        this.extSize = order.map((o) => bySize[o]);
        this.extAlloc = order.map((o) => byAlloc[o]);
        this.extCount = order.map((o) => byCount[o]);
    }

    /**
     * Label every directory with the extension of the heaviest single file
     * beneath it. Must run after summarise(), which renumbers extension ids.
     */
    computeDominant(): void {
        const { parent, flags, alloc, ext, domExt, count } = this;
        const domBytes = new Float64Array(count);

        for (let i = 0; i < count; i++) {
            if ((flags[i] & F_DIR) === 0) {
                domBytes[i] = alloc[i];
                domExt[i] = ext[i];
            } else {
                domExt[i] = -1;
            }
        }
        for (let i = count - 1; i > 0; i--) {
            const p = parent[i];
            if (domBytes[i] > domBytes[p]) {
                domBytes[p] = domBytes[i];
                domExt[p] = domExt[i];
            }
        }
    }

    /** Compact, transferable representation. Trims every column to `count`. */
    toTransfer(): { payload: StoreTransfer; transfer: ArrayBuffer[] } {
        const columns: StoreTransfer['columns'] = {};
        const transfer: ArrayBuffer[] = [];

        const take = (name: string, trimmed: Int32Array | Float64Array | Uint32Array | Uint8Array): void => {
            columns[name] = trimmed;
            transfer.push(trimmed.buffer as ArrayBuffer);
        };
        for (const name of I32_COLUMNS) take(name, this[name].slice(0, this.count));
        for (const name of F64_COLUMNS) take(name, this[name].slice(0, this.count));
        for (const name of U32_COLUMNS) take(name, this[name].slice(0, this.count));
        for (const name of U8_COLUMNS) take(name, this[name].slice(0, this.count));

        const nameOff = this.nameOff.slice(0, this.count + 1);
        const nameBuf = this.nameBuf.slice(0, this.nameLen);
        transfer.push(nameOff.buffer as ArrayBuffer, nameBuf.buffer as ArrayBuffer);

        return {
            payload: {
                count: this.count,
                root: this.root,
                nameLen: this.nameLen,
                nameOff,
                nameBuf,
                extNames: this.extNames,
                extSize: this.extSize,
                extAlloc: this.extAlloc,
                extCount: this.extCount,
                columns,
            },
            transfer,
        };
    }

    static fromTransfer(payload: StoreTransfer): NodeStore {
        const store = Object.create(NodeStore.prototype) as NodeStore;
        store.count = payload.count;
        store.cap = payload.count;

        for (const name of I32_COLUMNS) store[name] = payload.columns[name] as Int32Array;
        for (const name of F64_COLUMNS) store[name] = payload.columns[name] as Float64Array;
        for (const name of U32_COLUMNS) store[name] = payload.columns[name] as Uint32Array;
        for (const name of U8_COLUMNS) store[name] = payload.columns[name] as Uint8Array;

        store.nameOff = payload.nameOff;
        store.nameBuf = payload.nameBuf;
        store.nameLen = payload.nameLen;
        store.root = payload.root;
        store.extNames = payload.extNames;
        store.extSize = payload.extSize;
        store.extAlloc = payload.extAlloc;
        store.extCount = payload.extCount;
        store.cancelled = false;
        // Object.create skips field initialisers, so this is not redundant.
        store.ownAlloc = null;
        return store;
    }
}
