# Preserve PowerShell pipelines without buffering input before launch.
begin {
$streamInput = $args -contains '--input-format=stream-json'
for ($index = 0; $index -lt $args.Count - 1; $index++) {
    if ($args[$index] -eq '--input-format' -and $args[$index + 1] -eq 'stream-json') { $streamInput = $true }
}
$ErrorActionPreference = 'Stop'
$claudeBin = $env:CLAUDE_OAUTH_NATIVE_BINARY
if (-not $claudeBin) {
    # Prefer the executable to a shell wrapper that may route back into this shim.
    $command = Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
        $command = Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1
    }
    $claudeBin = $command.Source
}
$nativeArgs = @($args)
if ($nativeArgs.Count -gt 0 -and $nativeArgs[0] -eq '--hezarfen-entrypoint=claude') {
    $nativeArgs = @($nativeArgs | Select-Object -Skip 1)
}
# Match the live native launcher's provider sanitization; preserve ANTHROPIC_OAT_TOKEN.
$sanitizedVariables = @(
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_FOUNDRY_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_PROFILE',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'CLOUD_ML_REGION',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'ANTHROPIC_FOUNDRY_RESOURCE',
    'AZURE_CLIENT_ID',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_SECRET',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'NO_PROXY',
    'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'HEZARFEN_CLAUDE_OAUTH_LAUNCHER_SOURCE',
    'HEZARFEN_CLAUDE_OAUTH_RELEASE_ID'
)

$previous = @{}
foreach ($variable in $sanitizedVariables) {
    $previous[$variable] = [Environment]::GetEnvironmentVariable($variable, 'Process')
    [Environment]::SetEnvironmentVariable($variable, $null, 'Process')
}
$restore = {
    foreach ($variable in $sanitizedVariables) {
        [Environment]::SetEnvironmentVariable($variable, $previous[$variable], 'Process')
    }
}
$command = Join-Path $PSScriptRoot 'invoke-claude-process.ps1'
$forwarded = @($claudeBin) + $nativeArgs

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
