import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeStore } from '../server/store.js';
import { Selection, isPrecompressed } from '../server/selection.js';
import { F_DIR, SEL_ALL, SEL_NONE, SEL_PARTIAL } from '../shared/protocol.js';

type Tree = { [name: string]: number | Tree };

/**
 * Build a store the way the scan worker does, so these tests exercise the real
 * extension ranking and aggregation rather than a stand-in.
 */
function buildStore(tree: Tree, root = '/root'): NodeStore {
    const store = new NodeStore(64, 1024);
    store.root = root;
    const extIds = new Map<string, number>();
    const extNames: string[] = [];
    const intern = (name: string): number => {
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : '';
        let id = extIds.get(ext);
        if (id === undefined) {
            id = extNames.length;
            extNames.push(ext);
            extIds.set(ext, id);
        }
        return id;
    };

    const rootIdx = store.add(-1, root, F_DIR);
    const walk = (parent: number, node: Tree): void => {
        for (const [name, value] of Object.entries(node)) {
            if (typeof value === 'number') {
                const i = store.add(parent, name);
                store.size[i] = value;
                store.alloc[i] = value;
                store.ext[i] = intern(name);
            } else {
                walk(store.add(parent, name, F_DIR), value);
            }
        }
    };
    walk(rootIdx, tree);

    store.aggregate();
    store.sortChildren();
    store.summarise(extNames);
    store.computeDominant();
    return store;
}

/** Find a node by its path relative to the root. */
function at(store: NodeStore, path: string): number {
    let node = 0;
    for (const part of path.split('/').filter(Boolean)) {
        let found = -1;
        for (const c of store.children(node)) {
            if (store.name(c) === part) { found = c; break; }
        }
        assert.notEqual(found, -1, `no node at ${path} (missing ${part})`);
        node = found;
    }
    return node;
}

const names = (store: NodeStore, ids: ArrayLike<number> | number[]): string[] =>
    Array.from(ids as number[], (id) => store.segments(id).join('/')).sort();

const FIXTURE: Tree = {
    src: {
        'app.ts': 100,
        'main.ts': 200,
        lib: { 'util.ts': 50, 'helper.ts': 60, 'notes.md': 10 },
    },
    media: { 'clip.mp4': 100000, 'photo.jpg': 5000 },
    'readme.md': 30,
};

test('including a folder selects every file beneath it', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    sel.include([at(store, 'src')]);
    assert.deepEqual(names(store, sel.resolve().ids), [
        'src/app.ts', 'src/lib/helper.ts', 'src/lib/notes.md', 'src/lib/util.ts', 'src/main.ts',
    ]);
    assert.equal(sel.resolve().totalFiles, 5);
    assert.equal(sel.resolve().totalBytes, 100 + 200 + 50 + 60 + 10);
});

test('a folder is never itself an entry; only its files are', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    sel.include([at(store, 'src')]);
    assert.equal(sel.resolve().selected[at(store, 'src')], 0);
    assert.equal(sel.resolve().selected[at(store, 'src/lib')], 0);
});

test('excluding a subfolder removes only its files', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    sel.include([at(store, 'src')]);
    sel.exclude([at(store, 'src/lib')]);
    assert.deepEqual(names(store, sel.resolve().ids), ['src/app.ts', 'src/main.ts']);
});

test('the nearest rule wins, so one file can be rescued from an excluded folder', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    sel.include([at(store, 'src')]);
    sel.exclude([at(store, 'src/lib')]);
    sel.include([at(store, 'src/lib/util.ts')]);

    assert.deepEqual(names(store, sel.resolve().ids), ['src/app.ts', 'src/lib/util.ts', 'src/main.ts']);
    // And the rule set stayed small rather than enumerating the siblings.
    const rules = sel.ruleCounts;
    assert.equal(rules.included, 2);
    assert.equal(rules.excluded, 1);
});

