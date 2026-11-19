/**
 * What the user has picked for archiving.
 *
 * Selection is stored as *rules*, never as a list of files. "Everything under
 * node_modules" is one entry, not 268,000; "every .mp4" is one entry, not
 * 53,000; and "that folder except these three files" is expressible at all.
 * A flat Set of ids can do none of those at this scale.
 *
 *     nearest rule wins: walking up from a node, the first ancestor carrying
 *     an include or exclude decides it. Extension picks apply wherever no rule
 *     says otherwise.
 *
 * Nearest-ancestor-wins is what makes "take src/, drop src/lib/, but keep
 * src/lib/util.ts" a three-entry rule set. Under a plain "any exclusion beats
 * any inclusion" reading, re-including that one file would mean deleting the
 * folder's exclusion and re-excluding each of its other children by hand,
 * which grows the rule set by the branching factor on every such edit.
 *
 * Resolving it for every node is a single forward pass, because the store
 * guarantees `parent[i] < i` — a parent's decision is always final by the
 * time its children are reached. A reverse pass then rolls per-subtree
 * totals back up, which is what gives tri-state folder checkboxes and live
 * byte counts. Two O(n) passes, a few milliseconds on a million nodes.
 */

import { basename, extname } from 'node:path';
import { F_GONE } from './store.js';
import type { NodeStore } from './store.js';
import { F_DIR, F_ERROR, F_SKIPPED, SEL_ALL, SEL_NONE, SEL_PARTIAL } from '../shared/protocol.js';
import type { SelectionState } from '../shared/protocol.js';

/**
 * Formats whose bytes are already compressed. Deflating these costs minutes
 * and saves almost nothing, so they are stored verbatim instead — the single
 * biggest factor in how long an archive takes on a media-heavy selection.
 */
const PRECOMPRESSED = new Set([
    // images
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.heif', '.jxl',
    // video
    '.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.wmv', '.flv', '.mpg', '.mpeg',
    // audio
    '.mp3', '.aac', '.m4a', '.ogg', '.oga', '.opus', '.flac', '.wma',
    // archives and packages
    '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.zst', '.lz4', '.cab',
    '.jar', '.war', '.apk', '.ipa', '.nupkg', '.whl', '.crx', '.vsix',
    // documents and fonts that are zip or already-compressed containers
    '.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub',
    '.woff', '.woff2',
    // disk images
    '.dmg', '.iso', '.appimage',
]);

/** Rough deflate ratios, only used for the "≈ N GB zipped" forecast. */
const RATIO_STORED = 1.0;
const RATIO_TEXT = 0.25;
const RATIO_OTHER = 0.55;

const TEXTUAL = new Set([
    '.txt', '.md', '.json', '.xml', '.html', '.htm', '.css', '.scss', '.less',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.cs', '.java', '.py', '.rb',
    '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.sql', '.yml', '.yaml', '.toml',
    '.ini', '.cfg', '.csv', '.tsv', '.log', '.svg', '.map', '.sh', '.ps1',
]);

interface FilterTerm {
    /** Matched against the path relative to the scan root, not the file name. */
    byPath: boolean;
    test(value: string): boolean;
}

