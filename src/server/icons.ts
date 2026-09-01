/**
 * File and folder icons from the Material Icon Theme (MIT, © Material
 * Extensions) — the same icon set and mapping as the VS Code extension.
 *
 * The mapping is the valuable part and it is richer than "extension → icon":
 * exact filenames resolve first, so `package.json` becomes the Node icon rather
 * than a generic JSON one, and 4,654 folder names give `src`, `node_modules`
 * and `.git` their own icons.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

interface IconManifest {
    iconDefinitions: Record<string, { iconPath: string }>;
    fileExtensions: Record<string, string>;
    fileNames: Record<string, string>;
    folderNames: Record<string, string>;
    file: string;
    folder: string;
}

// Resolved through the package's own entry rather than a hard-coded
// node_modules path, so it keeps working wherever npm hoists the package to.
const require = createRequire(import.meta.url);
const PACKAGE_DIR = dirname(require.resolve('material-icon-theme/package.json'));
const ICONS_DIR = join(PACKAGE_DIR, 'icons');

const manifest = JSON.parse(
    readFileSync(join(PACKAGE_DIR, 'dist', 'material-icons.json'), 'utf8')
) as IconManifest;

export const DEFAULT_FILE_ICON = manifest.file;
export const DEFAULT_FOLDER_ICON = manifest.folder;

export function iconForFile(name: string): string {
    const lower = name.toLowerCase();
    const byName = manifest.fileNames[lower];
    if (byName) return byName;

    // Longest suffix wins. The manifest carries 208 multi-part extensions, so
    // "app.ts.map" has to prefer "ts.map" over "map", and checking dots left to
    // right yields the longest remaining suffix first.
    for (let dot = lower.indexOf('.'); dot !== -1; dot = lower.indexOf('.', dot + 1)) {
        const byExt = manifest.fileExtensions[lower.slice(dot + 1)];
        if (byExt) return byExt;
    }
    return manifest.file;
}

export function iconForFolder(name: string): string {
    // Node 0 carries an absolute path rather than a bare name.
    const leaf = basename(name) || name;
    return manifest.folderNames[leaf.toLowerCase()] ?? manifest.folder;
}

/** For the legend, whose keys are scanner extensions like ".ts" or "". */
export function iconForExtension(ext: string): string {
    if (!ext) return manifest.file;
    return manifest.fileExtensions[ext.replace(/^\./, '').toLowerCase()] ?? manifest.file;
}

/**
 * Absolute path of an icon's SVG, or null if the name is not a known icon.
 * Validating against iconDefinitions makes this an allowlist, and taking only
 * the basename of the manifest's own path means a request can never traverse.
 */
export function iconFilePath(name: string): string | null {
    const definition = manifest.iconDefinitions[name];
    if (!definition) return null;
    return join(ICONS_DIR, basename(definition.iconPath));
}
