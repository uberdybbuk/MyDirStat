/**
 * Bulk removal with progress.
 *
 * Deleting thousands of files is slow enough to need a progress report and a
 * cancel button, and destructive enough that the default has to be the
 * recoverable one. Two modes: move to the platform trash, or unlink outright.
 *
 * The trash path batches. On macOS each `osascript` invocation costs on the
 * order of a hundred milliseconds, so one call per file would turn a two
 * thousand file selection into several minutes of pure process startup; passing
 * a chunk of paths per call collapses that. Linux needs no batching because the
 * freedesktop trash is a rename, and Windows loops inside a single PowerShell
 * process for the same reason macOS batches.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { DeleteFailure, DeleteMode, DeleteState, DeleteStatus, DeleteTarget } from '../shared/protocol.js';
import { minimizeReferenceFile } from './web-reference.js';

const run = promisify(execFile);

/** Paths handed to one trash invocation. Keeps argv well inside any limit. */
const BATCH = 150;


export class DeleteJob {
    readonly id = randomBytes(8).toString('hex');
    readonly startedAt = Date.now();
    readonly bytesTotal: number;

    state: DeleteState = 'running';
    filesDone = 0;
    rewritten = 0;
    bytesFreed = 0;
    currentPath = '';
    finishedAt?: number;
    error?: string;

    private cancelled = false;
    private readonly failures: DeleteFailure[] = [];
    readonly done: Promise<void>;

    constructor(
        private readonly targets: DeleteTarget[],
        readonly mode: DeleteMode,
        /** `newSize` is set when the file was rewritten smaller rather than removed. */
        private readonly onDeleted: (id: number, newSize?: number) => void,
        private readonly onProgress: (job: DeleteJob) => void,
        readonly purpose: 'delete' | 'shrink' = 'delete'
    ) {
        this.bytesTotal = targets.reduce((a, t) => a + t.size, 0);
        this.done = this.run();
    }

    status(): DeleteStatus {
        return {
            id: this.id,
            state: this.state,
            mode: this.mode,
            purpose: this.purpose,
            rewritten: this.rewritten,
            files: this.targets.length,
            filesDone: this.filesDone,
            bytesFreed: this.bytesFreed,
            bytesTotal: this.bytesTotal,
            currentPath: this.currentPath,
            failures: this.failures.slice(0, 200),
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            error: this.error,
        };
    }

    cancel(): void {
        this.cancelled = true;
    }

    private finish(state: DeleteState, error?: string): void {
        this.state = state;
        this.error = error;
        this.finishedAt = Date.now();
        this.onProgress(this);
    }

    private async run(): Promise<void> {
        try {
            for (let i = 0; i < this.targets.length && !this.cancelled; i += this.step()) {
                const chunk = this.targets.slice(i, i + this.step());
                this.currentPath = chunk[0].label;
                await this.removeChunk(chunk);
                this.onProgress(this);
            }
            this.finish(this.cancelled ? 'cancelled' : 'done');
        } catch (err) {
            this.finish('failed', (err as Error).message);
        }
    }

    private step(): number {
        // Permanent removal is a direct syscall, so batching buys nothing and
        // per-file progress is more useful.
        return this.mode === 'permanent' || process.platform === 'linux' ? 1 : BATCH;
    }

    private async removeChunk(targets: DeleteTarget[]): Promise<void> {
        const rewrites = targets.filter((t) => t.minimize);
        if (rewrites.length > 0) await this.rewriteChunk(rewrites);
        const chunk = targets.filter((t) => !t.minimize);
        if (chunk.length === 0) return;

        const reasons = new Map<number, string>();
        const attempt = async (target: DeleteTarget, remove: () => Promise<unknown>): Promise<void> => {
            this.currentPath = target.label;
            try {
                await remove();
            } catch (err) {
                reasons.set(target.id, (err as Error).message.split('\n')[0]);
            }
        };

        if (this.mode === 'permanent') {
            for (const target of chunk) await attempt(target, () => fs.rm(target.path, { force: true }));
        } else if (process.platform === 'linux') {
            for (const target of chunk) await attempt(target, () => freedesktopTrash(target.path));
        } else {
            try {
                await trashBatch(chunk.map((t) => t.path));
            } catch {
                // A batch that fails as a whole says nothing about which member
                // was at fault, so fall back to one at a time to attribute it.
                for (const target of chunk) await attempt(target, () => trashBatch([target.path]));
            }
        }

        await this.confirm(chunk, reasons);
    }

