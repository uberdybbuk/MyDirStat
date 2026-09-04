# mydirstat

A cross-platform disk usage analyzer in the spirit of [WinDirStat](https://windirstat.net/).
TypeScript throughout — Node CLI, browser UI, no native dependencies.

```
npm install
npm run build
node bin/mydirstat.js ~/Projects
```

`npm run watch` rebuilds on change; `npm test` runs the layout suite.

It scans the directory, starts a loopback HTTP server, and opens a browser on the
familiar three-pane layout. A long scan reports running totals and a ticking elapsed time. Progress arrives
from the scanner a few times a second, but the clock is driven separately so the
line never looks frozen between reports. It can be interrupted with **Stop**,
which keeps whatever was found so far and leaves the tree fully usable.

The volume picker only appears where it earns its place: on Windows, where a
drive letter cannot be guessed, or on a machine with more than one real device.
Volumes are deduplicated by device id rather than by path, because macOS shows
the startup disk at both `/` and `/Volumes/<name>` through a firmlink — matching
on paths alone offers the same disk twice under two names.

The path box completes as an Explorer address bar does. Type into it and the
rest of the one folder that matches is written in and left *selected*, so
carrying on typing replaces it and Enter accepts it — the suggestion is offered
without ever being in the way. Underneath, the folders still matching are
listed: the arrow keys walk them, Tab takes the highlighted one and opens it a
level deeper without leaving the box, Escape puts the list away. Completion is
offered forwards only. Appending while the user is deleting would mean the box
refuses to shrink — backspace takes a character off, the completion puts it
straight back — so a deletion never triggers one. Listings are cached per
directory, so typing through a path costs one request per folder rather than one
per keystroke, and hidden folders stay out of the way until the fragment being
typed starts with a dot.

- **Directory tree** — subtree sizes, share bars, item counts, modification dates,
  sortable on any column, expanded lazily, with Material file and folder icons.
  Drag a column edge to resize it, double-click the edge to reset it; widths
  persist per pane. Arrow keys walk it the way a tree is expected to behave:
  up and down move between the rows on screen, right opens a folder and then
  steps into it, left closes it and then steps out to its parent, Home and End
  and the page keys jump, Enter zooms. Scrolling is minimal, so stepping through
  a long list never makes it jump under the cursor.
- **Extension legend** — every file type with its icon, colour, total size,
  share and file count, sortable on any of the four columns. Click a row to
  isolate that type on the map.
- **Treemap** — a squarified cushion treemap where area is proportional to size
  and colour is the file type. Hover for the path relative to the scan root,
  click to select, double-click a folder to zoom, right-click for cleanup
  actions. Zooming in reveals a breadcrumb bar for zooming back out; at the top
  level it hides itself, since the root path is already on screen.

Selection is linked across all three panes in both directions.

The address bar carries the scanned folder, so a reload restores the same view
and the URL is meaningful to look at:

```
http://127.0.0.1:56968/?path=/Users/tbaskan/repos/MyDirStat
```

Paths are always forward-slashed, on Windows too — a backslash would have to be
percent-encoded, turning `C:\Users\me` into `C:%5CUsers%5Cme` in the address
bar. The server converts to the native separator before it touches the
filesystem. The per-run token is kept out of the URL and held in `sessionStorage`
instead, so it survives a reload without ending up in history or a screenshot.

A page cannot impose a minimum size on the browser window, so the layout imposes
one on itself: toolbar controls never shrink or wrap their labels, the summary
drops to a second row when space is tight, and below `--app-min-width` (880px)
the body scrolls horizontally rather than compressing anything.

## Options

```
mydirstat [directory] [options]

  -p, --port <n>      Port to listen on (default: ephemeral)
      --no-open       Do not launch a browser
      --cross-device  Follow into other mounted filesystems
      --dupes         Count each hardlink separately instead of once
  -h, --help
  -v, --version
```

Sizes are **apparent** — the plain sum of file lengths, which is what an archive
holds and what a copy of the tree would occupy elsewhere. Units are binary,
matching `du` and WinDirStat rather than Finder. On-disk allocation
(`st_blocks × 512`, counting sparse files and slack honestly) is still gathered
per node and carried through the store; it has no control in the UI at present.

A directory that does not exist, is not a directory, or cannot be listed is
reported as such before any scan starts, in a bar under the toolbar. The check
is an `opendir`, not an existence test: a folder that exists but cannot be read
passes the latter, and the scan then finishes "successfully" over an empty tree,
which reads as *this folder is empty* rather than *you are not allowed to look*.
An unreadable directory found part way down a scan stays what it is — one faded
row — since that is a fact about that directory, not a failed scan.

By default the scan stays on one filesystem and counts a hardlinked file once.
Pseudo-filesystems (`/proc`, `/sys`, `/dev`) and self-referential mounts are
skipped when they turn up as children, though you can still scan one directly.

## Layout

```
src/shared/protocol.ts   Wire contract + node flags, compiled into both builds
src/server/              Scanner, store, pruning, HTTP server, CLI
src/client/              Treemap renderer, three-pane UI, typed API client
src/test/                Layout, selection and path tests
public/                  index.html, style.css; js/ is build output
bin/mydirstat.js         npm bin shim into dist/
```

Two `tsconfig` projects compile `src/shared` + `src/server` to `dist/` under
Node types, and `src/shared` + `src/client` to `public/js/` under DOM types.
`protocol.ts` is compiled into both, so the API shapes are checked at the
boundary instead of trusted, and the flag bits have one definition rather than
a copy in the client that can drift out of step with the scanner.

Runtime dependencies are `material-icon-theme` (data: SVGs and a mapping table,
no code) and `7zip-bin` (7-Zip binaries for every platform, run as a child
process). TypeScript is dev-only.

## How it works

Three decisions carry most of the design.

**The tree is columnar.** A million files as individual objects is hundreds of megabytes,
so `src/server/store.ts` keeps parallel typed arrays instead — about 45 bytes per node
plus its UTF-8 name. Children are always allocated after their parent, so a
single reverse pass is a valid post-order traversal; that is what makes subtree
aggregation and dominant-extension propagation one cheap loop each. The arrays
move from the scan worker to the server as transferable buffers with no
serialisation step.

**The scan runs on a worker thread.** `src/server/scan-worker.ts` walks the tree with an
explicit stack and synchronous `fs` calls, which beat the promise machinery for a
metadata-bound traversal, and posts throttled progress over SSE. Cancellation is
a flag in a `SharedArrayBuffer`. Roughly 45k entries/second on a warm APFS cache.

**The browser never receives the whole tree.** `src/server/treemap-query.ts` prunes by
*projected area*: given the canvas size, each node's value maps to the pixels it
will occupy, so anything sub-pixel is folded into an aggregate tile and any
directory too small to subdivide is left whole. A 340k-file scan becomes ~33k
tiles in ~175 KB gzipped. Two details matter and were both bugs first:

- The emit threshold has to sit near pixel size. Raise it and sets that are
  individually small but collectively huge — 52k subdirectories, say — fold into
  one tile that then misreports itself as the largest thing on the map.
- Every tile is coloured by an extension, including directories, which inherit
  the type of the heaviest file beneath them. Otherwise regions too fine to
  subdivide render as a featureless grey mass carrying no information.

The treemap itself combines two published algorithms, as WinDirStat does:
squarified layout (Bruls, Huizing & van Wijk 2000) for near-square tiles, and
cushion shading (van Wijk & van de Wetering 1999), where each nesting level adds
a parabolic ridge to a shared quadratic height field that is then lit per pixel.
That shading is what makes directory structure visible without drawing a single
border. The light vector is deliberately *not* normalised: leaving `lightZ` above
1 and clamping `cosa` at 1 gives each tile a lit plateau with darkening confined
to its edges, which reads as a crease between neighbours and keeps the base
colour identifiable.

## Icons

File and folder icons come from the [Material Icon
Theme](https://github.com/material-extensions/vscode-material-icon-theme), the
same set as the VS Code extension. Its mapping is richer than extension-to-icon:
exact filenames resolve first, so `package.json` gets the Node icon rather than a
generic JSON one, and 4,654 folder names give `src`, `node_modules` and `.git`
their own icons. Multi-part extensions resolve longest-suffix-first, so
`db.schema.json` is a JSON-schema icon and not plain JSON.

Icons appear in the tree and the legend, never on the treemap: tiles there are
routinely a handful of pixels, and colour is the whole encoding that ties the
map to the legend. In the tree each row carries a thin colour chip beside its
icon, so the link back to the tile's colour on the map survives.

The server resolves an icon name per row and serves the SVG from
`/icons/<name>.svg`, validated against the manifest's own definitions — an
allowlist, so a request cannot traverse out of the icon directory.

## Selecting and archiving

**Select…** in the toolbar opens a checkbox tree over the scan. Everything —
picking, archiving, deleting — happens inside that dialog; the main window never
changes in response to a selection, so browsing disk usage and choosing files
stay separate activities. Tick individual files or whole folders, or filter and
take the whole match in one click. The dialog keeps its selection between
openings.

A decision on a folder is a statement about its whole subtree: ticking or
unticking one clears any rule already sitting beneath it. Without that, a
folder's checkbox looks inert — nearest-rule-wins would let per-file rules made
earlier (by *Select all N*, say) keep beating the folder's own decision.

Selection is stored as **rules, not a list of files**. "Everything under
node_modules" is one entry rather than 268,000, "every .mp4" is one entry rather
than 53,000, and the nearest rule to a node wins — so *take `src/`, drop
`src/lib/`, but keep `src/lib/util.ts`* is three rules. Resolving that for every
node is one forward pass, since a parent's decision is settled before its
children are reached; a reverse pass then rolls up per-subtree totals, which is
what gives tri-state folder checkboxes and live byte counts.

Selection state is computed on the server, so after any change the dialog drops
its row cache entirely and refetches what is on screen, reloading the rest when
it is expanded again. Refreshing only the expanded folders is not enough: a
collapsed folder's rows come back the moment it is re-expanded, and collapsing a
folder does not un-expand its descendants, so a deeper folder can stay fresh
while its own parent goes stale.

Counts are always shown against the whole scan — *25 of 2,106 files · 183 KB of
28.3 MB* — so the size of what you are choosing from is never hidden. That
denominator shrinks when files are deleted, which is the sort of thing a cached
total quietly gets wrong.

The dialog is resizable from its bottom-right corner and remembers the size,
clamped to the current viewport so a size set on an external monitor does not
come back off-screen on a laptop.

Escape closes exactly one thing: the topmost open dialog. Each dialog owning its
own Escape handler is what let a single keypress close two of them — the inner
one dismissed itself, the same event carried on to the window, and by then the
dialog underneath looked like the topmost thing open. A job in progress is not
dismissed by Escape at all; only its finished report is.

The filter searches every file in the scan, not just the selected ones, so it
can find things to add. A term with no wildcard is a substring match, so typing
part of a name still works; a term containing `*` or `?` is anchored and matched
whole, which is what makes `*.cs` mean *C# files* rather than *contains .cs*.
Terms are separated by `;` or `,`, and by spaces too once a wildcard is in play —
`*.cs;*.txt` and `*.cs *.txt` both work, while a plain search for `my file` stays
one term. A term containing `/` is matched against the path relative to the scan
root instead of the name, which is the slower path and only taken when asked for.

**Invert** takes everything that is not selected and drops everything that is.
With a filter active the bulk bar offers the same thing over just the matches,
which is how *everything except the logs* is expressed without listing anything.
With nothing selected it means *take all*.

Inverting rewrites the rules rather than setting a "the answer is now backwards"
flag: a flag would leak into every later edit — ticking a box would have to mean
untick — and the rule set would stop describing what is actually selected. The
rewrite is what keeps it small. Rules are emitted at the highest node that can
carry them, so a subtree that ends up wholly taken is one rule and only genuinely
mixed folders are descended into; inverting *take `a/`* comes back as two rules,
not one per file.

### Selecting by file type

**Select by file type…** opens the extension legend again, this time with
checkboxes: every type in the scan with its size, share and file count, sortable
on any column and filterable by name. Tick the types, press OK, and the file
dialog comes back reflecting them.

The list is the scan's own extensions, which is the point. A fixed menu of
*text files*, *images* and so on is a list that is always wrong somewhere — the
honest test for "is this text" is to read the file, and reading every file in a
million-file scan is not on the table. Showing what is actually there, with its
weight, asks nothing of a canned definition and never misses a type this
particular tree happens to contain.

Ticking a type is one rule over the whole scan, not a list of files, so *every
`.mp4`* stays a single entry however many there are. The dialog is a
transaction: nothing is applied while it is open, Cancel changes nothing, and
reopening it starts from what is currently chosen.

### Compression

Archives are produced by 7-Zip, run as a child process. The binary comes from
the `7zip-bin` package rather than the host, so nothing has to be installed on
the machine doing the compressing — it ships builds for Windows, macOS and Linux
across x64, arm64, ia32 and arm.

| format | 27.5 MB tree, 1,856 files | time | unpack with |
| --- | --- | --- | --- |
| `7z` | **2.70 MB** | 3.7 s | `7z x` — 7-Zip, Keka, The Unarchiver |
| `zip` | 5.77 MB | 4.3 s | `unzip`, Finder, Explorer |

`7z` is solid: one continuous stream, so matches reach across file boundaries.
That is where the lead comes from, not the algorithm — with the same LZMA2
settings, solid gave 2.70 MB against 4.46 MB non-solid. Zip compresses every
entry independently and structurally cannot do this, which is also why it stays
on the menu: it opens with no tool at all.

Hand-rolled tar plus Node's built-in brotli was measured at 2.69 MB — the same
size — but took 20.1 s against 7-Zip's 3.7 s, and produced a file with no common
desktop archiver behind it. That implementation was removed once 7-Zip could be
bundled rather than assumed.

Paths go to 7-Zip in a list file, not on the command line: a selection can run
past any platform's argument limit. The finished-archive dialog prints the
command for unpacking whichever format was used.

Temporary archives are swept on startup as well as on exit, so a crash or a hard
kill cannot leave gigabytes behind. Only files carrying this program's own
prefix and old enough that no live job could own them are touched.

### Deleting

The dialog can remove what is selected, and the type dialog can remove whole
file types — every `.obj` and `.pdb` in the scan in one action, which is the
shape most cleanup actually takes. **Move to Trash** is recoverable; **Delete
permanently** requires typing the exact file count, so a stale dialog cannot
delete a set nobody looked at, and the server checks that number against its own
before it starts. Both report progress and can be cancelled.

Deleting a file type does not go through the selection: it must not sweep up
what is ticked in the tree, and ticking a type must not be the thing that arms a
delete. Types travel to the server as names rather than as legend ranks — ranks
are assigned per scan, and a stale rank would address the wrong type where a
stale name simply matches nothing.

**Nothing counts as deleted until its path is actually gone.** A helper that
exits zero has not necessarily removed anything, and writing those bytes off as
freed is worse than useless: the tree shrinks while the disk does not, and every
share derived from those totals is then wrong. Each batch is verified against
the filesystem afterwards, and whatever survived is listed by name with its
reason in the progress dialog instead of being reported as a success.

That check has already earned itself. On Windows the paths were passed as
`powershell -Command <script> <paths…>`, which looks like arguments and is not:
`-Command` takes everything after it as part of the command *text*, so `$args`
stayed empty, the loop ran zero times, the process exited cleanly and nothing
was ever recycled. Paths now travel in a UTF-8 list file — which also keeps
non-ASCII names intact, where neither the command line nor stdin does reliably —
and the script goes in as `-EncodedCommand`, where there is nothing left for a
quoting layer to mangle.

Trashing batches its calls. On macOS each `osascript` invocation costs around a
hundred milliseconds, so one call per file would turn two thousand files into
minutes of process startup alone — 85 files take 0.7 s batched.

Archives build to a temporary file with per-file progress and a cancel button,
then download as a normal file of known size. Unreadable or vanished files are
skipped and reported rather than aborting the archive.

## Cleanup actions

Right-click any tile or tree row:

| Action | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Show in file manager | `open -R` | `explorer /select,` | FileManager1 D-Bus, else `xdg-open` |
| Open | `open` | `start` | `xdg-open` |
| Move to Trash | Finder via `osascript` | `SendToRecycleBin` | freedesktop `~/.local/share/Trash` |

Permanent delete is behind a confirmation dialog.

After a removal the node is cut out of its parent's child chain and **every
total is recomputed from the nodes that are left** — the same arithmetic the
scan itself performed, so it cannot drift. Patching ancestors incrementally is
cheaper and was how this worked; one miscount there leaves the tree permanently
inconsistent, and the symptom is a directory reporting more bytes than the root
containing it, which is where shares above 100% come from. The rebuild also
re-derives the legend and the dominant type per directory, and marks the removed
nodes gone, so a deleted file cannot turn up in a search or be selected again.

Deleted nodes stay in the arrays but leave the tree, which the API has to
account for: a request for a folder that has been deleted is answered 410 rather
than with its remains, and the treemap climbs to the nearest folder that still
exists and reports which one it used, so zooming into a folder and then deleting
it moves the view up instead of leaving a ghost on screen.

## Security

The server can delete files, so it is guarded on three fronts: a random
per-process token required on every `/api` call (passed in the URL, then scrubbed
from the address bar), a `Host` header check so a rebound DNS name cannot reach
it, and an `Origin` check on mutating requests. It binds `127.0.0.1` only, and
every action target is verified to lie inside the scan root. Cleanup actions
shell out through `execFile` with an argv array, never a shell string.

## Credits

Icons: [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)
by Material Extensions, MIT licensed. The full licence ships with the package in
`node_modules/material-icon-theme/LICENSE`.

Algorithms: squarified treemap layout from Bruls, Huizing & van Wijk (2000);
cushion shading from van Wijk & van de Wetering (1999).

## Tests

```
npm test
```

Covers the squarified layout — exact area coverage, no overlaps, area
proportional to value, aspect ratios staying square enough to be useful — the
selection rule algebra, including nearest-rule-wins and folder decisions
clearing the rules beneath them, and path display/round-tripping.

`npm run typecheck` type-checks the server, client and test projects together.
