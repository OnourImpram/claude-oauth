import { writeFileSync } from "node:fs";
import { join } from "node:path";

// A real fake provider launched by runAntigravityProcess. The redirected call home
// carries only fixture process metadata here; no operator home is read.
const home = process.env["USERPROFILE"];
if (home === undefined) throw new Error("Fixture requires a call home");
writeFileSync(join(home, "fixture-child.json"), JSON.stringify({ pid: process.pid }));
process.stdin.resume();
setInterval(() => undefined, 60_000);
