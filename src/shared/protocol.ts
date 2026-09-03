/**
 * The wire contract between the server and the browser, plus the node flag
 * bits both sides need at runtime.
 *
 * This module is compiled into both builds, so the API shapes are checked at
 * the boundary rather than trusted. In the JavaScript version these shapes were
 * implicit and the flag constants were duplicated in the client, where they
 * could silently drift out of step with the scanner.
 */

/* ------------------------------------------------------------ node flags -- */

export const F_DIR = 1; // directory
export const F_LINK = 2; // symlink (never followed)
export const F_ERROR = 4; // could not be read
export const F_SKIPPED = 8; // deliberately not descended into
export const F_DUP = 16; // hardlink already counted elsewhere

/** Which number a size is reported as. */
export type SizeMetric = 'alloc' | 'size';

/* -------------------------------------------------------------- API rows -- */

/** One row of the directory tree. Node ids index the server's node store. */
export interface TreeRow {
    i: number;
    n: string;
    /** Material Icon Theme icon name; fetch at /icons/<icon>.svg */
    icon: string;
    /** Checkbox state: 0 none, 1 partial, 2 all. */
    sel: number;
    size: number;
    alloc: number;
    files: number;
    dirs: number;
    mtime: number;
    ext: number;
    flags: number;
    kids: boolean;
}

export interface NodeDetail extends TreeRow {
    path: string;
}

export interface ChildrenResponse {
    id: number;
    path: string;
    self: TreeRow;
    rows: TreeRow[];
}

export interface AncestorsResponse {
    chain: { i: number; n: string }[];
}

/**
 * One treemap tile. Deliberately has no name field: only the hovered tile ever
 * needs one and the client fetches that on demand, which keeps the payload to
 * roughly a third of its size.
 */
export interface TreemapNode {
    i: number; // -1 for a synthetic aggregate
    v: number; // value under the active metric
    e: number; // extension rank, or -1
    f: number; // node flags
    c: TreemapNode[] | null;
    g?: number; // for aggregates: how many items were folded in
}

export interface TreemapResponse {
    id: number;
    metric: SizeMetric;
    root: TreemapNode;
    tiles: number;
    truncated: boolean;
    minValue: number;
}

export interface ExtensionRow {
    ext: string;
    label: string;
    color: string;
    icon: string;
    rank: number;
    size: number;
    alloc: number;
    count: number;
    share: number;
}

export interface SpecialColors {
    dir: string;
    other: string;
    unreadable: string;
}

export interface ExtensionsResponse {
    rows: ExtensionRow[];
    special: SpecialColors;
}

/* --------------------------------------------------------- scan lifecycle -- */

export type ScanStatus = 'idle' | 'scanning' | 'ready' | 'error';

export interface ScanProgress {
    files: number;
    dirs: number;
    bytes: number;
    errors: number;
    path: string;
}

export interface ScanSummary {
    status: ScanStatus;
    scanId?: number;
    /** When the scan began, so a page opened mid-scan shows the true elapsed time. */
    startedAt?: number;
    root: string | null;
    nodes?: number;
    files?: number;
    dirs?: number;
    size?: number;
    alloc?: number;
    elapsedMs?: number;
    cancelled?: boolean;
    error?: string | null;
    progress?: ScanProgress;
}

export interface RootsResponse {
    /** One entry per distinct device; empty of duplicates like macOS firmlinks. */
    roots: { label: string; path: string }[];
    /**
     * Whether the volume picker is worth showing at all. False on a machine
     * with a single disk, where it would only repeat what the path box already
     * accepts.
     */
    showPicker: boolean;
    home: string;
    cwd: string;
}

export interface BrowseResponse {
    path: string;
    parent: string | null;
    entries: { name: string; path: string }[];
}

/* ---------------------------------------------------------------- actions -- */

export type ActionOp = 'reveal' | 'open' | 'trash' | 'delete';

export interface ActionRequest {
    op: ActionOp;
    id: number;
}

export interface ActionResponse {
    ok: true;
    path: string;
    summary: ScanSummary;
}

export interface ErrorResponse {
    error: string;
}

/* -------------------------------------------------------------- selection -- */

