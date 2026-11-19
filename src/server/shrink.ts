/**
 * "Shrink": strip a development folder of what it does not need to keep.
 *
 * A checked-out solution that has been built and run carries compiled output,
 * debug symbols, restored packages and pictures that together weigh far more
 * than the source. Everything here either comes back from a build or a package
 * restore, or is media the user has said they do not want to keep in these
 * trees. The dialog lists what was found per type and lets each one be
 * unticked, so this list only decides what is offered, never what is removed.
 *
 * A group matches by extension (`exts`), by exact file name (`names`), or by
 * extension inside a folder of a given name (`folder` + `folderExts`). Names
 * are for leftovers whose extension is too broad to take whole: `Thumbs.db` is
 * always Windows' thumbnail cache, a `.db` file may be a real database. Folder
 * rules are the same idea for scripts: a `.js` in `dist/` is a bundled library
 * like jQuery or a build product, a `.js` elsewhere is source.
 */

interface ShrinkGroup {
    label: string;
    exts?: readonly string[];
    /** Lower-case file names, matched case-insensitively. */
    names?: readonly string[];
    /** Lower-case folder name whose `folderExts` files are taken, at any depth. */
    folder?: string;
    folderExts?: readonly string[];
}

export const SHRINK_GROUPS: readonly ShrinkGroup[] = [
    {
        label: 'Build output',
        exts: [
            '.exe', '.dll', '.pdb', '.mdb', '.ilk', '.exp', '.lib', '.obj', '.o', '.a',
            '.so', '.dylib', '.pch', '.ipch', '.idb', '.iobj', '.ipdb', '.tlog',
            '.cache', '.pri', '.tmp', '.msi', '.msm',
        ],
    },
    {
        label: 'Archives',
        exts: ['.7z', '.rar', '.zip'],
    },
    {
        label: 'Fonts',
        exts: ['.ttf', '.otf', '.eot', '.woff', '.woff2'],
    },
    {
        label: 'Bundled libraries (dist/)',
        folder: 'dist',
        folderExts: ['.js', '.mjs', '.cjs', '.css', '.map', '.ts', '.svg'],
    },
    {
        label: 'Web service references',
        exts: ['.wsdl', '.datasource', '.disco'],
    },
    {
        label: 'Thumbnail caches',
        names: ['thumbs.db'],
    },
    {
        label: 'Packages',
        exts: ['.nupkg', '.snupkg'],
    },
    {
        label: 'Icons and images',
        exts: ['.ico', '.cur', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp'],
    },
    {
        label: 'Flash',
        exts: ['.swf', '.flv', '.fla', '.f4v', '.swc'],
    },
];

/** The type entries one group contributes, in the form `filesOfTypes` reads. */
function entriesOf(g: ShrinkGroup): string[] {
    return [
        ...(g.exts ?? []),
        ...(g.names ?? []),
        ...(g.folder ? (g.folderExts ?? []).map((ext) => `${g.folder}/*${ext}`) : []),
    ];
}

/**
 * Everything Shrink offers, in the form the delete request carries types:
 * `.ext`, `file.name` or `folder/*.ext`.
 */
export const SHRINK_TYPES: readonly string[] = SHRINK_GROUPS.flatMap(entriesOf);

/** Which group a type entry belongs to, for the dialog's grouping. */
export function shrinkGroupOf(type: string): string {
    return SHRINK_GROUPS.find((g) => entriesOf(g).includes(type))?.label ?? '';
}

/**
 * Not a delete: generated ASMX proxies (Visual Studio's Reference.cs, or
 * wsdl.exe's <Service>.cs) are rewritten to an interface of their operations
 * plus the data types (see web-reference.ts). The entry rides along with the
 * type entries in a delete request, so it has a form no extension, file name
 * or folder rule can take.
 */
export const MINIMIZE_PROXIES = 'minimize:proxies';
export const PROXY_GROUP = 'Web service proxies (minimized, not deleted)';
