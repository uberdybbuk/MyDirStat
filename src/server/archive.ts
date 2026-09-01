/**
 * Archive jobs: run 7-Zip against a file list, reporting progress, then hand
 * the result over as a normal download.
 *
 * The binary comes from the `7zip-bin` package rather than the host, so nothing
 * needs to be installed on the machine doing the compressing — it ships builds
 * for Windows, macOS and Linux on x64, arm64, ia32 and arm.
 *
 * Why 7z rather than something written here: measured on the same 27.5 MB tree
 * of 1,856 files, 7z's solid LZMA2 produced 2.70 MB in 3.7 s. Hand-rolled
 * tar+brotli reached 2.69 MB but took 20.1 s, and zip — which cannot compress
 * across file boundaries at all — managed only 5.77 MB. Same size as the best
 * alternative, five times faster, and a format people recognise.
 *
 * Paths are handed over in a list file rather than on the command line: a
 * selection can run to hundreds of thousands of entries, far past any platform's
 * argument limit.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, constants as fsConstants, accessSync, promises as fs, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { path7za } from '7zip-bin';
import type { ArchiveFormat, ZipSkip, ZipStatus } from '../shared/protocol.js';

export interface ArchiveEntry {
    /** Absolute path on disk, native separators. */
    path: string;
    /** Path relative to the archive base, always forward-slashed. */
    entry: string;
    size: number;
    mtime: number;
    stored: boolean;
}

export interface ArchiveRequest {
    entries: ArchiveEntry[];
    /** Working directory the entry paths are relative to. */
    baseDir: string;
    name: string;
    format: ArchiveFormat;
}

/**
 * npm does not always preserve the executable bit when unpacking, and a
 * non-executable binary fails with EACCES at the worst possible moment.
 */
let binaryReady = false;
function sevenZipBinary(): string {
    if (!binaryReady && process.platform !== 'win32') {
        try {
            accessSync(path7za, fsConstants.X_OK);
        } catch {
            try {
                chmodSync(path7za, 0o755);
            } catch {
                /* read-only install: the spawn below will report the real problem */
            }
        }
        binaryReady = true;
    }
    return path7za;
}

export class ArchiveJob {
    readonly id = randomBytes(8).toString('hex');
    readonly file: string;
    readonly listFile: string;
    readonly startedAt = Date.now();
    readonly bytesTotal: number;
    readonly name: string;
    readonly format: ArchiveFormat;

    state: ZipStatus['state'] = 'preparing';
    filesDone = 0;
    bytesRead = 0;
    bytesWritten = 0;
    currentPath = '';
    error?: string;
    size?: number;
    finishedAt?: number;

    private child?: ChildProcess;
    private cancelled = false;
    private settled = false;
    private readonly skipped: ZipSkip[] = [];
    private readonly total: number;
    readonly done: Promise<void>;
    private resolveDone!: () => void;

    constructor(
        private readonly request: ArchiveRequest,
        private readonly onProgress: (job: ArchiveJob) => void
    ) {
        this.name = request.name;
        this.format = request.format;
        this.total = request.entries.length;
        this.bytesTotal = request.entries.reduce((a, e) => a + e.size, 0);
        this.file = join(tmpdir(), `mydirstat-${this.id}.${request.format}`);
        this.listFile = join(tmpdir(), `mydirstat-${this.id}.list`);
        this.done = new Promise<void>((resolve) => {
            this.resolveDone = resolve;
        });
        void this.run();
    }

    status(): ZipStatus {
        return {
            id: this.id,
            state: this.state,
            files: this.total,
            filesDone: this.filesDone,
            bytesTotal: this.bytesTotal,
            bytesRead: this.bytesRead,
            bytesWritten: this.bytesWritten,
            currentPath: this.currentPath,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            error: this.error,
            skipped: this.skipped.slice(0, 200),
            name: this.name,
            size: this.size,
            format: this.format,
        };
    }

    whenFinished(): Promise<void> {
        return this.done;
    }

    cancel(): void {
        if (this.settled) return;
        this.cancelled = true;
        this.child?.kill('SIGTERM');
    }

    async discard(): Promise<void> {
        await Promise.all([
            fs.rm(this.file, { force: true }).catch(() => undefined),
            fs.rm(this.listFile, { force: true }).catch(() => undefined),
        ]);
    }

    /** Remove only the list file; the archive itself is the deliverable. */
    private async cleanupList(): Promise<void> {
        await fs.rm(this.listFile, { force: true }).catch(() => undefined);
    }

    private finish(state: ZipStatus['state'], error?: string): void {
        if (this.settled) return;
        this.settled = true;
        this.state = state;
        this.error = error;
        this.finishedAt = Date.now();
        void this.cleanupList();
        if (state !== 'done') void this.discard();
        this.onProgress(this);
        this.resolveDone();
    }

    private args(): string[] {
        const base = [
            'a',
            this.format === 'zip' ? '-tzip' : '-t7z',
            '-mx9',
            // Progress percentage on stdout, and the name of each file as it is
            // added — the only way to report either from an external process.
            '-bsp1',
            '-bb1',
            // Without this, non-ASCII names in the list file are misread.
            '-scsUTF-8',
            '-y',
        ];
        // Solid is what lets matches span files, and is most of 7z's advantage
        // over zip. The zip container has no equivalent.
        if (this.format !== 'zip') base.push('-ms=on');
        return [...base, this.file, `@${this.listFile}`];
    }

