/** CLI entry point: parse arguments, start the local server, open a browser. */

import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './server.js';
import { encodePathParam, toDisplayPath } from './paths.js';
import type { AddressInfo } from 'node:net';

const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { version: string };

const USAGE = `
mydirstat ${pkg.version} - disk usage analyzer

Usage:
  mydirstat [directory] [options]

Options:
  -p, --port <n>      Port to listen on (default: 0, an ephemeral port)
      --no-open       Do not launch a browser
      --cross-device  Follow into other mounted filesystems
      --dupes         Count hardlinked files once per link, not once in total
  -h, --help          Show this help
  -v, --version       Show version

The server binds 127.0.0.1 only and requires a per-run token, which is
included in the URL printed below.
`.trim();

let flags: Record<string, unknown>;
let positionals: string[];
try {
    const parsed = parseArgs({
        allowPositionals: true,
        options: {
            port: { type: 'string', short: 'p', default: '0' },
            // node:util parseArgs has no --no-x negation, so it is its own flag.
            'no-open': { type: 'boolean', default: false },
            'cross-device': { type: 'boolean', default: false },
            dupes: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
            version: { type: 'boolean', short: 'v', default: false },
        },
    });
    flags = parsed.values;
    positionals = parsed.positionals;
} catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
}

if (flags.help) {
    console.log(USAGE);
    process.exit(0);
}
if (flags.version) {
    console.log(pkg.version);
    process.exit(0);
}

const target = resolve(positionals[0] ?? process.cwd());
if (!existsSync(target) || !statSync(target).isDirectory()) {
    console.error(`Not a directory: ${target}`);
    process.exit(1);
}

const port = Number(flags.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${String(flags.port)}`);
    process.exit(2);
}

const crossDevice = flags['cross-device'] === true;
const app = createApp({ oneFileSystem: !crossDevice });

app.server.listen(port, '127.0.0.1', () => {
    const { port: actual } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${actual}/?t=${app.token}&path=${encodePathParam(toDisplayPath(target))}`;

    app.beginScan(target, {
        oneFileSystem: !crossDevice,
        countHardlinksOnce: flags.dupes !== true,
    });

    console.log(`mydirstat scanning ${target}`);
    console.log(`  ${url}`);
    console.log('  Ctrl+C to stop');

    if (flags['no-open'] !== true) openBrowser(url);
});

function openBrowser(url: string): void {
    const [cmd, args]: [string, string[]] =
        process.platform === 'darwin' ? ['open', [url]]
        : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
    execFile(cmd, args, (err) => {
        if (err) console.log('  (could not open a browser automatically)');
    });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        app.server.close();
        process.exit(0);
    });
}