    /**
     * Believe the filesystem, not the tool.
     *
     * A helper that exits zero has not necessarily deleted anything — a shell
     * that swallowed its arguments, a trash implementation that declined
     * silently. Counting those as freed bytes is worse than useless: the tree
     * shrinks while the disk does not, and every share it derives from those
     * totals is then wrong. So a target is only written off once its path is
     * actually gone.
     */
    private async confirm(chunk: DeleteTarget[], reasons: Map<number, string>): Promise<void> {
        const present = await Promise.all(chunk.map((t) => stillThere(t.path)));
        chunk.forEach((target, k) => {
            if (!present[k]) {
                this.accountFor(target);
                return;
            }
            this.failures.push({
                path: target.label,
                reason: reasons.get(target.id) ?? 'reported as removed but still on disk',
            });
            this.filesDone++;
        });
    }

    /**
     * Replace each file with its minimized form.
     *
     * In trash mode the originals go to the trash first, as one batch, and the
     * new text is written only where the original is confirmed gone. A write
     * that fails after that leaves the original in the trash, recoverable,
     * rather than lost. Permanent mode writes a sibling temp file and renames
     * it over the original, so a failure never leaves a half-written file.
     */
    private async rewriteChunk(chunk: DeleteTarget[]): Promise<void> {
        const ready: { target: DeleteTarget; before: number; after: Buffer }[] = [];
        for (const target of chunk) {
            if (this.cancelled) break;
            this.currentPath = target.label;
            try {
                const bytes = await fs.readFile(target.path);
                const after = minimizeReferenceFile(bytes);
                if (after) ready.push({ target, before: bytes.length, after });
                else this.fail(target, 'no longer a web reference proxy');
            } catch (err) {
                this.fail(target, (err as Error).message.split('\n')[0]);
            }
        }
        if (ready.length === 0) return;

        if (this.mode === 'trash') {
            try {
                await trashBatch(ready.map((r) => r.target.path));
            } catch {
                for (const r of ready) await trashBatch([r.target.path]).catch(() => undefined);
            }
        }

        // No cancel check from here on: once an original is in the trash, its
        // replacement has to be written, or the file is simply gone.
        for (const { target, before, after } of ready) {
            this.currentPath = target.label;
            try {
                if (this.mode === 'trash') {
                    if (await stillThere(target.path)) {
                        this.fail(target, 'could not be moved to the Trash');
                        continue;
                    }
                    await fs.writeFile(target.path, after, { flag: 'wx' });
                } else {
                    const temp = `${target.path}.mydirstat-${randomBytes(4).toString('hex')}`;
                    await fs.writeFile(temp, after, { flag: 'wx' });
                    // Source control often leaves files read-only, and a rename
                    // over a read-only file fails on Windows.
                    await fs.chmod(target.path, 0o666).catch(() => undefined);
                    try {
                        await fs.rename(temp, target.path);
                    } catch (err) {
                        await fs.rm(temp, { force: true });
                        throw err;
                    }
                }
                const written = (await fs.stat(target.path)).size;
                if (written !== after.length) {
                    this.fail(target, 'rewritten file has an unexpected size');
                    continue;
                }
                this.filesDone++;
                this.rewritten++;
                this.bytesFreed += before - written;
                this.onDeleted(target.id, written);
                this.onProgress(this);
            } catch (err) {
                this.fail(target, (err as Error).message.split('\n')[0]);
            }
        }
    }

    private fail(target: DeleteTarget, reason: string): void {
        this.failures.push({ path: target.label, reason });
        this.filesDone++;
    }

    private accountFor(target: DeleteTarget): void {
        this.filesDone++;
        this.bytesFreed += target.size;
        // Tell the store immediately so the tree reflects reality even if the
        // job is cancelled part way through.
        this.onDeleted(target.id);
    }
}

