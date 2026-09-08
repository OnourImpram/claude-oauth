param([Parameter(Mandatory = $true)][string]$LockPath)

$ErrorActionPreference = 'Stop'
$handle = $null
try {
    # FileShare.None denies subsequent opens until the handle closes.
    # https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare
    $handle = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    [Console]::WriteLine('ready')
    # EOF releases the lock if the Node parent dies; Node also force-closes a stuck helper.
    [Console]::ReadLine() | Out-Null
}
catch {
    [Console]::Error.WriteLine('lock fixture failed')
    exit 1
}
finally {
    if ($null -ne $handle) { $handle.Dispose() }
}