    private async run(): Promise<void> {
        try {
            // Entry paths are relative to baseDir, which is also the working
            // directory, so the archive holds exactly the intended layout.
            await fs.writeFile(this.listFile, this.request.entries.map((e) => e.entry).join('\n'), 'utf8');
        } catch (err) {
            this.finish('failed', (err as Error).message);
            return;
        }

        this.state = 'archiving';
        const child = spawn(sevenZipBinary(), this.args(), {
            cwd: this.request.baseDir,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.child = child;

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => this.consume(chunk));
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => this.consumeErrors(chunk));

        child.on('error', (err: Error) => this.finish('failed', err.message));
        child.on('close', (code) => {
            if (this.cancelled) {
                this.finish('cancelled');
                return;
            }
            // 7-Zip exits 1 for warnings — typically a file it could not open —
            // with a usable archive still written.
            if (code === 0 || code === 1) {
                this.filesDone = this.total;
                void fs
                    .stat(this.file)
                    .then((st) => {
                        this.size = st.size;
                        this.bytesWritten = st.size;
                        this.bytesRead = this.bytesTotal;
                        this.finish('done');
                    })
                    .catch((err: Error) => this.finish('failed', err.message));
                return;
            }
            this.finish('failed', this.error ?? `7-Zip exited with code ${String(code)}`);
        });
    }

    /**
     * 7-Zip redraws its progress line in place with carriage returns and
     * backspaces, so the stream has to be normalised before anything can be
     * read out of it.
     */
    private consume(chunk: string): void {
        for (const raw of chunk.split(/[\r\n]/)) {
            const line = raw.replace(/\x08/g, '').trim();
            if (line.length === 0) continue;

            const percent = /^(\d+)%/.exec(line);
            if (percent) {
                const fraction = Number(percent[1]) / 100;
                this.bytesRead = Math.round(this.bytesTotal * fraction);
                this.filesDone = Math.min(this.total, Math.round(this.total * fraction));
            }
            // "+ path" marks a file being added, "U path" an update.
            const named = /(?:^|\s)[+U]\s+(.+)$/.exec(line);
            if (named) this.currentPath = named[1];
        }
        this.onProgress(this);
    }

    private consumeErrors(chunk: string): void {
        for (const raw of chunk.split(/[\r\n]/)) {
            const line = raw.replace(/\x08/g, '').trim();
            if (line.length === 0) continue;
            if (/^(ERROR|WARNING)/i.test(line)) {
                this.skipped.push({ path: this.currentPath, reason: line });
            }
            if (/^ERROR/i.test(line) && !this.error) this.error = line;
        }
    }
}

/** Anything older than this cannot belong to a live job. */
const ORPHAN_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Reclaim temporary archives left by a process that never got to run its exit
 * handler — a crash, or a hard kill. Without this they accumulate silently, and
 * an abandoned archive can be gigabytes.
 *
 * Only files carrying our own prefix are considered, and only ones old enough
 * that no running job could still own them, so a second instance working
 * alongside this one is never disturbed.
 */
async function sweepOrphans(): Promise<void> {
    const dir = tmpdir();
    const cutoff = Date.now() - ORPHAN_AGE_MS;
    try {
        const names = await fs.readdir(dir);
        await Promise.all(
            names
                .filter((name) => /^mydirstat-[0-9a-f]{16}\.(7z|zip|list)$/.test(name))
                .map(async (name) => {
                    const path = join(dir, name);
                    try {
                        const stat = await fs.stat(path);
                        if (stat.mtimeMs < cutoff) await fs.rm(path, { force: true });
                    } catch {
                        /* vanished or not ours to remove */
                    }
                })
        );
    } catch {
        /* an unreadable temp directory is not worth failing a scan over */
    }
}

/** Keeps at most one archive per session and cleans temp files up on exit. */
export class ArchiveManager {
    private jobs = new Map<string, ArchiveJob>();

    constructor(private readonly onProgress: (job: ArchiveJob) => void) {
        void sweepOrphans();
        for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
            process.once(signal, () => {
                // Synchronous on purpose: an async unlink started here would not
                // finish before the process is gone.
                for (const job of this.jobs.values()) {
                    for (const path of [job.file, job.listFile]) {
                        try {
                            rmSync(path, { force: true });
                        } catch {
                            /* best effort on the way out */
                        }
                    }
                }
            });
        }
    }

    /** Starting a new archive retires whatever came before. */
    start(request: ArchiveRequest): ArchiveJob {
        for (const previous of [...this.jobs.values()]) {
            previous.cancel();
            void this.remove(previous.id);
        }
        const job = new ArchiveJob(request, this.onProgress);
        this.jobs.set(job.id, job);
        return job;
    }

    get(id: string): ArchiveJob | undefined {
        return this.jobs.get(id);
    }

    async remove(id: string): Promise<void> {
        const job = this.jobs.get(id);
        if (!job) return;
        this.jobs.delete(id);
        await job.discard();
    }
}