test('unticking a folder clears files picked individually inside it', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);

    sel.include([at(store, 'src/lib/util.ts')]);
    assert.equal(sel.resolve().totalFiles, 1);

    // A decision on the folder is a statement about its whole subtree. Without
    // pruning, the deeper per-file rule would be nearer and would keep winning,
    // so the folder's checkbox would appear inert.
    sel.exclude([at(store, 'src/lib')]);
    assert.equal(sel.resolve().totalFiles, 0);
    assert.equal(sel.state(at(store, 'src/lib')), SEL_NONE);
});

test('unticking a folder clears a bulk match made inside it', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);

    // What "Select all N" produces: one include rule per matched file.
    sel.include(sel.searchAll('.ts', 100).ids);
    assert.equal(sel.resolve().totalFiles, 4);
    assert.equal(sel.ruleCounts.included, 4);

    sel.exclude([at(store, 'src/lib')]);
    assert.equal(sel.resolve().totalFiles, 2, 'only src/app.ts and src/main.ts survive');
    assert.equal(sel.state(at(store, 'src/lib')), SEL_NONE);
    // The two rules under src/lib collapsed into the single folder rule.
    assert.equal(sel.ruleCounts.included, 2);
    assert.equal(sel.ruleCounts.excluded, 1);
});

test('ticking a folder subsumes the rules beneath it', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);

    sel.include([at(store, 'src')]);
    sel.exclude([at(store, 'src/lib/util.ts')]);
    sel.exclude([at(store, 'src/lib/helper.ts')]);
    assert.equal(sel.resolve().totalFiles, 3);

    // Re-ticking the parent is a fresh statement about everything under it.
    sel.include([at(store, 'src/lib')]);
    assert.equal(sel.resolve().totalFiles, 5);
    assert.equal(sel.ruleCounts.excluded, 0, 'stale child rules were dropped');
});

test('toggling a folder off and on again round-trips', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    const lib = at(store, 'src/lib');

    sel.toggle([lib]);
    assert.equal(sel.state(lib), SEL_ALL);
    sel.toggle([lib]);
    assert.equal(sel.state(lib), SEL_NONE);
    sel.toggle([lib]);
    assert.equal(sel.state(lib), SEL_ALL);
    assert.equal(sel.resolve().totalFiles, 3);
});

test('extension picks reach files anywhere', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    sel.setExtension(store.extNames.indexOf('.md'), true);
    assert.deepEqual(names(store, sel.resolve().ids), ['readme.md', 'src/lib/notes.md']);
});

test('an explicit exclusion overrides an extension pick', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    sel.setExtension(store.extNames.indexOf('.md'), true);
    sel.exclude([at(store, 'src/lib')]);
    assert.deepEqual(names(store, sel.resolve().ids), ['readme.md']);
});

test('folder checkboxes report none, partial and all', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    assert.equal(sel.state(at(store, 'src')), SEL_NONE);

    sel.include([at(store, 'src')]);
    assert.equal(sel.state(at(store, 'src')), SEL_ALL);
    assert.equal(sel.state(at(store, 'src/lib')), SEL_ALL);
    assert.equal(sel.state(0), SEL_PARTIAL, 'root holds media that is not selected');

    sel.exclude([at(store, 'src/lib/util.ts')]);
    assert.equal(sel.state(at(store, 'src/lib')), SEL_PARTIAL);
    assert.equal(sel.state(at(store, 'src')), SEL_PARTIAL);
    assert.equal(sel.state(at(store, 'src/app.ts')), SEL_ALL);
});

test('toggle flips whatever the current state is', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    const src = at(store, 'src');
    sel.toggle([src]);
    assert.equal(sel.state(src), SEL_ALL);
    sel.toggle([src]);
    assert.equal(sel.state(src), SEL_NONE);
});

