# Preserve PowerShell pipelines without buffering input before launch.
begin {
$streamInput = $args -contains '--input-format=stream-json'
for ($index = 0; $index -lt $args.Count - 1; $index++) {
    if ($args[$index] -eq '--input-format' -and $args[$index + 1] -eq 'stream-json') { $streamInput = $true }
}
$command = Join-Path $PSScriptRoot 'claude-oauth-launcher.ps1'
$forwarded = @($args)
$restore = { }

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
