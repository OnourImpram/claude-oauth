import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
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
 * The body of the ACP `fs/write_text_file` arm (2026-09-03).
 *
 * WHY: the interactive grok route DECLARED `clientCapabilities.fs.writeTextFile = true` but NO
 * arm was REGISTERED behind it -- a promise made in the protocol and not kept. Either the
 * declaration had to fall or the arm had to be written; the arm was written.
 *
 * The limits are exactly the read arm's: a path escaping the workspace, protected
 * directory/file names (.git, .gemini, .ssh, secrets and so on) and the size ceiling are
 * REFUSED. A symbolic link or a multiply-linked file is never overwritten.
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

    // SECURITY (2026-09-03, automated-audit finding -- this code was written by me the same
    // day): the first version performed the containment check on the UNRESOLVED path. The read
    // arm resolved with `realpath`, the write arm did not: a symlinked PARENT DIRECTORY (a
    // junction on Windows) could lead outside the workspace. The containment check is now always
    // performed on the RESOLVED path.
    const ensureInside = (real: string): string => {
        const pathFromWorkspace = relative(workspace, real);
        // The workspace ITSELF: the relative path becomes the empty string and the protected-path
        // check would wrongly refuse it. The root is inside by definition and is not protected.
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
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (existing !== undefined) {
        if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1) {
            throw new RouterError("unsupported_feature", "ACP requested a write outside the bounded text-file policy.", 422);
        }
        ensureInside(await realpath(requested));
        // Do not truncate until the opened file's identity matches the inspected file.
        // O_NOFOLLOW rejects final symlinks on POSIX. Windows uses the same fstat check,
        // which also catches an ancestor redirected to another file before open.
        // Source: https://nodejs.org/download/release/v24.14.0/docs/api/fs.html#file-system-flags
        const handle = await open(requested, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const opened = await handle.stat();
            if (!sameFile(existing, opened) || opened.nlink !== 1) {
                throw new RouterError("unsupported_feature", "ACP workspace file changed during inspection.", 422);
            }
            await handle.truncate(0);
            await handle.writeFile(options.content, { encoding: "utf8" });
        }
        finally {
            await handle.close();
        }
        return;
    }

    // The target does not exist: resolve the DEEPEST EXISTING ancestor, verify that it is inside,
    // and only then create the remaining directories. These path checks reject static
    // escapes; they do not lock ancestor directories against concurrent replacement.
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
    // The final path is rebuilt under the RESOLVED ancestor; not the raw path from the request.
    const target = resolve(realAncestor, relative(ancestor, requested));
    ensureInside(target);
    await mkdir(dirname(target), { recursive: true });
    // Exclusive creation refuses a file or symlink inserted since lstat reported ENOENT.
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
        const opened = await handle.stat();
        ensureInside(await realpath(target));
        const linked = await lstat(target);
        if (!sameFile(linked, opened) || opened.nlink !== 1) {
            throw new RouterError("unsupported_feature", "ACP workspace file changed during inspection.", 422);
        }
        await handle.writeFile(options.content, { encoding: "utf8" });
    }
    finally {
        await handle.close();
    }
}
