#!/bin/sh
# Portable router entry with a native remote-control fallback.
set -eu
native_entry=false
case "${1:-}" in
    remote-control|--hezarfen-entrypoint=claude) native_entry=true ;;
esac
# Required-value options from https://code.claude.com/docs/en/cli-reference#cli-flags
value_follows=false
for argument do
    if "$value_follows"; then value_follows=false; continue; fi
    if [ "$argument" = '--' ]; then break; fi
    case "$argument" in
        --advisor|--agent|--agents|--append-subagent-system-prompt|--append-subagent-system-prompt-file|--append-system-prompt|--append-system-prompt-file|--autocompact|--config|--debug-file|--effort|--fallback-model|--from-pr|--input-format|--json-schema|--max-budget-usd|--max-turns|--model|--name|--output-format|--permission-mode|--permission-prompt-tool|--session-id|--setting-sources|--settings|--system-prompt|--system-prompt-file|--teammate-mode|--plugin-dir|--mcp-config|--tools|--allowedTools|--allowed-tools|--disallowedTools|--disallowed-tools|--add-dir|--betas) value_follows=true ;;
        --remote-control|--rc) native_entry=true ;;
    esac
done
if "$native_entry"; then
    # Only a leading private entry marker is routing metadata.
    if [ "${1:-}" = '--hezarfen-entrypoint=claude' ]; then shift; fi
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_BEDROCK_BASE_URL ANTHROPIC_VERTEX_BASE_URL ANTHROPIC_FOUNDRY_BASE_URL ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_PROFILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_MANTLE AWS_BEARER_TOKEN_BEDROCK AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CLOUD_PROJECT CLOUD_ML_REGION ANTHROPIC_VERTEX_PROJECT_ID ANTHROPIC_FOUNDRY_RESOURCE AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_CLIENT_SECRET ANTHROPIC_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_SMALL_FAST_MODEL ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION CLAUDE_CODE_SUBAGENT_MODEL NO_PROXY CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY CLAUDE_CODE_AUTO_COMPACT_WINDOW HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE HEZARFEN_CLAUDE_OAUTH_RELEASE_ID
    exec "${CLAUDE_OAUTH_NATIVE_BINARY:-claude}" "$@"
fi

shim_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
release_root=${CLAUDE_OAUTH_RELEASE_ROOT:-"$shim_root/.."}
if [ -z "${CLAUDE_OAUTH_RELEASE_ROOT:-}" ] && [ ! -f "$release_root/release-id" ]; then
    release_root="$shim_root/.claude-oauth-runtime/current"
fi
release_root=$(CDPATH= cd -- "$release_root" && pwd)
release_id=$(cat "$release_root/release-id")
# Accept a release-id written with Windows line endings.
release_id=$(printf '%s' "$release_id" | tr -d '\r')
if ! printf '%s\n' "$release_id" | LC_ALL=C grep -Eq '^router-v3-[A-F0-9]{12}-[A-F0-9]{12}$'; then
    echo 'claude-oauth: malformed release-id artifact.' >&2
    exit 1
fi
cli="$release_root/dist/src/cli.js"
if [ ! -f "$cli" ]; then
    echo 'claude-oauth: release CLI is missing.' >&2
    exit 1
fi
node_bin=${CLAUDE_OAUTH_NODE:-"$release_root/node/bin/node"}
if [ -z "${CLAUDE_OAUTH_NODE:-}" ] && [ ! -x "$node_bin" ]; then
    node_bin=node
fi
export HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE=embedded-release
export HEZARFEN_CLAUDE_OAUTH_RELEASE_ID="$release_id"
# The CLI verifies this identity and builds the router environment after binding.
exec "$node_bin" --no-warnings "$cli" "$@"
