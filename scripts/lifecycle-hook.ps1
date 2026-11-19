$ErrorActionPreference = 'Stop'
try {
    # A PowerShell 7 caller can inject incompatible module discovery paths.
    $env:PSModulePath = Join-Path $PSHOME 'Modules'
    $taskRoot = Split-Path -Parent $PSScriptRoot
    $taskConfig = Get-Content -LiteralPath (Join-Path $taskRoot '.local\config.json') -Raw | ConvertFrom-Json
    $taskStart = New-Object Diagnostics.ProcessStartInfo
    $taskStart.FileName = $taskConfig.nodeBin
    $taskStart.Arguments = '"' + (Join-Path $PSScriptRoot 'lifecycle-hook.mjs') + '"'
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardInput = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    $taskProcess = [Diagnostics.Process]::Start($taskStart)
    # Preserve the original JSON bytes; Windows PowerShell's text pipeline is ASCII.
    [Console]::OpenStandardInput().CopyTo($taskProcess.StandardInput.BaseStream)
    $taskProcess.StandardInput.BaseStream.Close()
    if (-not $taskProcess.WaitForExit(2500)) { $taskProcess.Kill() }
} catch { }
finally { if ($taskProcess) { $taskProcess.Dispose() } }
exit 0