/** Move several paths to the platform trash in one invocation. */
async function trashBatch(paths: string[]): Promise<void> {
    if (process.platform === 'darwin') {
        // `items` is an AppleScript keyword — assigning to it fails with
        // "Can't set every item to {}" (-10006), so the list needs its own name.
        await run('osascript', [
            '-e', 'on run argv',
            '-e', 'set theTargets to {}',
            '-e', 'repeat with p in argv',
            '-e', 'set end of theTargets to (POSIX file (contents of p) as alias)',
            '-e', 'end repeat',
            '-e', 'tell application "Finder" to delete theTargets',
            '-e', 'end run',
            ...paths,
        ]);
        return;
    }

    if (process.platform === 'win32') {
        await windowsRecycle(paths);
        return;
    }

    for (const path of paths) await freedesktopTrash(path);
}

/**
 * Recycle Bin, via the shell API that VB.NET exposes.
 *
 * The paths travel in a file rather than on the command line. `powershell
 * -Command <script> <paths…>` looks like it passes arguments, but `-Command`
 * takes everything after it as *part of the command text*: `$args` stays empty,
 * so the loop ran zero times while the process still exited cleanly — nothing
 * was ever recycled, and the tree was told it had been. A list file also keeps
 * UTF-16 path names intact, which neither the command line nor stdin does
 * reliably on Windows PowerShell.
 *
 * The script itself goes in as -EncodedCommand for the same class of reason:
 * base64 has nothing left for a quoting layer to mangle.
 */
async function windowsRecycle(paths: string[]): Promise<void> {
    const list = join(tmpdir(), `mydirstat-trash-${randomBytes(8).toString('hex')}.txt`);
    await fs.writeFile(list, paths.join('\r\n'), 'utf8');
    try {
        const literal = list.replace(/'/g, "''");
        const script = [
            'Add-Type -AssemblyName Microsoft.VisualBasic',
            `foreach ($p in [System.IO.File]::ReadAllLines('${literal}', [System.Text.Encoding]::UTF8)) {`,
            '    if ($p.Length -eq 0) { continue }',
            // ThrowException, so a refusal surfaces as a failure here instead of
            // as a modal dialog on a machine nobody is looking at.
            '    if ([System.IO.Directory]::Exists($p)) {',
            "        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')",
            '    } else {',
            "        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')",
            '    }',
            '}',
        ].join('\n');
        await run('powershell', [
            '-NoProfile', '-NonInteractive',
            '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
        ]);
    } finally {
        await fs.rm(list, { force: true });
    }
}

/**
 * Whether the path is still on disk. Anything other than a plain "no such
 * file" counts as present: a delete that cannot be verified must not be
 * reported as one.
 */
async function stillThere(path: string): Promise<boolean> {
    try {
        await fs.lstat(path);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'ENOENT';
    }
}

/** XDG trash spec, so the desktop's "restore" knows where the file came from. */
async function freedesktopTrash(path: string): Promise<void> {
    const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    const filesDir = join(base, 'Trash', 'files');
    const infoDir = join(base, 'Trash', 'info');
    await fs.mkdir(filesDir, { recursive: true });
    await fs.mkdir(infoDir, { recursive: true });

    const name = basename(path);
    let target = name;
    for (let n = 1; ; n++) {
        try {
            await fs.access(join(filesDir, target));
            target = `${name}.${n}`;
        } catch {
            break;
        }
    }

    const stamp = new Date().toISOString().replace(/\.\d+Z$/, '');
    await fs.writeFile(
        join(infoDir, `${target}.trashinfo`),
        `[Trash Info]\nPath=${encodeURI(resolve(path))}\nDeletionDate=${stamp}\n`,
        { flag: 'wx' }
    );
    try {
        await fs.rename(path, join(filesDir, target));
    } catch (err) {
        await fs.rm(join(infoDir, `${target}.trashinfo`), { force: true });
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
            throw new Error(`${dirname(path)} is on a different filesystem than the trash`);
        }
        throw err;
    }
}
