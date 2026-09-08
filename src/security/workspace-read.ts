import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { RouterError } from "../domain/errors.js";
export interface WorkspaceTextWriteOptions {
    readonly workspace: string;
    readonly requestedPath: string;
    readonly content: string;
    readonly maximumBytes: number;
}
export interface WorkspaceTextReadOptions {
    readonly workspace: string;
    readonly requestedPath: string;
    readonly maximumBytes: number;
}
const protectedDirectoryNames = new Set([
    ".aws",
    ".azure",
    ".codex",
    ".direnv",
    ".docker",
    ".gemini",
    ".git",
    ".gnupg",
    ".grok",
    ".kube",
    ".secrets",
    ".ssh",
    "credentials",
    "secrets",
]);
const protectedFileNames = new Set([
    ".envrc",
    ".git-credentials",
    ".gitconfig",
    ".mcp.json",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "_netrc",
    "accounts.json",
    "application_default_credentials.json",
    "auth.json",
    "auth.toml",
    "client_secret.json",
    "client_secrets.json",
    "credentials",
    "credentials.json",
    "dockerconfigjson",
    "local.settings.json",
    "oauth-credentials.json",
    "oauth.json",
    "oauth_creds.json",
    "pip.conf",
    "providers.json",
    "service-account.json",
    "service_account.json",
    "settings.local.json",
    "token.json",
    "tokens.json",
]);
const protectedFileSuffixes = [
    ".key",
    ".kdbx",
    ".keystore",
    ".ovpn",
    ".p12",
    ".pem",
    ".pfx",
    ".tfstate",
    ".tfstate.backup",
    ".tfvars",
    ".tfvars.json",
];
const credentialContentPatterns = [
    /-----BEGIN [^-\r\n]{0,32}PRIVATE KEY-----/u,
    /(?:^|[\s{,])["']?(?:access|refresh|id)[_-]?token["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/iu,
    /(?:^|[\s{,])["']?(?:api[_-]?key|auth[_-]?token|client[_-]?secret|password|private[_-]?key|secret[_-]?access[_-]?key)["']?\s*[:=]\s*["']?[^\s"'`]{12,}/iu,
    /(?:^|[\s{,])["']?authorization["']?\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\b(?:sk|xai)-[A-Za-z0-9_-]{20,}\b/u,
    /\bAIza[0-9A-Za-z_-]{20,}\b/u,
];
function escapesWorkspace(pathFromWorkspace: string): boolean {
    return (pathFromWorkspace === ".." ||
        pathFromWorkspace.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(pathFromWorkspace));
}
function isProtectedPath(pathFromWorkspace: string): boolean {
    const segments = pathFromWorkspace.split(/[\\/]/u).filter((segment) => segment !== "");
    const normalized = segments.map((segment) => segment.toLowerCase());
    if (normalized.some((segment) => protectedDirectoryNames.has(segment)))
        return true;
    const name = normalized.at(-1);
    if (name === undefined)
        return true;
    if (name === ".env" || name.startsWith(".env."))
        return true;
    if (protectedFileNames.has(name))
        return true;
    if (protectedFileSuffixes.some((suffix) => name.endsWith(suffix)))
        return true;
    if (/^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/u.test(name))
        return true;
    return /^(?:client[_-]?secret|credentials?|service[_-]?account|tokens?)[._-].*\.(?:conf|ini|json|toml|txt|ya?ml)$/u.test(name);
}
function containsCredentialMaterial(text: string): boolean {
    return (containsEscapedStructuredKey(text) ||
        credentialContentPatterns.some((pattern) => pattern.test(text)));
}
function containsEscapedStructuredKey(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        const quote = text[index];
        if (quote !== '"' && quote !== "'")
            continue;
        let hasEncodedCharacter = false;
        let cursor = index + 1;
        while (cursor < text.length) {
            const character = text[cursor];
            if (character === undefined || character === "\r" || character === "\n")
                break;
            if (character === quote) {
                let separator = cursor + 1;
                while (/\s/u.test(text[separator] ?? ""))
                    separator += 1;
                if (hasEncodedCharacter &&
                    (text[separator] === ":" || text[separator] === "=")) {
                    return true;
                }
                index = cursor;
                break;
            }
            if (character === "\\") {
                const remainder = text.slice(cursor);
                if (/^\\(?:u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2})/u.test(remainder)) {
                    hasEncodedCharacter = true;
                }
                cursor += 2;
                continue;
            }
            cursor += 1;
        }
    }
    return false;
}
function sameFile(left: Stats, right: Stats): boolean {
    return (left.isFile() &&
        right.isFile() &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs);
}
export async function readBoundedWorkspaceText(options: WorkspaceTextReadOptions): Promise<string> {
    try {
        const workspace = await realpath(options.workspace);
        const requested = isAbsolute(options.requestedPath)
            ? options.requestedPath
            : resolve(workspace, options.requestedPath);
        const target = await realpath(requested);
        const pathFromWorkspace = relative(workspace, target);
        if (escapesWorkspace(pathFromWorkspace)) {
            throw new RouterError("unsupported_feature", "ACP attempted to read outside the allowed workspace.", 422);
        }
        if (isProtectedPath(pathFromWorkspace)) {
            throw new RouterError("unsupported_feature", "ACP attempted to read a protected workspace file.", 422);
        }
        const before = await lstat(target);
        if (before.isSymbolicLink() ||
            !before.isFile() ||
            before.nlink > 1 ||
            before.size > options.maximumBytes) {
            throw new RouterError("unsupported_feature", "ACP requested a file outside the bounded text-file policy.", 422);
        }
        const handle = await open(target, "r");
        try {
            const opened = await handle.stat();
            if (!sameFile(before, opened)) {
                throw new RouterError("unsupported_feature", "ACP workspace file changed during inspection.", 422);
            }
            const content = await handle.readFile();
            const after = await handle.stat();
            if (!sameFile(opened, after) || content.byteLength > options.maximumBytes) {
                throw new RouterError("unsupported_feature", "ACP workspace file changed during inspection.", 422);
            }
            let text: string;
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(content);
            }
            catch {
                throw new RouterError("unsupported_feature", "ACP requested a file that is not bounded UTF-8 text.", 422);
            }
            if (containsCredentialMaterial(text)) {
                throw new RouterError("unsupported_feature", "ACP requested a file containing protected credential material.", 422);
            }
            return text;
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (error instanceof RouterError)
            throw error;
        throw new RouterError("unsupported_feature", "ACP requested an unreadable workspace file.", 422);
    }
}

/**
 * ACP `fs/write_text_file` kolunun govdesi (2026-09-03).
 *
 * NEDEN: etkilesimli grok rotasi `clientCapabilities.fs.writeTextFile = true` BEYAN
 * ediyordu ama karsiliginda hicbir kol KAYITLI DEGILDI -- protokolde soylenmis ama
 * tutulmamis bir soz. Ya beyan dusecekti ya kol yazilacakti; kol yazildi.
 *
 * Sinirlar okuma kolunun ta kendisi: calisma alanindan kacan yol, korumali dizin/dosya
 * adlari (.git, .gemini, .ssh, secrets vb.) ve boyut tavani REDDEDILIR. Sembolik bag
 * ya da cok-baglantili bir dosyanin uzerine yazilmaz.
 */
export async function writeBoundedWorkspaceText(options: WorkspaceTextWriteOptions): Promise<void> {
    const bytes = Buffer.byteLength(options.content, "utf8");
    if (bytes > options.maximumBytes) {
        throw new RouterError("unsupported_feature", "ACP attempted to write past the bounded text-file policy.", 422);
    }
    const workspace = await realpath(options.workspace);
    const requested = isAbsolute(options.requestedPath)
        ? options.requestedPath
        : resolve(workspace, options.requestedPath);

    // GUVENLIK (2026-09-03, otomatik denetim bulgusu -- bu kod ayni gun benim yazdigimdi):
    // ilk surum kapsama kontrolunu COZULMEMIS yol uzerinde yapiyordu. Okuma kolu
    // `realpath` ile cozuyor, yazma kolu cozmuyordu: sembolik bagli bir UST DIZIN
    // (Windows'ta junction) calisma alanindan disari cikarabilirdi. Artik kapsama
    // kontrolu daima COZULMUS yol uzerinde yapilir.
    const ensureInside = (real: string): string => {
        const pathFromWorkspace = relative(workspace, real);
        // Calisma alaninin KENDISI: goreli yol bos dize olur ve korumali-yol denetimi
        // onu yanlislikla reddeder. Kok, tanimi geregi iceridedir ve korumali degildir.
        if (pathFromWorkspace === "") return pathFromWorkspace;
        if (escapesWorkspace(pathFromWorkspace)) {
            throw new RouterError("unsupported_feature", "ACP attempted to write outside the allowed workspace.", 422);
        }
        if (isProtectedPath(pathFromWorkspace)) {
            throw new RouterError("unsupported_feature", "ACP attempted to write a protected workspace file.", 422);
        }
        return pathFromWorkspace;
    };

    let existing: Stats | undefined;
    try {
        existing = await lstat(requested);
    }
    catch {
        existing = undefined;
    }

    if (existing !== undefined) {
        if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1) {
            throw new RouterError("unsupported_feature", "ACP requested a write outside the bounded text-file policy.", 422);
        }
        ensureInside(await realpath(requested));
        await writeFile(requested, options.content, { encoding: "utf8" });
        return;
    }

    // Hedef yok: EN DERIN VAR OLAN atayi coz, onun icerde oldugunu dogrula, kalan
    // dizinleri ancak ondan sonra yarat. Ayrica ata zincirinde sembolik bag/junction
    // varsa reddet -- kontrol ile yazma arasindaki TOCTOU penceresini kapatir.
    let ancestor = dirname(requested);
    const missing: string[] = [];
    for (;;) {
        try {
            const info = await lstat(ancestor);
            if (info.isSymbolicLink()) {
                throw new RouterError("unsupported_feature", "ACP attempted to write through a symlinked directory.", 422);
            }
            break;
        }
        catch (error) {
            if (error instanceof RouterError) throw error;
            const parent = dirname(ancestor);
            if (parent === ancestor) {
                throw new RouterError("unsupported_feature", "ACP attempted to write outside the allowed workspace.", 422);
            }
            missing.push(ancestor);
            ancestor = parent;
        }
    }
    const realAncestor = await realpath(ancestor);
    ensureInside(realAncestor);
    // Nihai yol, COZULMUS atanin altinda yeniden kurulur; istekteki ham yol degil.
    const target = resolve(realAncestor, relative(ancestor, requested));
    ensureInside(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, options.content, { encoding: "utf8" });
}
