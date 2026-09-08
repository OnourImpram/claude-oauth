// clean.mjs -- deletes the build output. tsc does not remove stale files; when a module is
// deleted from the source, its old .js stays in dist and keeps being imported.
//
// FIX: this script touches nothing outside dist/. If the deletion is refused, an open
// process is holding dist (a running claude session) -- close that first.
import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve(import.meta.dirname, "..", "dist");
let existed = false;
try { await stat(target); existed = true; } catch { /* already absent */ }
await rm(target, { recursive: true, force: true });
console.log(existed ? `deleted: ${target}` : `already absent: ${target}`);
