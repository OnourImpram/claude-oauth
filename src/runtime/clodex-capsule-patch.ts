import { RouterError } from "../domain/errors.js";

export const CLODEX_TRANSPORT_NONCE_ENV = "HEZARFEN_CLODEX_TRANSPORT_NONCE";

function replaceUnique(source: string, name: string, anchor: string, replacement: string): string {
    const count = source.split(anchor).length - 1;
    if (count !== 1) {
        throw new RouterError("adapter_unavailable", `Clodex capsule patch anchor ${name} matched ${count} times; expected exactly one.`, 503);
    }
    return source.replace(anchor, () => replacement);
}

// Anchors are from @bman654/clodex 2.21.7 dist/cli.js. They are the same text as in 2.11.1
// (measured 2026-11-15: the quick-mode password head, the /health + authorization pair and the body
// of isAuthorized are byte-identical in both bundles), and the upstream still enforces NEITHER
// property itself: quick local mode still returns a null password, and /health is still answered
// before the authorization check. So both stay enforced here. Its original bytes remain pinned
// separately; this transform never receives or embeds the session nonce.
export function patchClodexCapsule(source: string): string {
    const passwordAnchor = `async function getServerPasswordForQuickMode(mode, passwordOverride) {
  if (mode === "local") return { password: null, wasSaved: false };`;
    const withPassword = replaceUnique(source, "quick-local-password", passwordAnchor,
        `async function getServerPasswordForQuickMode(mode, passwordOverride) {
  if (mode === "local") {
    const password = process.env.${CLODEX_TRANSPORT_NONCE_ENV};
    if (!password || !password.trim()) throw new Error("Clodex capsule transport nonce is required.");
    return { password, wasSaved: false };
  }`);
    const health = `    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
`;
    const authorization = `    if (!isAuthorized(toRequest(req), options.serverPassword)) {
      sendJson(res, 401, { error: { message: "Unauthorized" } });
      return;
    }
`;
    return replaceUnique(withPassword, "health-authorization", health + authorization, authorization + health);
}
