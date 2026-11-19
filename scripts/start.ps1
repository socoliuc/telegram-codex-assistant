param([switch]$Automatic)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskLocal = Join-Path $taskRoot '.local'
. (Join-Path $PSScriptRoot 'instance-status.ps1')
$taskConfigPath = Join-Path $taskLocal 'config.json'
$taskPausePath = Join-Path $taskLocal 'paused.json'
if ($Automatic -and (Test-Path -LiteralPath $taskPausePath)) { Write-Output 'Automatic startup is paused.'; exit 0 }
if (-not $Automatic -and (Test-Path -LiteralPath $taskPausePath)) { Remove-Item -LiteralPath $taskPausePath }
if (-not (Test-Path -LiteralPath $taskConfigPath)) { throw 'Run Setup.cmd first.' }
if (Test-Path -LiteralPath (Join-Path $taskLocal 'instance.json')) {
    $taskInstanceStatus = Get-TelegramInstanceStatus -Path (Join-Path $taskLocal 'instance.json')
    if ($taskInstanceStatus -eq 'running') { Write-Output 'Assistant is already running.'; exit 0 }
    if ($taskInstanceStatus -ne 'stale') { throw 'Instance owner could not be verified. Inspect the local lock before restarting.' }
}
. (Join-Path $PSScriptRoot 'silent-launcher.ps1')
Start-Process -FilePath (Get-TelegramPythonw) -ArgumentList ('"' + (Join-Path $PSScriptRoot 'launch-silent.pyw') + '" listener') -WorkingDirectory $taskRoot -WindowStyle Hidden | Out-Null
Write-Output 'Assistant launch requested. Check Telegram or .local\health.json.'
