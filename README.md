# mydirstat

A cross-platform disk usage analyzer in the spirit of [WinDirStat](https://windirstat.net/).
TypeScript throughout — Node CLI, browser UI, no runtime dependencies.

```
npm install
npm run build
node bin/mydirstat.js ~/Projects
```

`npm run watch` rebuilds on change; `npm test` runs the layout suite.

It scans the directory, starts a loopback HTTP server, and opens a browser on the
familiar three-pane layout:

- **Directory tree** — subtree sizes, share bars, item counts, modification dates,
  sortable on any column, expanded lazily. Drag a column edge to resize it,
  double-click the edge to reset it; widths persist per pane.
- **Extension legend** — every file type with its colour, total size, share and
  file count. Click a row to isolate that type on the map.
- **Treemap** — a squarified cushion treemap where area is proportional to size
  and colour is the file type. Hover for the path, click to select, double-click
  a folder to zoom, right-click for cleanup actions.

Selection is linked across all three panes in both directions.

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

Sizes default to **on disk** (`st_blocks × 512`, so sparse files and slack are
reported honestly); the toolbar toggles to **apparent** size, the plain sum of
file lengths. Units are binary, matching `du` and WinDirStat rather than Finder.

By default the scan stays on one filesystem and counts a hardlinked file once.
Pseudo-filesystems (`/proc`, `/sys`, `/dev`) and self-referential mounts are
skipped when they turn up as children, though you can still scan one directly.

## Layout

```
src/shared/protocol.ts   Wire contract + node flags, compiled into both builds
src/server/              Scanner, store, pruning, HTTP server, CLI
src/client/              Treemap renderer, three-pane UI, typed API client
src/test/                Layout tests
public/                  index.html, style.css; js/ is build output
bin/mydirstat.js         npm bin shim into dist/
```

Two `tsconfig` projects compile `src/shared` + `src/server` to `dist/` under
Node types, and `src/shared` + `src/client` to `public/js/` under DOM types.
`protocol.ts` is compiled into both, so the API shapes are checked at the
boundary instead of trusted, and the flag bits have one definition rather than
a copy in the client that can drift out of step with the scanner. TypeScript is
the only dependency, and it is a dev dependency: nothing ships at runtime.

## How it works

Three decisions carry most of the design.

**The tree is columnar.** A million files as individual objects is hundreds of megabytes,
so `src/store.js` keeps parallel typed arrays instead — about 45 bytes per node
plus its UTF-8 name. Children are always allocated after their parent, so a
single reverse pass is a valid post-order traversal; that is what makes subtree
aggregation and dominant-extension propagation one cheap loop each. The arrays
move from the scan worker to the server as transferable buffers with no
serialisation step.

**The scan runs on a worker thread.** `src/scan-worker.js` walks the tree with an
explicit stack and synchronous `fs` calls, which beat the promise machinery for a
metadata-bound traversal, and posts throttled progress over SSE. Cancellation is
a flag in a `SharedArrayBuffer`. Roughly 45k entries/second on a warm APFS cache.

**The browser never receives the whole tree.** `src/treemap-query.js` prunes by
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

## Cleanup actions

Right-click any tile or tree row:

| Action | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Show in file manager | `open -R` | `explorer /select,` | FileManager1 D-Bus, else `xdg-open` |
| Open | `open` | `start` | `xdg-open` |
| Move to Trash | Finder via `osascript` | `SendToRecycleBin` | freedesktop `~/.local/share/Trash` |

Permanent delete is behind a confirmation dialog. After a removal the node is
detached and its bytes subtracted from every ancestor and from the legend, so
the view stays correct without a rescan.

## Security

The server can delete files, so it is guarded on three fronts: a random
per-process token required on every `/api` call (passed in the URL, then scrubbed
from the address bar), a `Host` header check so a rebound DNS name cannot reach
it, and an `Origin` check on mutating requests. It binds `127.0.0.1` only, and
every action target is verified to lie inside the scan root. Cleanup actions
shell out through `execFile` with an argv array, never a shell string.

## Tests

```
npm test
```

Covers the squarified layout: exact area coverage, no overlaps, area
proportional to value, and aspect ratios staying square enough to be useful.

`npm run typecheck` type-checks the server, client and test projects together.