/** Tri-state for a tree row's checkbox. */
export const SEL_NONE = 0;
export const SEL_PARTIAL = 1;
export const SEL_ALL = 2;
export type SelectionState = typeof SEL_NONE | typeof SEL_PARTIAL | typeof SEL_ALL;

export type SelectionSort = 'size' | 'name' | 'ext' | 'folder' | 'mtime';
export type SortDirection = 'asc' | 'desc';

export interface SelectionSummary {
    files: number;
    bytes: number;
    /** Everything that could be selected, so a count can be shown as X of Y. */
    availableFiles: number;
    availableBytes: number;
    /** Rough forecast, from per-type compression ratios. */
    estimatedZipBytes: number;
    /** Deepest folder containing everything selected; archive paths hang off it. */
    baseId: number;
    basePath: string;
    rules: { included: number; excluded: number; extensions: number[] };
}

export type SelectionOp =
    | { op: 'include'; ids: number[] }
    | { op: 'exclude'; ids: number[] }
    | { op: 'toggle'; ids: number[] }
    | { op: 'extension'; ext: number; on: boolean }
    /** The complete set of file types to take, replacing whatever was picked. */
    | { op: 'extensions'; ranks: number[] }
    /** Apply to every file matching a name/path query, across the whole scan. */
    | { op: 'matching'; text: string; on: boolean }
    | { op: 'clear' };

/** One hit from the selection dialog's filter. */
export interface SearchHit {
    i: number;
    n: string;
    /** Path relative to the scan root, for disambiguating same-named files. */
    rel: string;
    size: number;
    icon: string;
    sel: number;
}

export interface SearchResponse {
    /** Files matched in the whole scan; may exceed the number returned. */
    total: number;
    hits: SearchHit[];
}

/* -------------------------------------------------------------------- zip -- */

export type ZipState = 'preparing' | 'archiving' | 'done' | 'failed' | 'cancelled';

/**
 * `zip` stores each entry independently, so it opens anywhere but cannot match
 * across files. The tar formats are solid — one continuous stream — which is
 * where nearly all of the size difference comes from.
 */
export type ArchiveFormat = '7z' | 'zip';

export interface ArchiveFormatInfo {
    id: ArchiveFormat;
    label: string;
    detail: string;
    extension: string;
    /** Shell command that unpacks it, with %s standing in for the file name. */
    extract: string;
}

/**
 * Both are produced by the same bundled 7-Zip binary. `7z` is solid — one
 * continuous stream, so matches reach across files — which is where its lead
 * comes from; measured on 27.5 MB of 1,856 files it produced 2.70 MB against
 * zip's 5.77 MB. Zip stays available because it opens with no tool at all.
 */
export const ARCHIVE_FORMATS: ArchiveFormatInfo[] = [
    {
        id: '7z',
        label: '7z',
        detail: 'smallest · needs 7-Zip, Keka or similar',
        extension: '.7z',
        extract: '7z x %s',
    },
    {
        id: 'zip',
        label: 'zip',
        detail: 'largest · opens anywhere',
        extension: '.zip',
        extract: 'unzip %s',
    },
];

export interface ZipSkip {
    path: string;
    reason: string;
}

export interface ZipStatus {
    id: string;
    state: ZipState;
    files: number;
    filesDone: number;
    bytesTotal: number;
    bytesRead: number;
    bytesWritten: number;
    currentPath: string;
    startedAt: number;
    finishedAt?: number;
    error?: string;
    skipped: ZipSkip[];
    name: string;
    size?: number;
    format: ArchiveFormat;
}

/* ----------------------------------------------------------------- delete -- */

export type DeleteMode = 'trash' | 'permanent';
export type DeleteState = 'running' | 'done' | 'failed' | 'cancelled';

export interface DeleteTarget {
    id: number;
    path: string;
    label: string;
    size: number;
}

export interface DeleteFailure {
    path: string;
    reason: string;
}

export interface DeleteStatus {
    id: string;
    state: DeleteState;
    mode: DeleteMode;
    files: number;
    filesDone: number;
    bytesFreed: number;
    bytesTotal: number;
    currentPath: string;
    failures: DeleteFailure[];
    startedAt: number;
    finishedAt?: number;
    error?: string;
}