const WILDCARD = /[*?]/;
/** `dist/*.js`: an extension, but only beneath a folder with that name. */
const FOLDER_RULE = /^([^/*?]+)\/\*(\.[^/*?]+)$/;
/** `nuget:packages`: everything in a restored NuGet package under `packages/`. */
const PACKAGE_RULE = 'nuget:';
/** `Newtonsoft.Json.12.0.3`, `Foo.2.1.0-beta1`: how packages.config names a restored package. */
const VERSIONED_FOLDER = /^[A-Za-z_][\w.-]*?\.\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/;
/** Folders only a NuGet package has at its top level. */
const PACKAGE_LAYOUT = new Set(['lib', 'content', 'contentfiles', 'tools', 'build', 'buildtransitive', 'runtimes', 'analyzers', 'ref']);
/**
 * `*.cs` and friends: the shape nearly every preset is made of. One extension
 * segment only — `*.min.js` has to go the general route, since the extension of
 * `app.min.js` is `.js`.
 */
const SUFFIX_ONLY = /^\*(\.[^.*?/\\]+)$/;

/**
 * Read the dialog's filter box.
 *
 * A term with no `*` or `?` stays a plain substring match, so typing part of a
 * name still works. Anything with a wildcard is anchored and matched whole,
 * which is what makes `*.cs` mean "C# files" rather than "contains .cs". Terms
 * are separated by `;` or `,` — and by whitespace too once a wildcard is in
 * play, since `*.cs *.txt` is the other way people write these, while a plain
 * search for `my file` has to keep working as one term.
 *
 * `*.ext` terms are pulled out into a set rather than compiled to regular
 * expressions: a preset is sixty of them, and sixty regex tests per file across
 * a million-file scan is the difference between instant and a stall.
 */
function parseFilter(text: string): { exts: Set<string>; terms: FilterTerm[] } {
    const raw = text.trim().toLowerCase();
    const exts = new Set<string>();
    const terms: FilterTerm[] = [];
    if (raw.length === 0) return { exts, terms };

    for (const piece of raw.split(WILDCARD.test(raw) ? /[;,\s]+/ : /[;,]/)) {
        const term = piece.trim();
        if (term.length === 0) continue;

        const suffix = SUFFIX_ONLY.exec(term);
        if (suffix) {
            exts.add(suffix[1]);
            continue;
        }

        const byPath = term.includes('/');
        if (!WILDCARD.test(term)) {
            terms.push({ byPath, test: (value) => value.includes(term) });
            continue;
        }
        const pattern = term
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        const re = new RegExp(`^${pattern}$`);
        terms.push({ byPath, test: (value) => re.test(value) });
    }
    return { exts, terms };
}

export function isPrecompressed(name: string): boolean {
    return PRECOMPRESSED.has(extname(name).toLowerCase());
}

function ratioFor(name: string): number {
    const ext = extname(name).toLowerCase();
    if (PRECOMPRESSED.has(ext)) return RATIO_STORED;
    if (TEXTUAL.has(ext)) return RATIO_TEXT;
    return RATIO_OTHER;
}

export interface Resolved {
    /** 1 when this exact node is selected. Directories are never "selected". */
    selected: Uint8Array;
    /** Selected files within each subtree, inclusive. */
    files: Uint32Array;
    /** Selected bytes within each subtree, inclusive. */
    bytes: Float64Array;
    /** Every selected file id, in tree order. */
    ids: Int32Array;
    totalFiles: number;
    totalBytes: number;
    estimatedBytes: number;
    /** Deepest node containing the whole selection. */
    baseId: number;
}

export class Selection {
    private included = new Set<number>();
    private excluded = new Set<number>();
    private extensions = new Set<number>();
    private cache: Resolved | null = null;
    private availableCache: { files: number; bytes: number } | null = null;

    constructor(private readonly store: NodeStore) {}

    /**
     * Everything that could be picked: files only, minus entries that could not
     * be read and mount points never descended into, since neither can go into
     * an archive. Computed once and kept until something is removed, which is
     * what `invalidate()` is for.
     */
    available(): { files: number; bytes: number } {
        if (!this.availableCache) {
            const { flags, size, count } = this.store;
            let files = 0;
            let bytes = 0;
            for (let i = 1; i < count; i++) {
                if (flags[i] & (F_DIR | F_ERROR | F_SKIPPED | F_GONE)) continue;
                files += 1;
                bytes += size[i];
            }
            this.availableCache = { files, bytes };
        }
        return this.availableCache;
    }

    /**
     * Every live file of the named types, whatever the selection happens to be.
     *
     * Deleting a whole file type is its own operation, not a selection: it must
     * not sweep up what the user has ticked in the tree, and ticking a type must
     * not be the thing that arms a delete. Types are addressed by name rather
     * than by rank because ranks are assigned per scan — a name that no longer
     * exists simply matches nothing, where a stale rank would match the wrong
     * type.
     *
     * Each entry is one of three kinds, all matched case-insensitively:
     *
     *     .ext          an extension ("" for no extension)
     *     thumbs.db     an exact file name, so it can be taken without every .db
     *     dist/*.js     an extension, only beneath a folder of that name
     *     nuget:packages  every file of a restored NuGet package: a folder that
     *                   holds a .nupkg directly and sits in a folder of that name
     *
     * `keys` runs parallel to `ids` and says which entry took each file, so a
     * caller can report per entry. Precedence: file name, package, extension,
     * folder rule.
     *
     * `under` limits it to one subtree. Since `parent[i] < i`, a single forward
     * pass decides membership: a node is inside when its parent is.
     */
    filesOfTypes(
        names: readonly string[],
        under = 0
    ): { ids: number[]; keys: string[]; files: number; bytes: number } {
        const store = this.store;
        const wanted = new Set(names.map((n) => n.toLowerCase()));

        const fileNames = new Set<string>();
        // folder name -> extension -> the entry that asked for it
        const folderRules = new Map<string, Map<string, string>>();
        let packageFolder: string | null = null;
        for (const entry of wanted) {
            const rule = FOLDER_RULE.exec(entry);
            if (entry.startsWith(PACKAGE_RULE)) {
                packageFolder = entry.slice(PACKAGE_RULE.length);
            } else if (rule) {
                const exts = folderRules.get(rule[1]) ?? new Map<string, string>();
                exts.set(rule[2], entry);
                folderRules.set(rule[1], exts);
            } else if (entry !== '' && !entry.startsWith('.')) {
                fileNames.add(entry);
            }
        }
        const ranks = new Set<number>();
        store.extNames.forEach((ext, rank) => {
            if (wanted.has(ext)) ranks.add(rank);
        });

        let inside: Uint8Array | null = null;
        if (under > 0) {
            inside = new Uint8Array(store.count);
            inside[under] = 1;
            for (let i = under + 1; i < store.count; i++) {
                const p = store.parent[i];
                if (p >= 0 && inside[p] === 1) inside[i] = 1;
            }
        }

        // The nearest ancestor folder carrying a rule, per node. Directory
        // names only; files never get a name lookup here.
        let ruleFolder: Int32Array | null = null;
        const folderNames: string[] = [...folderRules.keys()];
        if (folderNames.length > 0) {
            ruleFolder = new Int32Array(store.count).fill(-1);
            for (let i = 1; i < store.count; i++) {
                const p = store.parent[i];
                if (p < 0) continue;
                ruleFolder[i] = ruleFolder[p];
                // The root's "name" is its whole path, so it never names a rule.
                if (p > 0) {
                    const k = folderNames.indexOf(store.name(p).toLowerCase());
                    if (k >= 0) ruleFolder[i] = k;
                }
            }
        }

        const inPackage = packageFolder === null ? null : this.packageMembers(packageFolder);

        const ids: number[] = [];
        const keys: string[] = [];
        let bytes = 0;
        if (ranks.size > 0 || fileNames.size > 0 || ruleFolder || inPackage) {
            for (let i = Math.max(1, under); i < store.count; i++) {
                if (inside && inside[i] === 0) continue;
                if (store.flags[i] & (F_DIR | F_ERROR | F_SKIPPED | F_GONE)) continue;
                const ext = store.extNames[store.ext[i]] ?? '';
                let key: string | undefined;
                if (fileNames.size > 0) {
                    const lower = store.name(i).toLowerCase();
                    if (fileNames.has(lower)) key = lower;
                }
                if (key === undefined && inPackage && inPackage[i] === 1) key = PACKAGE_RULE + packageFolder;
                if (key === undefined && ranks.has(store.ext[i])) key = ext;
                if (key === undefined && ruleFolder && ruleFolder[i] >= 0) {
                    key = folderRules.get(folderNames[ruleFolder[i]])!.get(ext);
                }
                if (key === undefined) continue;
                ids.push(i);
                keys.push(key);
                bytes += store.size[i];
            }
        }
        return { ids, keys, files: ids.length, bytes };
    }

    /**
     * Nodes inside a restored NuGet package, 1 per node.
     *
     * packages.config restores each package to `<packages>/<Id>.<Version>/`,
     * with the .nupkg itself directly in that folder. A folder there counts as
     * a package when it holds a .nupkg, or, for one whose .nupkg is already
     * gone, when it is named `Id.1.2.3` and has a package's own layout (lib/,
     * content/, tools/, build/…). Either test keeps a JavaScript monorepo's
     * `packages/ui` source folders out of it: the folder name alone says
     * nothing.
     */
    private packageMembers(folder: string): Uint8Array {
        const store = this.store;
        const nupkg = store.extNames.indexOf('.nupkg');
        const holdsPackage = new Uint8Array(store.count);
        if (nupkg >= 0) {
            for (let i = 1; i < store.count; i++) {
                if (store.ext[i] === nupkg && !(store.flags[i] & (F_DIR | F_GONE))) {
                    holdsPackage[store.parent[i]] = 1;
                }
            }
        }

        const hasLayout = new Uint8Array(store.count);
        for (let i = 1; i < store.count; i++) {
            if ((store.flags[i] & F_DIR) && PACKAGE_LAYOUT.has(store.name(i).toLowerCase())) {
                hasLayout[store.parent[i]] = 1;
            }
        }

        const nameOf = (d: number): string =>
            (d === 0 ? basename(store.root) : store.name(d)).toLowerCase();
        const isPackage = (d: number): boolean =>
            d > 0 &&
            nameOf(store.parent[d]) === folder &&
            (holdsPackage[d] === 1 || (hasLayout[d] === 1 && VERSIONED_FOLDER.test(store.name(d))));

        const member = new Uint8Array(store.count);
        for (let i = 1; i < store.count; i++) {
            const p = store.parent[i];
            if (p < 0) continue;
            if (member[p] === 1 || isPackage(p)) member[i] = 1;
        }
        return member;
    }

    /** Node ids are only meaningful for one scan, so a rescan starts over. */
    reset(): void {
        this.included.clear();
        this.excluded.clear();
        this.extensions.clear();
        this.invalidate();
    }

    /**
     * Drop everything derived from the tree while keeping the rules.
     *
     * The pool of selectable files is fixed for a given scan but not for a given
     * *store*: deleting files shrinks it. Leaving it cached is what made the
     * dialog go on offering "of 2,365 files · 171 MB" long after most of them
     * had been removed.
     */
    invalidate(): void {
        this.cache = null;
        this.availableCache = null;
    }

    get ruleCounts(): { included: number; excluded: number; extensions: number[] } {
        return {
            included: this.included.size,
            excluded: this.excluded.size,
            extensions: [...this.extensions].sort((a, b) => a - b),
        };
    }

    hasExtension(rank: number): boolean {
        return this.extensions.has(rank);
    }

    include(ids: readonly number[]): void {
        for (const id of ids) {
            this.excluded.delete(id);
            this.pruneUnder(id);
            this.included.add(id);
        }
        this.cache = null;
    }

    exclude(ids: readonly number[]): void {
        for (const id of ids) {
            this.included.delete(id);
            this.pruneUnder(id);
            this.excluded.add(id);
        }
        this.cache = null;
    }

    /**
     * Drop any rule sitting strictly below `id`.
     *
     * Nearest-rule-wins means a deeper rule beats a shallower one, which is
     * what lets a single file be rescued from an excluded folder. The flip side
     * is that a decision made *on a folder* has to clear the rules beneath it,
     * or it silently does nothing: unticking a folder whose files were picked
     * individually would leave every one of those per-file rules winning.
     *
     * Acting on a node is a statement about its whole subtree, so anything
     * older down there is stale. This also keeps the rule set from growing —
     * unticking a folder after selecting fifty thousand matches collapses those
     * fifty thousand rules back into one.
     */
    private pruneUnder(id: number): void {
        for (const set of [this.included, this.excluded]) {
            for (const rule of set) {
                if (rule !== id && this.isUnder(rule, id)) set.delete(rule);
            }
        }
    }

    /** True when `id` sits strictly below `ancestor`. */
    private isUnder(id: number, ancestor: number): boolean {
        for (let n = this.store.parent[id]; n !== -1; n = this.store.parent[n]) {
            if (n === ancestor) return true;
        }
        return false;
    }

    /** Flip each id to whatever it currently is not. */
    toggle(ids: readonly number[]): void {
        const { selected, files } = this.resolve();
        for (const id of ids) {
            const on = this.store.isDir(id) ? files[id] > 0 : selected[id] === 1;
            if (on) this.exclude([id]);
            else this.include([id]);
        }
    }

    /**
     * Flip what is selected: everything picked is dropped, everything left is
     * taken. With a `scope`, only those files flip and the rest stay as they are.
     *
     * The result is rewritten as fresh rules rather than kept as a "the answer
     * is now backwards" flag. A flag would leak into every later edit — ticking
     * a box would have to mean untick — and the rule set would stop describing
     * what is actually selected. Rebuilding keeps one representation of the
     * truth, and the rebuild is what stops it exploding: rules are emitted at
     * the highest node that can carry them, so inverting a selection made of
     * three folders comes back as a handful of rules, not a million.
     */
    invert(scope: readonly number[] | null): void {
        const n = this.store.count;
        const { selected } = this.resolve();
        const want = new Uint8Array(n);

        for (let i = 1; i < n; i++) {
            if (this.pickable(i)) want[i] = scope === null ? (selected[i] === 1 ? 0 : 1) : selected[i];
        }
        if (scope !== null) {
            for (const id of scope) {
                if (id > 0 && id < n && this.pickable(id)) want[id] = want[id] === 1 ? 0 : 1;
            }
        }
        this.rebuild(want);
    }

    /** Files that can be chosen at all: not directories, not unreadable, not gone. */
    private pickable(i: number): boolean {
        return (this.store.flags[i] & (F_DIR | F_ERROR | F_SKIPPED | F_GONE)) === 0;
    }

    /**
     * Replace every rule with the smallest set that selects exactly `want`.
     *
     * Two passes: a reverse one counting, per subtree, how many files could be
     * taken and how many should be; then a walk down from the root that stops
     * as soon as a subtree is uniform — all wanted or none wanted — and emits a
     * rule there only when it differs from what the node already inherits. Only
     * subtrees that are genuinely mixed are descended into, so the rule count
     * follows the shape of the boundary rather than the size of the tree.
     */
    private rebuild(want: Uint8Array): void {
        const store = this.store;
        const n = store.count;
        const pool = new Uint32Array(n); // files that could be taken, per subtree
        const take = new Uint32Array(n); // of those, the ones that should be

        for (let i = n - 1; i >= 1; i--) {
            if (this.pickable(i)) {
                pool[i] += 1;
                take[i] += want[i];
            }
            const p = store.parent[i];
            if (p >= 0) {
                pool[p] += pool[i];
                take[p] += take[i];
            }
        }

        this.included.clear();
        this.excluded.clear();
        // Type picks are absorbed into the explicit rules; leaving them on would
        // re-add files the inversion has just dropped.
        this.extensions.clear();

        // 0 = the node inherits "not selected", 1 = it inherits "selected".
        const stack: [number, number][] = [[0, 0]];
        while (stack.length > 0) {
            const [id, inherited] = stack.pop()!;
            if (pool[id] === 0) continue; // nothing here to select either way
            if (take[id] === 0) {
                if (inherited === 1) this.excluded.add(id);
                continue;
            }
            if (take[id] === pool[id]) {
                if (inherited === 0) this.included.add(id);
                continue;
            }
            for (const child of store.children(id)) stack.push([child, inherited]);
        }
        this.cache = null;
    }

    setExtension(rank: number, on: boolean): void {
        if (on) this.extensions.add(rank);
        else this.extensions.delete(rank);
        this.cache = null;
    }

    /**
     * Replace the set of chosen file types outright.
     *
     * The type dialog reports what it ended up with rather than the clicks that
     * got there, so applying it is idempotent and needs no diffing on either
     * side. Unticking a type genuinely drops it: these are rules over the whole
     * scan, not a list of files, so nothing is left behind to clean up.
     */
    setExtensions(ranks: readonly number[]): void {
        this.extensions = new Set(ranks);
        this.cache = null;
    }

    clear(): void {
        this.reset();
    }

    state(id: number): SelectionState {
        const { selected, files } = this.resolve();
        if (!this.store.isDir(id)) return selected[id] === 1 ? SEL_ALL : SEL_NONE;
        const chosen = files[id];
        if (chosen === 0) return SEL_NONE;
        return chosen >= this.store.files[id] ? SEL_ALL : SEL_PARTIAL;
    }

    resolve(): Resolved {
        if (this.cache) return this.cache;
        const store = this.store;
        const n = store.count;
        const { parent, flags, ext, size } = store;

        // 0 = no rule applies, 1 = nearest rule includes, 2 = nearest excludes.
        const decision = new Uint8Array(n);
        const selected = new Uint8Array(n);
        const files = new Uint32Array(n);
        const bytes = new Float64Array(n);

        let totalFiles = 0;
        let totalBytes = 0;
        let estimated = 0;

        // Forward: a decision only ever flows downward, and every parent index
        // is lower than its children's, so one pass settles it.
        for (let i = 0; i < n; i++) {
            const p = parent[i];
            decision[i] = this.included.has(i) ? 1
                : this.excluded.has(i) ? 2
                : p >= 0 ? decision[p]
                : 0;

            if (decision[i] === 2) continue;
            // Unreadable entries and mount points we never descended into
            // cannot be archived, so they are never selected.
            if (flags[i] & (F_DIR | F_ERROR | F_SKIPPED | F_GONE)) continue;
            if (decision[i] === 1 || this.extensions.has(ext[i])) selected[i] = 1;
        }

        // Reverse: children always come after parents, so this is a valid
        // post-order roll-up.
        for (let i = n - 1; i >= 0; i--) {
            if (selected[i] === 1) {
                files[i] += 1;
                bytes[i] += size[i];
                totalFiles += 1;
                totalBytes += size[i];
                estimated += size[i] * ratioFor(store.name(i));
            }
            const p = parent[i];
            if (p >= 0) {
                files[p] += files[i];
                bytes[p] += bytes[i];
            }
        }

        const ids = new Int32Array(totalFiles);
        let k = 0;
        for (let i = 0; i < n && k < totalFiles; i++) {
            if (selected[i] === 1) ids[k++] = i;
        }

        this.cache = {
            selected, files, bytes, ids,
            totalFiles, totalBytes,
            estimatedBytes: Math.round(estimated),
            baseId: this.commonBase(files, totalFiles),
        };
        return this.cache;
    }

    /**
     * Deepest folder that still contains the whole selection — archive paths
     * are relative to it, so selecting one deep folder does not produce a chain
     * of empty parent directories in the zip.
     *
     * Descend while exactly one child holds every selected file.
     */
    private commonBase(files: Uint32Array, total: number): number {
        if (total === 0) return 0;
        let node = 0;
        for (;;) {
            let next = -1;
            for (const c of this.store.children(node)) {
                if (files[c] === total) {
                    next = c;
                    break;
                }
            }
            // Stop at the file itself rather than descending into it.
            if (next === -1 || !this.store.isDir(next)) return node;
            node = next;
        }
    }

    /**
     * Every file in the scan the filter matches, not just selected ones — the
     * dialog's filter has to be able to find things in order to add them.
     *
     * Names are matched first because that is a cheap test on data already in
     * memory; the relative path is only built when a term looks like a path,
     * since materialising one per node would mean a parent walk and a string
     * join for every file in the scan.
     */
    searchAll(text: string, limit: number): { ids: number[]; total: number } {
        const store = this.store;
        const { exts, terms } = parseFilter(text);
        const ids: number[] = [];
        let total = 0;
        if (exts.size === 0 && terms.length === 0) return { ids, total };
        const wantsPath = terms.some((t) => t.byPath);

        for (let i = 1; i < store.count; i++) {
            if (store.flags[i] & (F_DIR | F_ERROR | F_SKIPPED | F_GONE)) continue;
            const name = store.name(i).toLowerCase();
            // `exts.has(name)` catches dotfiles: Node gives `.gitignore` no
            // extension at all, but `*.gitignore` plainly ought to match it.
            let hit = exts.size > 0 && (exts.has(extname(name)) || exts.has(name));
            if (!hit && terms.length > 0) {
                const path = wantsPath ? store.segments(i).join('/').toLowerCase() : '';
                hit = terms.some((t) => t.test(t.byPath ? path : name));
            }
            if (!hit) continue;
            total += 1;
            if (ids.length < limit) ids.push(i);
        }
        return { ids, total };
    }

    /** Archive entry name for a file, relative to the selection's base. */
    entryName(id: number, baseId: number): string {
        const store = this.store;
        const parts: string[] = [];
        for (let n = id; n !== -1 && n !== baseId; n = store.parent[n]) parts.push(store.name(n));
        parts.reverse();
        return parts.length > 0 ? parts.join('/') : basename(store.name(id));
    }
}
