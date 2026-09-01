#!/usr/bin/env node
// Thin shim so the npm bin entry exists without a build step. All the work
// lives in the compiled CLI.
import '../dist/server/cli.js';
