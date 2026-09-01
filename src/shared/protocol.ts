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
    roots: { label: string; path: string }[];
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
