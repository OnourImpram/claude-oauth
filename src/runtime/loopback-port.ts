import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
export async function allocateLoopbackPort(): Promise<number> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    server.close();
    await once(server, "close");
    return port;
}
// Claude Code's gateway model discovery keys its cache to ANTHROPIC_BASE_URL EXACTLY
// (in the binary: `e.baseUrl !== a.ANTHROPIC_BASE_URL -> return []`). An ephemeral port
// per session invalidates that cache every single time and the /model list NEVER shows
// external models. That is why the port is fixed.
//
// A fixed port on loopback is predictable, but on its own it opens nothing: every request
// must carry the 256-bit session nonce (in a header or in the path), otherwise it gets a
// 401.
// 8787 IS DELIBERATELY NOT USED: on this machine ~/.claude/cache/gateway-models.json is
// still dated 2026-05-05, has baseUrl http://127.0.0.1:8787 and carries four models of a
// gateway that no longer exists. Choosing that port would drop ghost models we do not
// serve into the picker.
export const PINNED_LOOPBACK_PORT = 8791;
export function preferredLoopbackPort(environment: NodeJS.ProcessEnv = process.env): number {
    const raw = environment["HEZARFEN_ROUTER_PORT"];
    if (raw === undefined)
        return PINNED_LOOPBACK_PORT;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : PINNED_LOOPBACK_PORT;
}
