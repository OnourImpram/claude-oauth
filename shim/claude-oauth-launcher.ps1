# Preserve PowerShell pipelines without buffering input before launch.
begin {
$streamInput = $args -contains '--input-format=stream-json'
for ($index = 0; $index -lt $args.Count - 1; $index++) {
    if ($args[$index] -eq '--input-format' -and $args[$index + 1] -eq 'stream-json') { $streamInput = $true }
}
$ErrorActionPreference = 'Stop'
$nativeEntry = $args.Count -gt 0 -and $args[0] -in @('remote-control', '--hezarfen-entrypoint=claude')
# Required-value options consume their next token even when it resembles --rc.
# https://code.claude.com/docs/en/cli-reference#cli-flags
$valueOptions = @('--advisor', '--agent', '--agents', '--append-subagent-system-prompt', '--append-subagent-system-prompt-file', '--append-system-prompt', '--append-system-prompt-file', '--autocompact', '--config', '--debug-file', '--effort', '--fallback-model', '--from-pr', '--input-format', '--json-schema', '--max-budget-usd', '--max-turns', '--model', '--name', '--output-format', '--permission-mode', '--permission-prompt-tool', '--session-id', '--setting-sources', '--settings', '--system-prompt', '--system-prompt-file', '--teammate-mode', '--plugin-dir', '--mcp-config', '--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--add-dir', '--betas')
$valueFollows = $false
foreach ($argument in $args) {
    if ($valueFollows) { $valueFollows = $false; continue }
    if ($argument -eq '--') { break }
    if ($argument -in $valueOptions) { $valueFollows = $true; continue }
    if ($argument -in @('--remote-control', '--rc')) { $nativeEntry = $true }
}

$forwarded = @($args)
$restore = { }
if ($nativeEntry) {
    $command = Join-Path $PSScriptRoot 'claude-launcher.ps1'
} else {
$releaseRoot = $env:CLAUDE_OAUTH_RELEASE_ROOT
if (-not $releaseRoot) {
    $releaseRoot = Split-Path -Parent $PSScriptRoot
    if (-not (Test-Path -LiteralPath (Join-Path $releaseRoot 'release-id'))) {
        $releaseRoot = Join-Path $PSScriptRoot '.claude-oauth-runtime/current'
    }
}
$releaseRoot = (Resolve-Path -LiteralPath $releaseRoot).Path
$releaseId = (Get-Content -Raw -LiteralPath (Join-Path $releaseRoot 'release-id')).Trim()
if ($releaseId -cnotmatch '^router-v3-[A-F0-9]{12}-[A-F0-9]{12}$') {
    throw 'claude-oauth: malformed release-id artifact.'
}
$cli = Join-Path $releaseRoot 'dist/src/cli.js'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw 'claude-oauth: release CLI is missing.'
}
$nodeBin = $env:CLAUDE_OAUTH_NODE
if (-not $nodeBin) {
    $nodeBin = Join-Path $releaseRoot 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeBin -PathType Leaf)) {
        $nodeBin = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    }
}


    $previousSource = $env:HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE
    $previousId = $env:HEZARFEN_CLAUDE_OAUTH_RELEASE_ID
    $restore = {
        [Environment]::SetEnvironmentVariable('HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE', $previousSource, 'Process')
        [Environment]::SetEnvironmentVariable('HEZARFEN_CLAUDE_OAUTH_RELEASE_ID', $previousId, 'Process')
    }
    $env:HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE = 'embedded-release'
    $env:HEZARFEN_CLAUDE_OAUTH_RELEASE_ID = $releaseId
    # The CLI verifies the content identity and builds the router environment.
    $command = Join-Path $PSScriptRoot 'invoke-claude-process.ps1'
    $forwarded = @($nodeBin, '--no-warnings', $cli) + $forwarded
}

    if ($streamInput) {
        try { & $command @forwarded; $result = $LASTEXITCODE } finally { & $restore }
        exit $result
    }
    try {
        $pipeline = { & $command @forwarded }.GetSteppablePipeline()
        # https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.steppablepipeline.begin
        $pipeline.Begin(($MyInvocation.ExpectingInput -or [Console]::IsInputRedirected), $ExecutionContext)
        $sawInput = $false
    } catch { & $restore; throw }
}
process {
    try {
        if ($null -ne $_) { $sawInput = $true; $pipeline.Process($_) }
    } catch { & $restore; throw }
}
end {
    try {
        if (-not $sawInput -and [Console]::IsInputRedirected) {
            $textInput = [Console]::In.ReadToEnd()
            if ($textInput.Length -gt 0) { $pipeline.Process($textInput) }
        }
        $pipeline.End()
        $result = $LASTEXITCODE
    } finally { & $restore }
    $global:LASTEXITCODE = $result
    if ($MyInvocation.InvocationName -ne '&') { exit $result }
}
