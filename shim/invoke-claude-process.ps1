# Preserve PowerShell pipelines without buffering input before launch.
begin {
$streamInput = $args -contains '--input-format=stream-json'
for ($index = 0; $index -lt $args.Count - 1; $index++) {
    if ($args[$index] -eq '--input-format' -and $args[$index + 1] -eq 'stream-json') { $streamInput = $true }
}

if ($args[0] -eq '--environment-argv' -or $streamInput) {
    if ($streamInput) {
        $binary = $args[0]
        $forwarded = @($args | Select-Object -Skip 1)
    } else {
        $decoded = $env:HEZARFEN_CLAUDE_OAUTH_ARGV | ConvertFrom-Json
        [Environment]::SetEnvironmentVariable('HEZARFEN_CLAUDE_OAUTH_ARGV', $null, 'Process')
        Set-Location -LiteralPath $decoded.cwd
        $binary = $decoded.binary
        $forwarded = @($decoded.arguments)
    }
    # Use OS handles before PowerShell reads input. Windows argv quoting:
    # https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
if ($binary -match '[/\\]') { $binary = (Resolve-Path -LiteralPath $binary).Path }
$extension = [IO.Path]::GetExtension($binary)
if ($extension -eq '.ps1') {
    & $binary @forwarded
    exit $LASTEXITCODE
}
if ($extension -in @('.cmd', '.bat')) {
    throw 'claude-oauth: select a native executable with CLAUDE_OAUTH_NATIVE_BINARY or CLAUDE_OAUTH_NODE; batch wrappers cannot preserve arbitrary Claude arguments safely.'
}
$quoted = @($forwarded | ForEach-Object {
    '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
})
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $binary
$start.Arguments = $quoted -join ' '
$start.UseShellExecute = $false
$start.CreateNoWindow = [Console]::IsOutputRedirected
$start.RedirectStandardOutput = [Console]::IsOutputRedirected
$start.RedirectStandardError = [Console]::IsErrorRedirected
$start.RedirectStandardInput = $false
$start.WorkingDirectory = (Get-Location).Path
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $start
try {
    if (-not $child.Start()) { throw 'claude-oauth: child could not start.' }
    $copies = @()
    if ($start.RedirectStandardOutput) { $copies += $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput()) }
    if ($start.RedirectStandardError) { $copies += $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError()) }
    $child.WaitForExit()
    foreach ($copy in $copies) { $null = $copy.GetAwaiter().GetResult() }
    $result = $child.ExitCode
} finally {
    $child.Dispose()
}
exit $result
}
# Environment transport preserves quotes without expanding the command line.
# The payload is cleared in the child before the target starts.
$payload = @{ binary = $args[0]; arguments = @($args | Select-Object -Skip 1); cwd = (Get-Location).Path } | ConvertTo-Json -Compress
$previousPayload = $env:HEZARFEN_CLAUDE_OAUTH_ARGV
$env:HEZARFEN_CLAUDE_OAUTH_ARGV = $payload
$restore = { [Environment]::SetEnvironmentVariable('HEZARFEN_CLAUDE_OAUTH_ARGV', $previousPayload, 'Process') }
# Native stderr must not turn a child's exit code into a PowerShell Stop exception.
$ErrorActionPreference = 'Continue'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$command = (Get-Process -Id $PID).Path
$forwarded = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '--environment-argv')

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
