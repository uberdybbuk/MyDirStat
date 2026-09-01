/**
 * Path form at the HTTP boundary.
 *
 * Everything crossing the wire — query parameters, JSON, anything shown in the
 * UI — uses forward slashes on every platform. Only the filesystem calls use
 * the native separator.
 *
 * Two reasons. A backslash has to be percent-encoded in a URL, so a Windows
 * path turns `?path=C:\Users\me` into `C:%5CUsers%5Cme`, which is unreadable
 * and easy to mangle when copied by hand. And it means the client never has to
 * care which platform the server runs on.
 */

// The platform is a parameter rather than a module-level constant so the
// Windows branch is reachable from tests on any host. It is the branch that
// motivated this module, and it is the one a macOS or Linux CI run would
// otherwise never execute.
type Platform = NodeJS.Platform;

/** Native path in, forward-slash path out. Safe to call on any platform. */
export function toDisplayPath(path: string, platform: Platform = process.platform): string {
    return platform === 'win32' ? path.replace(/\\/g, '/') : path;
}

/** Forward-slash path in, native path out. Safe to call on any platform. */
export function toNativePath(path: string, platform: Platform = process.platform): string {
    // UNC paths survive the round trip: "//server/share" <-> "\\\\server\\share".
    return platform === 'win32' ? path.replace(/\//g, '\\') : path;
}

export { encodePathParam } from '../shared/paths.js';
