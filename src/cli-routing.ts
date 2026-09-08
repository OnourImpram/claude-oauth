const ENTRYPOINT_ENVIRONMENT_NAME = "HEZARFEN_CLAUDE_OAUTH_ENTRYPOINT";
const NATIVE_CLAUDE_COMMANDS = new Set([
    "agents",
    "auth",
    "auto-mode",
    "doctor",
    "gateway",
    "import",
    "install",
    "mcp",
    "plugin",
    "plugins",
    "project",
    "setup-token",
    "ultrareview",
    "update",
    "upgrade",
]);
export type PublicEntrypoint = "claude" | "oauth";
export interface EntrypointResolution {
    readonly entrypoint: PublicEntrypoint;
    readonly args: readonly string[];
}
// The claude.cmd / claude.ps1 shims announce the entry point as a leading argument,
// but nothing consumed it and nothing set the environment variable either -- so
// publicEntrypoint() always answered "oauth" and launchClaudeOAuth was unreachable
// from the `claude` command. Honouring both channels here means a shim and a launcher
// template can drift apart without silently disabling the whole runtime again.
const ENTRYPOINT_ARGUMENT_PREFIX = "--hezarfen-entrypoint=";
export function resolveEntrypoint(argumentList: readonly string[], environment: NodeJS.ProcessEnv): EntrypointResolution {
    const first = argumentList[0];
    if (first !== undefined && first.startsWith(ENTRYPOINT_ARGUMENT_PREFIX)) {
        return {
            entrypoint: first.slice(ENTRYPOINT_ARGUMENT_PREFIX.length) === "claude" ? "claude" : "oauth",
            args: argumentList.slice(1),
        };
    }
    return { entrypoint: publicEntrypoint(environment), args: argumentList };
}
export function publicEntrypoint(environment: NodeJS.ProcessEnv): PublicEntrypoint {
    return environment[ENTRYPOINT_ENVIRONMENT_NAME] === "claude" ? "claude" : "oauth";
}
export function isNativeClaudeCommand(arguments_: readonly string[]): boolean {
    const first = arguments_[0];
    if (first === undefined)
        return false;
    if (["--help", "-h", "help", "--version", "-v"].includes(first))
        return true;
    return NATIVE_CLAUDE_COMMANDS.has(first);
}
