/**
 * Cleanup actions. Everything shells out through execFile with an argv array —
 * never a shell string — so paths containing quotes, spaces or semicolons are
 * inert rather than injectable.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, basename, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** True when `child` is `parent` or lives beneath it. Blocks `..` escapes. */
export function isInside(parent: string, child: string): boolean {
    const p = resolve(parent);
    const c = resolve(child);
    if (c === p) return true;
    return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Show the item selected in the platform's file manager. */
export async function reveal(path: string): Promise<void> {
    if (process.platform === 'darwin') {
        await run('open', ['-R', path]);
    } else if (process.platform === 'win32') {
        // explorer exits non-zero even on success, so its status is not a signal.
        await run('explorer', [`/select,${path}`]).catch(() => undefined);
    } else {
        try {
            await run('dbus-send', [
                '--session', '--dest=org.freedesktop.FileManager1', '--type=method_call',
                '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems',
                `array:string:file://${encodeURI(path)}`, 'string:',
            ]);
        } catch {
            await run('xdg-open', [dirname(path)]);
        }
    }
}

/** Open the item with the system default application. */
export async function open(path: string): Promise<void> {
    if (process.platform === 'darwin') await run('open', [path]);
    else if (process.platform === 'win32') await run('cmd', ['/c', 'start', '', path]);
    else await run('xdg-open', [path]);
}

/**
 * Move to the platform recycle bin, so a misclick stays recoverable. Throws if
 * the platform has no trash we can reach, rather than silently falling through
 * to a permanent delete.
 */
export async function trash(path: string): Promise<void> {
    if (process.platform === 'darwin') {
        // `on run argv` keeps the path out of the compiled script text. The
        // `as alias` coercion is required: Finder cannot act on a bare
        // `POSIX file` reference and fails with -1728.
        await run('osascript', [
            '-e', 'on run argv',
            '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
            '-e', 'end run',
            path,
        ]);
        return;
    }

    if (process.platform === 'win32') {
        const script =
            'Add-Type -AssemblyName Microsoft.VisualBasic;' +
            '$p = $args[0];' +
            'if (Test-Path -LiteralPath $p -PathType Container) {' +
            '  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin")' +
            '} else {' +
            '  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin")' +
            '}';
        await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script, path]);
        return;
    }

    await freedesktopTrash(path);
}

/**
 * XDG trash spec: the file moves into $XDG_DATA_HOME/Trash/files and a sidecar
 * .trashinfo records where it came from, which is what lets a desktop's
 * "restore" work. rename() only works within one filesystem; a cross-device
 * move would need per-volume .Trash-$uid directories, which we do not attempt.
 */
async function freedesktopTrash(path: string): Promise<void> {
    const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    const trashDir = join(base, 'Trash');
    const filesDir = join(trashDir, 'files');
    const infoDir = join(trashDir, 'info');
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
    const info = `[Trash Info]\nPath=${encodeURI(resolve(path))}\nDeletionDate=${stamp}\n`;
    await fs.writeFile(join(infoDir, `${target}.trashinfo`), info, { flag: 'wx' });

    try {
        await fs.rename(path, join(filesDir, target));
    } catch (err) {
        await fs.rm(join(infoDir, `${target}.trashinfo`), { force: true });
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
            throw new Error('Item is on a different filesystem than the trash directory');
        }
        throw err;
    }
}

/** Permanent removal. Only reached when the caller explicitly asks for it. */
export async function remove(path: string): Promise<void> {
    await fs.rm(path, { recursive: true, force: false });
}