test('the common base is the deepest folder holding the whole selection', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);

    sel.include([at(store, 'src/lib')]);
    assert.equal(sel.resolve().baseId, at(store, 'src/lib'), 'one folder: base is that folder');
    assert.deepEqual(
        sel.resolve().ids ? Array.from(sel.resolve().ids, (id) => sel.entryName(id, sel.resolve().baseId)).sort() : [],
        ['helper.ts', 'notes.md', 'util.ts'],
        'entry names hang off the base, with no empty parent chain'
    );

    sel.include([at(store, 'media')]);
    assert.equal(sel.resolve().baseId, 0, 'two branches: base rises to their common ancestor');
    assert.deepEqual(
        Array.from(sel.resolve().ids, (id) => sel.entryName(id, sel.resolve().baseId)).sort(),
        ['media/clip.mp4', 'media/photo.jpg', 'src/lib/helper.ts', 'src/lib/notes.md', 'src/lib/util.ts']
    );
});

test('a single selected file bases on its own folder', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    sel.include([at(store, 'src/lib/util.ts')]);
    const { baseId, ids } = sel.resolve();
    assert.equal(baseId, at(store, 'src/lib'));
    assert.deepEqual(Array.from(ids, (id) => sel.entryName(id, baseId)), ['util.ts']);
});

test('search reaches every file in the scan, not only selected ones', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);

    // Nothing selected yet: the filter must still find things to add.
    const ts = sel.searchAll('.ts', 100);
    assert.equal(ts.total, 4);
    assert.deepEqual(ts.ids.map((i) => store.name(i)).sort(), ['app.ts', 'helper.ts', 'main.ts', 'util.ts']);

    assert.equal(sel.searchAll('util', 100).total, 1);
    assert.equal(sel.searchAll('nothing-here', 100).total, 0);
});

test('search is case-insensitive and matches a path when the query looks like one', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);

    assert.equal(sel.searchAll('CLIP.MP4', 100).total, 1, 'case folded');

    const byPath = sel.searchAll('lib/', 100);
    assert.deepEqual(byPath.ids.map((i) => store.name(i)).sort(), ['helper.ts', 'notes.md', 'util.ts']);

    // The same fragment without a slash is a plain name test, so it misses.
    assert.equal(sel.searchAll('lib', 100).total, 0);
});

test('search reports the full total but returns at most the limit', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    const capped = sel.searchAll('.ts', 2);
    assert.equal(capped.total, 4, 'total counts every match');
    assert.equal(capped.ids.length, 2, 'only the limit is materialised');
});

test('search never returns directories', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    for (const id of sel.searchAll('e', 500).ids) {
        assert.equal(store.isDir(id), false, store.name(id));
    }
});

test('already-compressed formats are stored, not deflated', () => {
    for (const name of ['clip.mp4', 'photo.JPG', 'bundle.zip', 'doc.pdf', 'pkg.nupkg', 'f.woff2']) {
        assert.equal(isPrecompressed(name), true, name);
    }
    for (const name of ['app.ts', 'readme.md', 'data.csv', 'lib.dll', 'notes', 'x.bmp']) {
        assert.equal(isPrecompressed(name), false, name);
    }
});

test('the zip forecast sits between the stored and fully-deflated extremes', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    sel.include([0]);
    const { totalBytes, estimatedBytes } = sel.resolve();
    assert.ok(estimatedBytes > 0 && estimatedBytes <= totalBytes, `${estimatedBytes} vs ${totalBytes}`);
    // Media dominates this fixture and cannot shrink, so the forecast stays high.
    assert.ok(estimatedBytes > totalBytes * 0.9, 'media-dominated selection barely compresses');
});

test('clear removes every rule', () => {
    const store = buildStore(FIXTURE);
    const sel = new Selection(store);
    sel.include([0]);
    sel.setExtension(0, true);
    sel.clear();
    assert.equal(sel.resolve().totalFiles, 0);
    assert.deepEqual(sel.ruleCounts, { included: 0, excluded: 0, extensions: [] });
});
